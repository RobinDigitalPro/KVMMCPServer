// Actual official SDK/stdio/broker/capture-worker acceptance in an isolated root.
// HID writes are replaced by a no-op only in this explicitly capture-only harness.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CaptureWorker } from '../src/capture-worker.mjs';
import { startBroker } from '../src/broker.mjs';
import { externalRoot } from '../src/state.mjs';
const text = value => JSON.parse(value.content[0].text);
if (process.argv[2] !== '--live' || !path.isAbsolute(process.argv[3] ?? '')) throw new Error('Usage: --live ABSOLUTE_CAPTURE_EXE ABSOLUTE_TEST_ROOT');
const root = externalRoot(process.argv[4]); await fs.mkdir(root, { recursive: true });
const capture = new CaptureWorker(process.argv[3], root);
const transport = { send: async () => {}, captureAvailable: true, recordingAvailable: true,
  capture: options => capture.snapshot(options), startRecording: options => capture.startRecording(options), stopRecording: () => capture.stopRecording(),
  onRecording: listener => { capture.on('recording', listener); return () => capture.off('recording', listener); }, close: () => capture.close() };
const broker = await startBroker({ dataRoot: root, transport });
const clients = [];
async function connect(name) {
  const client = new Client({ name, version: '0.3.0' }); clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url)), '--connect', '--data-root', root, '--agent', name], stderr: 'pipe' })); return client;
}
const receipt = { startedUtc: new Date().toISOString(), captureOnlyHarness: true, hidWritesSuppressed: true, inputSent: false };
try {
  const a = await connect('capture-owner'), b = await connect('capture-other');
  receipt.toolCount = (await a.listTools()).tools.length; assert.equal(receipt.toolCount, 11);
  const lease = text(await a.callTool({ name: 'hid_acquire', arguments: { owner: 'capture-acceptance', ttlMs: 10000 } }));
  const image = await a.callTool({ name: 'hid_capture', arguments: { token: lease.token, format: 'jpeg', maxWidth: 1280 } });
  assert.equal(image.isError, undefined); assert.equal(image.content[1].mimeType, 'image/jpeg'); receipt.snapshot = text(image);
  receipt.started = text(await a.callTool({ name: 'screen_record_start', arguments: { token: lease.token, maxSeconds: 2, maxWidth: 1280 } }));
  assert.equal(receipt.started.state, 'recording');
  await a.callTool({ name: 'hid_release', arguments: { token: lease.token } });
  assert.equal((await b.callTool({ name: 'screen_record_stop', arguments: { recordingId: receipt.started.recordingId } })).isError, true);
  for (let n = 0; n < 40; n++) {
    const status = text(await a.callTool({ name: 'screen_record_status', arguments: { recordingId: receipt.started.recordingId } }));
    if (status.state !== 'recording') { receipt.completed = status; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(receipt.completed?.state, 'completed'); assert.equal(receipt.completed.finalized, true);
  const next = text(await a.callTool({ name: 'hid_acquire', arguments: { owner: 'disconnect-acceptance', ttlMs: 10000 } }));
  await a.callTool({ name: 'screen_record_start', arguments: { token: next.token, maxSeconds: 600, maxWidth: 640 } });
  await a.callTool({ name: 'hid_release', arguments: { token: next.token } });
  await a.close();
  for (let n = 0; n < 40; n++) { const status = broker.controller.status(); if (status.recording?.state === 'stopped') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  receipt.afterDisconnect = broker.controller.status().recording;
  assert.equal(receipt.afterDisconnect.state, 'stopped'); assert.equal(receipt.afterDisconnect.finalized, true);
  receipt.passed = true;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  await broker.close(); await fs.writeFile(path.join(root, 'mcp-capture-acceptance.json'), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify(receipt, null, 2));
