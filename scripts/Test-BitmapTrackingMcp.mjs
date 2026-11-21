// Real SDK/stdio/broker/native acceptance; own occluded software-cursor fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {CaptureWorker} from '../src/capture-worker.mjs';
import {startBroker} from '../src/broker.mjs';
const [mode,exe,fixtureExe,root]=process.argv.slice(2),seconds=Number(process.argv[6]??60);
const templateSize=Number(process.argv[7]??32);if(![32,48].includes(templateSize))throw Error('Template size is32 or48');
const expectedCallerThreadId=process.argv[8];if(expectedCallerThreadId&&!/^[a-f0-9-]{36}$/.test(expectedCallerThreadId))throw Error('Expected calling chat must be a UUID');
if(mode!=='--live'||![exe,fixtureExe,root].every(v=>v&&path.isAbsolute(v))||!Number.isInteger(seconds)||seconds<5||seconds>90)throw Error('--live ABS_CAPTURE ABS_FIXTURE NEW_ROOT [5..90 seconds]');
await fs.mkdir(root,{recursive:false});const title='KVM Tracking '+randomUUID();
const fixture=spawn(fixtureExe,[title,path.join(root,'fixture')],{windowsHide:true,stdio:['pipe','pipe','pipe']});fixture.stderr.on('data',()=>{});
const queued=[],waiting=[];createInterface({input:fixture.stdout}).on('line',line=>{const value=JSON.parse(line),resolve=waiting.shift();resolve?resolve(value):queued.push(value);});
const next=()=>queued.length?Promise.resolve(queued.shift()):Promise.race([new Promise(resolve=>waiting.push(resolve)),delay(5000).then(()=>{throw Error('Fixture reply timeout');})]);
const command=async value=>{fixture.stdin.write(value+'\n');return next();};
const report={verified:false,inputSent:false,hidWritesSuppressed:true,releaseGatePassed:false,callerThreadId:process.env.CODEX_THREAD_ID??null,expectedCallerThreadId,durationSeconds:seconds,templateSize,cases:[],samples:[]};let capture,broker;const clients=[];let writes=0;
const call=async(client,name,args={})=>{const value=await client.callTool({name,arguments:args});if(value.isError)throw Error(name+': '+value.content[0].text);return JSON.parse(value.content[0].text);};
try{
 const geometry=await next();await command('pause');if(templateSize===48)await command('size48');capture=new CaptureWorker(exe,root);capture.on('fault',()=>{});report.trackingTransitions=[];let observedState;capture.on('tracking',s=>{if(s.state!==observedState){observedState=s.state;report.trackingTransitions.push({atUtc:new Date().toISOString(),state:s.state,reason:s.reason,fullSearches:s.fullSearches});}});
 const transport={send:async()=>{writes++;},releaseInput:async()=>{},captureAvailable:true,recordingAvailable:true,
  capture:o=>capture.snapshot(o),startTracking:o=>capture.startTracking(o),stopTracking:id=>capture.stopTracking(id),locateTracking:id=>capture.locateTracking(id),locateBitmap:o=>capture.locateBitmap(o),
  startRecording:o=>capture.startRecording(o),stopRecording:()=>capture.stopRecording(),startBuffer:o=>capture.startBuffer(o),stopBuffer:()=>capture.stopBuffer(),bufferStatus:()=>capture.bufferStatus(),exportBuffer:o=>capture.exportBuffer(o),
  onTracking:f=>{capture.on('tracking',f);return()=>capture.off('tracking',f);},onRecording:f=>{capture.on('recording',f);return()=>capture.off('recording',f);},onBuffer:f=>{capture.on('buffer',f);return()=>capture.off('buffer',f);},close:()=>capture.close()};
 broker=await startBroker({dataRoot:root,transport});
 for(let n=0;n<2;n++){const c=new Client({name:'tracking-acceptance-'+n,version:'0.10.0'});await c.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--connect','--data-root',root],stderr:'pipe'}));clients.push(c);}
 assert.equal((await clients[0].listTools()).tools.length,27);
 const source={mode:'window',title,processId:geometry.processId,area:'client'};
 const bitmapPngBase64=(await fs.readFile(path.join(root,'fixture',`cursor${templateSize}.png`))).toString('base64');
 let lease=await call(clients[0],'hid_acquire',{owner:'CPU-tracking-acceptance',ttlMs:60000});
 const adhoc=await call(clients[0],'locate_bitmap',{token:lease.token,source,bitmapPngBase64,anchor:{x:0,y:0},includeCursor:false});assert.equal(adhoc.found,true,JSON.stringify(adhoc));
 const paused=await command('pause');assert.deepEqual(adhoc.position,{x:paused.x,y:paused.y});report.cases.push({name:'adhoc_exact',result:adhoc});
 const oversized=(await fs.readFile(path.join(root,'fixture','cursor49.png'))).toString('base64');
 assert.equal((await clients[0].callTool({name:'activate_tracking',arguments:{token:lease.token,source,bitmapPngBase64:oversized}})).isError,true);
 await delay(1100);const baseStart=await capture.metrics();await delay(2000);report.baselineResources=await capture.metrics();
 const cpuRate=(a,b)=>100*(b.cpuTime100ns-a.cpuTime100ns)/(b.cpuSampleTicks100ns-a.cpuSampleTicks100ns)/b.logicalProcessors;
 report.baselineCpuPercent=cpuRate(baseStart,report.baselineResources);
 const activated=await call(clients[0],'activate_tracking',{token:lease.token,source,bitmapPngBase64,anchor:{x:0,y:0},includeCursor:false});assert.equal(activated.state,'tracking',JSON.stringify(activated));
 const id=activated.trackingId;assert.deepEqual(activated.position,{x:paused.x,y:paused.y});report.initial=activated;
 assert.equal((await clients[1].callTool({name:'locate_tracking',arguments:{trackingId:id}})).isError,true);
 await call(clients[0],'hid_release',{token:lease.token});assert.equal((await call(clients[0],'hid_status')).control.owner,null);
 await command('run');const started=performance.now();
 while(performance.now()-started<seconds*1000){await delay(200);const s=await call(clients[0],'locate_tracking',{trackingId:id});assert.equal(s.state,'tracking',JSON.stringify(s));assert.equal(s.fullSearches,1);assert.equal(s.sourceWidth,640);assert.equal(s.trackingReadbackBytes,128*128*4);report.samples.push({atMs:performance.now()-started,frames:s.framesProcessed,ageMs:s.measurementAgeMs,p95:s.matchP95Ms,matchMs:s.matchMs,cpu:s.resources.cpuPercent,privateBytes:s.resources.privateBytes,cpuCounters:s.resources});}
 const finalPoint=await command('pause');await delay(120);const final=await call(clients[0],'locate_tracking',{trackingId:id});assert.deepEqual(final.position,{x:finalPoint.x,y:finalPoint.y});report.tracked=final;
 // Shared-source media may consume a frame first; tracking must see the same
 // owned image without a second capture session or missing those updates.
 lease=await call(clients[0],'hid_acquire',{owner:'tracking-media-sharing',ttlMs:60000});
 const recording=await call(clients[0],'screen_record_start',{token:lease.token,source,maxSeconds:3,fps:15,maxWidth:640,systemAudio:false});
 await delay(3300);const recorded=await call(clients[0],'screen_record_status',{recordingId:recording.recordingId});assert.equal(recorded.finalized,true);assert.ok(recorded.frames>=30,JSON.stringify(recorded));
 const afterRecording=(await call(clients[0],'hid_status')).bitmapTracking;report.cases.push({name:'tracking_after_recording',status:afterRecording});assert.equal(afterRecording.state,'tracking',JSON.stringify(afterRecording));assert.equal(afterRecording.fullSearches,1);
 const execute=promisify(execFile);const decoded=JSON.parse((await execute(exe,['inspect-all',recorded.path,recorded.path+'.png'],{windowsHide:true,timeout:15000})).stdout);assert.equal(decoded.endOfStream,true);report.cases.push({name:'recording_shares_source',frames:recorded.frames,decodedFrames:decoded.decodedFrames});
 const buffer=await call(clients[0],'media_buffer_start',{token:lease.token,source,mode:'video',profile:'light'});await delay(4500);const duringBuffer=(await call(clients[0],'hid_status')).bitmapTracking;report.cases.push({name:'tracking_during_buffer',status:duringBuffer});assert.equal(duringBuffer.state,'tracking',JSON.stringify(duringBuffer));assert.equal(duringBuffer.fullSearches,1);
 const exported=await call(clients[0],'media_buffer_export',{bufferId:buffer.bufferId,seconds:2});await call(clients[0],'media_buffer_stop',{bufferId:buffer.bufferId});
 const bufferDecoded=JSON.parse((await execute(exe,['inspect-all',exported.path,exported.path+'.png'],{windowsHide:true,timeout:15000})).stdout);assert.equal(bufferDecoded.endOfStream,true);report.cases.push({name:'buffer_shares_source',decodedFrames:bufferDecoded.decodedFrames});
 await call(clients[0],'hid_release',{token:lease.token});
 const beforeLost=final.fullSearches;await command('teleport');await delay(250);const lostStatus=(await call(clients[0],'hid_status')).bitmapTracking;
 assert.equal(lostStatus.state,'lost',JSON.stringify(lostStatus));assert.equal(lostStatus.position,null);assert.equal(lostStatus.fullSearches,beforeLost);
 await delay(200);assert.equal((await call(clients[0],'hid_status')).bitmapTracking.fullSearches,beforeLost);
 const recovered=await call(clients[0],'locate_tracking',{trackingId:id});assert.equal(recovered.state,'tracking',JSON.stringify(recovered));assert.equal(recovered.fullSearches,beforeLost+1);report.cases.push({name:'lost_relocate_only',lost:lostStatus,recovered});
 const stopped=await call(clients[0],'stop_tracking',{trackingId:id});assert.equal(stopped.state,'stopped');assert.equal((await call(clients[0],'locate_tracking',{trackingId:id})).fullSearches,recovered.fullSearches);await call(clients[0],'stop_tracking',{trackingId:id});
 lease=await call(clients[0],'hid_acquire',{owner:'tracking-ambiguity',ttlMs:60000});await command('duplicate');await delay(100);
 const ambiguous=await call(clients[0],'locate_bitmap',{token:lease.token,source,bitmapPngBase64,includeCursor:false});report.cases.push({name:'ambiguity',result:ambiguous});assert.equal(ambiguous.found,false);assert.equal(ambiguous.reason,'ambiguous');
 await command('single');await delay(100);
 const disconnect=await call(clients[0],'activate_tracking',{token:lease.token,source,bitmapPngBase64,includeCursor:false});assert.equal(disconnect.state,'tracking');await clients[0].close();await delay(150);
 assert.equal((await call(clients[1],'hid_status')).bitmapTracking.state,'stopped');
 const samples=report.samples.slice(5),sorted=(key)=>samples.map(s=>s[key]).sort((a,b)=>a-b),quantile=(key,p)=>{const a=sorted(key);return a[Math.floor((a.length-1)*p)];};
 const counters=[activated.resources,...report.samples.map(s=>s.cpuCounters),final.resources],sustained=[];let previous=0;
 for(let n=1;n<counters.length;n++){while(previous+1<n&&counters[n].cpuSampleTicks100ns-counters[previous+1].cpuSampleTicks100ns>=100000000)previous++;if(counters[n].cpuSampleTicks100ns-counters[previous].cpuSampleTicks100ns>=100000000)sustained.push(cpuRate(counters[previous],counters[n]));}
 const averageCpu=cpuRate(activated.resources,final.resources);
 report.performance={matchP95Ms:quantile('matchMs',.95),ageP95Ms:quantile('ageMs',.95),maximumShortWindowCpuPercent:Math.max(...samples.map(s=>s.cpu)),averageCpuPercent:averageCpu,maximum10SecondCpuPercent:sustained.length?Math.max(...sustained):averageCpu,maximumPrivateBytes:Math.max(...samples.map(s=>s.privateBytes)),processedFrames:final.framesProcessed-activated.framesProcessed,observedFramesPerSecond:(final.framesProcessed-activated.framesProcessed)/seconds};
 report.gates={minuteRun:seconds>=60,matchingWithin2ms:report.performance.matchP95Ms<=2,ageWithin100ms:report.performance.ageP95Ms<=100,cpuAverageIncrementWithin2Points:averageCpu-report.baselineCpuPercent<=2,cpuSustainedIncrementWithin2Points:report.performance.maximum10SecondCpuPercent-report.baselineCpuPercent<=2,privateBytesWithin256MiB:report.performance.maximumPrivateBytes<=256*1024*1024,atLeast45FramesPerSecond:report.performance.observedFramesPerSecond>=45,noInput:writes===0};
 report.performanceGatePassed=Object.values(report.gates).every(Boolean);report.releaseGatePassed=report.performanceGatePassed&&!!expectedCallerThreadId&&report.callerThreadId===expectedCallerThreadId;assert.equal(writes,0);report.verified=true;
}catch(error){report.error=error.stack;throw error;}
finally{await Promise.allSettled(clients.map(c=>c.close()));await broker?.close().catch(()=>{});await capture?.close().catch(()=>{});fixture.stdin.end();fixture.kill();await fs.writeFile(path.join(root,'tracking-acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({verified:report.verified,releaseGatePassed:report.releaseGatePassed,performance:report.performance,error:report.error,report:path.join(root,'tracking-acceptance.json')}));}
