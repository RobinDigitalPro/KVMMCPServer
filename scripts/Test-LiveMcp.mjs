import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const [flag, dataRoot, observerDirectory] = process.argv.slice(2);
if (flag !== '--live' || !path.isAbsolute(dataRoot ?? '')) throw new Error('Usage: node scripts/Test-LiveMcp.mjs --live ABSOLUTE_DATA_ROOT');
if (observerDirectory && !path.isAbsolute(observerDirectory)) throw new Error('Observer directory must be absolute');
const dir = observerDirectory ?? path.join(dataRoot, 'tests', 'live-' + new Date().toISOString().slice(0, 10).replaceAll('-', ''));
async function observation() {
  let state;
  for (let i = 0; i < 10; i++) {
    try { state = JSON.parse(await fs.readFile(path.join(dir, 'input.jsonl.state.json'), 'utf8')); break; }
    catch (e) { if (i === 9) throw e; await delay(20); }
  }
  if (!state.foreground || Date.now() - Date.parse(state.observedUtc) > 700) throw new Error('Fresh Input Observer foreground required');
  return state;
}
const result = { function: 'mcp_live', startedUtc: new Date().toISOString(), status: 'running' };
const attempt = result.startedUtc.replaceAll(':', '-');
const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url)), '--live', path.join(dataRoot, 'native', 'HidTransport.exe'), '--data-root', dataRoot], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let id = 0, stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
createInterface({ input: child.stdout }).on('line', line => {
  const response = JSON.parse(line), p = pending.get(response.id);
  if (!p) return; pending.delete(response.id); clearTimeout(p.timer);
  response.error ? p.reject(new Error(response.error.message)) : p.resolve(response.result);
});
function rpc(method, params) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('MCP response timeout: ' + stderr)); }, 5000);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
}
async function call(name, args = {}, expectedError = false) {
  if (name !== 'hid_status' && name !== 'hid_acquire' && name !== 'hid_release' && name !== 'hid_emergency_stop') await observation();
  const response = await rpc('tools/call', { name, arguments: args });
  if (expectedError) { if (!response.isError) throw new Error(name + ' should have been rejected'); return response.content[0].text; }
  if (response.isError) throw new Error(response.content[0].text);
  return JSON.parse(response.content[0].text);
}
try {
  const before = await observation(); result.before = before;
  result.initialize = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-acceptance', version: '0.1.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  result.toolCount = (await rpc('tools/list', {})).tools.length;
  result.statusBefore = await call('hid_status');
  if (result.statusBefore.simulated || !result.statusBefore.liveHelperConnected || result.statusBefore.native.administrator) throw new Error('Expected live connection running without administrator rights');
  const lease = await call('hid_acquire', { owner: 'mcp-live-acceptance', ttlMs: 5000 });
  result.capture = await call('hid_capture', { token: lease.token });
  const png = await fs.readFile(result.capture.path);
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== result.capture.width || png.readUInt32BE(20) !== result.capture.height) throw new Error('MCP capture is not the declared PNG frame');
  result.competingOwnerRejected = await call('hid_acquire', { owner: 'second-agent' }, true);
  await call('hid_mouse_relative', { token: lease.token, dx: -5, dy: 0, buttons: 0 });
  await call('hid_keyboard', { token: lease.token, modifiers: 2, keys: [] });
  await delay(50); await observation();
  await call('hid_emergency_stop');
  result.reacquireRejected = await call('hid_acquire', { owner: 'retry-after-stop' }, true);
  await delay(150);
  result.statusAfter = await call('hid_status');
  const text = (await fs.readFile(path.join(dir, 'input.jsonl'), 'utf8')).replace(/^\uFEFF/, '');
  result.received = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(e => e.sequence > before.events);
  if (!result.received.some(e => e.kind === 'mouse' && !e.absolute && e.x === -5 && e.y === 0)) throw new Error('MCP movement not independently received');
  const shifts = result.received.filter(e => e.kind === 'keyboard' && e.scanCode === 42);
  if (!shifts.some(e => !(e.flags & 1)) || !shifts.some(e => e.flags & 1) || !result.statusAfter.control.operatorStopped) throw new Error('MCP emergency stop did not independently release and revoke control');
  result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = error.message; process.exitCode = 1; }
finally {
  await call('hid_emergency_stop').catch(() => {});
  child.stdin.end();
  let shutdownTimer;
  result.serverExit = await Promise.race([exited, new Promise(resolve => { shutdownTimer = setTimeout(() => { child.kill(); resolve({ timedOut: true }); }, 2000); })]);
  clearTimeout(shutdownTimer);
  result.stderr = stderr; result.finishedUtc = new Date().toISOString();
  const artifact = path.join(dir, `mcp-${attempt}-result.json`);
  await fs.writeFile(artifact, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ function: result.function, status: result.status, toolCount: result.toolCount, capture: result.capture, administrator: result.statusBefore?.native?.administrator, emergencyStopped: result.statusAfter?.control?.operatorStopped, receivedEvents: result.received?.length, error: result.error, artifact }, null, 2));
}
