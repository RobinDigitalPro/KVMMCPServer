// Native diagnostics only: synthetic pixels/system-audio source. No desktop
// capture, microphone, HID device, kernel change or input injection.
// node scripts/Test-MediaBuffer.mjs ABS_SCREEN_CAPTURE_EXE ABS_EXTERNAL_OUTPUT
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CaptureWorker } from '../src/capture-worker.mjs';
const [executable, output] = process.argv.slice(2);
if (![executable,output].every(x=>x&&path.isAbsolute(x))) throw new Error('Absolute executable and external output directory required');
await fs.mkdir(output,{recursive:true});
const run=async args=>{
  const {stdout,stderr}=await promisify(execFile)(executable,args,{windowsHide:true,timeout:65000,maxBuffer:512*1024});
  assert.equal(stderr,'');return stdout.trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
};
const receipt={startedUtc:new Date().toISOString(),synthetic:true,inputSent:false,captureOpened:false,cases:[]};
try {
  receipt.history=(await run(['self-test-history']))[0];assert.equal(receipt.history.ok,true);
  const worker=new CaptureWorker(executable,path.join(output,'protocol'));
  try {
    receipt.worker=await worker.bufferStatus();assert.equal(receipt.worker.resources.limitsActive,true);
    assert.equal(receipt.worker.resources.cpuHardCapPercent,5);assert.equal(receipt.worker.resources.privateCommitLimitBytes,512*1024*1024);
    await assert.rejects(worker.startBuffer({mode:'combined',profile:'ultra'}));
    await assert.rejects(worker.exportBuffer({seconds:31}));
  }finally{await worker.close();}
  for(const mode of ['audio','video','combined'])for(const profile of ['light','standard','high']){
    const folder=path.join(output,`${mode}-${profile}`);const seconds=mode==='combined'?35:4;
    const results=await run(['guarded-self-test-buffer','--data-root',folder,mode,profile,String(seconds)]);
    assert.equal(results.length,3);
    for(const result of results){
      assert.equal(result.ok,true);assert.equal(result.resources.limitsActive,true);
      assert.ok(result.actualSeconds>0&&result.actualSeconds<=result.requestedSeconds+.01);
      assert.ok(result.bufferedBytes<=32*1024*1024);assert.ok(result.availableSeconds<=30);
      if(seconds>30)assert.ok(result.availableSeconds>25);
      const decoded={};
      if(mode!=='audio'){
        decoded.video=(await run(['inspect-all',result.exportPath,path.join(folder,`${result.requestedSeconds}.png`)]))[0];
        assert.equal(decoded.video.ok,true);assert.equal(decoded.video.endOfStream,true);assert.ok(decoded.video.decodedFrames>1);
        assert.ok(Math.abs(decoded.video.durationMs-result.actualSeconds*1000)<250);
      }
      decoded.audio=(await run(['inspect-audio',result.exportPath]))[0];assert.equal(decoded.audio.audio,mode!=='video');
      if(mode!=='video'){assert.equal(decoded.audio.sampleRate,48000);assert.equal(decoded.audio.channels,2);assert.equal(decoded.audio.endOfStream,true);}
      result.decoded=decoded;
    }
    const live=path.join(folder,mode==='audio'?'live.m4a':'live.mp4');assert.ok((await fs.stat(live)).size>100);
    receipt.cases.push({mode,profile,ranSeconds:seconds,exports:results});
    console.log(JSON.stringify({verified:true,mode,profile,ranSeconds:seconds,availableSeconds:results[0].availableSeconds,privateBytes:results[0].resources.privateBytes}));
  }
  receipt.verified=true;
}catch(error){receipt.verified=false;receipt.error=error.stack;throw error;}
finally{receipt.finishedUtc=new Date().toISOString();await fs.writeFile(path.join(output,'native-buffer-acceptance.json'),JSON.stringify(receipt,null,2));}
