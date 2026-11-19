import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { startBroker } from '../src/broker.mjs';
import { LocalClient, LocalEndpoint } from '../src/local-client.mjs';
import { readJson } from '../src/state.mjs';

const text = result => JSON.parse(result.content[0].text);
async function root() {
  const base = process.env.HID_TEST_ROOT ?? path.join(os.tmpdir(), 'OpenDesktopHID-tests');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, 'broker-'));
}
test('two local clients share one controller; leases are connection-bound and disconnect releases', async () => {
  const dataRoot = await root(), broker = await startBroker({ dataRoot, simulated: true });
  const a = await LocalClient.connect(dataRoot, 'agent-a'), b = await LocalClient.connect(dataRoot, 'agent-b');
  try {
    assert.equal(a.identity.instance, b.identity.instance);
    assert.equal(broker.address.address, '127.0.0.1');
    const lease = text(await a.call('hid_acquire', { owner: 'task-a', jobId: 'job-a' }));
    assert.equal((await b.call('hid_acquire', { owner: 'task-b' })).isError, true);
    assert.equal((await b.call('hid_mouse_relative', { token: lease.token, dx: 1 })).isError, true);
    a.close();
    for (let i = 0; i < 50 && broker.controller.status().control.owner; i++) await delay(10);
    assert.equal(broker.controller.status().control.owner, null);
    const next = text(await b.call('hid_acquire', { owner: 'task-b' }));
    assert.ok(next.token);
    await b.call('hid_release', { token: next.token });
    const logs = await fs.readFile(path.join(dataRoot, 'events.jsonl'), 'utf8');
    assert.ok(!logs.includes(lease.token));
    const status = await readJson(path.join(dataRoot, 'live-status.json'));
    assert.equal(status.control.owner, null);
  } finally { a.close(); b.close(); await broker.close(); }
});

test('operator stop survives controller restart and requires explicit local reset', async () => {
  const dataRoot = await root();
  let broker = await startBroker({ dataRoot, simulated: true });
  let client = await LocalClient.connect(dataRoot);
  await client.call('hid_emergency_stop', {}); client.close(); await broker.close();
  broker = await startBroker({ dataRoot, simulated: true }); client = await LocalClient.connect(dataRoot);
  try {
    assert.equal(text(await client.call('hid_status')).control.operatorStopped, true);
    assert.equal((await client.call('hid_acquire', { owner: 'after-restart' })).isError, true);
    assert.equal((await client.request('resume').catch(error => ({ error: error.message }))).error, 'Unknown local controller method');
  } finally { client.close(); await broker.close(); }
  await broker.store.resume();
  broker = await startBroker({ dataRoot, simulated: true }); client = await LocalClient.connect(dataRoot);
  try { assert.equal(text(await client.call('hid_status')).control.operatorStopped, false); }
  finally { client.close(); await broker.close(); }
});

test('operator stop file is honored independently of an MCP connection', async () => {
  const dataRoot = await root(), broker = await startBroker({ dataRoot, simulated: true });
  try {
    await broker.store.persistStop('operator_cli');
    for (let i = 0; i < 60 && !broker.controller.status().control.operatorStopped; i++) await delay(10);
    assert.equal(broker.controller.status().control.operatorStopped, true);
  } finally { await broker.close(); }
});

test('MCP endpoint reconnects after restart but never retries input or clears stop', async () => {
  const dataRoot = await root();
  let broker = await startBroker({ dataRoot, simulated: true });
  const endpoint = await new LocalEndpoint({ dataRoot, simulated: true, autostart: false }).connect();
  try {
    const lease = text(await endpoint.call('hid_acquire', { owner: 'old-connection' }));
    await endpoint.call('hid_emergency_stop');
    await broker.close(); await delay(20);
    broker = await startBroker({ dataRoot, simulated: true });
    await assert.rejects(endpoint.call('hid_mouse_relative', { token: lease.token, dx: 10 }), /not retried/);
    assert.equal(text(await endpoint.call('hid_status')).control.operatorStopped, true);
    assert.equal((await endpoint.call('hid_acquire', { owner: 'new' })).isError, true);
  } finally { endpoint.close(); await broker.close(); }
});

test('local controller refuses a connection without its private credential', async () => {
  const dataRoot = await root(), broker = await startBroker({ dataRoot, simulated: true });
  try {
    const socket = net.createConnection({ host: '127.0.0.1', port: broker.address.port });
    const closed = new Promise(resolve => { socket.once('close', resolve); socket.on('error', () => {}); });
    socket.write(JSON.stringify({ id: 1, method: 'hello', params: { nonce: 'a'.repeat(64), proof: 'é'.repeat(64) } }) + '\n');
    await closed;
    assert.equal(broker.controller.status().clients, 0);
    const valid = await LocalClient.connect(dataRoot); valid.close();
  } finally { await broker.close(); }
});

test('simultaneous SDK startup creates one shared controller and shuts it down cleanly', async () => {
  const dataRoot = await root(), clients = [];
  try {
    await Promise.all(['startup-a', 'startup-b'].map(async name => {
      const client = new Client({ name, version: '1.0.0' }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url)), '--simulate', '--data-root', dataRoot], stderr: 'pipe' }));
    }));
    const statuses = await Promise.all(clients.map(async client => text(await client.callTool({ name: 'hid_status', arguments: {} }))));
    assert.equal(statuses[0].pid, statuses[1].pid);
    assert.equal(statuses[0].simulated, true);
  } finally {
    for (const client of clients) await client.close();
    const operator = await LocalClient.connect(dataRoot); await operator.request('shutdown'); operator.close();
    for (let i = 0; i < 60 && (await readJson(path.join(dataRoot, 'controller', 'endpoint.local.json'))); i++) await delay(25);
    assert.equal(await readJson(path.join(dataRoot, 'controller', 'endpoint.local.json')), undefined);
  }
});

test('two official SDK stdio clients share one broker and preserve stop across MCP reconnect', async () => {
  const dataRoot = await root(), broker = await startBroker({ dataRoot, simulated: true });
  const clients = [];
  try {
    for (const agent of ['sdk-a', 'sdk-b']) {
      const client = new Client({ name: agent, version: '1.0.0' }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url)), '--connect', '--data-root', dataRoot, '--agent', agent], stderr: 'pipe' }));
    }
    const [a, b] = clients;
    assert.equal((await a.listTools()).tools.length, 14);
    const lease = text(await a.callTool({ name: 'hid_acquire', arguments: { owner: 'sdk-a' } }));
    assert.equal((await b.callTool({ name: 'hid_mouse_relative', arguments: { token: lease.token, dx: 1 } })).isError, true);
    await b.callTool({ name: 'hid_emergency_stop', arguments: {} });
    assert.equal(text(await a.callTool({ name: 'hid_status', arguments: {} })).control.operatorStopped, true);
  } finally { for (const client of clients) await client.close(); await broker.close(); }
});
