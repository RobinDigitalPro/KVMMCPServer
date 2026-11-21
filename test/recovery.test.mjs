import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {DesktopController} from '../src/controller.mjs';
import {StateStore,atomicJson} from '../src/state.mjs';
import {recoverableFault,budget} from '../src/recovery.mjs';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {createMcpServer} from '../src/mcp.mjs';
const text=r=>JSON.parse(r.content[0].text);
async function fixture(t,{store=false,nextReady}={}){
 let state;
 if(store){const base=process.env.HID_TEST_ROOT??os.tmpdir();await fs.mkdir(base,{recursive:true});state=new StateStore(await fs.mkdtemp(path.join(base,'recovery-')));await state.initialize();}
 const helpers=[];
 const factory=onFault=>{
  const index=helpers.length,helper={failed:false,closed:false,sent:[],neutral:0,pings:0,captureAvailable:true,
   async ready(){if(index>0&&nextReady)await nextReady();},status(){return {connected:!this.failed&&!this.closed,currentSession:1,consoleSession:1};},
   async send(report){if(this.failed)throw Error('failed transport');this.sent.push([...report]);},
   async ping(){if(this.failed)throw Error('failed transport');this.pings++;},async releaseInput(){this.neutral++;},
   async capture(){return {data:'AA==',mimeType:'image/png',frameId:'fixture-frame'};},async close(){this.closed=true;},
   fail(reason='heartbeat_timeout'){this.failed=true;onFault(Error(reason));}};
  helpers.push(helper);return helper;
 };
 const controller=await DesktopController.create({simulated:false,store:state,transportFactory:factory}),client=controller.attach('recovery-test');
 t.after(()=>controller.close());return {controller,client,helpers,state,call:(name,args={},context)=>controller.call(client,name,args,context)};
}
test('recovery allowlist and bounded retry budget do not admit manual or session stops',()=>{
 for(const reason of ['heartbeat_timeout','native helper exited (2)','write EPIPE'])assert.equal(recoverableFault(reason),true);
 for(const reason of ['operator_request','operator_hotkey','console_session_changed','interactive_desktop_unavailable','unknown'])assert.equal(recoverableFault(reason),false);
 assert.equal(budget({attempts:[1000,32000,63000]},64000).retryAfterMs,237000);
});
test('healthy try-restart leaves the current helper and lease untouched',async t=>{
 const f=await fixture(t),lease=text(await f.call('hid_acquire',{owner:'active'}));
 const reply=text(await f.call('hid_try_restart'));assert.equal(reply.alreadyHealthy,true);assert.equal(f.helpers.length,1);
 assert.equal(f.controller.status().control.owner,'active');await f.call('hid_release',{token:lease.token});
});
test('explicit technical recovery replaces only the helper, invalidates old lease and requires a fresh capture',async t=>{
 const f=await fixture(t),old=text(await f.call('hid_acquire',{owner:'before'}));
 await f.call('hid_keyboard',{token:old.token,keys:[4]});f.helpers[0].fail();
 const reply=await f.call('hid_try_restart');assert.ok(!reply.isError,JSON.stringify(reply));assert.equal(text(reply).restarted,true);
 assert.equal(f.helpers.length,2);assert.equal(f.helpers[0].closed,true);assert.equal(f.helpers[1].neutral,1);assert.equal(f.helpers[1].sent.length,0);
 assert.equal((await f.call('hid_keyboard',{token:old.token,keys:[4]})).isError,true);
 const fresh=text(await f.call('hid_acquire',{owner:'after'}));
 assert.equal((await f.call('hid_keyboard',{token:fresh.token,keys:[4]})).isError,true);
 assert.ok(!(await f.call('hid_capture',{token:fresh.token})).isError);
 assert.ok(!(await f.call('hid_keyboard',{token:fresh.token,keys:[]})).isError);await f.call('hid_release',{token:fresh.token});
 // A late fault from the disposed generation cannot stop its replacement.
 f.helpers[0].fail();await delay(20);assert.equal(f.controller.status().operatorStop.stopped,false);
});
test('manual emergency stop cannot be cleared by MCP, including after a prior technical fault',async t=>{
 const f=await fixture(t,{store:true});f.helpers[0].fail();await f.call('hid_emergency_stop');
 assert.equal((await f.call('hid_try_restart')).isError,true);assert.equal(f.helpers.length,1);
 assert.equal((await f.state.stopState()).kind,'operator');assert.equal((await fs.stat(f.state.manualStopPath)).isFile(),true);
});
test('operator stop during startup cancels recovery and remains durably latched',async t=>{
 let open;const gate=new Promise(resolve=>{open=resolve;});
 const f=await fixture(t,{store:true,nextReady:()=>gate});f.helpers[0].fail();const pending=f.call('hid_try_restart');
 for(let i=0;i<500&&f.helpers.length<2;i++)await delay(10);assert.equal(f.helpers.length,2);
 await f.call('hid_emergency_stop');open();assert.equal((await pending).isError,true);
 assert.equal((await f.state.stopState()).kind,'operator');assert.equal(f.controller.status().control.operatorStopped,true);
 assert.equal(f.helpers[1].closed,true);assert.equal((await f.call('hid_try_restart')).isError,true);
});
test('external operator latch wins even if the technical stop file is cleared concurrently',async t=>{
 const f=await fixture(t,{store:true});await f.state.persistStop('heartbeat_timeout',{kind:'technical'});const expected=await f.state.stopState();
 await f.state.persistStop('operator_cli');await assert.rejects(f.state.clearTechnicalStop(expected),/operator|Stop changed/i);
 await atomicJson(f.state.stopPath,{stopped:false});assert.equal((await f.state.stopState()).kind,'operator');
});
test('parallel recovery calls create only one replacement and cooldown survives controller restart',async t=>{
 let open;const gate=new Promise(resolve=>{open=resolve;});
 const f=await fixture(t,{store:true,nextReady:()=>gate});f.helpers[0].fail();const pending=f.call('hid_try_restart');
 for(let i=0;i<500&&f.helpers.length<2;i++)await delay(10);
 assert.equal((await f.call('hid_try_restart')).isError,true);open();assert.ok(!(await pending).isError);
 f.helpers[1].fail();const again=await f.call('hid_try_restart');assert.equal(again.isError,true);assert.match(again.content[0].text,/COOLDOWN/);
 assert.equal((await f.state.recoveryState()).attempts.length,1);
 await f.controller.close();const next=await DesktopController.create({simulated:true,store:f.state});t.after(()=>next.close());const id=next.attach('after-broker-restart');
 const retry=await next.call(id,'hid_try_restart',{});assert.equal(retry.isError,true);assert.match(retry.content[0].text,/COOLDOWN/);
});
test('failed replacement leaves technical stop intact and never exposes its session',async t=>{
 const f=await fixture(t,{nextReady:async()=>{throw Error('helper startup rejected');}});f.helpers[0].fail();
 const reply=await f.call('hid_try_restart');assert.equal(reply.isError,true);assert.equal(f.controller.status().operatorStop.stopped,true);
 assert.equal(f.helpers[1].closed,true);assert.equal(f.helpers[1].sent.length,0);assert.equal((await f.call('hid_acquire',{owner:'blocked'})).isError,true);
});
test('cancelled recovery does not replace the helper or clear its technical stop',async t=>{
 const f=await fixture(t),abort=new AbortController();f.helpers[0].fail();abort.abort(Error('cancelled by caller'));
 const reply=await f.call('hid_try_restart',{}, {signal:abort.signal});assert.equal(reply.isError,true);assert.equal(f.helpers.length,1);assert.equal(f.controller.status().operatorStop.stopped,true);
});
test('official MCP client discovers recovery and invokes it without exposing operator resume',async t=>{
 const f=await fixture(t),server=createMcpServer({call:f.call}),sdk=new Client({name:'helper-recovery-test',version:'1'}),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 try{
  await Promise.all([server.connect(serverTransport),sdk.connect(clientTransport)]);
  assert.equal((await sdk.listTools()).tools.some(t=>t.name==='hid_try_restart'),true);
  f.helpers[0].fail();const reply=await sdk.callTool({name:'hid_try_restart',arguments:{}});assert.ok(!reply.isError);assert.equal(text(reply).restarted,true);assert.equal(text(reply).status.recovery.inProgress,false);
  await sdk.callTool({name:'hid_emergency_stop',arguments:{}});assert.equal((await sdk.callTool({name:'hid_try_restart',arguments:{}})).isError,true);
 }finally{await sdk.close();await server.close();}
});
