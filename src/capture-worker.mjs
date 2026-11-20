import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, externalRoot } from './state.mjs';

// One private pipe to a persistent user-mode worker. No HTTP/video endpoint.
export class CaptureWorker extends EventEmitter {
  #child; #ready; #pending = new Map(); #id = 0; #heartbeat; #closed = false; #fatal; #root; #exit; #recording; #writes = Promise.resolve(); #starting; #buffer; #exporting = false;
  constructor(executable, dataRoot) {
    super(); this.#root = externalRoot(dataRoot);
    this.#child = spawn(executable, ['guarded-serve', '--data-root', this.#root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#exit = new Promise(resolve => this.#child.once('exit', resolve));
    let ready, fail;
    this.#ready = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
    // Attach immediately: startup can fail before the first caller awaits it.
    this.#ready.catch(() => {});
    const timer = setTimeout(() => reject(new Error('Capture worker startup timed out')), 5000);
    const reject = error => { clearTimeout(timer); fail(error); this.#fail(error); };
    this.#child.on('error', reject);
    this.#child.on('exit', code => { if (!this.#closed) reject(new Error(`Capture worker exited (${code})`)); });
    this.#child.stdin.on('error', reject);
    this.#child.stderr.on('data', chunk => process.stderr.write(chunk));
    createInterface({ input: this.#child.stdout }).on('line', line => {
      try {
        if (line.length > 65536) throw new Error('Capture worker response too large');
        const value = JSON.parse(line);
        if (value.type === 'ready') { clearTimeout(timer); ready(value); }
        else if (value.type === 'fatal') reject(new Error(value.error));
        else if (value.type === 'buffer_state' || value.type === 'buffer_progress') {
          this.#updateBuffer(value);
        } else if (value.type === 'recording_finished' || value.type === 'recording_progress') {
          this.#update(value);
        } else {
          const pending = this.#pending.get(value.id);
          if (!pending) return;
          this.#pending.delete(value.id); clearTimeout(pending.timer);
          value.ok ? pending.resolve(value) : pending.reject(new Error(value.error ?? 'Capture operation failed'));
        }
      } catch (error) { reject(error); }
    });
    this.#heartbeat = setInterval(() => { void this.#request('ping').catch(error => this.#fail(error)); }, 1000);
    this.#heartbeat.unref();
  }
  #update(value) {
    const { id, ok, type, ...metadata } = value;
    this.#recording = metadata;
    // Preserve only metadata, never lease tokens. MP4s and receipts stay external.
    if (metadata.recordingId) this.#writes = this.#writes.then(() => atomicJson(path.join(this.#root, 'recordings', `${metadata.recordingId}.json`), metadata)).catch(error => {
      this.emit('fault', error); this.#fail(error);
    });
    this.emit('recording', metadata);
  }
  #fail(error) {
    if (this.#fatal || this.#closed) return;
    this.#fatal = error; clearInterval(this.#heartbeat);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    if (this.#recording?.state === 'recording') this.#update({ ...this.#recording, state: 'failed', reason: error.message, finalized: false, finishedUtc: new Date().toISOString() });
    if (this.#buffer?.bufferId) this.#updateBuffer({ ...this.#buffer, state: 'failed', reason: 'worker_disconnected', error: error.message.slice(0,300), availableSeconds: 0, bufferedBytes: 0, stoppedUtc: new Date().toISOString() });
    this.#child.kill(); this.emit('fault', error);
  }
  async #request(operation, fields = [], timeoutMs = 8000) {
    if (this.#fatal) throw this.#fatal;
    if (this.#closed) throw new Error('Capture worker is closed');
    await this.#ready;
    if (this.#fatal || this.#closed) throw this.#fatal ?? new Error('Capture worker is closed');
    if (this.#pending.size >= 8) throw new Error('Media request queue is full');
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error('Capture operation timed out')), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write([operation, id, ...fields].join('\t') + '\n');
    });
  }
  #updateBuffer(value) {
    const { id, ok, type, ...metadata } = value;
    this.#buffer = metadata; this.emit('buffer', { ...metadata });
  }
  async startBuffer({ bufferId = randomUUID(), mode, profile = 'standard' }) {
    if (!/^[a-f0-9-]{36}$/.test(bufferId) || !['audio','video','combined'].includes(mode) || !['light','standard','high'].includes(profile)) throw new Error('Invalid buffer options');
    const value = await this.#request('buffer_start', [bufferId, mode, profile]);this.#updateBuffer(value);return this.buffer;
  }
  async bufferStatus() { const value = await this.#request('buffer_status');this.#updateBuffer(value);return this.buffer; }
  async stopBuffer(reason = 'requested') {
    if (!['requested','operator_stop','agent_disconnected','recording_started'].includes(reason)) throw new Error('Invalid buffer stop reason');
    const value = await this.#request('buffer_stop', [reason]);this.#updateBuffer(value);return this.buffer;
  }
  get buffer() { return this.#buffer ? { ...this.#buffer } : null; }
  async exportBuffer({ seconds, signal }) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Buffer export seconds must be 1..30');
    if (this.#exporting) throw new Error('An export is already in progress');signal?.throwIfAborted();this.#exporting = true;
    const cancel = () => this.#fail(new Error('Media export cancelled; worker stopped without affecting HID'));
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const exportId = randomUUID();
      const { id, ok, ...metadata } = await this.#request('buffer_export', [exportId, seconds], 20000);
      signal?.throwIfAborted();
      const expected = path.join(this.#root, 'media', `${exportId}.${metadata.mimeType === 'audio/mp4' ? 'm4a' : 'mp4'}`);
      if (path.resolve(metadata.path) !== expected) throw new Error('Unexpected media export path');
      const stat = await fs.stat(expected);if (stat.size > 40 * 1024 * 1024) throw new Error('Media export exceeds byte limit');
      const receipt = { ...metadata, bytes: stat.size, requestedSeconds: seconds, exportedUtc: new Date().toISOString() };
      await atomicJson(path.join(this.#root, 'media', `${exportId}.json`), receipt);return receipt;
    } finally { this.#exporting = false;signal?.removeEventListener('abort', cancel); }
  }
  async snapshot({ format = 'png', maxWidth = 0, includeCursor = true, signal } = {}) {
    signal?.throwIfAborted();
    if (!['png', 'jpeg'].includes(format) || !Number.isInteger(maxWidth) || maxWidth < 0 || maxWidth > 3840) throw new Error('Invalid snapshot options');
    const frameId = randomUUID();
    const { id, ok, ...metadata } = await this.#request('snapshot', [frameId, format, maxWidth, includeCursor ? 1 : 0]);
    signal?.throwIfAborted();
    const expected = path.join(this.#root, 'captures', `${frameId}.${format === 'jpeg' ? 'jpg' : 'png'}`);
    if (path.resolve(metadata.path) !== expected) throw new Error('Unexpected capture output path');
    if ((await fs.stat(expected)).size > 16 * 1024 * 1024) throw new Error('Capture exceeds 16 MiB image limit');
    return { ...metadata, data: (await fs.readFile(expected, { signal })).toString('base64') };
  }
  async startRecording({ recordingId = randomUUID(), maxSeconds = 600, fps = 15, maxWidth = 1920, bitrate = 6000000, systemAudio = true } = {}) {
    if (!/^[a-f0-9-]{36}$/.test(recordingId) || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 600 || !Number.isInteger(fps) || fps < 1 || fps > 30 || !Number.isInteger(maxWidth) || maxWidth < 0 || maxWidth > 3840 || !Number.isInteger(bitrate) || bitrate < 1000000 || bitrate > 20000000) throw new Error('Invalid recording options; maximum duration is 600 seconds');
    if (this.#starting || this.#recording?.state === 'recording') throw new Error('A recording is already active');
    if (typeof systemAudio !== 'boolean') throw new Error('systemAudio must be boolean');
    this.#starting = (async () => {
      const value = await this.#request('record', [recordingId, maxSeconds, fps, maxWidth, bitrate, systemAudio ? 1 : 0]);
      // A very short recording can finish before its start acknowledgement is read.
      if (this.#recording?.recordingId !== recordingId || this.#recording.state === 'recording') this.#update(value);
      return this.#recording;
    })();
    try { return await this.#starting; } finally { this.#starting = undefined; }
  }
  get recording() { return this.#recording ? { ...this.#recording } : null; }
  async stopRecording() {
    await this.#starting?.catch(() => {});
    if (this.#recording?.state === 'recording') await this.#request('stop');
    await this.#writes; return this.recording;
  }
  async close() {
    if (this.#closed) return;
    try { if (!this.#fatal) await this.#request('quit'); }
    finally {
      this.#closed = true; clearInterval(this.#heartbeat); this.#child.stdin.end();
      let timer;
      await Promise.race([this.#exit, new Promise(resolve => { timer = setTimeout(() => { this.#child.kill(); resolve(); }, 1000); })]); clearTimeout(timer);
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Capture worker closed')); } this.#pending.clear();
      await this.#writes;
    }
  }
}
