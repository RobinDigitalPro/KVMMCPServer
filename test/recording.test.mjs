import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopController } from '../src/controller.mjs';
import { parseTool } from '../src/tools.mjs';

const text = value => JSON.parse(value.content[0].text);
async function setup({ start } = {}) {
  let current, listener, stopCount = 0;
  const transport = { send: async () => {}, recordingAvailable: true, captureAvailable: true,
    onRecording: value => { listener = value; },
    startRecording: async options => { await start?.(); current = { ...options, state: 'recording', finalized: false }; return current; },
    stopRecording: async () => { stopCount++; if (!current) return null; current = { ...current, state: 'stopped', finalized: true }; listener?.(current); return current; },
    capture: async options => ({ data: 'AA==', width: 640, height: 360, sourceWidth: 1920, sourceHeight: 1080, mimeType: options.format === 'jpeg' ? 'image/jpeg' : 'image/png' }),
  };
  const controller = await DesktopController.create({ transport });
  const client = controller.attach('record-owner'), other = controller.attach('other');
  const lease = text(await controller.call(client, 'hid_acquire', { owner: 'demo', ttlMs: 100 }));
  return { controller, client, other, lease, stopped: () => stopCount, finish: () => listener({ ...current, state: 'completed', finalized: true }) };
}
test('recording bounds reject over ten minutes, invalid rate, dimensions and bitrate', () => {
  for (const bad of [{ maxSeconds: 601 }, { maxSeconds: 0 }, { maxSeconds: 1.5 }, { fps: 31 }, { maxWidth: 100 }, { bitrate: 0 }]) assert.throws(() => parseTool('screen_record_start', { token: 't', ...bad }));
  assert.equal(parseTool('screen_record_start', { token: 't', maxSeconds: 600 }).maxSeconds, 600);
});
test('recording start needs a valid connection-bound input lease', async () => {
  const s = await setup();
  try {
    assert.equal((await s.controller.call(s.client, 'screen_record_start', { token: 'wrong' })).isError, true);
    assert.equal((await s.controller.call(s.other, 'screen_record_start', { token: s.lease.token })).isError, true);
    assert.equal(s.controller.status().recording, null);
  } finally { await s.controller.close(); }
});
test('recording survives input release, status/stop remain connection-bound and stop is idempotent', async () => {
  const s = await setup();
  try {
    const recording = text(await s.controller.call(s.client, 'screen_record_start', { token: s.lease.token, maxSeconds: 600 }));
    await s.controller.call(s.client, 'hid_release', { token: s.lease.token });
    assert.equal(s.controller.status().control.owner, null);
    assert.equal(text(await s.controller.call(s.client, 'screen_record_status', { recordingId: recording.recordingId })).state, 'recording');
    assert.equal((await s.controller.call(s.other, 'screen_record_stop', { recordingId: recording.recordingId })).isError, true);
    assert.equal((await s.controller.call(s.other, 'screen_record_status', { recordingId: recording.recordingId })).isError, true);
    assert.equal(text(await s.controller.call(s.client, 'screen_record_stop', { recordingId: recording.recordingId })).state, 'stopped');
    await s.controller.call(s.client, 'screen_record_stop', { recordingId: recording.recordingId }); assert.equal(s.stopped(), 1);
  } finally { await s.controller.close(); }
});
test('only one recording can be active and natural completion updates status', async () => {
  const s = await setup();
  try {
    const first = text(await s.controller.call(s.client, 'screen_record_start', { token: s.lease.token }));
    assert.equal((await s.controller.call(s.client, 'screen_record_start', { token: s.lease.token })).isError, true);
    s.finish(); assert.equal(text(await s.controller.call(s.client, 'screen_record_status', { recordingId: first.recordingId })).state, 'completed');
    assert.notEqual(text(await s.controller.call(s.client, 'screen_record_start', { token: s.lease.token })).recordingId, first.recordingId);
  } finally { await s.controller.close(); }
});
test('owner disconnect and emergency stop terminate recording after input release', async () => {
  for (const action of ['disconnect', 'emergency']) {
    const s = await setup();
    try {
      await s.controller.call(s.client, 'screen_record_start', { token: s.lease.token });
      await s.controller.call(s.client, 'hid_release', { token: s.lease.token });
      if (action === 'disconnect') await s.controller.detach(s.client); else await s.controller.stop('test');
      assert.equal(s.controller.status().recording.state, 'stopped'); assert.equal(s.stopped(), 1);
    } finally { await s.controller.close(); }
  }
});
test('cancel or disconnect while recording is starting cannot leave an orphan recording', async () => {
  for (const action of ['cancel', 'disconnect', 'stop']) {
    let begin, finish;
    const entered = new Promise(resolve => { begin = resolve; });
    const wait = new Promise(resolve => { finish = resolve; });
    const s = await setup({ start: async () => { begin(); await wait; } }), abort = new AbortController();
    try {
      const pending = s.controller.call(s.client, 'screen_record_start', { token: s.lease.token }, { signal: abort.signal });
      await entered;
      let cleanup;
      if (action === 'cancel') abort.abort(); else if (action === 'disconnect') cleanup = s.controller.detach(s.client); else cleanup = s.controller.stop('test');
      finish(); assert.equal((await pending).isError, true); await cleanup;
      assert.notEqual(s.controller.status().recording.state, 'recording'); assert.ok(s.stopped() >= 1);
    } finally { await s.controller.close(); }
  }
});
test('JPEG snapshot MIME type and options pass through the real controller', async () => {
  const s = await setup();
  try {
    const image = await s.controller.call(s.client, 'hid_capture', { token: s.lease.token, format: 'jpeg', maxWidth: 640 });
    assert.equal(image.content[1].mimeType, 'image/jpeg'); assert.equal(text(image).sourceWidth, 1920);
  } finally { await s.controller.close(); }
});
test('failed MP4 finalization cannot prevent input release on disconnect', async () => {
  const controller = await DesktopController.create({ transport: { send: async () => {}, recordingAvailable: true,
    startRecording: async options => ({ ...options, state: 'recording' }), stopRecording: async () => { throw new Error('disk_failure'); } } });
  const client = controller.attach();
  try {
    const lease = text(await controller.call(client, 'hid_acquire', { owner: 'held-input' }));
    await controller.call(client, 'hid_keyboard', { token: lease.token, modifiers: 2, keys: [] });
    await controller.call(client, 'screen_record_start', { token: lease.token });
    await controller.detach(client);
    assert.equal(controller.status().control.owner, null); assert.equal(controller.status().recording.state, 'failed');
  } finally { await controller.close(); }
});
