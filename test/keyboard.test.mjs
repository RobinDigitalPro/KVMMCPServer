import test from 'node:test';
import assert from 'node:assert/strict';
import { HidSession } from '../src/session.mjs';
import { DesktopController } from '../src/controller.mjs';
import { parseTool } from '../src/tools.mjs';

const keys = report => ({ modifiers: report[1], keys: [...report.subarray(3)].filter(Boolean) });
const tick = () => new Promise(resolve => setTimeout(resolve, 1));
function fixture(options) {
  const sent = [];
  const session = new HidSession({ send: async report => { sent.push(Buffer.from(report)); } }, options);
  return { session, sent };
}

test('incremental key state composes with full keyboard reports and independent modifiers', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('keys');
  await session.keyboard(token, { keys: [4], modifiers: 1 });
  await session.keyDown(token, { key: 225 });
  await session.keyDown(token, { key: 5 });
  await session.keyUp(token, { key: 4 });
  assert.deepEqual(keys(sent.at(-1)), { keys: [5], modifiers: 3 });
  await session.keyUp(token, { key: 224 });
  assert.deepEqual(keys(sent.at(-1)), { keys: [5], modifiers: 2 });
  await session.release(token);
  const next = await session.acquire('next');
  await session.keyDown(next.token, { key: 6 });
  assert.deepEqual(keys(sent.at(-1)), { keys: [6], modifiers: 0 });
});

test('invalid keys, rollover, held-key presses and insufficient lease send no extra input', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('limits', 1000);
  await session.keyboard(token, { keys: [4, 5, 6, 7, 8, 9] });
  const count = sent.length;
  await assert.rejects(session.keyDown(token, { key: 10 }), /six/);
  await assert.rejects(session.keyDown(token, { key: 223 }), /key/);
  await assert.rejects(session.keyPress(token, { key: 4 }), /already held/);
  await assert.rejects(session.keyPress(token, { key: 225, durationMs: 1000 }), /lease time/);
  for (const durationMs of [0, -1, 1.5, 10001]) await assert.rejects(session.keyPress(token, { key: 225, durationMs }), /durationMs/);
  assert.equal(sent.length, count);
  assert.throws(() => parseTool('hid_key_press', { token, key: 225, durationMs: 10001 }));
});

test('timed key press preserves an existing chord and restores it before later input', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('timing');
  await session.keyDown(token, { key: 224 });
  const press = session.keyPress(token, { key: 4, durationMs: 35 });
  const later = session.keyDown(token, { key: 5 });
  const timing = await press; await later;
  assert.ok(timing.elapsedMs >= 30);
  assert.deepEqual(sent.map(keys), [
    { modifiers: 1, keys: [] }, { modifiers: 1, keys: [4] },
    { modifiers: 1, keys: [] }, { modifiers: 1, keys: [5] },
  ]);
  await session.release(token);
});

test('cancelling a timed press releases the lease and all held keys promptly', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('cancel');
  const abort = new AbortController();
  const press = session.keyPress(token, { key: 4, durationMs: 10000 }, { signal: abort.signal });
  const rejected = assert.rejects(press);
  while (!sent.length) await tick();
  abort.abort(); await rejected;
  assert.equal(session.status().owner, null);
  assert.deepEqual(keys(sent.at(-1)), { modifiers: 0, keys: [] });
});

test('lease expiry interrupts a held key even while the session queue is occupied', async () => {
  let now = 0; const { session, sent } = fixture({ clock: () => now });
  const { token } = await session.acquire('expiry', 500);
  const press = session.keyPress(token, { key: 225, durationMs: 100 });
  const rejected = assert.rejects(press, /lease expired/);
  while (!sent.length) await tick(); now = 501;
  await rejected;
  assert.equal(session.status().owner, null);
  assert.deepEqual(keys(sent.at(-1)), { modifiers: 0, keys: [] });
});

test('operator stop interrupts a timed hold without waiting for its duration', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('stop');
  const press = session.keyPress(token, { key: 225, durationMs: 10000 });
  const rejected = assert.rejects(press);
  while (!sent.length) await tick(); await session.emergencyStop(); await rejected;
  assert.equal(session.status().operatorStopped, true);
  assert.deepEqual(keys(sent.at(-1)), { modifiers: 0, keys: [] });
});

test('a disconnected owner interrupts its timed press and leaves no held keyboard state', async () => {
  const sent = []; const controller = await DesktopController.create({ transport: { send: async report => { sent.push(Buffer.from(report)); } } });
  const client = controller.attach('disconnect');
  try {
    const acquired = await controller.call(client, 'hid_acquire', { owner: 'disconnect' });
    const { token } = JSON.parse(acquired.content[0].text);
    const press = controller.call(client, 'hid_key_press', { token, key: 225, durationMs: 10000 });
    while (!sent.length) await tick(); await controller.detach(client);
    assert.equal((await press).isError, true);
    assert.equal(controller.status().control.owner, null);
    assert.deepEqual(keys(sent.at(-1)), { modifiers: 0, keys: [] });
  } finally { await controller.close(); }
});

test('explicit lease release can interrupt a pending timed MCP call without waiting for its queue', async () => {
  const sent = []; const controller = await DesktopController.create({ transport: { send: async report => { sent.push(Buffer.from(report)); } } });
  const client = controller.attach('release');
  try {
    const { token } = JSON.parse((await controller.call(client, 'hid_acquire', { owner: 'release' })).content[0].text);
    const press = controller.call(client, 'hid_key_press', { token, key: 225, durationMs: 10000 });
    while (!sent.length) await tick();
    assert.notEqual((await controller.call(client, 'hid_release', { token })).isError, true);
    assert.equal((await press).isError, true);
    assert.equal(controller.status().control.owner, null);
    assert.deepEqual(keys(sent.at(-1)), { modifiers: 0, keys: [] });
  } finally { await controller.close(); }
});

test('a desktop transition cancels a timed hold and discards cached modifiers', async () => {
  let epoch = 0; const sent = [];
  const session = new HidSession({ status: () => ({ inputResetEpoch: epoch }), send: async report => { sent.push(Buffer.from(report)); } });
  let { token } = await session.acquire('transition');
  await session.keyDown(token, { key: 224 });
  const press = session.keyPress(token, { key: 4, durationMs: 1000 });
  const rejected = assert.rejects(press, /Desktop changed/);
  while (sent.length < 2) await tick(); epoch++;
  await rejected;
  ({ token } = await session.acquire('after-transition'));
  await session.keyDown(token, { key: 5 });
  assert.deepEqual(keys(sent.at(-1)), { modifiers: 0, keys: [5] });
  await session.release(token);
});
