// Explicit, foreground-only acceptance of the official SDK and shared controller.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { LocalClient } from '../src/local-client.mjs';
import { pixelToAbsolute } from '../src/reports.mjs';

const [flag, dataRoot, observerRoot] = process.argv.slice(2);
if (flag !== '--live' || !path.isAbsolute(dataRoot ?? '') || !path.isAbsolute(observerRoot ?? '')) throw new Error('Usage: Test-LiveSdk.mjs --live ABSOLUTE_DATA_ROOT ABSOLUTE_OBSERVER_DIRECTORY');
const receipt = { test: 'shared-controller-official-sdk', startedUtc: new Date().toISOString(), status: 'running' };
const clients = [];
const text = response => { if (response.isError) throw new Error(response.content[0].text); return JSON.parse(response.content[0].text); };
async function observation() {
  let value;
  for (let i = 0; i < 10; i++) {
    try { value = JSON.parse(await fs.readFile(path.join(observerRoot, 'input.jsonl.state.json'), 'utf8')); break; }
    catch (error) { if (i === 9) throw error; await delay(20); }
  }
  if (!value.foreground || Date.now() - Date.parse(value.observedUtc) > 700) throw new Error('Fresh foreground Input Observer required');
  return value;
}
async function events(after) {
  return (await fs.readFile(path.join(observerRoot, 'input.jsonl'), 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(event => event.sequence > after);
}
async function connect(name) {
  const client = new Client({ name, version: '0.2.0' }); clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url)), '--live', path.join(dataRoot, 'native', 'HidTransport.exe'), '--data-root', dataRoot, '--agent', name], stderr: 'pipe' });
  transport.stderr.on('data', chunk => { receipt.stderr = (receipt.stderr ?? '') + chunk; });
  await client.connect(transport); return client;
}
let leaseB;
try {
  receipt.before = await observation();
  const a = await connect('live-sdk-a'), b = await connect('live-sdk-b');
  receipt.toolCount = (await a.listTools()).tools.length;
  receipt.statusBefore = text(await a.callTool({ name: 'hid_status', arguments: {} }));
  if (receipt.statusBefore.simulated || !receipt.statusBefore.liveHelperConnected || receipt.statusBefore.native.administrator || receipt.statusBefore.control.operatorStopped) throw new Error('Expected live, non-administrator, unstopped controller');
  const lease = text(await a.callTool({ name: 'hid_acquire', arguments: { owner: 'live-sdk-a', jobId: 'sdk-acceptance', ttlMs: 10000 } }));
  await observation();
  const capture = await a.callTool({ name: 'hid_capture', arguments: { token: lease.token } });
  receipt.capture = text(capture);
  const image = capture.content.find(content => content.type === 'image');
  const png = Buffer.from(image.data, 'base64');
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== receipt.capture.width || png.readUInt32BE(20) !== receipt.capture.height) throw new Error('Official client did not receive a valid declared PNG');
  receipt.competingLeaseRejected = (await b.callTool({ name: 'hid_acquire', arguments: { owner: 'live-sdk-b' } })).isError === true;
  receipt.borrowedTokenRejected = (await b.callTool({ name: 'hid_mouse_relative', arguments: { token: lease.token, dx: 1 } })).isError === true;
  if (!receipt.competingLeaseRejected || !receipt.borrowedTokenRejected) throw new Error('Client isolation failed');
  await observation();
  text(await a.callTool({ name: 'hid_mouse_relative', arguments: { token: lease.token, dx: 10, dy: 5, buttons: 0 } }));
  await observation();
  text(await a.callTool({ name: 'hid_keyboard', arguments: { token: lease.token, modifiers: 2, keys: [] } }));
  await delay(50); await observation();
  const disconnectedAt = Date.now();
  await a.close();
  for (let i = 0; i < 60; i++) {
    await observation(); receipt.received = await events(receipt.before.events);
    if (receipt.received.some(e => e.kind === 'keyboard' && e.scanCode === 42 && (e.flags & 1))) break;
    await delay(25);
  }
  receipt.disconnectReleaseMs = Date.now() - disconnectedAt;
  const shifts = receipt.received.filter(e => e.kind === 'keyboard' && e.scanCode === 42);
  if (!shifts.some(e => !(e.flags & 1)) || !shifts.some(e => e.flags & 1) || !receipt.received.some(e => e.kind === 'mouse' && !e.absolute && e.x === 10 && e.y === 5)) throw new Error('Independent receiver did not verify input and disconnect release');
  leaseB = text(await b.callTool({ name: 'hid_acquire', arguments: { owner: 'live-sdk-b', ttlMs: 5000 } }));
  const before = await observation();
  receipt.targetPixel = { x: before.clientLeft + Math.floor(before.clientWidth / 2), y: before.clientTop + Math.floor(before.clientHeight / 2) };
  const coordinates = pixelToAbsolute(receipt.targetPixel, { width: before.primaryWidth, height: before.primaryHeight });
  text(await b.callTool({ name: 'hid_mouse_absolute', arguments: { token: leaseB.token, ...coordinates, buttons: 0 } }));
  await delay(100); receipt.after = await observation();
  if (Math.abs(receipt.after.cursorX - receipt.targetPixel.x) > 2 || Math.abs(receipt.after.cursorY - receipt.targetPixel.y) > 2) throw new Error('Absolute movement through the second client missed its target');
  text(await b.callTool({ name: 'hid_release', arguments: { token: leaseB.token } })); leaseB = undefined;
  receipt.statusAfter = text(await b.callTool({ name: 'hid_status', arguments: {} }));
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = error.message; process.exitCode = 1; }
finally {
  if (leaseB) await clients[1].callTool({ name: 'hid_release', arguments: { token: leaseB.token } }).catch(() => {});
  for (const client of clients) await client.close().catch(() => {});
  // A graceful test shutdown is not an operator stop and does not clear one.
  try { const operator = await LocalClient.connect(dataRoot, 'test-cleanup'); await operator.request('shutdown'); operator.close(); }
  catch (error) { receipt.cleanupError = error.message; }
  receipt.finishedUtc = new Date().toISOString();
  receipt.nativeSha256 = (await import('node:crypto')).createHash('sha256').update(await fs.readFile(path.join(dataRoot, 'native', 'HidTransport.exe'))).digest('hex');
  await fs.writeFile(path.join(observerRoot, 'sdk-result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, toolCount: receipt.toolCount, disconnectReleaseMs: receipt.disconnectReleaseMs, capture: receipt.capture, error: receipt.error, cleanupError: receipt.cleanupError }, null, 2));
}
