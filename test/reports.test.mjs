import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeReport, relativeReports, absoluteReport, keyboardReport, controlReport, pixelToAbsolute } from '../src/reports.mjs';

test('relative: negative counts and wheel are encoded as signed bytes', () => {
  assert.equal(relativeReport({ dx: -127, dy: 127, buttons: 5, wheel: -1 }).toString('hex'), '0405817fff');
});
test('absolute: endpoint coordinates use little-endian 15-bit values', () => {
  assert.equal(absoluteReport({ x: 32767, y: 0, buttons: 1, wheel: 1 }).toString('hex'), '0301ff7f000001');
});
test('keyboard: modifiers, reserved byte, six key slots', () => {
  assert.equal(keyboardReport({ modifiers: 2, keys: [4, 0x28] }).toString('hex'), '070200042800000000');
  assert.equal(keyboardReport().toString('hex'), '070000000000000000');
});
test('control envelope matches vmulti 65-byte output format, with zero padding', () => {
  const packet = controlReport(relativeReport({ dx: 1 }));
  assert.equal(packet.length, 65);
  assert.equal(packet.subarray(0, 7).toString('hex'), '40050400010000');
  assert.ok(packet.subarray(7).every(b => b === 0));
});
test('invalid and malformed values are rejected before reaching native code', () => {
  for (const dx of [-128, 128, NaN, Infinity, 1.5, '1']) assert.throws(() => relativeReport({ dx }));
  assert.throws(() => absoluteReport({ x: 32768, y: 0 }));
  assert.throws(() => relativeReport({ buttons: 8 }));
  assert.throws(() => keyboardReport({ keys: [4, 4] }));
  assert.throws(() => keyboardReport({ keys: [4, 5, 6, 7, 8, 9, 10] }));
  assert.throws(() => controlReport(Buffer.from([4, 0])));
  assert.throws(() => controlReport(Buffer.from([4, 0, 128, 0, 0])));
  assert.throws(() => controlReport(Buffer.from([7, 0, 1, 0, 0, 0, 0, 0, 0])));
});
test('large relative moves preserve every count on all axes and wheel', () => {
  // A deterministic grid covers signs, exact limits and uneven divisions.
  for (const dx of [-32767, -255, -128, -1, 0, 1, 128, 255, 32767]) {
    for (const dy of [-256, -1, 0, 1, 256]) {
      const rs = relativeReports({ dx, dy, wheel: 129, buttons: 3 });
      const sum = offset => rs.reduce((n, r) => n + r.readInt8(offset), 0);
      assert.equal(sum(2), dx); assert.equal(sum(3), dy); assert.equal(sum(4), 129);
      assert.ok(rs.every(r => r[1] === 3));
    }
  }
});
test('pixel mapping includes viewport edges, negative origins and single-pixel dimensions', () => {
  const vp = { left: -1920, top: 20, width: 1920, height: 1080 };
  assert.deepEqual(pixelToAbsolute({ x: -1920, y: 20 }, vp), { x: 0, y: 0 });
  assert.deepEqual(pixelToAbsolute({ x: -1, y: 1099 }, vp), { x: 32767, y: 32767 });
  assert.deepEqual(pixelToAbsolute({ x: 0, y: 0 }, { width: 1, height: 1 }), { x: 0, y: 0 });
  assert.throws(() => pixelToAbsolute({ x: 1920, y: 0 }, { width: 1920, height: 1080 }));
});
