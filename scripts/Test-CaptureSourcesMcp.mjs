// Actual SDK -> stdio -> broker -> native GPU capture, isolated and HID-free.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {CaptureWorker} from '../src/capture-worker.mjs';
import {startBroker} from '../src/broker.mjs';
const [mode,exe,fixtureExe,root]=process.argv.slice(2);if(mode!=='--live'||![exe,fixtureExe,root].every(x=>x&&path.isAbsolute(x)))throw Error('--live ABS_CAPTURE ABS_FIXTURE NEW_OUTPUT required');
const seconds=Number(process.argv[6]??60);if(!Number.isInteger(seconds)||seconds<2||seconds>600)throw Error('Optional duration must be 2..600 seconds');
await fs.mkdir(root,{recursive:false});const title='MCP Capture '+randomUUID();const fixture=spawn(fixtureExe,[title],{windowsHide:true,stdio:['pipe','pipe','pipe']});fixture.stderr.on('data',()=>{});
const ready=new Promise(resolve=>createInterface({input:fixture.stdout}).once('line',line=>resolve(JSON.parse(line))));
const capture=new CaptureWorker(exe,root),execute=promisify(execFile);capture.on('fault',()=>{});let writes=0;
const transport={send:async()=>{writes++;},releaseInput:async()=>{},captureAvailable:true,recordingAvailable:true,capture:o=>capture.snapshot(o),startRecording:o=>capture.startRecording(o),stopRecording:()=>capture.stopRecording(),startBuffer:o=>capture.startBuffer(o),bufferStatus:()=>capture.bufferStatus(),stopBuffer:()=>capture.stopBuffer(),exportBuffer:o=>capture.exportBuffer(o),onRecording:f=>{capture.on('recording',f);return()=>capture.off('recording',f);},onBuffer:f=>{capture.on('buffer',f);return()=>capture.off('buffer',f);},close:()=>capture.close()};
const broker=await startBroker({dataRoot:root,transport}),clients=[],receipt={verified:false,hidWritesSuppressed:true,inputSent:false,snapshots:[]};
const call=async(c,name,args={})=>{const r=await c.callTool({name,arguments:args});assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
try{
  await ready;for(let n=0;n<2;n++){const c=new Client({name:'capture-source-test-'+n,version:'0.9.0'});clients.push(c);await c.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--connect','--data-root',root],stderr:'pipe'}));}
  const [a,b]=clients,catalog=(await a.listTools()).tools;assert.equal(catalog.length,23);assert.ok(catalog.find(x=>x.name==='hid_capture').inputSchema.properties.source);
  let {token}=await call(a,'hid_acquire',{owner:'capture-sources',ttlMs:15000});
  const source={mode:'window',title};
  for(const s of [{mode:'fullscreen'},{mode:'region',x:0,y:0,width:320,height:240},source]){const frame=await call(a,'hid_capture',{token,source:s,format:'jpeg',maxWidth:640});assert.equal(frame.source.mode,s.mode);receipt.snapshots.push(frame);}
  receipt.recording=await call(a,'screen_record_start',{token,source,maxSeconds:seconds,fps:5,maxWidth:640});assert.equal(receipt.recording.source.mode,'window');await call(a,'hid_release',{token});
  assert.equal((await b.callTool({name:'screen_record_stop',arguments:{recordingId:receipt.recording.recordingId}})).isError,true);
  for(let n=0;n<seconds+15;n++){await delay(1000);const status=await call(a,'screen_record_status',{recordingId:receipt.recording.recordingId});if(status.state!=='recording'){receipt.completed=status;break;}}
  assert.equal(receipt.completed?.state,'completed');assert.equal(receipt.completed.finalized,true);assert.ok(receipt.completed.durationMs>=seconds*1000-1000);
  receipt.decoded=JSON.parse((await execute(exe,['inspect-all',receipt.completed.path,receipt.completed.path+'.png'],{windowsHide:true,timeout:30000})).stdout.trim());assert.equal(receipt.decoded.endOfStream,true);assert.ok(receipt.decoded.decodedFrames>=Math.min(10,seconds*2));
  receipt.audio=JSON.parse((await execute(exe,['inspect-audio',receipt.completed.path],{windowsHide:true,timeout:30000})).stdout.trim());
  if(receipt.completed.audio){assert.equal(receipt.audio.audio,true);assert.equal(receipt.audio.endOfStream,true);}
  ({token}=await call(a,'hid_acquire',{owner:'combined-window-buffer',ttlMs:15000}));const buffer=await call(a,'media_buffer_start',{token,mode:'combined',profile:'light',source});await call(a,'hid_release',{token});
  for(let n=0;n<30;n++){await delay(500);const s=await call(a,'media_buffer_status',{bufferId:buffer.bufferId});assert.equal(s.state,'buffering',JSON.stringify(s));if(s.availableSeconds>=5){receipt.buffer=s;break;}}
  assert.ok(receipt.buffer);receipt.exported=await call(a,'media_buffer_export',{bufferId:buffer.bufferId,seconds:5});assert.equal(receipt.exported.source.mode,'window');await call(a,'media_buffer_stop',{bufferId:buffer.bufferId});
  receipt.bufferDecoded=JSON.parse((await execute(exe,['inspect-all',receipt.exported.path,receipt.exported.path+'.png'],{windowsHide:true,timeout:30000})).stdout.trim());assert.equal(receipt.bufferDecoded.endOfStream,true);assert.ok(receipt.bufferDecoded.decodedFrames>1);
  receipt.bufferAudio=JSON.parse((await execute(exe,['inspect-audio',receipt.exported.path],{windowsHide:true,timeout:30000})).stdout.trim());assert.equal(receipt.bufferAudio.audio,true);assert.equal(receipt.bufferAudio.endOfStream,true);assert.equal(writes,0);receipt.verified=true;
}catch(error){receipt.error=error.stack;throw error;}
finally{for(const c of clients)await c.close().catch(()=>{});await broker.close();fixture.stdin.end();fixture.kill();await fs.writeFile(path.join(root,'mcp-capture-sources.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({verified:receipt.verified,inputSent:false,report:path.join(root,'mcp-capture-sources.json'),error:receipt.error}));}
