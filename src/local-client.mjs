import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { externalRoot, readJson } from './state.mjs';

export class LocalClient {
  #socket; #pending = new Map(); #id = 0; #closed = false;
  constructor(socket) {
    this.#socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 24 * 1024 * 1024) { socket.destroy(new Error('Controller response too large')); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line), pending = this.#pending.get(reply.id);
          if (pending) { this.#pending.delete(reply.id); pending.cleanup(); reply.error ? pending.reject(new Error(reply.error)) : pending.resolve(reply.result); }
        } catch { socket.destroy(new Error('Invalid controller response')); }
      }
    });
    const fail = () => {
      this.#closed = true;
      for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(new Error('Local controller disconnected')); }
      this.#pending.clear();
    };
    socket.on('error', fail); socket.on('close', fail);
  }
  static async connect(dataRoot, agent = 'local-agent') {
    const endpoint = await readJson(path.join(externalRoot(dataRoot), 'controller', 'endpoint.local.json'));
    if (!endpoint || endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.secret !== 'string') throw new Error('No valid local controller endpoint');
    const socket = net.createConnection({ host: '127.0.0.1', port: endpoint.port });
    socket.setNoDelay(true);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Local controller connection timed out')); }, 1500);
      socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const client = new LocalClient(socket);
    try {
      const nonce = randomBytes(32).toString('hex');
      const proof = role => createHmac('sha256', endpoint.secret).update(`${endpoint.instance}:${nonce}:${role}`).digest('hex');
      client.identity = await client.request('hello', { nonce, proof: proof('client'), agent });
      if (typeof client.identity.proof !== 'string' || !/^[a-f0-9]{64}$/.test(client.identity.proof) || !timingSafeEqual(Buffer.from(client.identity.proof), Buffer.from(proof('server')))) throw new Error('Local controller identity verification failed');
      return client;
    }
    catch (error) { client.close(); throw error; }
  }
  request(method, params = {}, { signal } = {}) {
    if (this.#closed) return Promise.reject(new Error('Local controller disconnected'));
    signal?.throwIfAborted();
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.#pending.delete(id)) return;
        cleanup(); this.#socket.write(JSON.stringify({ id: ++this.#id, method: 'cancel', params: { requestId: id } }) + '\n');
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Request cancelled')));
      };
      const timer = setTimeout(() => {
        this.#socket.destroy(new Error('Local controller request timed out'));
      }, method === 'call' && params.name === 'hid_key_press' ? 15000 : 10000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      this.#socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  call(name, args, options) { return this.request('call', { name, args }, options); }
  get connected() { return !this.#closed && !this.#socket.destroyed; }
  close() { this.#socket.end(); this.#socket.destroy(); }
}

export class LocalEndpoint {
  #client; #options; #connecting; #closed = false;
  constructor(options) { this.#options = options; }
  async connect() {
    if (this.#closed) throw new Error('MCP adapter is closed');
    if (!this.#connecting) this.#connecting = ensureLocalClient(this.#options).then(client => { if (this.#closed) { client.close(); throw new Error('MCP adapter is closed'); } this.#client = client; }).finally(() => { this.#connecting = undefined; });
    await this.#connecting;
    return this;
  }
  async call(name, args, options) {
    if (this.#closed) throw new Error('MCP adapter is closed');
    if (!this.#client?.connected) {
      if (!['hid_status', 'hid_acquire', 'hid_emergency_stop'].includes(name)) throw new Error('Controller connection changed; inspect status and acquire a fresh lease. Input was not retried.');
      await this.connect();
    }
    // Never retry a submitted action: its acknowledgement may have been lost.
    return this.#client.call(name, args, options);
  }
  close() { this.#closed = true; this.#client?.close(); }
}

export async function ensureLocalClient({ dataRoot, simulated, executable, agent, autostart = true }) {
  externalRoot(dataRoot);
  const checked = async () => {
    const client = await LocalClient.connect(dataRoot, agent);
    if (simulated !== undefined && client.identity.simulated !== simulated) { client.close(); throw new Error('Controller mode mismatch: use a separate data root for simulation'); }
    if (executable && client.identity.executable?.toLowerCase() !== executable.toLowerCase()) { client.close(); throw new Error('Controller mode mismatch: a different native executable is already configured'); }
    return client;
  };
  try { return await checked(); }
  catch (error) { if (!autostart || error.message.includes('mode mismatch')) throw error; }
  const folder = path.join(dataRoot, 'controller');
  await fs.mkdir(folder, { recursive: true });
  const log = await fs.open(path.join(folder, 'process.log'), 'a');
  try {
    const args = [fileURLToPath(new URL('./broker.mjs', import.meta.url)), simulated ? '--simulate' : '--live', ...(!simulated ? [executable] : []), '--data-root', dataRoot];
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', () => {}); child.unref();
  } finally { await log.close(); }
  let lastError;
  for (let i = 0; i < 50; i++) {
    await delay(100);
    try { return await checked(); } catch (error) { if (error.message.includes('mode mismatch')) throw error; lastError = error; }
  }
  throw new Error('Local controller did not start: ' + lastError?.message + '; inspect controller/process.log');
}
