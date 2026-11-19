// Explicit physical-console acceptance. Right Shift down/up, timed F8 in our receiver.
// Usage: node scripts/Test-KeyTiming.mjs --live ABS_HID_EXE ABS_OBSERVER_EXE ABS_DATA_ROOT
// Inspect the emitted screenshot, then send "run" on stdin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { LocalClient } from '../src/local-client.mjs';
const [mode, hid, observer, root] = process.argv.slice(2);
if (mode !== '--live' || ![hid, observer, root].every(value => value && path.isAbsolute(value))) throw new Error('Explicit --live and absolute paths required');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (path.resolve(root).toLowerCase().startsWith(source.toLowerCase() + path.sep)) throw new Error('Use an external data root');
await fs.mkdir(root, { recursive: true });
const log = path.join(root, 'key-events.jsonl');
const child = spawn(observer, [log], { windowsHide: false, stdio: 'ignore' });
const client = new Client({ name: 'key-timing-acceptance', version: '0.7.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(source, 'src/mcp.mjs'), '--live', hid, '--data-root', root, '--agent', 'key-timing-acceptance'] });
const input = createInterface({ input: process.stdin });
const command = new Promise(resolve => input.once('line', resolve));
const receipt = { startedUtc: new Date().toISOString(), tests: [], verified: false };
let token;
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const value = result.content?.find(item => item.type === 'text')?.text;
  if (result.isError) throw new Error(value);
  return JSON.parse(value);
};
const read = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const foreground = async () => {
  const state = await read(log + '.state.json');
  if (state.processId !== child.pid || !state.foreground || Date.now() - Date.parse(state.observedUtc) > 2000) throw new Error('Our input observer must be visibly focused; no input sent');
};
const events = async () => (await fs.readFile(log, 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(event => event.kind === 'keyboard');
try {
  for (let n = 0; n < 50; n++) { try { await foreground(); break; } catch { if (n === 49) throw new Error('Observer is not foreground'); await delay(100); } }
  await client.connect(transport);
  receipt.toolCount = (await client.listTools()).tools.length; assert.equal(receipt.toolCount, 17);
  ({ token } = await call('hid_acquire', { owner: 'key-timing-acceptance', ttlMs: 60000 }));
  await call('hid_capture', { token, format: 'jpeg', maxWidth: 1280 });
  const frame = await call('hid_capture', { token, format: 'jpeg', maxWidth: 1280 });
  console.log(JSON.stringify({ ready: true, observerPid: child.pid, frame, next: 'Inspect our receiver, then send run' }));
  if ((await command).trim() !== 'run') throw new Error('Live input was not confirmed');
  await foreground();
  await call('hid_key_down', { token, key: 229 }); await delay(50);
  await call('hid_key_up', { token, key: 229 });
  await delay(50);
  const shift = (await events()).filter(event => event.scanCode === 54 && [16, 161].includes(event.virtualKey));
  assert.ok(shift.some(event => (event.flags & 1) === 0) && shift.some(event => (event.flags & 1) === 1));
  receipt.tests.push({ op: 'key_down/key_up', passed: true });
  for (const durationMs of [750, 10000]) {
    await foreground(); const before = (await events()).length;
    const result = await call('hid_key_press', { token, key: 65, durationMs });
    await delay(100);
    const captured = (await events()).slice(before).filter(event => event.virtualKey === 119);
    const down = captured.find(event => (event.flags & 1) === 0);
    const up = captured.find(event => (event.flags & 1) === 1);
    assert.ok(down && up, 'Actual device down and up must both be observed');
    const observedMs = (up.monotonicTicks - down.monotonicTicks) * 1000 / down.ticksPerSecond;
    assert.ok(observedMs >= durationMs - 50 && observedMs <= durationMs + 1500, `Unexpected observed hold: ${observedMs}`);
    receipt.tests.push({ op: 'key_press', durationMs, observedMs, result });
    console.log(JSON.stringify(receipt.tests.at(-1)));
  }
  await call('hid_release', { token }); token = undefined;
  receipt.verified = true;
} finally {
  if (token) await call('hid_release', { token }).catch(() => {});
  await client.close().catch(() => {}); await transport.close().catch(() => {});
  try { const broker = await LocalClient.connect(root, 'key-test-cleanup'); try { await broker.request('shutdown'); } finally { broker.close(); } } catch {}
  child.kill(); input.close(); process.stdin.pause(); process.stdin.unref?.();
  receipt.finishedUtc = new Date().toISOString();
  await fs.writeFile(path.join(root, 'key-timing-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ verified: receipt.verified, receipt: path.join(root, 'key-timing-receipt.json') }));
}
