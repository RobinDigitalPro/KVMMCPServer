import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeTransport } from '../src/native-transport.mjs';

test('the real native transport isolates media-worker faults and recreates observation, while HID faults still stop',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'kvm-isolation-'));await fs.writeFile(path.join(root,'ScreenCapture.exe'),'test marker; never executed');
  let faults=0,kills=0;const workers=[];
  const hid=new EventEmitter();hid.stdout=new PassThrough();hid.stderr=new PassThrough();hid.stdin=new EventEmitter();hid.exitCode=null;
  hid.stdin.write=line=>{const request=JSON.parse(line);queueMicrotask(()=>hid.stdout.write(JSON.stringify({id:request.id,ok:true})+'\n'));};
  hid.kill=()=>{kills++;hid.exitCode=1;hid.emit('exit',1);};hid.stdin.end=()=>{hid.exitCode=0;hid.emit('exit',0);};
  const transport=new NativeTransport(path.join(root,'HidTransport.exe'),{dataRoot:path.join(root,'data'),onFault:()=>faults++,spawnHid:()=>{queueMicrotask(()=>hid.stdout.write('{"type":"ready","processId":1}\n'));return hid;},captureFactory:()=>{
    const worker=new EventEmitter();worker.startBuffer=async options=>({...options,state:'buffering'});worker.snapshot=async()=>({desktop:'Default',capturedUtc:new Date().toISOString(),data:'AA=='});worker.close=async()=>{};workers.push(worker);return worker;
  }});
  try{
    await transport.ready();await transport.startBuffer({mode:'video'});assert.equal(workers.length,1);
    workers[0].emit('fault',new Error('encoder exceeded private-memory limit'));
    assert.equal(faults,0);assert.equal(kills,0);assert.equal(transport.status().connected,true);assert.match(transport.status().mediaError,/memory/);
    await transport.ping();await transport.capture();assert.equal(workers.length,2);assert.equal(transport.status().mediaError,undefined);
    hid.kill();assert.equal(faults,1);assert.equal(transport.status().connected,false);
  }finally{await transport.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('kvm-isolation-'));await fs.rm(root,{recursive:true,force:true});}
});
