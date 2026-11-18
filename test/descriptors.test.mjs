import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Decode the descriptor's HID short items independently of the report encoders.
// This catches mismatched packet sizes or accidentally absolute relative axes.
function descriptorItems() {
  const text = readFileSync(new URL('../driver/descriptors.h', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bytes = [...text.matchAll(/0x([\da-f]{2})\b/gi)].map(m => parseInt(m[1], 16));
  let id = 0, size = 0, count = 0, page = 0, usages = [], depth = 0;
  const items = [];
  for (let i = 0; i < bytes.length;) {
    const prefix = bytes[i++], n = [0, 1, 2, 4][prefix & 3];
    assert.ok(i + n <= bytes.length, 'truncated HID item');
    const data = bytes.slice(i, i + n); i += n;
    const value = data.reduce((v, b, j) => v + b * 2 ** (8 * j), 0);
    const type = (prefix >> 2) & 3, tag = prefix >> 4;
    if (type === 1) {
      if (tag === 0) page = value;
      if (tag === 7) size = value;
      if (tag === 8) id = value;
      if (tag === 9) count = value;
    }
    if (type === 2 && tag === 0) usages.push(value);
    if (type === 0) {
      if (tag === 10) depth++;
      if (tag === 12) depth--;
      if (tag === 8 || tag === 9) items.push({ id, kind: tag === 8 ? 'input' : 'output', bits: size * count, flags: value, page, usages: [...usages] });
      usages = [];
      assert.ok(depth >= 0);
    }
  }
  assert.equal(depth, 0, 'unbalanced collections');
  return items;
}
test('HID descriptor input sizes agree with keyboard and both mouse wire formats', () => {
  const items = descriptorItems();
  for (const [id, bytes] of [[3, 7], [4, 5], [7, 9], [64, 65]]) {
    const bits = items.filter(i => i.id === id && i.kind === 'input').reduce((n, i) => n + i.bits, 0);
    assert.equal(bits, (bytes - 1) * 8, `report ${id}`);
  }
  assert.equal(items.filter(i => i.id === 64 && i.kind === 'output').reduce((n, i) => n + i.bits, 0), 64 * 8);
});
test('relative X/Y/wheel are relative; absolute X/Y are absolute and wheel remains relative', () => {
  const items = descriptorItems();
  const relative = items.find(i => i.id === 4 && i.usages.includes(0x30));
  assert.equal(relative.flags & 4, 4);
  assert.deepEqual(relative.usages, [0x30, 0x31, 0x38]);
  const absolute = items.find(i => i.id === 3 && i.usages.includes(0x30));
  assert.equal(absolute.flags & 4, 0); assert.equal(absolute.bits, 32);
  assert.equal(items.find(i => i.id === 3 && i.usages.includes(0x38)).flags & 4, 4);
});
