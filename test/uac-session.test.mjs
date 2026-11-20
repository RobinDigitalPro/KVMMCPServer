import test from 'node:test';
import assert from 'node:assert/strict';
import { HidSession } from '../src/session.mjs';
import { DesktopController } from '../src/controller.mjs';
import { completedConsentRelease, secureInputDeadline } from '../src/native-transport.mjs';

test('expired UAC screenshots are refused before native input, independently of lease validity', () => {
  const now = 100000;
  assert.equal(secureInputDeadline(now + 60000, now - 1000, now), now + 29000);
  for (const [lease, frame] of [[now + 60000, now - 30000], [now, now], [undefined, now], [now + 60000, NaN]]) {
    assert.throws(() => secureInputDeadline(lease, frame, now), error => error.policyRefusal === true && /expired/.test(error.message));
  }
});

test('a completed consent click consumes only its matching absolute button release', () => {
  const click = Buffer.from([3, 1, 100, 0, 200, 0, 0]);
  const up = Buffer.from([3, 0, 100, 0, 200, 0, 0]);
  assert.equal(completedConsentRelease(click, up), true);
  for (const report of [[3, 0, 101, 0, 200, 0, 0], [3, 0, 100, 0, 200, 0, 1], [3, 2, 100, 0, 200, 0, 0], [4, 0, 0, 0, 0], [7, 0, 0, 0, 0, 0, 0, 0, 0]]) {
    assert.equal(completedConsentRelease(click, Buffer.from(report)), false);
  }
  assert.equal(completedConsentRelease(undefined, up), false);
});

test('a refused UAC control sends no fallback input and preserves the lease', async () => {
  let sends = 0, releases = 0;
  const transport = {
    send: async () => { sends++; const error = new Error('Click is outside a recognized UAC button'); error.policyRefusal = true; throw error; },
    releaseInput: async () => { releases++; },
  };
  const session = new HidSession(transport);
  const lease = await session.acquire('uac-policy', 60000);
  await assert.rejects(session.moveAbsolute(lease.token, { x: 100, y: 100, buttons: 1 }), /outside a recognized UAC button/);
  assert.equal(session.status().faulted, false);
  assert.equal(session.status().owner, 'uac-policy');
  assert.equal(sends, 1);
  assert.equal(releases, 1);
  await session.release(lease.token);
  assert.equal(releases, 2);
  assert.equal(sends, 1);
});

test('an uncertain privileged write still faults the session', async () => {
  const session = new HidSession({ send: async () => { throw new Error('Lost acknowledgement'); }, releaseInput: async () => {} });
  const lease = await session.acquire('uac-write');
  await assert.rejects(session.moveAbsolute(lease.token, { x: 100, y: 100, buttons: 1 }), /Lost acknowledgement/);
  assert.equal(session.status().faulted, true);
  assert.equal(session.status().owner, null);
});

test('disconnect cancels pending UAC input before waiting for neutralization', async () => {
  let entered, finish; const started = new Promise(resolve => { entered = resolve; });
  let cancelled = 0;
  const transport = {
    send: async () => { entered(); await new Promise(resolve => { finish = resolve; }); },
    releaseInput: async () => {},
    cancelPendingUacInput: () => { cancelled++; finish?.(); },
    setInputDeadline: value => assert.ok(value > Date.now()),
  };
  const controller = await DesktopController.create({ transport });
  try {
    const client = controller.attach('uac-owner');
    const acquired = await controller.call(client, 'hid_acquire', { owner: 'uac-owner', ttlMs: 60000 });
    const { token } = JSON.parse(acquired.content[0].text);
    const input = controller.call(client, 'hid_mouse_absolute', { token, x: 100, y: 100 });
    await started;
    await controller.detach(client);
    await input;
    assert.equal(cancelled, 1);
    assert.equal(controller.status().control.owner, null);
  } finally { await controller.close(); }
});
