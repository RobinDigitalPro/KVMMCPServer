import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopController } from '../src/controller.mjs';
import { parseTool } from '../src/tools.mjs';
const text = value => JSON.parse(value.content[0].text);
async function fixture({ start, exportMedia } = {}) {
  let buffer, recording, listener, stops=0;const calls=[];
  const transport={send:async()=>{},captureAvailable:true,recordingAvailable:true,
    onBuffer:cb=>{listener=cb;return()=>{};},
    startBuffer:async options=>{calls.push('buffer_start');await start?.();buffer={...options,state:'buffering',reason:'',availableSeconds:12,bufferedBytes:1000};listener(buffer);return buffer;},
    stopBuffer:async reason=>{calls.push(`buffer_stop:${reason}`);stops++;if(buffer){buffer={...buffer,state:'stopped',reason};listener(buffer);}return buffer;},
    bufferStatus:async()=>buffer,
    exportBuffer:async options=>{calls.push('export');await exportMedia?.();return {actualSeconds:Math.min(12,options.seconds),path:'external/test.mp4',reencoded:false};},
    startRecording:async options=>{calls.push('record_start');recording={...options,state:'recording'};return recording;},
    stopRecording:async()=>{calls.push('record_stop');return recording={...recording,state:'stopped'};},
  };
  const controller=await DesktopController.create({transport});const client=controller.attach('buffer-owner'),other=controller.attach('other');
  const lease=text(await controller.call(client,'hid_acquire',{owner:'media-test',ttlMs:60000}));
  return {controller,client,other,lease,calls,stops:()=>stops,
    start:()=>controller.call(client,'media_buffer_start',{token:lease.token,mode:'combined'}),
    event:metadata=>{buffer={...buffer,...metadata};listener(buffer);},
  };
}
test('buffer schema permits exactly three bounded modes/profiles and no free codec parameters',()=>{
  for(const mode of ['audio','video','combined']) for(const profile of ['light','standard','high']) assert.equal(parseTool('media_buffer_start',{token:'t',mode,profile}).mode,mode);
  for(const extra of [{mode:'both'},{profile:'ultra'},{fps:300},{sampleRate:384000},{maxWidth:99999},{microphone:true}]) assert.throws(()=>parseTool('media_buffer_start',{token:'t',mode:'combined',...extra}));
  for(const seconds of [0,31,1.5,Infinity]) assert.throws(()=>parseTool('media_buffer_export',{bufferId:'00000000-0000-4000-8000-000000000001',seconds}));
});
test('startup requires the owning input lease; release does not stop the buffer',async()=>{
  const s=await fixture();try{
    assert.equal((await s.controller.call(s.other,'media_buffer_start',{token:s.lease.token,mode:'audio'})).isError,true);assert.equal(s.calls.length,0);
    const buffer=text(await s.start());assert.equal(buffer.profile,'standard');assert.equal('token' in buffer,false);
    await s.controller.call(s.client,'hid_release',{token:s.lease.token});assert.equal(s.controller.status().control.owner,null);
    assert.equal(text(await s.controller.call(s.client,'media_buffer_status',{bufferId:buffer.bufferId})).state,'buffering');assert.equal(s.stops(),0);
    assert.equal((await s.controller.call(s.other,'media_buffer_export',{bufferId:buffer.bufferId,seconds:5})).isError,true);
    assert.equal((await s.controller.call(s.other,'media_buffer_stop',{bufferId:buffer.bufferId})).isError,true);
  }finally{await s.controller.close();}
});
test('stop freezes history, export never restarts it, and stop is idempotent',async()=>{
  const s=await fixture();try{
    const buffer=text(await s.start());await s.controller.call(s.client,'media_buffer_stop',{bufferId:buffer.bufferId});
    await s.controller.call(s.client,'media_buffer_stop',{bufferId:buffer.bufferId});assert.equal(s.stops(),1);
    const exported=text(await s.controller.call(s.client,'media_buffer_export',{bufferId:buffer.bufferId,seconds:30}));assert.equal(exported.actualSeconds,12);assert.equal(exported.reencoded,false);
    assert.equal(s.controller.status().mediaBuffer.state,'stopped');assert.equal(s.calls.filter(x=>x==='buffer_start').length,1);
  }finally{await s.controller.close();}
});
test('recording preempts buffering in order, refuses a simultaneous buffer/export, and does not restart it',async()=>{
  const s=await fixture();try{
    const buffer=text(await s.start());const recording=text(await s.controller.call(s.client,'screen_record_start',{token:s.lease.token}));
    assert.deepEqual(s.calls.slice(0,3),['buffer_start','buffer_stop:recording_started','record_start']);
    assert.equal(s.controller.status().mediaBuffer.reason,'recording_started');
    assert.equal((await s.start()).isError,true);assert.equal((await s.controller.call(s.client,'media_buffer_export',{bufferId:buffer.bufferId,seconds:5})).isError,true);
    await s.controller.call(s.client,'screen_record_stop',{recordingId:recording.recordingId});assert.equal(s.controller.status().mediaBuffer.state,'stopped');
  }finally{await s.controller.close();}
});
test('invalid and unauthorized recording requests cannot stop another active buffer',async()=>{
  const s=await fixture();try{
    await s.start();assert.equal((await s.controller.call(s.other,'screen_record_start',{token:s.lease.token})).isError,true);
    assert.equal((await s.controller.call(s.client,'screen_record_start',{token:s.lease.token,maxSeconds:10000})).isError,true);assert.equal(s.stops(),0);
  }finally{await s.controller.close();}
});
test('important owner events arrive once on the next call; progress is not notification spam',async()=>{
  const s=await fixture();try{
    const buffer=text(await s.start());s.event({availableSeconds:15});s.event({state:'stopped',reason:'cpu_pressure'});
    const other=await s.controller.call(s.other,'hid_status');assert.equal(other.content.length,1);
    const own=await s.controller.call(s.client,'hid_status');const events=JSON.parse(own.content[1].text).mediaBufferEvents;
    assert.equal(events.length,1);assert.equal(events[0].reason,'cpu_pressure');assert.equal(events[0].bufferId,buffer.bufferId);
    assert.equal((await s.controller.call(s.client,'hid_status')).content.length,1);
  }finally{await s.controller.close();}
});
test('media failure remains visible while HID and the controller stay healthy',async()=>{
  const s=await fixture();try{
    await s.start();s.event({state:'failed',reason:'worker_disconnected',availableSeconds:0,bufferedBytes:0});
    assert.equal(s.controller.status().mediaBuffer.reason,'worker_disconnected');assert.equal(s.controller.status().operatorStop.stopped,false);
    assert.notEqual((await s.controller.call(s.client,'hid_mouse_relative',{token:s.lease.token,dx:1})).isError,true);
  }finally{await s.controller.close();}
});
test('cancel/disconnect/emergency during startup cannot orphan a buffer',async()=>{
  for(const action of ['cancel','disconnect','stop']){
    let enter,finish;const entered=new Promise(r=>enter=r),wait=new Promise(r=>finish=r);const s=await fixture({start:async()=>{enter();await wait;}});const abort=new AbortController();
    try{
      const pending=s.controller.call(s.client,'media_buffer_start',{token:s.lease.token,mode:'audio'},{signal:abort.signal});await entered;
      let cleanup;if(action==='cancel')abort.abort();else if(action==='disconnect')cleanup=s.controller.detach(s.client);else cleanup=s.controller.stop('test');
      finish();assert.equal((await pending).isError,true);await cleanup;assert.notEqual(s.controller.status().mediaBuffer.state,'buffering');assert.ok(s.stops()>0);
    }finally{await s.controller.close();}
  }
});
test('concurrent starts serialize and a full request queue cannot prevent disconnect cleanup',async()=>{
  let finish,enter;const entered=new Promise(r=>enter=r),wait=new Promise(r=>finish=r);const s=await fixture({exportMedia:async()=>{enter();await wait;}});
  try{
    const starts=await Promise.all([s.start(),s.start()]);assert.equal(starts.filter(x=>!x.isError).length,1);
    const buffer=text(starts.find(x=>!x.isError));const exporting=s.controller.call(s.client,'media_buffer_export',{bufferId:buffer.bufferId,seconds:5});await entered;
    const queued=Array.from({length:6},()=>s.controller.call(s.client,'media_buffer_status',{bufferId:buffer.bufferId}));
    const cleanup=s.controller.detach(s.client);finish();await exporting;const results=await Promise.all(queued);await cleanup;
    assert.ok(results.some(x=>x.isError));assert.equal(s.controller.status().mediaBuffer.state,'idle');assert.equal(s.controller.status().control.owner,null);
  }finally{await s.controller.close();}
});
