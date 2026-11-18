import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { validateReport } from './reports.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class NativeTransport {
  #child; #pending = new Map(); #id = 0; #fatal; #ready; #resolveReady; #rejectReady; #metadata; #executable; #dataRoot; #onFault; #closing = false; #exit;
  constructor(executable, { dataRoot, onFault = () => {} } = {}) {
    if (typeof executable !== 'string' || !executable) throw new TypeError('native executable path required');
    if (dataRoot && !path.isAbsolute(dataRoot)) throw new TypeError('capture dataRoot must be absolute');
    this.#executable = executable; this.#dataRoot = dataRoot; this.#onFault = onFault;
    this.#ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.#child = spawn(executable, ['serve', '--live'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
        else if (message.type === 'stopped' || (message.ok === false && message.id === undefined)) this.#fail(new Error(message.error ?? 'local operator or native watchdog stopped the session'));
        else {
          const request = this.#pending.get(message.id);
          if (!request) return;
          this.#pending.delete(message.id); clearTimeout(request.timer);
          if (message.ok === true) request.resolve(message); else request.reject(new Error(message.error ?? 'native operation failed'));
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
    const timer = setTimeout(() => this.#fail(new Error('native startup timed out')), 5000);
    try { return await this.#ready; } finally { clearTimeout(timer); }
  }
  status() { return { connected: Boolean(this.#metadata) && !this.#fatal && this.#child.exitCode === null, ...this.#metadata, ...(this.#fatal ? { error: this.#fatal.message } : {}) }; }
  get captureAvailable() { return Boolean(this.#dataRoot); }
  async capture({ signal } = {}) {
    if (!this.#dataRoot) throw new Error('Capture requires an external --data-root configuration');
    if (this.#fatal) throw this.#fatal;
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
  async #request(op, report) {
    await this.#ready;
    if (this.#fatal) throw this.#fatal;
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error('native write timed out; kernel watchdog must release held input')), 3000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(JSON.stringify({ id, op, ...(report ? { report } : {}) }) + '\n');
    });
  }
  send(report) { return this.#request('send', validateReport(report).toString('hex')); }
  ping() { return this.#request('ping'); }
  async close() {
    this.#closing = true;
    if (!this.#fatal) {
      try { await this.#request('release'); } finally { this.#child.stdin.end(); }
    }
    let timer;
    await Promise.race([this.#exit, new Promise(resolve => { timer = setTimeout(() => { this.#child.kill(); resolve(); }, 1500); })]);
    clearTimeout(timer);
  }
}
