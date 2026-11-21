import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { absoluteReport, relativeReports, keyboardReport } from './reports.mjs';

// Transport.send must resolve only after the driver acknowledges the write.
// A write acknowledgment alone does not prove the target application consumed it.
export class HidSession {
  #transport; #clock; #lease; #tail = Promise.resolve(); #absolute; #faulted = false; #operatorStopped = false;
  #keyboard = { modifiers: 0, keys: [] }; #keyboardEpoch = 0; #press;
  #mouseButtons = 0; #mouseEpoch = 0; #absoluteButtons = 0; #relativeButtons = 0;
  // Keep epoch-style timestamps while measuring leases monotonically, so a
  // Windows clock correction cannot extend a controller's permitted lifetime.
  constructor(transport, { clock = () => performance.timeOrigin + performance.now() } = {}) {
    if (typeof transport?.send !== 'function') throw new TypeError('transport.send is required');
    this.#transport = transport;
    this.#clock = clock;
  }
  #queue(fn) {
    const next = this.#tail.then(fn);
    this.#tail = next.catch(() => {});
    return next;
  }
  status() {
    return {
      owner: this.#lease?.owner ?? null,
      leaseRemainingMs: this.#lease ? Math.max(0, Math.round(this.#lease.expiresAt - this.#clock())) : 0,
      operatorStopped: this.#operatorStopped,
      faulted: this.#faulted,
    };
  }
  acquire(owner, ttlMs = 15000) {
    return this.#queue(async () => {
      if (typeof owner !== 'string' || !owner.trim() || owner.length > 100) throw new TypeError('owner is required (max 100 characters)');
      if (!Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 60000) throw new RangeError('ttlMs must be 100..60000');
      if (this.#operatorStopped) throw new Error('operator stopped this session; restart required');
      if (this.#faulted) throw new Error('transport fault; reopen the session');
      if (this.#lease) {
        if (this.#lease.expiresAt > this.#clock()) throw new Error('desktop already leased');
        await this.#release();
      }
      this.#lease = { token: randomUUID(), owner, expiresAt: this.#clock() + ttlMs };
      return { ...this.#lease };
    });
  }
  async #check(token) {
    if (this.#operatorStopped) throw new Error('operator stopped this session');
    if (this.#faulted) throw new Error('transport fault; reopen the session');
    if (!this.#lease || this.#lease.token !== token) throw new Error('invalid lease');
    if (this.#lease.expiresAt <= this.#clock()) {
      await this.#release();
      throw new Error('lease expired');
    }
  }
  assertLease(token) { return this.#queue(() => this.#check(token)); }
  #clearMouse() { this.#mouseButtons = 0; this.#absoluteButtons = 0; this.#relativeButtons = 0; this.#absolute = undefined; }
  #syncMouse() {
    const epoch = this.#transport.status?.().inputResetEpoch ?? 0;
    if (epoch !== this.#mouseEpoch) { this.#clearMouse(); this.#mouseEpoch = epoch; }
    return epoch;
  }
  #rememberMouse(report, acknowledged) {
    if (![3, 4].includes(report[0]) || (!acknowledged && !report[1])) return;
    // Preserve a possible down before awaiting its ACK; only a confirmed up
    // clears it. Keep the two HID mouse collections separate.
    if (report[0] === 3) { this.#absolute = { x: report.readUInt16LE(2), y: report.readUInt16LE(4) }; this.#absoluteButtons = report[1]; }
    else this.#relativeButtons = report[1];
    this.#mouseButtons = this.#absoluteButtons | this.#relativeButtons;
  }
  async #send(reports, signal) {
    let acknowledgement;
    for (const report of reports) {
      if (this.#operatorStopped || signal?.aborted) {
        await this.#release();
        throw new Error(this.#operatorStopped ? 'operator stopped this session' : 'input cancelled');
      }
      if (this.#lease && this.#lease.expiresAt <= this.#clock()) {
        await this.#release();
        throw new Error('lease expired');
      }
      if (this.#press?.deadline && this.#clock() >= this.#press.deadline) throw new Error('Text batch duration limit reached; input released');
      if ([3, 4].includes(report[0])) this.#syncMouse();
      this.#rememberMouse(report, false);
      try { acknowledgement = await this.#transport.send(report); this.#rememberMouse(report, true); }
      catch (error) {
        if (error.policyRefusal === true) { await this.#transport.releaseInput?.(); this.#keyboard = { modifiers: 0, keys: [] }; this.#clearMouse(); throw error; }
        this.#faulted = true;
        // Attempt every neutral report even if one transport write fails.
        await this.#release().catch(() => {});
        throw error;
      }
    }
    return acknowledgement;
  }
  moveRelative(token, options, { signal } = {}) {
    return this.#queue(async () => { await this.#check(token); await this.#send(relativeReports(options), signal); });
  }
  moveAbsolute(token, options, { signal } = {}) {
    return this.#queue(async () => {
      await this.#check(token);
      const report = absoluteReport(options);
      await this.#send([report], signal);
    });
  }
  keyboard(token, options, { signal } = {}) {
    return this.#queue(async () => { await this.#check(token); await this.#setKeyboard(options, signal); });
  }
  async #setKeyboard(options, signal) {
    const report = keyboardReport(options);
    await this.#send([report], signal);
    this.#keyboard = { modifiers: report[1], keys: [...report.subarray(3)].filter(key => key !== 0) };
    this.#keyboardEpoch = this.#transport.status?.().inputResetEpoch ?? 0;
  }
  #syncKeyboard() {
    const epoch = this.#transport.status?.().inputResetEpoch ?? 0;
    if (epoch !== this.#keyboardEpoch) { this.#keyboardEpoch = epoch; this.#keyboard = { modifiers: 0, keys: [] }; }
  }
  #keyState(key, down) {
    this.#syncKeyboard();
    if (!Number.isInteger(key) || !((key >= 4 && key <= 101) || (key >= 224 && key <= 231))) throw new RangeError('key must be HID usage 4..101 or modifier usage 224..231');
    const state = { modifiers: this.#keyboard.modifiers, keys: [...this.#keyboard.keys] };
    if (key >= 224) { const bit = 1 << (key - 224); state.modifiers = down ? state.modifiers | bit : state.modifiers & ~bit; }
    else state.keys = down ? [...new Set([...state.keys, key])] : state.keys.filter(held => held !== key);
    keyboardReport(state); // Check six-key rollover before sending anything.
    return state;
  }
  keyDown(token, { key }, { signal } = {}) {
    return this.#queue(async () => { await this.#check(token); await this.#setKeyboard(this.#keyState(key, true), signal); });
  }
  keyUp(token, { key }, { signal } = {}) {
    return this.#queue(async () => { await this.#check(token); await this.#setKeyboard(this.#keyState(key, false), signal); });
  }
  cancelPendingInput(token, reason = 'input cancelled') { if (this.#press?.token === token) this.#press.abort.abort(new Error(reason)); }
  #requireTime(durationMs) { if (this.#lease.expiresAt - this.#clock() < durationMs + 50) throw new Error('Not enough lease time for durationMs and input release'); }
  async #wait(token, durationMs, signal, epoch) {
    const until = this.#clock() + durationMs;
    while (this.#clock() < until) {
      await delay(Math.min(25, Math.max(1, until - this.#clock())), undefined, { signal });
      await this.#check(token);
      if (this.#press?.deadline && this.#clock() >= this.#press.deadline) throw new Error('Text batch duration limit reached; input released');
      if ((this.#transport.status?.().inputResetEpoch ?? 0) !== epoch) throw new Error('Desktop changed during input; input released');
    }
    signal?.throwIfAborted();
  }
  async #atomic(token, signal, action, maxMs) {
    const press = { token, abort: new AbortController(), deadline: maxMs ? this.#clock() + maxMs : undefined }; this.#press = press;
    const combined = signal ? AbortSignal.any([signal, press.abort.signal]) : press.abort.signal;
    try { combined.throwIfAborted(); return await action(combined); }
    catch (error) { if (error.policyRefusal !== true && this.#lease?.token === token) await this.#release().catch(() => {}); throw error; }
    finally { if (this.#press === press) this.#press = undefined; }
  }
  keyChord(token, { keys = [], modifiers = 0, durationMs = 100 }, { signal } = {}) {
    return this.#queue(async () => {
      await this.#check(token);
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 10000) throw new RangeError('durationMs must be 1..10000');
      const chord = keyboardReport({ keys, modifiers });
      if (!keys.length && !modifiers) throw new Error('A chord must contain a key or modifier');
      // Synchronize cached keyboard state after native desktop neutralization.
      this.#syncKeyboard();
      const previous = this.#keyboard, epoch = this.#keyboardEpoch;
      const pressed = { keys: [...new Set([...previous.keys, ...keys])], modifiers: previous.modifiers | chord[1] };
      keyboardReport(pressed);
      if (keys.some(key => previous.keys.includes(key)) || (previous.modifiers & modifiers)) throw new Error('Chord keys must not already be held');
      this.#requireTime(durationMs);
      return this.#atomic(token, signal, async combined => {
        const started = performance.now();
        await this.#setKeyboard(pressed, combined); await this.#wait(token, durationMs, combined, epoch); await this.#setKeyboard(previous, combined);
        return { keys, modifiers, durationMs, elapsedMs: Math.round((performance.now() - started) * 100) / 100 };
      });
    });
  }
  click(token, { button = 'left', x, y, durationMs = 80 }, { signal } = {}) {
    return this.#queue(async () => {
      await this.#check(token);
      if (!['left', 'right', 'middle'].includes(button)) throw new RangeError('button must be left, right or middle');
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 1000) throw new RangeError('durationMs must be 1..1000');
      if ((x === undefined) !== (y === undefined)) throw new Error('Provide both x and y, or neither');
      const epoch = this.#syncMouse();
      if (this.#mouseButtons) throw new Error('Release held mouse buttons before clicking');
      const buttons = { left: 1, right: 2, middle: 4 }[button];
      const reports = x === undefined ? [relativeReports({ buttons })[0], relativeReports()[0]] : [absoluteReport({ x, y, buttons }), absoluteReport({ x, y })];
      this.#requireTime(durationMs);
      return this.#atomic(token, signal, async combined => {
        const started = performance.now(), acknowledgement = await this.#send([reports[0]], combined);
        const secureConsent = acknowledgement?.secureDelegated === true;
        if (!secureConsent) await this.#wait(token, durationMs, combined, epoch);
        await this.#send([reports[1]], combined);
        return { button, durationMs, elapsedMs: Math.round((performance.now() - started) * 100) / 100, secureConsent, durationControlledByService: secureConsent };
      });
    });
  }
  #relativeGesture(button) {
    if (!['left', 'right', 'middle'].includes(button)) throw new RangeError('button must be left, right or middle');
    const native = this.#transport.status?.() ?? {};
    if (native.inputPaused || native.desktop === 'Winlogon') {
      const error = new Error('Relative gestures require the ordinary desktop'); error.policyRefusal = true; throw error;
    }
    const epoch = this.#syncMouse();
    if (this.#mouseButtons) throw new Error('Release held mouse buttons before a relative gesture');
    return { epoch, mask: { left: 1, right: 2, middle: 4 }[button] };
  }
  moveClickRelative(token, { dx = 0, dy = 0, button = 'left', pauseMs = 50, durationMs = 80 }, { signal } = {}) {
    return this.#queue(async () => {
      await this.#check(token);
      if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 1000 || !Number.isInteger(durationMs) || durationMs < 1 || durationMs > 1000) throw new RangeError('pauseMs must be 0..1000; durationMs 1..1000');
      const moves = relativeReports({ dx, dy });
      const { epoch, mask } = this.#relativeGesture(button);
      this.#requireTime(pauseMs + durationMs + moves.length * 2);
      return this.#atomic(token, signal, async combined => {
        const started = performance.now();
        await this.#send(moves, combined);
        await this.#wait(token, pauseMs, combined, epoch);
        await this.#send(relativeReports({ buttons: mask }), combined);
        await this.#wait(token, durationMs, combined, epoch);
        await this.#send(relativeReports(), combined);
        return { dx, dy, button, pauseMs, durationMs, elapsedMs: Math.round((performance.now() - started) * 100) / 100, released: true };
      }, 5000);
    });
  }
  dragRelative(token, { dx = 0, dy = 0, button = 'left', durationMs = 500, holdMs = 50 }, { signal } = {}) {
    return this.#queue(async () => {
      await this.#check(token);
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 5000 || !Number.isInteger(holdMs) || holdMs < 0 || holdMs > 1000) throw new RangeError('durationMs must be 1..5000; holdMs 0..1000');
      relativeReports({ dx, dy }); // Full displacement validation before button-down.
      const { epoch, mask } = this.#relativeGesture(button);
      const steps = Math.max(1, Math.ceil(durationMs / 20), Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 127));
      this.#requireTime(durationMs + holdMs + steps * 2);
      return this.#atomic(token, signal, async combined => {
        const started = performance.now();
        await this.#send(relativeReports({ buttons: mask }), combined);
        await this.#wait(token, holdMs, combined, epoch);
        const begin = this.#clock(); let previousX = 0, previousY = 0;
        for (let step = 1; step <= steps; step++) {
          const x = Math.round(dx * step / steps), y = Math.round(dy * step / steps);
          await this.#send(relativeReports({ dx: x - previousX, dy: y - previousY, buttons: mask }), combined);
          previousX = x; previousY = y;
          await this.#wait(token, Math.max(0, begin + durationMs * step / steps - this.#clock()), combined, epoch);
        }
        await this.#send(relativeReports(), combined);
        return { dx, dy, button, durationMs, holdMs, steps, elapsedMs: Math.round((performance.now() - started) * 100) / 100, released: true };
      }, 6500);
    });
  }
  typeText(token, { text, layout = 'active', intervalMs = 10 }, { signal } = {}) {
    return this.#queue(async () => {
      await this.#check(token);
      if (typeof text !== 'string' || !text.length || text.length > 1024) throw new RangeError('text must contain 1..1024 UTF-16 units');
      if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 100) throw new RangeError('intervalMs must be 0..100');
      if (typeof this.#transport.planText !== 'function') throw new Error('Windows text planner is unavailable in this mode');
      this.#syncKeyboard();
      if (this.#keyboard.keys.length || this.#keyboard.modifiers) throw new Error('Release held keyboard keys before typing text');
      return this.#atomic(token, signal, async combined => {
        const started = performance.now(), plan = await this.#transport.planText({ text, layout });
        combined.throwIfAborted();
        if (!Array.isArray(plan?.strokes) || !plan.strokes.length || plan.strokes.length > 2048 || !plan.context) throw new Error('Invalid Windows text plan');
        for (const stroke of plan.strokes) {
          if (!Number.isInteger(stroke.key) || stroke.key < 4 || stroke.key > 101 || ![0, 2, 64, 66].includes(stroke.modifiers)) throw new Error('Unsafe text stroke');
          keyboardReport({ keys: [stroke.key], modifiers: stroke.modifiers });
        }
        const requestedMs = plan.strokes.length * (10 + intervalMs);
        if (requestedMs > 30000) throw new Error('Text batch exceeds 30 seconds; use smaller batches');
        this.#requireTime(requestedMs);
        const epoch = this.#transport.status?.().inputResetEpoch ?? 0;
        let sent = 0;
        this.#transport.setTextContext?.(plan.context);
        try {
          for (const stroke of plan.strokes) {
            await this.#setKeyboard({ keys: [stroke.key], modifiers: stroke.modifiers }, combined);
            await this.#wait(token, 10, combined, epoch);
            await this.#setKeyboard({}, combined); sent++;
            await this.#wait(token, intervalMs, combined, epoch);
          }
          return { characters: plan.characters, strokes: sent, mappingLayout: plan.mappingLayout, intervalMs, elapsedMs: Math.round((performance.now() - started) * 100) / 100 };
        } catch (error) { if (sent) error.message = `Text input interrupted after ${sent} strokes: ${error.message}`; throw error; }
        finally { this.#transport.setTextContext?.(undefined); }
      }, 30000);
    });
  }
  keyPress(token, { key, durationMs = 100 }, { signal } = {}) {
    return this.#queue(async () => {
      await this.#check(token);
      if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 10000) throw new RangeError('durationMs must be 1..10000');
      const pressed = this.#keyState(key, true), previous = this.#keyboard, epoch = this.#keyboardEpoch;
      if (pressed.modifiers === previous.modifiers && pressed.keys.length === previous.keys.length) throw new Error('key is already held; release it before key_press');
      if (this.#lease.expiresAt - this.#clock() < durationMs + 50) throw new Error('Not enough lease time for durationMs and key release');
      const press = { token, abort: new AbortController() }; this.#press = press;
      const combined = signal ? AbortSignal.any([signal, press.abort.signal]) : press.abort.signal;
      const started = performance.now();
      try {
        await this.#setKeyboard(pressed, combined);
        const until = this.#clock() + durationMs;
        do {
          await delay(Math.min(25, Math.max(1, until - this.#clock())), undefined, { signal: combined });
          await this.#check(token);
          if ((this.#transport.status?.().inputResetEpoch ?? 0) !== epoch) throw new Error('Desktop changed during key hold; input released');
        } while (this.#clock() < until);
        await this.#setKeyboard(previous, combined);
        return { key, durationMs, elapsedMs: Math.round((performance.now() - started) * 100) / 100 };
      } catch (error) {
        if (error.policyRefusal !== true && this.#lease?.token === token) await this.#release().catch(() => {});
        throw error;
      } finally { if (this.#press === press) this.#press = undefined; }
    });
  }
  async #release() {
    const absoluteUp = this.#absoluteButtons && this.#absolute ? absoluteReport(this.#absolute) : undefined;
    this.#lease = undefined;
    this.#keyboard = { modifiers: 0, keys: [] };
    this.#mouseButtons = 0;
    if (typeof this.#transport.releaseInput === 'function') {
      try { await this.#transport.releaseInput(); this.#clearMouse(); return; } catch (error) { this.#faulted = true; throw error; }
    }
    const reports = [relativeReports()[0], keyboardReport()];
    if (absoluteUp) reports.push(absoluteUp);
    let failure;
    for (const report of reports) {
      try { await this.#transport.send(report); this.#rememberMouse(report, true); } catch (error) { failure ??= error; }
    }
    if (failure) { this.#faulted = true; throw failure; }
  }
  release(token) {
    const cancellingPress = this.#press?.token === token;
    this.cancelPendingInput(token, 'input released');
    return this.#queue(async () => {
      if (!this.#lease && cancellingPress) return;
      if (!this.#lease || this.#lease.token !== token) throw new Error('invalid lease');
      await this.#release();
    });
  }
  // Local operator takeover must not depend on knowing an agent's token.
  emergencyStop() { this.#operatorStopped = true; this.#press?.abort.abort(new Error('operator stopped this session')); return this.#queue(() => this.#release()); }
  expire() {
    return this.#queue(async () => {
      if (this.#lease && this.#lease.expiresAt <= this.#clock()) await this.#release();
    });
  }
}
