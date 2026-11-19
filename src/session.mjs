import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { absoluteReport, relativeReports, keyboardReport } from './reports.mjs';

// Transport.send must resolve only after the driver acknowledges the write.
// A write acknowledgment alone does not prove the target application consumed it.
export class HidSession {
  #transport; #clock; #lease; #tail = Promise.resolve(); #absolute; #faulted = false; #operatorStopped = false;
  #keyboard = { modifiers: 0, keys: [] }; #keyboardEpoch = 0; #press;
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
  async #send(reports, signal) {
    for (const report of reports) {
      if (this.#operatorStopped || signal?.aborted) {
        await this.#release();
        throw new Error(this.#operatorStopped ? 'operator stopped this session' : 'input cancelled');
      }
      if (this.#lease && this.#lease.expiresAt <= this.#clock()) {
        await this.#release();
        throw new Error('lease expired');
      }
      try { await this.#transport.send(report); }
      catch (error) {
        if (error.policyRefusal === true) { await this.#transport.releaseInput?.(); this.#keyboard = { modifiers: 0, keys: [] }; throw error; }
        this.#faulted = true;
        // Attempt every neutral report even if one transport write fails.
        await this.#release().catch(() => {});
        throw error;
      }
    }
  }
  moveRelative(token, options, { signal } = {}) {
    return this.#queue(async () => { await this.#check(token); await this.#send(relativeReports(options), signal); });
  }
  moveAbsolute(token, options, { signal } = {}) {
    return this.#queue(async () => {
      await this.#check(token);
      const report = absoluteReport(options);
      // Remember the intended location even if a successful write loses its ACK.
      this.#absolute = { x: options.x, y: options.y };
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
  #keyState(key, down) {
    const epoch = this.#transport.status?.().inputResetEpoch ?? 0;
    if (epoch !== this.#keyboardEpoch) { this.#keyboardEpoch = epoch; this.#keyboard = { modifiers: 0, keys: [] }; }
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
    this.#lease = undefined;
    this.#keyboard = { modifiers: 0, keys: [] };
    if (typeof this.#transport.releaseInput === 'function') {
      try { await this.#transport.releaseInput(); return; } catch (error) { this.#faulted = true; throw error; }
    }
    const reports = [relativeReports()[0], keyboardReport()];
    if (this.#absolute) reports.push(absoluteReport(this.#absolute));
    let failure;
    for (const report of reports) {
      try { await this.#transport.send(report); } catch (error) { failure ??= error; }
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
