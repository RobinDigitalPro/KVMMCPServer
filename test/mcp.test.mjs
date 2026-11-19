import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { DesktopController } from '../src/controller.mjs';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/mcp.mjs';

const text = result => JSON.parse(result.content[0].text);
test('official MCP SDK client discovers and calls the real stdio server', async () => {
  const client = new Client({ name: 'sdk-acceptance', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url)), '--simulate'], stderr: 'pipe' });
  let errors = ''; transport.stderr.on('data', chunk => { errors += chunk; });
  try {
    await client.connect(transport);
    const catalog = (await client.listTools()).tools;
    assert.equal(catalog.length, 17);
    assert.ok(['hid_key_down', 'hid_key_up', 'hid_key_press', 'hid_type_text', 'hid_key_chord', 'hid_click'].every(name => catalog.some(tool => tool.name === name)));
    const status = text(await client.callTool({ name: 'hid_status', arguments: {} }));
    assert.equal(status.simulated, true);
    const lease = text(await client.callTool({ name: 'hid_acquire', arguments: { owner: 'sdk-test' } }));
    assert.equal((await client.callTool({ name: 'hid_mouse_relative', arguments: { token: lease.token, dx: 128 } })).isError, undefined);
    const bad = await client.callTool({ name: 'hid_keyboard', arguments: { token: lease.token, keys: [4, 4] } });
    assert.equal(bad.isError, true);
    assert.notEqual((await client.callTool({ name: 'hid_key_down', arguments: { token: lease.token, key: 225 } })).isError, true);
    const timed = text(await client.callTool({ name: 'hid_key_press', arguments: { token: lease.token, key: 4, durationMs: 30 } }));
    assert.equal(timed.durationMs, 30);
    assert.ok(timed.elapsedMs >= 25);
    assert.notEqual((await client.callTool({ name: 'hid_key_up', arguments: { token: lease.token, key: 225 } })).isError, true);
    assert.notEqual((await client.callTool({ name: 'hid_key_chord', arguments: { token: lease.token, modifiers: 5, durationMs: 1 } })).isError, true);
    assert.notEqual((await client.callTool({ name: 'hid_click', arguments: { token: lease.token, durationMs: 1 } })).isError, true);
    assert.equal((await client.callTool({ name: 'hid_type_text', arguments: { token: lease.token, text: 'read-only simulation has no Windows layout planner' } })).isError, true);
    await client.callTool({ name: 'hid_release', arguments: { token: lease.token } });
    assert.equal(text(await client.callTool({ name: 'hid_status', arguments: {} })).control.owner, null);
  } finally { await client.close(); }
  assert.equal(errors, '');
});

test('capture needs a valid lease and expiry is rechecked before returning an image', async () => {
  let captures = 0;
  const controller = await DesktopController.create({ transport: { send: async () => {}, captureAvailable: true, capture: async () => { captures++; await new Promise(resolve => setTimeout(resolve, 150)); return { data: 'AA==', width: 1, height: 1 }; } } });
  const agent = controller.attach();
  try {
    assert.equal((await controller.call(agent, 'hid_capture', { token: 'wrong' })).isError, true);
    assert.equal(captures, 0);
    const lease = text(await controller.call(agent, 'hid_acquire', { owner: 'capture-test', ttlMs: 100 }));
    const expired = await controller.call(agent, 'hid_capture', { token: lease.token });
    assert.equal(expired.isError, true);
    assert.ok(!expired.content.some(item => item.type === 'image'));
    assert.equal(captures, 1);
  } finally { await controller.close(); }
});

test('operator stop interrupts an in-flight capture without waiting for it', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const controller = await DesktopController.create({ transport: { send: async () => {}, captureAvailable: true,
    capture: ({ signal }) => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) } });
  const agent = controller.attach();
  try {
    const lease = text(await controller.call(agent, 'hid_acquire', { owner: 'stop-test' }));
    const capture = controller.call(agent, 'hid_capture', { token: lease.token });
    await ready;
    await controller.call(agent, 'hid_emergency_stop');
    assert.equal((await capture).isError, true);
    assert.equal(controller.status().control.operatorStopped, true);
    assert.equal((await controller.call(agent, 'hid_acquire', { owner: 'retry' })).isError, true);
  } finally { await controller.close(); }
});

test('late cancellation from an old capture cannot release a newer lease', async () => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const controller = await DesktopController.create({ transport: { send: async () => {}, captureAvailable: true,
    capture: () => new Promise(resolve => { finish = resolve; started(); }) } });
  const agent = controller.attach(); const abort = new AbortController();
  try {
    const first = text(await controller.call(agent, 'hid_acquire', { owner: 'old' }));
    const capture = controller.call(agent, 'hid_capture', { token: first.token }, { signal: abort.signal }); await ready;
    abort.abort(new Error('Cancelled'));
    await controller.call(agent, 'hid_release', { token: first.token });
    const next = text(await controller.call(agent, 'hid_acquire', { owner: 'new' }));
    finish({ data: 'AA==', width: 1, height: 1 });
    assert.equal((await capture).isError, true);
    assert.equal(controller.status().control.owner, 'new');
    await controller.call(agent, 'hid_release', { token: next.token });
  } finally { await controller.close(); }
});

test('official SDK cancellation reaches the controller and releases its lease', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const controller = await DesktopController.create({ transport: { send: async () => {}, captureAvailable: true,
    capture: ({ signal }) => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) } });
  const agent = controller.attach();
  const server = createMcpServer({ call: (name, args, context) => controller.call(agent, name, args, context) });
  const client = new Client({ name: 'cancel-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide); await client.connect(clientSide);
    const lease = text(await client.callTool({ name: 'hid_acquire', arguments: { owner: 'cancel' } }));
    const abort = new AbortController();
    const capture = client.callTool({ name: 'hid_capture', arguments: { token: lease.token } }, { signal: abort.signal });
    const rejected = assert.rejects(capture);
    await ready; abort.abort(new Error('Cancel capture')); await rejected;
    for (let i = 0; i < 50 && controller.status().control.owner; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(controller.status().control.owner, null);
  } finally { await client.close(); await server.close(); await controller.close(); }
});
