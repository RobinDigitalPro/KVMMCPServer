import { randomUUID } from 'node:crypto';

// Called under the controller's bounded media transition lock. The input lease
// authorizes startup; ownership thereafter is the authenticated connection.
export class MediaBuffer {
  #transport; #current; #sequence = 0; #events = new Map(); #unsubscribe; #changed;
  constructor(transport, changed = () => {}) {
    this.#transport = transport;this.#changed = changed;
    this.#unsubscribe = transport?.onBuffer?.(metadata => this.#update(metadata));
  }
  status() { return this.#current ? { ...this.#current } : { state: 'idle', sequence: this.#sequence }; }
  #update(metadata) {
    if (!this.#current || metadata?.bufferId !== this.#current.bufferId) return;
    const previous = this.#current;
    const changed = metadata.state !== previous.state || metadata.reason !== previous.reason;
    this.#current = { ...previous, ...metadata, sequence: changed ? ++this.#sequence : previous.sequence };
    if (changed) {
      const events = this.#events.get(previous.clientId) ?? [];
      events.push({ sequence: this.#sequence, bufferId: previous.bufferId, state: this.#current.state, reason: this.#current.reason ?? '', atUtc: new Date().toISOString() });
      this.#events.set(previous.clientId, events.slice(-16));this.#changed(this.status());
    }
  }
  events(client) { const events = this.#events.get(client) ?? [];this.#events.delete(client);return events; }
  #owned(client, bufferId) {
    if (!this.#current || this.#current.clientId !== client || this.#current.bufferId !== bufferId) throw new Error('Buffer belongs to another connection or is unknown');
    return this.#current;
  }
  async start(client, labels, options, valid) {
    if (!this.#transport?.startBuffer) throw new Error('Media buffer unavailable; install the current ScreenCapture.exe');
    if (['starting','buffering','stopping'].includes(this.#current?.state)) throw new Error('A buffer is already active');
    this.#current = { bufferId: randomUUID(), clientId: client, ...labels, mode: options.mode, profile: options.profile ?? 'standard', state: 'starting', sequence: ++this.#sequence, availableSeconds: 0, bufferedBytes: 0 };
    const bufferId = this.#current.bufferId;
    try {
      this.#update(await this.#transport.startBuffer({ ...options, bufferId }));
      if (!valid()) { await this.stop('requested');throw new Error('Buffer start cancelled or connection closed'); }
      return this.status();
    } catch (error) {
      if (this.#current.bufferId === bufferId && this.#current.state === 'starting') this.#update({ bufferId, state: 'failed', reason: 'encoder_start_failed', error: error.message.slice(0,300) });
      throw error;
    }
  }
  async stop(reason = 'requested', clear = false) {
    const current = this.#current;
    if (!current) return this.status();
    try {
      if (['starting','buffering','stopping'].includes(current.state) || clear) {
        const metadata = await this.#transport.stopBuffer(clear ? 'agent_disconnected' : reason);
        if (!clear) this.#update(metadata ?? { bufferId: current.bufferId, state: 'failed', reason: 'worker_disconnected', availableSeconds: 0, bufferedBytes: 0 });
      }
      return this.status();
    } catch (error) {
      this.#update({ bufferId: current.bufferId, state: 'failed', reason: 'worker_disconnected', error: error.message.slice(0,300), availableSeconds: 0, bufferedBytes: 0 });throw error;
    } finally { if (clear) { this.#current = undefined;this.#events.delete(current.clientId); } }
  }
  async call(client, name, args, { signal } = {}) {
    this.#owned(client, args.bufferId);signal?.throwIfAborted();
    if (name === 'media_buffer_status') { const metadata = await this.#transport.bufferStatus?.();if (metadata) this.#update(metadata);return this.status(); }
    if (name === 'media_buffer_stop') return this.stop();
    if (name === 'media_buffer_export') {
      const exported = await this.#transport.exportBuffer({ seconds: args.seconds, signal });signal?.throwIfAborted();return exported;
    }
    throw new Error('Unknown media buffer operation');
  }
  async detach(client) {
    this.#events.delete(client);
    if (this.#current?.clientId === client) await this.stop('agent_disconnected', true);
  }
  close() { this.#unsubscribe?.();this.#events.clear(); }
}
