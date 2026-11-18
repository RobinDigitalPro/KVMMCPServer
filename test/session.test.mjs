import test from 'node:test';
import assert from 'node:assert/strict';
import { HidSession } from '../src/session.mjs';

test('operator stop interrupts a split movement before its remaining packets', async () => {
  const sent = []; let session, stop;
  session = new HidSession({ send: async report => { sent.push(report); if (!stop) stop = session.emergencyStop(); } });
  const lease = await session.acquire('interrupt');
  await assert.rejects(session.moveRelative(lease.token, { dx: 1000 }), /operator stopped/);
  await stop;
  assert.equal(sent.filter(report => report[0] === 4 && report.readInt8(2) !== 0).length, 1);
});

function fixture() {
  const sent = []; let now = 0;
  const session = new HidSession({ send: async r => { sent.push(Buffer.from(r)); } }, { clock: () => now });
  return { session, sent, advance: ms => { now += ms; } };
}
test('one controller at a time; wrong tokens cannot inject or release', async () => {
  const { session, sent } = fixture();
  const lease = await session.acquire('agent-1');
  await assert.rejects(session.acquire('agent-2'), /already leased/);
  await assert.rejects(session.moveRelative('wrong', { dx: 1 }), /invalid lease/);
  await assert.rejects(session.release('wrong'), /invalid lease/);
  assert.equal(sent.length, 0);
  await session.moveRelative(lease.token, { dx: 1 });
  assert.equal(sent[0].readInt8(2), 1);
});
test('concurrent calls preserve whole movement order', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('a');
  await Promise.all([session.moveRelative(token, { dx: 255 }), session.keyboard(token, { keys: [4] })]);
  assert.deepEqual(sent.map(r => r[0]), [4, 4, 4, 7]);
});
test('release clears keyboard and both mouse collections without moving absolute position', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('a');
  await session.moveAbsolute(token, { x: 123, y: 456, buttons: 1 });
  await session.keyboard(token, { modifiers: 2, keys: [4] });
  await session.release(token);
  assert.equal(sent.at(-3).toString('hex'), '0400000000');
  assert.equal(sent.at(-2).toString('hex'), '070000000000000000');
  assert.equal(sent.at(-1).toString('hex'), '03007b00c80100');
  await assert.rejects(session.moveRelative(token, { dx: 1 }), /invalid lease/);
});
test('expired lease releases held keys before a second controller starts', async () => {
  const { session, sent, advance } = fixture(); const a = await session.acquire('a', 100);
  await session.keyboard(a.token, { keys: [4] }); advance(101);
  const b = await session.acquire('b');
  assert.notEqual(a.token, b.token);
  assert.equal(sent.at(-1)[3], 0);
});
test('watchdog tick and operator takeover release without an agent token', async () => {
  const { session, sent, advance } = fixture(); await session.acquire('a', 100);
  advance(100); await session.expire(); assert.equal(sent.length, 2);
  await session.acquire('b'); await session.emergencyStop();
  assert.equal(sent.length, 4);
  await assert.rejects(session.acquire('agent-retry'), /operator stopped/);
});
test('transport failure attempts every neutral report and blocks further use', async () => {
  let calls = 0; const sent = [];
  const session = new HidSession({ send: async r => { calls++; sent.push(r); if (calls <= 2) throw new Error('unplugged'); } });
  const { token } = await session.acquire('a');
  await assert.rejects(session.moveRelative(token, { buttons: 1 }), /unplugged/);
  assert.equal(sent.length, 3);
  assert.equal(sent[2][0], 7);
  await assert.rejects(session.acquire('b'), /transport fault/);
});
test('a lost absolute-write acknowledgment still triggers release at the intended location', async () => {
  const sent = [];
  const session = new HidSession({ send: async r => { sent.push(r); if (sent.length === 1) throw new Error('lost ack'); } });
  const { token } = await session.acquire('a');
  await assert.rejects(session.moveAbsolute(token, { x: 123, y: 456, buttons: 1 }), /lost ack/);
  assert.equal(sent.at(-1).toString('hex'), '03007b00c80100');
});
test('lease expiry interrupts a split movement between packets and permits a new controller', async () => {
  let now = 0; const sent = [];
  const session = new HidSession({ send: async r => { sent.push(r); now += 100; } }, { clock: () => now });
  const { token } = await session.acquire('a', 100);
  await assert.rejects(session.moveRelative(token, { dx: 255 }), /lease expired/);
  assert.deepEqual(sent.map(r => r[0]), [4, 4, 7]);
  assert.equal(sent[0].readInt8(2), 85);
  const lease = await session.acquire('b'); assert.equal(lease.owner, 'b');
});
test('status reports the current owner and operator stop without disclosing its token', async () => {
  const { session, advance } = fixture(); const lease = await session.acquire('visible-agent', 1000);
  assert.deepEqual(session.status(), { owner: 'visible-agent', leaseRemainingMs: 1000, operatorStopped: false, faulted: false });
  assert.ok(!JSON.stringify(session.status()).includes(lease.token));
  advance(250); assert.equal(session.status().leaseRemainingMs, 750);
  await session.emergencyStop();
  assert.deepEqual(session.status(), { owner: null, leaseRemainingMs: 0, operatorStopped: true, faulted: false });
});
