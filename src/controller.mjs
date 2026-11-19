import { randomUUID } from 'node:crypto';
import { HidSession } from './session.mjs';
import { NativeTransport } from './native-transport.mjs';
import { parseTool } from './tools.mjs';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export class DesktopController {
  #session; #transport; #store; #simulated; #stopped; #owner; #clients = new Map(); #captures = new Map(); #lastAction; #timer; #heartbeat; #closing = false; #stopPromise; #reports = 0;
  #recording; #recordingCleanup;
  constructor({ transport, simulated, store, stopped }) {
    this.#transport = transport; this.#simulated = simulated; this.#store = store; this.#stopped = stopped;
    if (transport) this.#session = new HidSession(transport);
  }
  static async create({ simulated = false, executable, dataRoot, store, transport } = {}) {
    const stopped = await store?.stopState() ?? { stopped: false };
    const controller = new DesktopController({ simulated, store, stopped });
    try {
    if (!stopped.stopped) {
      controller.#transport = transport ?? (simulated ? { send: async () => { controller.#reports++; } } : new NativeTransport(executable, { dataRoot, onFault: error => { void controller.stop(error.message).catch(() => {}); } }));
      controller.#session = new HidSession(controller.#transport);
      await controller.#transport.ready?.();
      controller.#recordingCleanup = controller.#transport.onRecording?.(metadata => {
        if (controller.#recording?.recordingId === metadata.recordingId) {
          controller.#recording = { ...controller.#recording, ...metadata };
          void controller.publish({ event: 'recording_state', recordingId: metadata.recordingId, state: metadata.state }).catch(() => {});
        }
      });
      const requested = await store?.stopState();
      if (requested?.stopped) await controller.stop(requested.reason ?? 'operator_file_request');
    }
    controller.#timer = setInterval(() => {
      void (async () => {
        if (!controller.#stopped.stopped && store) {
          const requested = await store.stopState();
          if (requested.stopped) await controller.stop(requested.reason ?? 'operator_file_request');
        }
        await controller.#session?.expire(); await controller.publish();
      })().catch(error => { void controller.stop(error.message).catch(() => {}); });
    }, 250); controller.#timer.unref();
    if (!simulated && typeof controller.#transport?.ping === 'function') controller.#heartbeat = setInterval(() => {
      controller.#transport.ping().catch(error => { void controller.stop(error.message).catch(() => {}); });
    }, 1000);
    await controller.publish({ event: 'controller_started' });
    return controller;
    } catch (error) { await controller.close().catch(() => {}); throw error; }
  }
  attach(label = 'local-agent') { const id = randomUUID(); this.#clients.set(id, String(label).slice(0, 100)); return id; }
  async detach(client) {
    if (this.#owner?.client === client) this.#session?.cancelPendingInput(this.#owner.token, 'Agent disconnected');
    if (this.#owner?.client === client) this.#transport?.cancelPendingUacInput?.();
    for (const capture of this.#captures.values()) if (capture.client === client) capture.abort.abort(new Error('Agent disconnected'));
    this.#clients.delete(client);
    if (this.#owner?.client === client) {
      const token = this.#owner.token; this.#owner = undefined;
      await this.#session.release(token).catch(() => {});
    }
    // Recording finalization must never prevent neutral input on disconnect.
    if (this.#recording?.clientId === client) await this.#stopRecording('agent_disconnected').catch(() => {});
    await this.publish({ event: 'agent_disconnected' });
  }
  status() {
    const native = this.#transport?.status?.();
    const control = this.#session?.status() ?? { owner: null, leaseRemainingMs: 0, operatorStopped: this.#stopped.stopped, faulted: false };
    return { version: '0.7.1', updatedUtc: new Date().toISOString(), running: !this.#closing, pid: process.pid, simulated: this.#simulated, liveHelperConnected: !this.#simulated && Boolean(this.#transport) && (native?.connected ?? true), native,
      control: { ...control, operatorStopped: this.#stopped.stopped || (!this.#closing && control.operatorStopped), jobId: control.owner ? this.#owner?.jobId ?? null : null, clientId: control.owner ? this.#owner?.client ?? null : null },
      operatorStop: this.#stopped, clients: this.#clients.size, activeCaptures: this.#captures.size, lastAction: this.#lastAction ?? null,
      screenCapture: !this.#simulated && Boolean(this.#transport?.captureAvailable), screenRecording: !this.#simulated && Boolean(this.#transport?.recordingAvailable), recording: this.#recording ?? null, ...(this.#simulated ? { simulatedReports: this.#reports } : {}), applicationConsumptionVerified: false };
  }
  publish(event) { return this.#store?.publish(this.status(), event) ?? Promise.resolve(); }
  async stop(reason = 'operator_request') {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = { stopped: true, reason: String(reason).slice(0, 300), stoppedUtc: new Date().toISOString() };
    clearInterval(this.#heartbeat);
    this.#transport?.cancelPendingUacInput?.();
    for (const capture of this.#captures.values()) capture.abort.abort(new Error('Operator stopped desktop control'));
    // emergencyStop marks the session synchronously, interrupting split input.
    const release = this.#session?.emergencyStop() ?? Promise.resolve();
    this.#stopPromise = (async () => {
      const outcomes = await Promise.allSettled([this.#store?.persistStop(this.#stopped.reason), release, this.#stopRecording(this.#stopped.reason)]);
      this.#owner = undefined;
      await this.publish({ event: 'operator_stop', reason: this.#stopped.reason, released: outcomes[1].status === 'fulfilled' });
      if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
      if (outcomes[1].status === 'rejected') throw outcomes[1].reason;
      if (outcomes[2].status === 'rejected') throw outcomes[2].reason;
    })();
    return this.#stopPromise;
  }
  async call(client, name, rawArgs = {}, { signal } = {}) {
    let action, cancelUac;
    try {
      if (!this.#clients.has(client)) throw new Error('Unknown local connection');
      const args = parseTool(name, rawArgs);
      if (name === 'hid_status') return result(this.status());
      if (name === 'hid_emergency_stop') { await this.stop(); return result({ ok: true, operatorStopped: true, persisted: Boolean(this.#store), simulated: this.#simulated }); }
      if (name === 'screen_record_status' || name === 'screen_record_stop') {
        if (this.#recording?.clientId !== client || this.#recording.recordingId !== args.recordingId) throw new Error('Recording belongs to another connection or is unknown');
        if (name === 'screen_record_stop') await this.#stopRecording('requested');
        return result(this.#recording);
      }
      if (this.#closing || this.#stopped.stopped) throw new Error('Operator stopped this controller; explicit local operator resume required');
      signal?.throwIfAborted();
      if (name === 'hid_acquire') {
        const lease = await this.#session.acquire(args.owner, args.ttlMs);
        this.#owner = { client, token: lease.token, jobId: args.jobId ?? null };
        if (signal?.aborted || !this.#clients.has(client)) {
          await this.#session.release(lease.token); this.#owner = undefined;
          throw new Error('Lease acquisition cancelled or connection closed');
        }
        await this.publish({ event: 'lease_acquired', owner: args.owner, jobId: args.jobId ?? null, clientId: client });
        return result({ ...lease, jobId: args.jobId ?? null, simulated: this.#simulated, inputSent: false });
      }
      if (this.#owner?.client !== client || this.#owner.token !== args.token) throw new Error('Lease belongs to another connection or is invalid');
      // Release must reach the timed input without queuing behind its hold.
      if (name !== 'hid_release') await this.#session.assertLease(args.token);
      this.#transport?.setInputDeadline?.(Date.now() + this.#session.status().leaseRemainingMs);
      cancelUac = () => this.#transport?.cancelPendingUacInput?.();
      signal?.addEventListener('abort', cancelUac, { once: true });
      action = { id: randomUUID(), tool: name, clientId: client, owner: this.#session.status().owner, jobId: this.#owner.jobId, startedUtc: new Date().toISOString(), state: 'running' };
      this.#lastAction = action;
      await this.publish({ event: 'action_started', ...action });
      let response;
      if (name === 'hid_capture') {
        if (this.#simulated || !this.#transport.captureAvailable) throw new Error('Screen capture unavailable in this mode');
        if (this.#captures.size) throw new Error('A capture is already in progress');
        const abort = new AbortController();
        const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
        this.#captures.set(action.id, { client, abort });
        try {
          const { token, ...options } = args;
          const { data, ...metadata } = await this.#transport.capture({ ...options, signal: combined });
          combined.throwIfAborted();
          await this.#session.assertLease(args.token);
          response = { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType: metadata.mimeType ?? 'image/png', data }] };
          action.frameId = metadata.frameId;
        } finally { this.#captures.delete(action.id); }
      } else if (name === 'screen_record_start') {
        if (this.#simulated || !this.#transport.recordingAvailable) throw new Error('Screen recording unavailable; install ScreenCapture.exe');
        if (['starting', 'recording', 'stopping'].includes(this.#recording?.state)) throw new Error('A recording is already active');
        const { token, ...options } = args;
        options.systemAudio ??= true;
        const recordingId = randomUUID();
        this.#recording = { recordingId, clientId: client, owner: action.owner, jobId: action.jobId, state: 'starting' };
        try {
          const metadata = await this.#transport.startRecording({ ...options, recordingId });
          this.#recording = { ...this.#recording, ...metadata };
          if (signal?.aborted || this.#stopped.stopped || this.#closing || !this.#clients.has(client)) {
            await this.#stopRecording('start_cancelled'); throw new Error('Recording start cancelled');
          }
          // Input lease expiry does not shorten the separately authorized recording.
          response = result(this.#recording);
        } catch (error) {
          if (this.#recording?.recordingId === recordingId && this.#recording.state === 'starting') this.#recording = { ...this.#recording, state: 'failed', error: error.message };
          throw error;
        }
      } else if (name === 'hid_release') {
        this.#transport?.cancelPendingUacInput?.();
        await this.#session.release(args.token); this.#owner = undefined;
      } else {
        const { token, ...options } = args;
        const method = { hid_mouse_relative: 'moveRelative', hid_mouse_absolute: 'moveAbsolute', hid_keyboard: 'keyboard', hid_key_down: 'keyDown', hid_key_up: 'keyUp', hid_key_press: 'keyPress', hid_key_chord: 'keyChord', hid_type_text: 'typeText', hid_click: 'click' }[name];
        const details = await this.#session[method](token, options, { signal });
        if (details) response = result({ ok: true, simulated: this.#simulated, inputSent: !this.#simulated, ...details });
      }
      action.state = 'completed'; action.finishedUtc = new Date().toISOString();
      await this.publish({ event: 'action_finished', ...action });
      return response ?? result({ ok: true, simulated: this.#simulated, inputSent: !this.#simulated });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (action) { action.state = 'failed'; action.finishedUtc = new Date().toISOString(); action.error = message.slice(0, 300); await this.publish({ event: 'action_finished', ...action }).catch(() => {}); }
      // Cancellation of input may have a partial effect: release this client's state.
      if (signal?.aborted && this.#owner?.client === client && this.#owner.token === rawArgs.token) {
        const token = this.#owner.token; this.#owner = undefined;
        await this.#session.release(token).catch(() => {});
      }
      return { isError: true, content: [{ type: 'text', text: message }] };
    } finally { if (cancelUac) signal?.removeEventListener('abort', cancelUac); }
  }
  async #stopRecording(reason) {
    if (!['starting', 'recording', 'stopping'].includes(this.#recording?.state)) return;
    const recordingId = this.#recording.recordingId;
    this.#recording = { ...this.#recording, state: 'stopping', stopReason: reason };
    try {
      const metadata = await this.#transport?.stopRecording();
      if (this.#recording?.recordingId === recordingId) this.#recording = { ...this.#recording, ...(metadata ?? {}), state: metadata?.state === 'recording' ? 'stopping' : metadata?.state ?? 'interrupted', stopReason: reason };
    } catch (error) {
      if (this.#recording?.recordingId === recordingId) this.#recording = { ...this.#recording, state: 'failed', reason: error.message, finalized: false };
      throw error;
    }
  }
  async close() {
    if (this.#closing) return;
    this.#transport?.cancelPendingUacInput?.();
    this.#closing = true; clearInterval(this.#timer); clearInterval(this.#heartbeat);
    for (const capture of this.#captures.values()) capture.abort.abort(new Error('Controller shutting down'));
    await this.#session?.emergencyStop().catch(() => {});
    await this.#stopRecording('controller_shutdown').catch(() => {});
    await this.#transport?.close?.().catch(() => {});
    this.#recordingCleanup?.();
    await this.publish({ event: 'controller_stopped' }); await this.#store?.flush();
  }
}
