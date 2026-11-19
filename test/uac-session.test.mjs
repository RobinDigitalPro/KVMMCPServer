import test from 'node:test';
import assert from 'node:assert/strict';
import { HidSession } from '../src/session.mjs';
import { DesktopController } from '../src/controller.mjs';

test('a refused UAC application sends no fallback input and preserves the lease', async () => {
  let sends = 0, releases = 0;
  const transport = {
    send: async () => { sends++; const error = new Error('Application is not approved'); error.policyRefusal = true; throw error; },
    releaseInput: async () => { releases++; },
  };
  const session = new HidSession(transport);
  const lease = await session.acquire('uac-policy', 60000);
  await assert.rejects(session.moveAbsolute(lease.token, { x: 100, y: 100, buttons: 1 }), /not approved/);
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
