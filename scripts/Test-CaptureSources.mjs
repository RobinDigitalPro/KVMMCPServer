// Read-only live media test. Own non-activating fixture; never injects HID.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {CaptureWorker} from '../src/capture-worker.mjs';
const [mode,exe,fixtureExe,root]=process.argv.slice(2);if(mode!=='--live'||![exe,fixtureExe,root].every(x=>x&&path.isAbsolute(x)))throw Error('--live ABS_CAPTURE ABS_FIXTURE NEW_OUTPUT required');
await fs.mkdir(root,{recursive:false});const title='KVM Capture '+randomUUID();const fixture=spawn(fixtureExe,[title],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const waiting=[],states=[];fixture.stderr.on('data',()=>{});createInterface({input:fixture.stdout}).on('line',line=>{const s=JSON.parse(line);const w=waiting.shift();w?w(s):states.push(s);});
const nextState=()=>states.length?Promise.resolve(states.shift()):Promise.race([new Promise(resolve=>waiting.push(resolve)),delay(5000).then(()=>{throw Error('Fixture timeout');})]);
const command=async op=>{fixture.stdin.write(op+'\n');return nextState();};
const execute=promisify(execFile),receipt={verified:false,inputSent:false,cases:[]};let worker;
try{
  const initial=await nextState();worker=new CaptureWorker(exe,root);worker.on('fault',()=>{});
  const windowSource={mode:'window',title,area:'client'};
  const sources=[windowSource,{mode:'fullscreen'},{mode:'region',x:0,y:0,width:320,height:240}];
  for(const source of sources){
    const first=await worker.snapshot({source,format:'png',includeCursor:false,maxWaitMs:100});assert.equal(first.source.mode,source.mode);
    if(source.mode==='region'){assert.equal(first.width,320);assert.equal(first.height,240);assert.equal(first.readbackBytes,320*240*4);}
    if(source.mode==='window'){assert.equal(first.source.backend,'windows-graphics-capture');assert.equal(first.width,initial.width);assert.equal(first.height,initial.height);}
    receipt.cases.push({test:'snapshot',mode:source.mode,frame:{...first,data:undefined}});
    const record=await worker.startRecording({source,maxSeconds:3,fps:5,maxWidth:640,systemAudio:false});assert.equal(record.source.mode,source.mode);
    await delay(500);await assert.rejects(worker.snapshot({source:{mode:'region',x:20,y:20,width:100,height:100}}),/source_busy/);
    await worker.snapshot({source,format:'jpeg',maxWidth:640});await delay(3000);const stopped=await worker.stopRecording();assert.equal(stopped.finalized,true);
    const decoded=JSON.parse((await execute(exe,['inspect-all',stopped.path,stopped.path+'.png'],{windowsHide:true,timeout:15000})).stdout.trim());assert.equal(decoded.endOfStream,true);assert.ok(decoded.decodedFrames>=1);receipt.cases.push({test:'recording',mode:source.mode,recording:stopped,decoded});
    await worker.startBuffer({mode:'video',profile:'light',source});let status;
    for(let n=0;n<20;n++){await delay(500);status=await worker.bufferStatus();assert.equal(status.state,'buffering',JSON.stringify(status));if(status.availableSeconds>=1.5)break;}
    receipt.cases.push({test:'buffer_ready',mode:source.mode,status});assert.equal(status.source.mode,source.mode);assert.ok(status.availableSeconds>=1.5,JSON.stringify(status));
    const exported=await worker.exportBuffer({seconds:2});await worker.stopBuffer();const bufferDecoded=JSON.parse((await execute(exe,['inspect-all',exported.path,exported.path+'.png'],{windowsHide:true,timeout:15000})).stdout.trim());assert.equal(bufferDecoded.endOfStream,true);receipt.cases.push({test:'buffer',mode:source.mode,status,exported,decoded:bufferDecoded});
  }
  await assert.rejects(worker.snapshot({source:{mode:'region',x:32767,y:32767,width:100,height:100}}),/region_out_of_bounds/);
  await worker.snapshot({source:windowSource});await command('minimize');await assert.rejects(worker.snapshot({source:windowSource}),/window_minimized/);await command('restore');await delay(300);
  // A continuous source must stop on resize, retaining a valid finalized file.
  await worker.startRecording({source:windowSource,maxSeconds:5,fps:5,systemAudio:false});await command('resize');await delay(700);const resized=await worker.stopRecording();receipt.cases.push({test:'resize_stops_recording',recording:resized});assert.match(resized.reason,/source_resized/);assert.equal(resized.finalized,true);
  const benchmarks=[];
  for(const source of sources){await worker.snapshot({source,format:'jpeg',maxWidth:640});const times=[];let last;
    for(let n=0;n<9;n++){const begin=performance.now();last=await worker.snapshot({source,format:'jpeg',maxWidth:640});times.push(performance.now()-begin);}
    times.sort((a,b)=>a-b);benchmarks.push({mode:source.mode,p50Ms:times[4],p95Ms:times[8],readbackBytes:last.readbackBytes,imageBytes:Buffer.from(last.data,'base64').length});
  }
  receipt.benchmarks=benchmarks;
  receipt.verified=true;
}catch(error){receipt.error=error.stack;throw error;}
finally{await worker?.close().catch(()=>{});fixture.stdin.end();fixture.kill();await fs.writeFile(path.join(root,'capture-sources.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({verified:receipt.verified,cases:receipt.cases.length,error:receipt.error,report:path.join(root,'capture-sources.json')}));}
