import { randomUUID } from 'node:crypto';
import { HidSession } from './session.mjs';
import { NativeTransport } from './native-transport.mjs';
import { parseTool } from './tools.mjs';
import { MediaBuffer } from './media-buffer.mjs';
import {BitmapTracking} from './bitmap-tracking.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {recoverableFault,technicalStop,budget,abortable} from './recovery.mjs';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export class DesktopController {
  #session; #transport; #store; #simulated; #stopped; #owner; #clients = new Map(); #captures = new Map(); #lastAction; #timer; #heartbeat; #closing = false; #stopPromise; #reports = 0;
  #recording; #recordingCleanup;
  #buffer; #mediaTail = Promise.resolve(); #mediaPending = 0;#tracking;
  #factory;#generation=0;#restartTask;#restartAbort;#recoveryState={attempts:[]};#needsFreshCapture=false;
  constructor({ transport, simulated, store, stopped }) {
    this.#transport = transport; this.#simulated = simulated; this.#store = store; this.#stopped = stopped;
    if (transport) this.#session = new HidSession(transport);
  }
  static async create({ simulated = false, executable, dataRoot, store, transport,transportFactory } = {}) {
    const stopped = await store?.stopState() ?? { stopped: false };
    const controller = new DesktopController({ simulated, store, stopped });
    controller.#factory=transportFactory??(onFault=>simulated?{send:async()=>{controller.#reports++;}}:new NativeTransport(executable,{dataRoot,onFault}));
    try {
    controller.#recoveryState=await store?.recoveryState?.()??{attempts:[]};
    if (!stopped.stopped) {
      await controller.#openTransport(transport);
      const requested = await store?.stopState();
      if (requested?.stopped) await controller.stop(requested.reason ?? 'operator_file_request');
    }
    controller.#timer = setInterval(() => {
      const generation=controller.#generation;
      void (async () => {
        if (!controller.#stopped.stopped && store) {
          const requested = await store.stopState();
          if (requested.stopped) await controller.stop(requested.reason ?? 'operator_file_request');
        }
        await controller.#session?.expire(); await controller.publish();
      })().catch(error => { if(generation===controller.#generation)void controller.stop(error.message).catch(() => {}); });
    }, 250); controller.#timer.unref();
    await controller.publish({ event: 'controller_started' });
    return controller;
    } catch (error) { await controller.close().catch(() => {}); throw error; }
  }
  async #openTransport(initial){
    const generation=++this.#generation;
    const fault=error=>{if(generation!==this.#generation||this.#closing)return;this.#restartAbort?.abort(error);void this.stop(error.message,{technical:recoverableFault(error.message)}).catch(()=>{});};
    this.#transport=initial??this.#factory(fault);const transport=this.#transport;this.#session=new HidSession(transport);
    await transport.ready?.();
    if(generation!==this.#generation||this.#closing){await transport.close?.();throw Error('Stale helper startup was cancelled');}
    this.#buffer=new MediaBuffer(this.#transport,metadata=>{void this.publish({event:'buffer_state',bufferId:metadata.bufferId,state:metadata.state,reason:metadata.reason}).catch(()=>{});});
    this.#tracking=new BitmapTracking(this.#transport);
    this.#recordingCleanup=this.#transport.onRecording?.(metadata=>{if(this.#recording?.recordingId===metadata.recordingId){this.#recording={...this.#recording,...metadata};void this.publish({event:'recording_state',recordingId:metadata.recordingId,state:metadata.state}).catch(()=>{});}});
    if(!this.#simulated&&typeof this.#transport.ping==='function'){
      const transport=this.#transport;this.#heartbeat=setInterval(()=>{void transport.ping().catch(fault);},1000);
    }
  }
  async #tryRestart(client,signal){
    if(this.#closing)throw Error('Controller is shutting down');
    if(!this.#stopped.stopped)return {restarted:false,alreadyHealthy:true,status:this.status()};
    this.#restartAbort=new AbortController();
    const combined=AbortSignal.any([this.#restartAbort.signal,AbortSignal.timeout(20000),...(signal?[signal]:[])]);
    let expected,attempted=false;
    try{
      // A caller may request recovery before the fault's durable stop is flushed.
      await abortable(this.#stopPromise?.catch(()=>{}),combined);
      expected=await this.#store?.stopState()??this.#stopped;
      if(!technicalStop(expected)||!technicalStop(this.#stopped))throw Error('LOCAL_OPERATOR_REQUIRED: manual or non-recoverable stop cannot be cleared through MCP');
      this.#recoveryState=await this.#store?.recoveryState?.()??this.#recoveryState;
      const limit=budget(this.#recoveryState);if(limit.retryAfterMs)throw Error('RECOVERY_COOLDOWN: retry after '+limit.retryAfterMs+' ms');
      combined.throwIfAborted();attempted=true;
      this.#recoveryState={attempts:[...limit.attempts,Date.now()],lastAttemptUtc:new Date().toISOString(),lastResult:'starting'};
      await this.#store?.saveRecovery?.(this.#recoveryState);
      await this.publish({event:'helper_restart_started',clientId:client,reason:expected.reason});
      await abortable(this.#stopPromise?.catch(()=>{}),combined);
      clearInterval(this.#heartbeat);++this.#generation;
      await abortable(this.#transport?.close?.(),combined);
      this.#recordingCleanup?.();this.#buffer?.close();this.#tracking?.close();
      this.#owner=undefined;this.#transport=undefined;this.#session=undefined;this.#buffer=undefined;this.#tracking=undefined;
      combined.throwIfAborted();
      await abortable(this.#openTransport(),combined);
      const native=this.#transport.status?.();
      if(!this.#simulated&&(!native?.connected||native.inputPaused||native.currentSession!==native.consoleSession))throw Error('Physical console is unavailable; local operator required');
      for(let i=0;i<3;i++){await abortable(this.#transport.ping?.(),combined);await delay(200,undefined,{signal:combined});}
      if(!this.#simulated&&typeof this.#transport.releaseInput!=='function')throw Error('Neutral input cannot be confirmed');
      await abortable(this.#transport.releaseInput?.(),combined);
      combined.throwIfAborted();if(!this.#clients.has(client))throw Error('Recovery requester disconnected');
      await this.#store?.clearTechnicalStop(expected);
      combined.throwIfAborted();
      this.#stopped={stopped:false,recoveredUtc:new Date().toISOString(),previousReason:expected.reason};this.#stopPromise=undefined;this.#needsFreshCapture=true;
      this.#recoveryState={...this.#recoveryState,lastResult:'recovered'};await this.#store?.saveRecovery?.(this.#recoveryState);
      await this.publish({event:'helper_restart_succeeded',clientId:client});
      return {restarted:true,neutralizationConfirmed:true,replayedInput:false,requiresNewLease:true,requiresFreshCapture:true,status:this.status()};
    }catch(error){
      if(attempted){
        clearInterval(this.#heartbeat);++this.#generation;
        await this.#transport?.close?.().catch(()=>{});this.#recordingCleanup?.();this.#buffer?.close();this.#tracking?.close();
        this.#owner=undefined;
        const current=await this.#store?.stopState();
        if(current?.stopped&&!technicalStop(current))this.#stopped=current;
        else{this.#stopped=expected;await this.#store?.persistStop(expected.reason,{kind:'technical'});}
        this.#recoveryState={...this.#recoveryState,lastResult:'failed',lastError:error.message.slice(0,300)};await this.#store?.saveRecovery?.(this.#recoveryState);
        await this.publish({event:'helper_restart_failed',error:error.message.slice(0,300)});
      }
      throw error;
    }finally{this.#restartAbort=undefined;}
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
    await this.#media(async () => {
      await Promise.allSettled([this.#recording?.clientId === client ? this.#stopRecording('agent_disconnected') : undefined, this.#buffer?.detach(client),this.#tracking?.detach(client)]);
    }, true).catch(() => {});
    await this.publish({ event: 'agent_disconnected' });
  }
  status() {
    const native = this.#transport?.status?.();
    const control = this.#session?.status() ?? { owner: null, leaseRemainingMs: 0, operatorStopped: this.#stopped.stopped, faulted: false };
    return { version: '0.11.0', updatedUtc: new Date().toISOString(), running: !this.#closing, pid: process.pid, simulated: this.#simulated, liveHelperConnected: !this.#simulated && Boolean(this.#transport) && (native?.connected ?? true), native,
      control: { ...control, operatorStopped: this.#stopped.stopped || (!this.#closing && control.operatorStopped), jobId: control.owner ? this.#owner?.jobId ?? null : null, clientId: control.owner ? this.#owner?.client ?? null : null },
      operatorStop: this.#stopped, recovery:{inProgress:Boolean(this.#restartTask),eligible:technicalStop(this.#stopped),retryAfterMs:budget(this.#recoveryState).retryAfterMs,lastResult:this.#recoveryState.lastResult??null,requiresFreshCapture:this.#needsFreshCapture}, clients: this.#clients.size, activeCaptures: this.#captures.size, lastAction: this.#lastAction ?? null,
      screenCapture: !this.#simulated && Boolean(this.#transport?.captureAvailable), screenRecording: !this.#simulated && Boolean(this.#transport?.recordingAvailable), recording: this.#recording ?? null, mediaBuffer: this.#buffer?.status() ?? { state: 'idle' },bitmapTracking:this.#tracking?.status()??{state:'idle'}, ...(this.#simulated ? { simulatedReports: this.#reports } : {}), applicationConsumptionVerified: false };
  }
  publish(event) { return this.#store?.publish(this.status(), event) ?? Promise.resolve(); }
  async stop(reason = 'operator_request',{technical=false}={}) {
    if(!technical)this.#restartAbort?.abort(Error('Operator stopped recovery'));
    if (this.#stopPromise) {
      if(!technical&&this.#stopped.kind!=='operator'){
        this.#stopped={stopped:true,reason:String(reason).slice(0,300),kind:'operator',stoppedUtc:new Date().toISOString()};
        await this.#store?.persistStop(this.#stopped.reason,{kind:'operator'});
        await this.#stopPromise.catch(()=>{});await this.publish({event:'operator_stop',reason:this.#stopped.reason,released:false});return;
      }
      return this.#stopPromise;
    }
    this.#stopped = { stopped: true, reason: String(reason).slice(0, 300),kind:technical?'technical':'operator', stoppedUtc: new Date().toISOString() };
    clearInterval(this.#heartbeat);
    this.#transport?.cancelPendingUacInput?.();
    for (const capture of this.#captures.values()) capture.abort.abort(new Error('Operator stopped desktop control'));
    // emergencyStop marks the session synchronously, interrupting split input.
    const release = this.#session?.emergencyStop() ?? Promise.resolve();
    this.#stopPromise = (async () => {
      const outcomes = await Promise.allSettled([this.#store?.persistStop(this.#stopped.reason,{kind:this.#stopped.kind}), release, this.#media(async () => { await Promise.allSettled([this.#stopRecording(this.#stopped.reason), this.#buffer?.stop('operator_stop'),this.#tracking?.stop('operator_stop')]); }, true)]);
      this.#owner = undefined;
      await this.publish({ event: 'operator_stop', reason: this.#stopped.reason, released: outcomes[1].status === 'fulfilled' });
      if (outcomes[0].status === 'rejected') throw outcomes[0].reason;
      if (outcomes[1].status === 'rejected') throw outcomes[1].reason;
      if (outcomes[2].status === 'rejected') throw outcomes[2].reason;
    })();
    return this.#stopPromise;
  }
  #media(action, cleanup = false) {
    // Cleanup has reserved admission; a full ordinary queue cannot strand media.
    if (this.#mediaPending >= 4 && !cleanup) return Promise.reject(new Error('Media transition queue is full'));
    this.#mediaPending++;
    const pending = this.#mediaTail.then(action);
    this.#mediaTail = pending.catch(() => {}).finally(() => { this.#mediaPending--; });return pending;
  }
  async call(client, name, rawArgs = {}, context = {}) {
    const response = await this.#call(client, name, rawArgs, context);
    const events = this.#buffer?.events(client);
    if (events?.length) response.content.push({ type: 'text', text: JSON.stringify({ mediaBufferEvents: events }) });
    return response;
  }
  async #call(client, name, rawArgs = {}, { signal } = {}) {
    let action, cancelUac;
    try {
      if (!this.#clients.has(client)) throw new Error('Unknown local connection');
      const args = parseTool(name, rawArgs);
      if (name === 'hid_status') return result(this.status());
      if (name === 'hid_emergency_stop') { await this.stop(); return result({ ok: true, operatorStopped: true, persisted: Boolean(this.#store), simulated: this.#simulated }); }
      if(name==='hid_try_restart'){
        if(this.#restartTask)throw Error('RECOVERY_IN_PROGRESS: another restart is pending');
        this.#restartTask=this.#tryRestart(client,signal);
        let reply;try{reply=await this.#restartTask;}finally{this.#restartTask=undefined;}
        if(reply.status)reply.status=this.status();return result(reply);
      }
      if(this.#restartTask)throw Error('RECOVERY_IN_PROGRESS: wait for recovery and acquire a fresh lease');
      if(name==='locate_tracking'||name==='stop_tracking')return result(await this.#media(async()=>{
        if(!this.#clients.has(client))throw Error('Connection closed');
        if(name==='locate_tracking'&&(this.#stopped.stopped||this.#closing))throw Error('Operator stopped this controller');
        return this.#tracking.call(client,name,args,{signal});
      }));
      if (name === 'screen_record_status' || name === 'screen_record_stop') {
        if (this.#recording?.clientId !== client || this.#recording.recordingId !== args.recordingId) throw new Error('Recording belongs to another connection or is unknown');
        if (name === 'screen_record_stop') await this.#media(() => this.#stopRecording('requested'));
        return result(this.#recording);
      }
      if (['media_buffer_status','media_buffer_stop','media_buffer_export'].includes(name)) {
        return result(await this.#media(async () => {
          if (!this.#clients.has(client)) throw new Error('Connection closed');
          if (!this.#buffer) throw new Error('Buffer is unknown');
          if (name === 'media_buffer_export' && ['starting','recording','stopping'].includes(this.#recording?.state)) throw new Error('MEDIA_BUSY: recording is active');
          return this.#buffer?.call(client, name, args, { signal });
        }));
      }
      if (this.#closing || this.#stopped.stopped) throw new Error(technicalStop(this.#stopped)?'Technical helper fault; inspect hid_status.recovery and call hid_try_restart':'Operator stopped this controller; explicit local operator resume required');
      const persisted=await this.#store?.stopState();if(persisted?.stopped){await this.stop(persisted.reason);throw Error('Operator stopped this controller');}
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
      if(this.#needsFreshCapture&&!['hid_capture','hid_release'].includes(name))throw Error('Capture a fresh screenshot after helper recovery before sending input');
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
          this.#needsFreshCapture=false;
          action.frameId = metadata.frameId;
        } finally { this.#captures.delete(action.id); }
      } else if(name==='activate_tracking'||name==='locate_bitmap'){
        response=result(await this.#media(async()=>{
          signal?.throwIfAborted();await this.#session.assertLease(args.token);
          if(this.#stopped.stopped||this.#closing||!this.#clients.has(client))throw Error('Bitmap operation cancelled');
          const {token,...options}=args;
          if(name==='activate_tracking')return this.#tracking.start(client,{owner:action.owner,jobId:action.jobId},options,()=>!signal?.aborted&&!this.#stopped.stopped&&!this.#closing&&this.#clients.has(client));
          const found=await this.#transport.locateBitmap(options);signal?.throwIfAborted();await this.#session.assertLease(args.token);return found;
        }));
      } else if (name === 'media_buffer_start') {
        response = result(await this.#media(async () => {
          signal?.throwIfAborted();await this.#session.assertLease(args.token);
          if (this.#stopped.stopped || this.#closing || !this.#clients.has(client)) throw new Error('Buffer startup cancelled');
          if (['starting','recording','stopping'].includes(this.#recording?.state)) throw new Error('MEDIA_BUSY: recording is active');
          const { token, ...options } = args;
          return this.#buffer.start(client, { owner: action.owner, jobId: action.jobId }, options, () => !signal?.aborted && !this.#stopped.stopped && !this.#closing && this.#clients.has(client));
        }));
      } else if (name === 'screen_record_start') {
        response = await this.#media(async () => {
        signal?.throwIfAborted();await this.#session.assertLease(args.token);
        if (this.#stopped.stopped || this.#closing || !this.#clients.has(client)) throw new Error('Recording startup cancelled');
        if (this.#simulated || !this.#transport.recordingAvailable) throw new Error('Screen recording unavailable; install ScreenCapture.exe');
        if (['starting', 'recording', 'stopping'].includes(this.#recording?.state)) throw new Error('A recording is already active');
        await this.#buffer?.stop('recording_started');
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
          return result(this.#recording);
        } catch (error) {
          if (this.#recording?.recordingId === recordingId && this.#recording.state === 'starting') this.#recording = { ...this.#recording, state: 'failed', error: error.message };
          throw error;
        }
        });
      } else if (name === 'hid_release') {
        this.#transport?.cancelPendingUacInput?.();
        await this.#session.release(args.token); this.#owner = undefined;
      } else {
        const { token, ...options } = args;
        const method = { hid_mouse_relative: 'moveRelative', hid_mouse_absolute: 'moveAbsolute', hid_keyboard: 'keyboard', hid_key_down: 'keyDown', hid_key_up: 'keyUp', hid_key_press: 'keyPress', hid_key_chord: 'keyChord', hid_type_text: 'typeText', hid_click: 'click', hid_move_click_relative: 'moveClickRelative', hid_drag_relative: 'dragRelative' }[name];
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
    this.#restartAbort?.abort(Error('Controller shutting down'));
    this.#transport?.cancelPendingUacInput?.();
    this.#closing = true; clearInterval(this.#timer); clearInterval(this.#heartbeat);
    await this.#restartTask?.catch(()=>{});++this.#generation;
    for (const capture of this.#captures.values()) capture.abort.abort(new Error('Controller shutting down'));
    await this.#session?.emergencyStop().catch(() => {});
    await this.#media(async () => { await Promise.allSettled([this.#stopRecording('controller_shutdown'),this.#buffer?.stop('operator_stop'),this.#tracking?.stop('controller_shutdown')]); }, true).catch(() => {});
    await this.#transport?.close?.().catch(() => {});
    this.#recordingCleanup?.();
    this.#buffer?.close();
    this.#tracking?.close();
    await this.publish({ event: 'controller_stopped' }); await this.#store?.flush();
  }
}
