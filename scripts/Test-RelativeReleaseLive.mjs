// Explicit live test in our own independently observed receiver. No VM actions.
// --live ABS_OBSERVER_EXE ABS_OPERATIONAL_ROOT NEW_EXTERNAL_OUTPUT_DIRECTORY
// Inspect the ready frame, then send "run" on stdin. No input before that gate.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const [mode,observer,dataRoot,output]=process.argv.slice(2);
if(mode!=='--live'||![observer,dataRoot,output].every(x=>x&&path.isAbsolute(x)))throw Error('Explicit --live and absolute paths required');
await fs.mkdir(output,{recursive:false});const log=path.join(output,'receiver.jsonl');
const receiver=spawn(observer,[log],{windowsHide:false,stdio:['ignore','ignore','pipe']});receiver.stderr.on('data',()=>{});
const input=createInterface({input:process.stdin});const command=new Promise((resolve,reject)=>{input.once('line',resolve);input.once('close',()=>reject(Error('Keep stdin open (use a TTY) until receiver inspection is confirmed')));});command.catch(()=>{});
const connections=[],receipt={version:'0.8.1',startedUtc:new Date().toISOString(),verified:false,scope:'dedicated physical-host receiver; no guest/game test',cases:[]};
let lease,owner;
const call=async(client,name,args={},options)=>{const r=await client.callTool({name,arguments:args},options);if(r.isError)throw Error(r.content[0].text);return JSON.parse(r.content[0].text);};
const state=async()=>{for(let n=0;n<30;n++)try{return JSON.parse((await fs.readFile(log+'.state.json','utf8')).replace(/^\uFEFF/,''));}catch(e){if(n===29)throw e;await delay(50);}};
const focused=async()=>{const s=await state();assert.equal(s.processId,receiver.pid);assert.equal(s.foreground,true,'Dedicated receiver must remain foreground');assert.ok(Date.now()-Date.parse(s.observedUtc)<2000);return s;};
const events=async after=>(await fs.readFile(log,'utf8')).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x.replace(/^\uFEFF/,''))).filter(x=>x.sequence>after&&x.kind==='mouse');
const point=s=>({x:Math.round((s.buttonLeft+s.buttonWidth/2)*32767/(s.primaryWidth-1)),y:Math.round((s.buttonTop+s.buttonHeight/2)*32767/(s.primaryHeight-1))});
const acquire=async(client,label,ttlMs=10000)=>{owner=client;({token:lease}=await call(client,'hid_acquire',{owner:label,ttlMs}));};
const release=async()=>{await call(owner,'hid_release',{token:lease});lease=undefined;};
const position=async client=>{const s=await focused();await call(client,'hid_mouse_absolute',{token:lease,...point(s),buttons:0});await delay(150);return focused();};
try{
  await state();
  for(let n=0;n<2;n++){
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--connect','--data-root',dataRoot,'--agent',`relative-release-test-${n}`]});
    const client=new Client({name:'relative-release-acceptance',version:'0.8.1'});connections.push({client,transport});await client.connect(transport);
    assert.equal((await client.listTools()).tools.length,23);assert.equal((await call(client,'hid_status')).version,'0.8.1');
  }
  const a=connections[0].client,b=connections[1].client;
  await acquire(a,'relative-release-observe');receipt.initialFrame=await call(a,'hid_capture',{token:lease,format:'jpeg',maxWidth:1280});await release();
  console.log(JSON.stringify({ready:true,frame:receipt.initialFrame.path,receiverPid:receiver.pid,next:'Inspect receiver, then send run'}));
  if((await command).trim()!=='run')throw Error('Receiver inspection not confirmed');
  await acquire(a,'absolute-bookmark-first-owner');await position(a);await release();
  for(let n=0;n<5;n++){
    const client=n%2?a:b;await acquire(client,`relative-release-owner-${n}`);const before=await focused();
    await call(client,'hid_move_click_relative',{token:lease,dx:8,dy:0,pauseMs:30,durationMs:30});await delay(150);const moved=await focused();
    assert.equal(moved.clicks,before.clicks+1);assert.ok(moved.cursorX!==before.cursorX,'Actual cursor must move before checking no snap-back');
    await release();await delay(150);const after=await focused(),raw=await events(before.events);
    assert.equal(after.cursorX,moved.cursorX);assert.equal(after.cursorY,moved.cursorY);assert.ok(raw.every(e=>!e.absolute));
    receipt.cases.push({name:`relative_click_and_release_owner_${n}`,passed:true,observedClick:true,cursorBeforeRelease:{x:moved.cursorX,y:moved.cursorY},cursorAfterRelease:{x:after.cursorX,y:after.cursorY},absoluteEvents:0});
  }
  await acquire(a,'held-absolute-release');const beforeHeld=await position(a);
  await call(a,'hid_mouse_absolute',{token:lease,...point(beforeHeld),buttons:1});await delay(100);await release();await delay(150);
  const held=await events(beforeHeld.events);assert.ok(held.some(e=>e.absolute&&(e.buttons&1)));assert.ok(held.some(e=>e.absolute&&(e.buttons&2)));
  receipt.cases.push({name:'held_absolute_button_still_releases',passed:true,absoluteDownAndUpObserved:true});

  await acquire(b,'cancel-relative-click');const beforeCancel=await position(b);const abort=new AbortController();
  const pending=call(b,'hid_move_click_relative',{token:lease,dx:8,dy:0,pauseMs:600,durationMs:80},{signal:abort.signal});const rejected=assert.rejects(pending);
  await delay(150);abort.abort();await rejected;await delay(250);const status=await call(b,'hid_status');assert.equal(status.control.owner,null);assert.equal(status.control.faulted,false);lease=undefined;
  const afterCancel=await focused();assert.equal(afterCancel.clicks,beforeCancel.clicks);assert.ok((await events(beforeCancel.events)).every(e=>!e.absolute));
  receipt.cases.push({name:'cancel_during_pause_releases_without_absolute_replay_or_click',passed:true});
  await acquire(a,'relative-release-final-observe');receipt.finalFrame=await call(a,'hid_capture',{token:lease,format:'jpeg',maxWidth:1280});await release();receipt.finalState=await focused();receipt.verified=true;
}catch(error){receipt.error=error.stack;throw error;}
finally{
  if(lease)await call(owner,'hid_release',{token:lease}).catch(()=>{});
  for(const {client,transport} of connections){await client.close().catch(()=>{});await transport.close().catch(()=>{});}
  receiver.kill();input.close();process.stdin.pause();process.stdin.unref?.();receipt.finishedUtc=new Date().toISOString();
  await fs.writeFile(path.join(output,'relative-release-live.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({verified:receipt.verified,cases:receipt.cases.length,report:path.join(output,'relative-release-live.json'),error:receipt.error}));
}
