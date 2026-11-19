import test from 'node:test';
import assert from 'node:assert/strict';
import { HidSession } from '../src/session.mjs';
import { parseTool } from '../src/tools.mjs';
const tick = () => new Promise(resolve => setTimeout(resolve, 1));
const keyboard = report => ({ modifiers: report[1], keys: [...report.subarray(3)].filter(Boolean) });
const fixture = (extra = {}) => {
  const sent = [], contexts = [];
  const transport = { send: async report => { sent.push(Buffer.from(report)); }, setTextContext: value => contexts.push(value), ...extra };
  return { session: new HidSession(transport), sent, contexts };
};

test('failed controller publication closes its transport instead of leaving an orphan writer', async () => {
  const { DesktopController } = await import('../src/controller.mjs');
  let closed = false;
  await assert.rejects(DesktopController.create({
    transport: { send: async () => {}, close: async () => { closed = true; } },
    store: { stopState: async () => ({ stopped: false }), publish: async () => { throw new Error('locked event log'); }, flush: async () => {} },
  }), /locked event log/);
  assert.equal(closed, true);
});

test('one chord emits all modifiers/keys together and restores prior keyboard state', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('chord');
  await session.keyDown(token, { key: 225 });
  await session.keyChord(token, { modifiers: 5, keys: [4], durationMs: 10 });
  assert.deepEqual(sent.map(keyboard), [
    { modifiers: 2, keys: [] }, { modifiers: 7, keys: [4] }, { modifiers: 2, keys: [] },
  ]);
  await session.keyChord(token, { modifiers: 5, durationMs: 1 });
  await session.release(token);
});

test('empty, duplicate and already held chord members cannot send input', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('bad-chord');
  await session.keyDown(token, { key: 224 }); const count = sent.length;
  for (const options of [{}, { keys: [4, 4] }, { modifiers: 1 }, { durationMs: 0, modifiers: 4 }]) await assert.rejects(session.keyChord(token, options));
  assert.equal(sent.length, count); await session.release(token);
});

test('an atomic click presses and releases the same mouse collection without moving twice', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('click');
  await session.click(token, { button: 'right', durationMs: 1 });
  assert.deepEqual(sent.map(report => report.toString('hex')), ['0402000000', '0400000000']);
  sent.length = 0;
  await session.click(token, { x: 123, y: 456, durationMs: 1 });
  assert.deepEqual(sent.map(report => report.toString('hex')), ['03017b00c80100', '03007b00c80100']);
  await session.release(token);
});

test('click validation preserves held mouse state and rejects incomplete coordinates', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('held-mouse');
  await session.moveRelative(token, { buttons: 1 }); const count = sent.length;
  await assert.rejects(session.click(token, {}), /held mouse/);
  assert.equal(sent.length, count);
  await session.moveRelative(token, { buttons: 0 });
  await assert.rejects(session.click(token, { x: 10 }), /both/);
  await session.release(token);
});

test('UAC clicks reuse the existing one-shot delegation without waiting or replaying down', async () => {
  const sent = [];
  const session = new HidSession({ send: async report => { sent.push(Buffer.from(report)); return { secureDelegated: true }; } });
  const { token } = await session.acquire('consent');
  const result = await session.click(token, { x: 100, y: 200, durationMs: 1000 });
  assert.equal(result.durationControlledByService, true);
  assert.equal(sent.length, 2); assert.equal(sent[0][1], 1); assert.equal(sent[1][1], 0);
  await session.release(token);
});

test('cancelling a mouse click sends neutral input and releases the lease', async () => {
  const { session, sent } = fixture(); const { token } = await session.acquire('cancel-click');
  const abort = new AbortController(); const click = session.click(token, { durationMs: 1000 }, { signal: abort.signal });
  const rejected = assert.rejects(click); while (!sent.length) await tick(); abort.abort(); await rejected;
  assert.equal(session.status().owner, null); assert.equal(sent.at(-2)[1], 0);
});

const textPlan = { strokes: [{ key: 20, modifiers: 2 }, { key: 31, modifiers: 64 }], context: { window: 'abc', foregroundLayout: '8130813', capsLock: false }, mappingLayout: '8130813', characters: 2 };
test('typing uses the preflight physical layout plan, releases each key and clears context', async () => {
  const { session, sent, contexts } = fixture({ planText: async request => { assert.equal(request.layout, 'Belgian (Period)'); return textPlan; } });
  const { token } = await session.acquire('typing');
  const result = await session.typeText(token, { text: 'A@', layout: 'Belgian (Period)', intervalMs: 0 });
  assert.equal(result.characters, 2);
  assert.deepEqual(sent.map(keyboard), [{ keys: [20], modifiers: 2 }, { keys: [], modifiers: 0 }, { keys: [31], modifiers: 64 }, { keys: [], modifiers: 0 }]);
  assert.deepEqual(contexts, [textPlan.context, undefined]); await session.release(token);
});

test('unsupported text is rejected during preflight with zero keyboard strokes', async () => {
  const { session, sent } = fixture({ planText: async () => { const error = new Error('unsupported character'); error.policyRefusal = true; throw error; } });
  const { token } = await session.acquire('unsupported');
  await assert.rejects(session.typeText(token, { text: 'unsupported' }), /unsupported/);
  assert.equal(sent.length, 0); assert.equal(session.status().owner, 'unsupported'); await session.release(token);
});

test('held modifiers, oversized batches and invalid strokes cannot reach text injection', async () => {
  let plan = textPlan;
  const { session, sent } = fixture({ planText: async () => plan }); const { token } = await session.acquire('text-limits');
  await session.keyDown(token, { key: 224 }); const count = sent.length;
  await assert.rejects(session.typeText(token, { text: 'abc' }), /held keyboard/); assert.equal(sent.length, count);
  await session.keyUp(token, { key: 224 });
  assert.throws(() => parseTool('hid_type_text', { token, text: 'x'.repeat(1025) }));
  plan = { ...textPlan, strokes: [{ key: 4, modifiers: 1 }] };
  const next = sent.length; await assert.rejects(session.typeText(token, { text: 'a' }), /Unsafe/);
  assert.equal(sent.slice(next).some(report => report[0] === 7 && report[3] !== 0), false);
});

test('cancelling text prevents later characters and clears its target context', async () => {
  const { session, sent, contexts } = fixture({ planText: async () => ({ ...textPlan, strokes: Array(50).fill(textPlan.strokes[0]) }) });
  const { token } = await session.acquire('cancel-text'); const abort = new AbortController();
  const typing = session.typeText(token, { text: 'A'.repeat(50) }, { signal: abort.signal }); const rejected = assert.rejects(typing);
  while (!sent.length) await tick(); abort.abort(); await rejected;
  assert.equal(session.status().owner, null); assert.equal(contexts.at(-1), undefined);
  assert.equal(sent.filter(report => report[0] === 7 && report[3] === 20).length, 1);
});

test('actual text execution has a local time bound even when the lease remains valid', async () => {
  let now = 0, context; const sent = [];
  const session = new HidSession({ planText: async () => textPlan, setTextContext: value => { context = value; }, send: async report => { sent.push(Buffer.from(report)); if (report[0] === 7 && report[3]) now = 30001; } }, { clock: () => now });
  const { token } = await session.acquire('slow-text', 60000);
  await assert.rejects(session.typeText(token, { text: 'A@', intervalMs: 0 }), /duration limit/);
  assert.equal(session.status().owner, null); assert.equal(context, undefined);
  assert.equal(sent.filter(report => report[0] === 7 && report[3]).length, 1);
});
