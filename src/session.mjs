import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { absoluteReport, relativeReports, keyboardReport } from './reports.mjs';

// Transport.send must resolve only after the driver acknowledges the write.
// A write acknowledgment alone does not prove the target application consumed it.
export class HidSession {
  #transport; #clock; #lease; #tail = Promise.resolve(); #absolute; #faulted = false; #operatorStopped = false;
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
        if (error.policyRefusal === true) { await this.#transport.releaseInput?.(); throw error; }
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
    return this.#queue(async () => { await this.#check(token); await this.#send([keyboardReport(options)], signal); });
  }
  async #release() {
    this.#lease = undefined;
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
    return this.#queue(async () => {
      if (!this.#lease || this.#lease.token !== token) throw new Error('invalid lease');
      await this.#release();
    });
  }
  // Local operator takeover must not depend on knowing an agent's token.
  emergencyStop() { this.#operatorStopped = true; return this.#queue(() => this.#release()); }
  expire() {
    return this.#queue(async () => {
      if (this.#lease && this.#lease.expiresAt <= this.#clock()) await this.#release();
    });
  }
}
