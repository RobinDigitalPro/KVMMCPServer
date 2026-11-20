// Explicit read-only host media acceptance. No HID input or microphone.
// --live ABS_CAPTURE_EXE ABS_OPERATIONAL_ROOT ABS_EXTERNAL_TEST_OUTPUT
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const [flag,executable,dataRoot,output]=process.argv.slice(2);
if(flag!=='--live'||![executable,dataRoot,output].every(x=>x&&path.isAbsolute(x)))throw new Error('Explicit --live and absolute paths required');
await fs.mkdir(output,{recursive:true});const run=promisify(execFile);
const client=new Client({name:'buffer-live-acceptance',version:'0.8.0'});
const adapter=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--connect','--data-root',dataRoot,'--agent','media-acceptance']});
const receipt={startedUtc:new Date().toISOString(),inputSent:false,microphone:false,modes:[]};let token,buffer,recording;
const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);};
const command=async args=>JSON.parse((await run(executable,args,{windowsHide:true,timeout:20000,maxBuffer:65536})).stdout);
const lease=async()=>{({token}=await call('hid_acquire',{owner:'read-only-media-acceptance',ttlMs:15000}));};
const release=async()=>{if(token)await call('hid_release',{token});token=undefined;};
const tone=path.join(output,'quiet-test-tone.wav');
const rate=48000,samples=rate*2,wav=Buffer.alloc(44+samples*4);wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*4,40);
for(let n=0;n<samples;n++){const v=Math.round(1000*Math.sin(2*Math.PI*440*n/rate));wav.writeInt16LE(v,44+n*4);wav.writeInt16LE(v,46+n*4);}await fs.writeFile(tone,wav);
try{
  await client.connect(adapter);receipt.toolCount=(await client.listTools()).tools.length;assert.equal(receipt.toolCount,23);
  receipt.audioProbe=await command(['audio-probe']);assert.equal(receipt.audioProbe.available,true);
  for(const mode of ['audio','video','combined']){
    await lease();buffer=await call('media_buffer_start',{token,mode,profile:mode==='video'?'light':'standard'});await release();
    if(mode==='combined'){await delay(31000);await command(['test-tone',tone]);await delay(2000);}else{await delay(750);if(mode==='audio')await command(['test-tone',tone]);else await delay(2000);await delay(1000);}
    const status=await call('media_buffer_status',{bufferId:buffer.bufferId});assert.equal(status.state,'buffering');assert.equal(status.resources.limitsActive,true);assert.ok(status.availableSeconds<=30);assert.ok(status.bufferedBytes<=32*1024*1024);
    const exports=[];
    for(const seconds of mode==='combined'?[5,15,30]:[5]){
      const exported=await call('media_buffer_export',{bufferId:buffer.bufferId,seconds});assert.ok(exported.actualSeconds>0&&exported.actualSeconds<=seconds+.01);assert.equal(exported.reencoded,false);
      const decoded={audio:await command(['inspect-audio',exported.path])};assert.equal(decoded.audio.audio,mode!=='video');
      if(mode!=='audio'){decoded.video=await command(['inspect-all',exported.path,path.join(output,`${mode}-${seconds}.png`)]);assert.equal(decoded.video.endOfStream,true);}
      if(mode!=='video')assert.ok(decoded.audio.peak>100);exports.push({exported,decoded});
    }
    receipt.modes.push({mode,status,exports});console.log(JSON.stringify({verified:true,mode,availableSeconds:status.availableSeconds,privateBytes:status.resources.privateBytes,cpuPercent:status.resources.cpuPercent}));
    if(mode!=='combined')await call('media_buffer_stop',{bufferId:buffer.bufferId});
  }
  await lease();recording=await call('screen_record_start',{token,maxSeconds:60,fps:10,maxWidth:1280});await release();
  const preempted=await call('media_buffer_status',{bufferId:buffer.bufferId});assert.equal(preempted.state,'stopped');assert.equal(preempted.reason,'recording_started');
  await lease();const refused=await client.callTool({name:'media_buffer_start',arguments:{token,mode:'video'}});assert.equal(refused.isError,true);await release();
  await delay(45000);await command(['test-tone',tone]);
  for(let n=0;n<25;n++){recording=await call('screen_record_status',{recordingId:recording.recordingId});if(recording.state!=='recording')break;await delay(1000);}
  assert.equal(recording.state,'completed');assert.equal(recording.finalized,true);assert.ok(recording.durationMs>=59900);receipt.minuteRecording={recording,audio:await command(['inspect-audio',recording.path]),video:await command(['inspect-all',recording.path,path.join(output,'minute-first.png')])};assert.ok(receipt.minuteRecording.audio.peak>100);assert.equal(receipt.minuteRecording.video.endOfStream,true);
  console.log(JSON.stringify({verified:true,minuteRecording:true,frames:recording.frames,durationMs:recording.durationMs}));
  const status=await call('hid_status');assert.equal(status.operatorStop.stopped,false);assert.equal(status.liveHelperConnected,true);assert.equal(status.control.faulted,false);
  await lease();const frame=await call('hid_capture',{token,format:'jpeg',maxWidth:640});await release();receipt.finalController={healthy:true,frame};receipt.verified=true;
}catch(error){receipt.error=error.stack;throw error;}
finally{
  await release().catch(()=>{});if(recording)await call('screen_record_stop',{recordingId:recording.recordingId}).catch(()=>{});if(buffer)await call('media_buffer_stop',{bufferId:buffer.bufferId}).catch(()=>{});
  await client.close().catch(()=>{});await adapter.close().catch(()=>{});receipt.finishedUtc=new Date().toISOString();await fs.writeFile(path.join(output,'live-buffer-acceptance.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({verified:receipt.verified,error:receipt.error}));
}
