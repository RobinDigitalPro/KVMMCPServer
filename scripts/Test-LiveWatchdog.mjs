// Controlled failure of our own helper, while holding only Left Shift in the
// foreground, read-only Input Observer. Never run by the ordinary test suite.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeTransport } from '../src/native-transport.mjs';

const [flag, kind, dataRoot, observerDirectory] = process.argv.slice(2);
if (flag !== '--live' || !['native', 'kernel'].includes(kind) || !path.isAbsolute(dataRoot ?? '')) throw new Error('Usage: node scripts/Test-LiveWatchdog.mjs --live native|kernel ABSOLUTE_DATA_ROOT');
if (observerDirectory && !path.isAbsolute(observerDirectory)) throw new Error('Observer directory must be absolute');
const dir = observerDirectory ?? path.join(dataRoot, 'tests', 'live-' + new Date().toISOString().slice(0, 10).replaceAll('-', ''));
const executable = path.join(dataRoot, 'native', 'HidTransport.exe');
const result = { function: `${kind}_watchdog`, startedUtc: new Date().toISOString(), status: 'running' };
const attempt = result.startedUtc.replaceAll(':', '-');
let child, released = false, childExit;
const messages = [], pending = new Map(); let id = 0;
async function observation() {
  let state;
  for (let i = 0; i < 10; i++) {
    try { state = JSON.parse(await fs.readFile(path.join(dir, 'input.jsonl.state.json'), 'utf8')); break; }
    catch (error) { if (i === 9) throw error; await delay(20); }
  }
  if (!state.foreground || Date.now() - Date.parse(state.observedUtc) > 700) throw new Error('Test window lost foreground or fresh observation');
  return state;
}
async function events(since) {
  const text = (await fs.readFile(path.join(dir, 'input.jsonl'), 'utf8')).replace(/^\uFEFF/, '');
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(e => e.sequence > since);
}
function request(op, report) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Helper ACK timeout')); }, 1500);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: requestId, op, ...(report ? { report } : {}) }) + '\n');
  });
}
try {
  const before = await observation(); result.before = before;
  child = spawn(executable, ['serve', '--live'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Helper ready timeout')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line); messages.push(message);
        if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
        else if (message.ok === false && message.id === undefined) { clearTimeout(timer); reject(new Error(message.error)); }
        const p = pending.get(message.id);
        if (p) { pending.delete(message.id); clearTimeout(p.timer); message.ok ? p.resolve(message) : p.reject(new Error(message.error)); }
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
  result.helper = await ready;
  await observation();
  const sentAt = Date.now();
  // HID keyboard report 7: Left Shift only, no character keys.
  await request('send', '070200000000000000');
  let received = [];
  for (let i = 0; i < 20; i++) {
    await observation(); received = await events(before.events);
    if (received.some(e => e.kind === 'keyboard' && e.scanCode === 42 && !(e.flags & 1))) break;
    await delay(25);
  }
  if (!received.some(e => e.kind === 'keyboard' && e.scanCode === 42 && !(e.flags & 1))) throw new Error('Shift-down not received');
  if (kind === 'kernel') {
    // Terminate only the helper we just spawned. Windows termination does not
    // execute its managed finally/release block, isolating the kernel watchdog.
    child.kill(); result.terminatedHelper = await childExit;
  }
  for (let i = 0; i < 180; i++) {
    await observation(); received = await events(before.events);
    if (received.some(e => e.kind === 'keyboard' && e.scanCode === 42 && (e.flags & 1))) { released = true; break; }
    await delay(25);
  }
  result.releaseObservedMs = Date.now() - sentAt;
  result.received = received;
  result.helperMessages = messages;
  if (!released) throw new Error('Shift was not automatically released');
  const expectedMs = kind === 'kernel' ? 3000 : result.helper.watchdogTimeoutMs;
  if (result.releaseObservedMs < expectedMs - 300 || result.releaseObservedMs > expectedMs + 1300) throw new Error('Watchdog release outside its expected interval');
  if (kind === 'native') for (let i = 0; i < 20 && !messages.some(m => m.type === 'stopped'); i++) await delay(25);
  if (kind === 'native' && !messages.some(m => m.type === 'stopped' && m.released === true)) throw new Error('Native watchdog did not report release');
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = error.message; process.exitCode = 1; }
finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    if (!released) await request('release').catch(() => {});
    child.stdin.end();
    await Promise.race([childExit, delay(700)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await childExit; }
  }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Test completed')); } pending.clear();
  // Explicit neutral cleanup also covers a failed or interrupted experiment.
  const recovery = new NativeTransport(executable);
  try { await recovery.ready(); await recovery.close(); } catch (error) { result.cleanupError = error.message; process.exitCode = 1; }
  result.finishedUtc = new Date().toISOString();
  await fs.writeFile(path.join(dir, `${kind}-watchdog-${attempt}-result.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ function: result.function, status: result.status, releaseObservedMs: result.releaseObservedMs, receivedEvents: result.received?.length, terminatedHelper: result.terminatedHelper, error: result.error, cleanupError: result.cleanupError, artifact: path.join(dir, `${kind}-watchdog-${attempt}-result.json`) }, null, 2));
}
