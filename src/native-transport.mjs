import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { validateReport } from './reports.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { CaptureWorker } from './capture-worker.mjs';

export function completedConsentRelease(previous, next) {
  return Boolean(previous && previous[0] === 3 && previous[1] === 1 &&
    next[0] === 3 && next[1] === 0 && next[6] === 0 &&
    previous.subarray(2).equals(next.subarray(2)));
}

export function secureInputDeadline(leaseDeadline, capturedAt, now = Date.now()) {
  const deadline = Math.floor(Math.min(leaseDeadline ?? 0, capturedAt + 30000));
  if (!Number.isFinite(deadline) || deadline <= now) {
    const error = new Error('UAC screenshot or input lease expired; capture a fresh image');
    error.policyRefusal = true;
    throw error;
  }
  return deadline;
}

export class NativeTransport {
  #child; #pending = new Map(); #id = 0; #fatal; #ready; #resolveReady; #rejectReady; #metadata; #executable; #dataRoot; #onFault; #closing = false; #exit;
  #captureWorker; #recordingListeners = new Set(); #bufferListeners = new Set(); #trackingListeners=new Set();#mediaError; #inputResetEpoch = 0; #textContext;
  #captureFactory;
  #securePrompt; #secureCapturedAt = 0; #inputDeadline; #secureInputPending = false; #completedSecureClick;
  constructor(executable, { dataRoot, onFault = () => {}, spawnHid = spawn, captureFactory = (exe, root) => new CaptureWorker(exe, root) } = {}) {
    if (typeof executable !== 'string' || !executable) throw new TypeError('native executable path required');
    if (dataRoot && !path.isAbsolute(dataRoot)) throw new TypeError('capture dataRoot must be absolute');
    this.#executable = executable; this.#dataRoot = dataRoot; this.#onFault = onFault;this.#captureFactory = captureFactory;
    this.#ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.#child = spawnHid(executable, ['serve', '--live'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#exit = new Promise(resolve => this.#child.once('exit', resolve));
    this.#child.on('error', error => this.#fail(error));
    this.#child.on('exit', code => { if (!this.#closing || code !== 0) this.#fail(new Error(`native helper exited (${code})`)); });
    this.#child.stdin.on('error', error => this.#fail(error));
    // Native stderr is deliberately kept separate from MCP's stdout transport.
    this.#child.stderr.on('data', data => process.stderr.write(data));
    createInterface({ input: this.#child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.type === 'ready') { this.#metadata = message; this.#resolveReady(message); }
        else if (message.type === 'desktop_transition') { this.#metadata = { ...this.#metadata, inputPaused: message.inputPaused, desktop: message.desktop }; if (message.inputPaused) this.#inputResetEpoch++; else this.#securePrompt = undefined; }
        else if (message.type === 'stopped' || (message.ok === false && message.id === undefined)) this.#fail(new Error(message.error ?? 'local operator or native watchdog stopped the session'));
        else {
          const request = this.#pending.get(message.id);
          if (!request) return;
          this.#pending.delete(message.id); clearTimeout(request.timer);
          if (message.ok === true) request.resolve(message); else { const error = new Error(message.error ?? 'native operation failed'); error.policyRefusal = message.policyRefusal === true && message.inputSent === false; request.reject(error); }
        }
      } catch (error) { this.#fail(error); }
    });
  }
  #fail(error) {
    if (this.#fatal) return;
    this.#fatal = error; this.#rejectReady(error);
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.#pending.clear();
    this.#child.kill();
    if (!this.#closing) this.#onFault(error);
  }
  async ready() {
    const timer = setTimeout(() => this.#fail(new Error('native startup timed out')), 10000);
    try { return await this.#ready; } finally { clearTimeout(timer); }
  }
  status() { return { connected: Boolean(this.#metadata) && !this.#fatal && this.#child.exitCode === null, ...this.#metadata, inputResetEpoch: this.#inputResetEpoch, ...(this.#fatal ? { error: this.#fatal.message } : {}), ...(this.#mediaError ? { mediaError: this.#mediaError } : {}) }; }
  get captureAvailable() { return Boolean(this.#dataRoot); }
  get recordingAvailable() { return Boolean(this.#dataRoot && existsSync(path.join(path.dirname(this.#executable), 'ScreenCapture.exe'))); }
  #screen() {
    if (this.#fatal || this.#closing) throw this.#fatal ?? new Error('Native transport is closed');
    if (!this.recordingAvailable) throw new Error('Build/install ScreenCapture.exe beside HidTransport.exe to enable recording');
    if (!this.#captureWorker) {
      const worker = this.#captureFactory(path.join(path.dirname(this.#executable), 'ScreenCapture.exe'), this.#dataRoot);
      this.#captureWorker = worker;this.#mediaError = undefined;
      // Media has its own disposable, OS-limited process. Its failure must not
      // poison the HID transport or persist a global operator stop.
      worker.on('fault', error => { this.#mediaError = error.message.slice(0,300);if (this.#captureWorker === worker) this.#captureWorker = undefined; });
      worker.on('recording', metadata => { for (const listener of this.#recordingListeners) listener(metadata); });
      worker.on('buffer', metadata => { for (const listener of this.#bufferListeners) listener(metadata); });
      worker.on('tracking',metadata=>{for(const listener of this.#trackingListeners)listener(metadata);});
    }
    return this.#captureWorker;
  }
  onRecording(listener) { this.#recordingListeners.add(listener); return () => this.#recordingListeners.delete(listener); }
  onBuffer(listener) { this.#bufferListeners.add(listener); return () => this.#bufferListeners.delete(listener); }
  onTracking(listener){this.#trackingListeners.add(listener);return()=>this.#trackingListeners.delete(listener);}
  startTracking(options){return this.#screen().startTracking(options);}
  locateTracking(id){if(!this.#captureWorker)throw Error('Tracking worker is unavailable');return this.#captureWorker.locateTracking(id);}
  stopTracking(id){return this.#captureWorker?.stopTracking(id)??Promise.resolve(null);}
  locateBitmap(options){return this.#screen().locateBitmap(options);}
  startBuffer(options) { return this.#screen().startBuffer(options); }
  bufferStatus() { return this.#captureWorker?.bufferStatus() ?? Promise.resolve(null); }
  stopBuffer(reason) { return this.#captureWorker?.stopBuffer(reason) ?? Promise.resolve(null); }
  exportBuffer(options) { if (!this.#captureWorker) throw new Error('Buffer worker is unavailable');return this.#captureWorker.exportBuffer(options); }
  startRecording(options) { return this.#screen().startRecording(options); }
  stopRecording() { return this.#captureWorker?.stopRecording() ?? Promise.resolve(null); }
  async capture({ signal, ...options } = {}) {
    if (!this.#dataRoot) throw new Error('Capture requires an external --data-root configuration');
    if (this.#fatal) throw this.#fatal;
    if (this.recordingAvailable) { const frame = await this.#screen().snapshot({ ...options, signal }); this.#securePrompt = frame.desktop === 'Winlogon' ? frame.uacPromptId : undefined; this.#secureCapturedAt = Date.parse(frame.capturedUtc); return frame; }
    if (options.format === 'jpeg' || options.maxWidth || options.includeCursor === true || options.source || options.maxWaitMs) throw new Error('Extended snapshots require ScreenCapture.exe');
    signal?.throwIfAborted();
    const frameId = randomUUID();
    const folder = path.join(this.#dataRoot, 'captures'); await fs.mkdir(folder, { recursive: true });
    const output = path.join(folder, `${frameId}.png`);
    const metadata = await new Promise((resolve, reject) => {
      const child = spawn(this.#executable, ['capture', '--output', output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Screen capture timed out')); }, 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('exit', code => {
        clearTimeout(timer);
        try { const value = JSON.parse(stdout); if (code !== 0 || !value.ok) throw new Error(value.error ?? stderr ?? 'Capture failed'); resolve(value); }
        catch (error) { reject(error); }
      });
    });
    signal?.throwIfAborted();
    const stat = await fs.stat(output);
    if (stat.size > 16 * 1024 * 1024) throw new Error('Capture exceeds 16 MiB image limit');
    const data = (await fs.readFile(output, { signal })).toString('base64');
    signal?.throwIfAborted();
    return { ...metadata, frameId, data };
  }
  setInputDeadline(deadline) { this.#inputDeadline = deadline; }
  async planText(options) { return (await this.#request('plan_text', undefined, false, options)).plan; }
  setTextContext(context) { this.#textContext = context; }
  cancelPendingUacInput() { if (this.#secureInputPending) this.#child.kill(); }
  async releaseInput() { this.#securePrompt = undefined; this.#completedSecureClick = undefined; return this.#request('release'); }
  async #request(op, report, secure = false, fields = {}) {
    await this.#ready;
    if (this.#fatal) throw this.#fatal;
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timeout = secure || (op === 'ping' && this.#metadata?.secureDesktopSupported) ? 15000 : 3000;
      const timer = setTimeout(() => this.#fail(new Error('native write timed out; kernel watchdog must release held input')), timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(JSON.stringify({ id, op, ...fields, ...(report ? { report } : {}), ...(op === 'send' && this.#textContext ? { textContext: this.#textContext } : {}), ...(secure ? { promptId: this.#securePrompt, deadlineUtcMs: Math.floor(Math.min(this.#inputDeadline ?? 0, this.#secureCapturedAt + 30000)) } : {}) }) + '\n');
    });
  }
  async send(report) {
    const validated = validateReport(report);
    // A secure consent click already includes button-up. A matching caller
    // release must not reuse its consumed prompt or move on the next desktop.
    if (completedConsentRelease(this.#completedSecureClick, validated)) return this.releaseInput();
    this.#completedSecureClick = undefined;
    const secure = Boolean(this.#securePrompt);
    if (secure) secureInputDeadline(this.#inputDeadline, this.#secureCapturedAt);
    this.#secureInputPending = secure;
    try {
      const result = await this.#request('send', validated.toString('hex'), secure);
      if (secure && result.secureDelegated === true && validated[0] === 3 && validated[1] === 1) this.#completedSecureClick = Buffer.from(validated);
      return result;
    } finally { this.#secureInputPending = false; }
  }
  ping() { return this.#request('ping'); }
  async close() {
    this.#closing = true;
    this.cancelPendingUacInput();
    await this.#captureWorker?.close().catch(() => {});
    if (!this.#fatal) {
      try { await this.#request('release'); } finally { this.#child.stdin.end(); }
    }
    let timer;
    await Promise.race([this.#exit, new Promise(resolve => { timer = setTimeout(() => { this.#child.kill(); resolve(); }, 1500); })]);
    clearTimeout(timer);
  }
}
