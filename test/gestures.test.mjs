import test from 'node:test';
import assert from 'node:assert/strict';
import { HidSession } from '../src/session.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(extra={}){const sent=[];return {sent,session:new HidSession({send:async r=>{sent.push(Buffer.from(r));},...extra})};}
const sum=reports=>reports.reduce((v,r)=>({dx:v.dx+r.readInt8(2),dy:v.dy+r.readInt8(3)}),{dx:0,dy:0});
test('relative move-click completes displacement before its local pause and click',async()=>{
  const {session,sent}=fixture(),lease=await session.acquire('move-click',60000);
  const result=await session.moveClickRelative(lease.token,{dx:300,dy:-280,pauseMs:10,durationMs:1});
  assert.deepEqual(sum(sent.slice(0,-2)),{dx:300,dy:-280});assert.ok(sent.slice(0,-2).every(r=>r[1]===0));
  assert.equal(sent.at(-2)[1],1);assert.equal(sent.at(-1)[1],0);assert.equal(result.released,true);assert.ok(result.elapsedMs>=10);await session.release(lease.token);
});
test('relative drag preserves every count while holding, then releases at zero relative movement',async()=>{
  const {session,sent}=fixture(),lease=await session.acquire('drag',60000);
  const result=await session.dragRelative(lease.token,{dx:-301,dy:129,button:'right',durationMs:20,holdMs:0});
  assert.deepEqual(sum(sent),{dx:-301,dy:129});assert.ok(sent.slice(0,-1).every(r=>r[0]===4&&r[1]===2));assert.equal(sent.at(-1).toString('hex'),'0400000000');assert.equal(result.released,true);await session.release(lease.token);
});
test('cancelling drag after button-down neutralizes input and releases the lease',async()=>{
  const {session,sent}=fixture(),lease=await session.acquire('cancel-drag',60000),abort=new AbortController();
  const pending=session.dragRelative(lease.token,{dx:200,durationMs:1000,holdMs:100},{signal:abort.signal});const rejected=assert.rejects(pending);
  while(!sent.length)await delay(1);abort.abort();await rejected;assert.equal(session.status().owner,null);assert.equal(sent.findLast(r=>r[0]===4)[1],0);
});
test('expiry during move-click pause prevents the click and neutralizes input',async()=>{
  let now=0;const sent=[];const session=new HidSession({send:async r=>{sent.push(Buffer.from(r));now=1000;}},{clock:()=>now});const lease=await session.acquire('expiry',500);
  await assert.rejects(session.moveClickRelative(lease.token,{dx:1,pauseMs:20,durationMs:1}),/lease expired/);assert.equal(sent.some(r=>r[0]===4&&r[1]),false);assert.equal(session.status().owner,null);
});
test('held buttons, invalid bounds and secure desktop refuse before new gesture input',async()=>{
  const {session,sent}=fixture(),lease=await session.acquire('guard',60000);await session.moveRelative(lease.token,{buttons:1});let count=sent.length;
  await assert.rejects(session.dragRelative(lease.token,{dx:5}),/held mouse/);assert.equal(sent.length,count);await session.moveRelative(lease.token,{buttons:0});count=sent.length;
  await assert.rejects(session.dragRelative(lease.token,{dx:40000}),/dx/);await assert.rejects(session.moveClickRelative(lease.token,{pauseMs:1001}));assert.equal(sent.length,count);await session.release(lease.token);
  const secure=fixture({status:()=>({inputPaused:true,desktop:'Winlogon'})}),other=await secure.session.acquire('secure',60000);await assert.rejects(secure.session.dragRelative(other.token,{dx:1}),/ordinary desktop/);assert.equal(secure.sent.length,0);await secure.session.release(other.token);
});
test('a lost drag acknowledgement faults safely instead of replaying movement',async()=>{
  let writes=0,releases=0;const session=new HidSession({send:async()=>{if(++writes===2)throw new Error('lost ACK');},releaseInput:async()=>{releases++;}}),lease=await session.acquire('fault',60000);
  await assert.rejects(session.dragRelative(lease.token,{dx:1,durationMs:1,holdMs:0}),/lost ACK/);assert.equal(writes,2);assert.ok(releases>=1);assert.equal(session.status().faulted,true);assert.equal(session.status().owner,null);
});
