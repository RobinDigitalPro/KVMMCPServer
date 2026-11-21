import {randomUUID} from 'node:crypto';
// Ownership is the live broker connection, independent of an input lease.
export class BitmapTracking {
  #transport;#current;#unsubscribe;
  constructor(transport){this.#transport=transport;this.#unsubscribe=transport?.onTracking?.(metadata=>this.#update(metadata));}
  #update(metadata){if(this.#current?.trackingId===metadata?.trackingId&&!(metadata.revision<this.#current.revision))this.#current={...this.#current,...metadata};}
  status(){if(!this.#current)return {state:'idle'};const value={...this.#current},time=Date.parse(value.observedUtc);if(Number.isFinite(time))value.measurementAgeMs=Math.max(0,Date.now()-time);return value;}
  #owned(client,id){if(this.#current?.clientId!==client||this.#current?.trackingId!==id)throw Error('Tracker belongs to another connection or is unknown');}
  async start(client,labels,options,valid){
    if(!this.#transport?.startTracking)throw Error('Bitmap tracking is unavailable');
    if(['starting','tracking','lost'].includes(this.#current?.state))throw Error('A tracker already owns the capture source; stop it first');
    const trackingId=randomUUID();this.#current={trackingId,clientId:client,...labels,state:'starting',valid:false};
    try{this.#update(await this.#transport.startTracking({...options,trackingId}));if(!valid()){await this.stop('start_cancelled');throw Error('Tracking startup cancelled or connection closed');}return this.status();}
    catch(error){if(this.#current?.trackingId===trackingId&&this.#current.state==='starting')this.#current={...this.#current,state:'stopped',reason:error.message,valid:false};throw error;}
  }
  async stop(reason='requested'){
    if(!this.#current||this.#current.state==='stopped')return this.status();
    try{if(this.#current.state!=='stopped')this.#update(await this.#transport.stopTracking(this.#current.trackingId));}
    finally{this.#current={...this.#current,state:'stopped',valid:false,position:null,bounds:null,reason};}
    return this.status();
  }
  async call(client,name,{trackingId},{signal}={}){
    this.#owned(client,trackingId);signal?.throwIfAborted();
    if(name==='stop_tracking')return this.stop();
    if(this.#current.state==='stopped')return this.status();
    this.#update(await this.#transport.locateTracking(trackingId));
    if(signal?.aborted){await this.stop('request_cancelled');signal.throwIfAborted();}
    return this.status();
  }
  async detach(client){if(this.#current?.clientId===client)await this.stop('agent_disconnected');}
  close(){this.#unsubscribe?.();}
}
