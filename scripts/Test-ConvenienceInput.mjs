// Explicit physical-console test in our own foreground receiver. Never ordinary CI.
// node scripts/Test-ConvenienceInput.mjs --live ABS_HID_EXE ABS_OBSERVER_EXE ABS_DATA_ROOT
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
if (path.resolve(root).toLowerCase().startsWith(source.toLowerCase() + path.sep)) throw new Error('Use an external data directory');
await fs.mkdir(root, { recursive: true });
const log = path.join(root, 'receiver-events.jsonl');
const child = spawn(observer, [log], { windowsHide: false, stdio: 'ignore' });
const client = new Client({ name: 'convenience-input-acceptance', version: '0.7.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(source, 'src/mcp.mjs'), '--live', hid, '--data-root', root, '--agent', 'input-acceptance'] });
const input = createInterface({ input: process.stdin });
const command = new Promise(resolve => input.once('line', resolve));
const receipt = { startedUtc: new Date().toISOString(), tests: [], verified: false };
let token, originalCaps;
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
};
const state = async () => {
  for (let n = 0; n < 5; n++) {
    try { return JSON.parse((await fs.readFile(log + '.state.json', 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) { if (n === 4) throw error; await delay(20); }
  }
};
const foreground = async () => {
  const current = await state();
  if (current.processId !== child.pid || !current.foreground || Date.now() - Date.parse(current.observedUtc) > 2000) throw new Error('Our receiver must be visibly focused before input');
  return current;
};
const point = (x, y, current) => ({ x: Math.round(x * 32767 / (current.primaryWidth - 1)), y: Math.round(y * 32767 / (current.primaryHeight - 1)) });
try {
  for (let n = 0; n < 50; n++) { try { if ((await state()).processId !== child.pid) throw new Error('Waiting for receiver'); break; } catch { if (n === 49) throw new Error('Receiver did not initialize'); await delay(100); } }
  await client.connect(transport);
  const catalog = (await client.listTools()).tools; assert.equal(catalog.length, 17);
  ({ token } = await call('hid_acquire', { owner: 'input-acceptance', ttlMs: 60000 }));
  await call('hid_capture', { token, format: 'jpeg', maxWidth: 1280 });
  const frame = await call('hid_capture', { token, format: 'jpeg', maxWidth: 1280 });
  await call('hid_release', { token }); token = undefined;
  console.log(JSON.stringify({ ready: true, frame, next: 'Inspect our receiver then send run' }));
  if ((await command).trim() !== 'run') throw new Error('Input not confirmed');
  ({ token } = await call('hid_acquire', { owner: 'input-acceptance', ttlMs: 60000 }));
  const visible = await state();
  assert.equal(visible.processId, child.pid);
  // The caller has inspected our topmost receiver screenshot. A physical click
  // focuses its empty field even when Windows denied background activation.
  if (!visible.foreground) {
    await call('hid_click', { token, ...point(visible.fieldLeft + visible.fieldWidth / 2, visible.fieldTop + visible.fieldHeight / 2, visible) });
    await delay(100);
  }
  let current = await foreground(); originalCaps = current.capsLock;
  assert.equal(current.keyboardLayout.slice(-8), '8130813', 'Set Belgian (Period) for this receiver before this explicit layout test');
  const sample = 'AaZzQqWw 0123456789 @€\\/|[]{};:!? éèçà êëôûï ^~\nTab:\tOK';
  receipt.tests.push({ op: 'hid_type_text', result: await call('hid_type_text', { token, text: sample, layout: 'Belgian (Period)' }) });
  await delay(150); current = await foreground();
  assert.equal(current.probeText.replaceAll('\r\n', '\n'), sample);
  receipt.tests.at(-1).actualTextMatched = true;
  await call('hid_key_chord', { token, modifiers: 5, durationMs: 40 });
  await call('hid_key_chord', { token, modifiers: 1, keys: [20], durationMs: 40 });
  await delay(100); current = await foreground(); assert.equal(current.selectionLength, current.probeText.length);
  receipt.tests.push({ op: 'hid_key_chord', ctrlAltCompleted: true, ctrlASelectedAll: true });
  await call('hid_key_press', { token, key: 57, durationMs: 20 }); await delay(100);
  current = await foreground(); assert.notEqual(current.capsLock, originalCaps);
  const capsSample = 'AaZz19@€';
  receipt.tests.push({ op: 'hid_type_text_caps', capsLock: current.capsLock, result: await call('hid_type_text', { token, text: capsSample, layout: 'Belgian (Period)' }) });
  await delay(150); current = await foreground(); assert.equal(current.probeText, capsSample);
  receipt.tests.at(-1).actualTextMatched = true;
  await call('hid_key_press', { token, key: 57, durationMs: 20 }); await delay(100);
  current = await foreground(); assert.equal(current.capsLock, originalCaps);
  const before = current.probeText;
  const unsupported = await client.callTool({ name: 'hid_type_text', arguments: { token, text: 'prefix😀', layout: 'Belgian (Period)' } });
  assert.equal(unsupported.isError, true); await delay(100); current = await foreground(); assert.equal(current.probeText, before);
  receipt.tests.push({ op: 'unsupported_unicode', rejectedBeforeTyping: true });
  const button = point(current.buttonLeft + current.buttonWidth / 2, current.buttonTop + current.buttonHeight / 2, current);
  await call('hid_click', { token, ...button }); await delay(100);
  current = await foreground(); assert.equal(current.clicks, 1);
  await delay(650); await call('hid_click', { token }); await delay(100);
  current = await foreground(); assert.equal(current.clicks, 2);
  receipt.tests.push({ op: 'hid_click', explicitPositionClicked: true, currentPositionClicked: true, observedClicks: current.clicks });
  receipt.finalCapture = await call('hid_capture', { token, format: 'jpeg', maxWidth: 1280 });
  receipt.verified = true;
} catch (error) { receipt.error = error.message; throw error; }
finally {
  if (token && originalCaps !== undefined) {
    try { const current = await foreground(); if (current.capsLock !== originalCaps) { await call('hid_key_press', { token, key: 57, durationMs: 20 }); await delay(100); } receipt.capsLockRestored = (await state()).capsLock === originalCaps; } catch (error) { receipt.capsRestoreError = error.message; }
  }
  if (token) await call('hid_release', { token }).catch(() => {});
  await client.close().catch(() => {}); await transport.close().catch(() => {});
  try { const broker = await LocalClient.connect(root, 'input-test-cleanup'); try { await broker.request('shutdown'); } finally { broker.close(); } } catch {}
  child.kill(); input.close(); process.stdin.pause(); process.stdin.unref?.();
  receipt.finishedUtc = new Date().toISOString();
  await fs.writeFile(path.join(root, 'input-acceptance.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
