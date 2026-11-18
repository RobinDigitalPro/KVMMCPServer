// Wire format: vmulti/inc/vmulticommon.h. See THIRD_PARTY_NOTICES.md.
export const REPORT = Object.freeze({ absolute: 3, relative: 4, keyboard: 7, control: 0x40 });
export const CONTROL_SIZE = 65;

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in ${min}..${max}`);
  return value;
}

export function relativeReport({ dx = 0, dy = 0, buttons = 0, wheel = 0 } = {}) {
  const r = Buffer.alloc(5);
  r[0] = REPORT.relative;
  r[1] = integer(buttons, 'buttons', 0, 7);
  r.writeInt8(integer(dx, 'dx', -127, 127), 2);
  r.writeInt8(integer(dy, 'dy', -127, 127), 3);
  r.writeInt8(integer(wheel, 'wheel', -127, 127), 4);
  return r;
}

export function absoluteReport({ x, y, buttons = 0, wheel = 0 }) {
  const r = Buffer.alloc(7);
  r[0] = REPORT.absolute;
  r[1] = integer(buttons, 'buttons', 0, 7);
  r.writeUInt16LE(integer(x, 'x', 0, 32767), 2);
  r.writeUInt16LE(integer(y, 'y', 0, 32767), 4);
  r.writeInt8(integer(wheel, 'wheel', -127, 127), 6);
  return r;
}

export function keyboardReport({ modifiers = 0, keys = [] } = {}) {
  if (!Array.isArray(keys) || keys.length > 6 || new Set(keys).size !== keys.length)
    throw new RangeError('keys must contain at most six distinct HID usage codes');
  const r = Buffer.alloc(9);
  r[0] = REPORT.keyboard;
  r[1] = integer(modifiers, 'modifiers', 0, 255);
  keys.forEach((key, i) => { r[3 + i] = integer(key, 'key', 4, 0x65); });
  return r;
}

export function validateReport(report) {
  if (!Buffer.isBuffer(report)) throw new TypeError('report must be a Buffer');
  if (report[0] === REPORT.relative && report.length === 5) {
    relativeReport({ buttons: report[1], dx: report.readInt8(2), dy: report.readInt8(3), wheel: report.readInt8(4) });
  } else if (report[0] === REPORT.absolute && report.length === 7) {
    absoluteReport({ buttons: report[1], x: report.readUInt16LE(2), y: report.readUInt16LE(4), wheel: report.readInt8(6) });
  } else if (report[0] === REPORT.keyboard && report.length === 9 && report[2] === 0) {
    // Empty slots are zero; don't accept malformed raw packets at the native boundary.
    keyboardReport({ modifiers: report[1], keys: [...report.subarray(3)].filter(k => k !== 0) });
  } else throw new RangeError('unsupported report ID, length, or reserved byte');
  return report;
}

export function controlReport(report) {
  validateReport(report);
  const packet = Buffer.alloc(CONTROL_SIZE);
  packet[0] = REPORT.control;
  packet[1] = report.length;
  report.copy(packet, 2);
  return packet;
}

// HID relative values are device counts, not a promise of screen pixels.
// Split large movements without losing counts; keep the path approximately linear.
export function relativeReports({ dx = 0, dy = 0, buttons = 0, wheel = 0 } = {}) {
  integer(dx, 'dx', -32767, 32767);
  integer(dy, 'dy', -32767, 32767);
  integer(wheel, 'wheel', -32767, 32767);
  integer(buttons, 'buttons', 0, 7);
  const count = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(wheel)) / 127));
  let last = [0, 0, 0];
  return Array.from({ length: count }, (_, i) => {
    const next = [dx, dy, wheel].map(v => Math.round(v * (i + 1) / count));
    const r = relativeReport({ dx: next[0] - last[0], dy: next[1] - last[1], wheel: next[2] - last[2], buttons });
    last = next;
    return r;
  });
}

// Coordinates must refer to one explicitly selected physical-pixel viewport.
// Whether a driver maps that viewport to the primary display must be tested live.
export function pixelToAbsolute({ x, y }, { left = 0, top = 0, width, height }) {
  integer(left, 'left', -100000, 100000);
  integer(top, 'top', -100000, 100000);
  integer(width, 'width', 1, 100000);
  integer(height, 'height', 1, 100000);
  integer(x, 'x', left, left + width - 1);
  integer(y, 'y', top, top + height - 1);
  return {
    x: width === 1 ? 0 : Math.round((x - left) * 32767 / (width - 1)),
    y: height === 1 ? 0 : Math.round((y - top) * 32767 / (height - 1)),
  };
}

export function releaseReports() {
  // Clear both mouse collections. Relative neutral leaves the cursor in place;
  // the absolute collection is released at its last position by the session.
  return [relativeReport(), keyboardReport()];
}
