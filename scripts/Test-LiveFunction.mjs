// Explicit opt-in hardware test. Never included in the ordinary test suite.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeTransport } from '../src/native-transport.mjs';
import { HidSession } from '../src/session.mjs';
import { pixelToAbsolute } from '../src/reports.mjs';

const [mode, name, dataRoot, observerDirectory] = process.argv.slice(2);
if (mode !== '--live' || !['relative', 'absolute', 'buttons', 'drag', 'wheel', 'keyboard', 'modifiers'].includes(name) || !dataRoot || !path.isAbsolute(dataRoot)) {
  throw new Error('Usage: node scripts/Test-LiveFunction.mjs --live relative|absolute|buttons|drag|wheel|keyboard|modifiers ABSOLUTE_DATA_ROOT');
}
if (observerDirectory && !path.isAbsolute(observerDirectory)) throw new Error('Observer directory must be absolute');
const observerDir = observerDirectory ?? path.join(dataRoot, 'tests', 'live-' + new Date().toISOString().slice(0, 10).replaceAll('-', ''));
const statePath = path.join(observerDir, 'input.jsonl.state.json');
const inputPath = path.join(observerDir, 'input.jsonl');
async function state() {
  let value;
  for (let i = 0; i < 10; i++) {
    try { value = JSON.parse(await fs.readFile(statePath, 'utf8')); break; }
    catch (error) { if (i === 9) throw error; await delay(20); }
  }
  if (!value.foreground || Date.now() - Date.parse(value.observedUtc) > 700) throw new Error('Input Observer is not the freshly observed foreground window');
  return value;
}
async function events() {
  const text = (await fs.readFile(inputPath, 'utf8')).replace(/^\uFEFF/, '');
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
const transport = new NativeTransport(path.join(dataRoot, 'native', 'HidTransport.exe'));
const session = new HidSession(transport);
const result = { function: name, startedUtc: new Date().toISOString(), status: 'running' };
const attempt = result.startedUtc.replaceAll(':', '-');
try {
  await transport.ready();
  const before = await state();
  const { token } = await session.acquire(`host-${name}-acceptance`, 5000);
  result.before = before;
  if (name === 'relative') {
    result.request = { dx: 10, dy: 5, buttons: 0 };
    await session.moveRelative(token, result.request);
  } else if (name === 'absolute') {
    const target = { x: before.clientLeft + Math.floor(before.clientWidth / 2), y: before.clientTop + Math.floor(before.clientHeight / 2) };
    result.targetPixel = target;
    result.request = { ...pixelToAbsolute(target, { width: before.primaryWidth, height: before.primaryHeight }), buttons: 0 };
    await session.moveAbsolute(token, result.request);
  } else if (name === 'buttons' || name === 'drag' || name === 'wheel') {
    if (before.cursorX < before.clientLeft + 20 || before.cursorX > before.clientLeft + before.clientWidth - 20 || before.cursorY < before.clientTop + 90 || before.cursorY > before.clientTop + before.clientHeight - 20) throw new Error('Pointer must be safely inside the observed read-only test surface');
    if (name === 'buttons' || name === 'drag') {
      result.request = { button: 'left', stateSequence: [1, 0], ...(name === 'drag' ? { dx: 10 } : {}) };
      await session.moveRelative(token, { buttons: 1 });
      await delay(30); await state();
      if (name === 'drag') { await session.moveRelative(token, { dx: 10, buttons: 1 }); await delay(30); await state(); }
      await session.moveRelative(token, { buttons: 0 });
    } else {
      result.request = { wheel: 1, buttons: 0 };
      await session.moveRelative(token, result.request);
    }
  } else {
    result.request = { keys: [4], modifiers: name === 'modifiers' ? 2 : 0 };
    await session.keyboard(token, result.request);
    await delay(30); await state();
    await session.keyboard(token, { keys: [], modifiers: 0 });
  }
  await delay(150);
  result.after = await state();
  result.received = (await events()).filter(e => e.sequence > before.events);
  if (name === 'relative') {
    if (!result.received.some(e => e.kind === 'mouse' && !e.absolute && e.x === 10 && e.y === 5)) throw new Error('Requested relative movement not independently received');
  } else if (name === 'absolute') {
    if (!result.received.some(e => e.kind === 'mouse' && e.absolute)) throw new Error('Absolute Raw Input not received');
    if (Math.abs(result.after.cursorX - result.targetPixel.x) > 2 || Math.abs(result.after.cursorY - result.targetPixel.y) > 2) throw new Error('Absolute cursor target missed');
  } else if (name === 'buttons' || name === 'drag') {
    if (!result.received.some(e => e.kind === 'mouse' && (e.buttons & 1)) || !result.received.some(e => e.kind === 'mouse' && (e.buttons & 2))) throw new Error('Left-button down/up not independently received');
    if (name === 'drag') {
      const down = result.received.findIndex(e => e.kind === 'mouse' && (e.buttons & 1));
      const move = result.received.findIndex(e => e.kind === 'mouse' && !e.absolute && e.x === 10 && e.y === 0);
      const up = result.received.findIndex(e => e.kind === 'mouse' && (e.buttons & 2));
      if (!(down < move && move < up)) throw new Error('Drag motion was not bracketed by button down/up');
    }
  } else if (name === 'wheel') {
    if (!result.received.some(e => e.kind === 'mouse' && (e.buttons & 0x400) && e.wheelData === 120)) throw new Error('One wheel detent not independently received');
  } else {
    const keys = result.received.filter(e => e.kind === 'keyboard' && e.scanCode === 0x1e);
    if (!keys.some(e => !(e.flags & 1)) || !keys.some(e => e.flags & 1)) throw new Error('Keyboard HID usage 4 make/break not independently received');
    if (name === 'modifiers') {
      const shifts = result.received.filter(e => e.kind === 'keyboard' && e.scanCode === 42);
      if (!shifts.some(e => !(e.flags & 1)) || !shifts.some(e => e.flags & 1)) throw new Error('Shift modifier make/break not independently received');
    }
  }
  await session.release(token);
  result.status = 'passed';
} catch (error) {
  result.status = 'failed'; result.error = error.message; process.exitCode = 1;
} finally {
  await session.emergencyStop().catch(() => {});
  await transport.close().catch(() => {});
  result.finishedUtc = new Date().toISOString();
  await fs.writeFile(path.join(observerDir, `${name}-${attempt}-result.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
