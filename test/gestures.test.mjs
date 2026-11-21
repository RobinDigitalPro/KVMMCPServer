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
for(const prior of ['move','completed-click','previous-owner'])test(`relative click and release never replay an absolute ${prior}`,async()=>{
  const {session,sent}=fixture();let lease=await session.acquire('first',15000);
  if(prior==='completed-click')await session.click(lease.token,{x:12000,y:16000,durationMs:1});
  else await session.moveAbsolute(lease.token,{x:12000,y:16000});
  if(prior==='previous-owner'){await session.release(lease.token);lease=await session.acquire('second',15000);}
  const begin=sent.length;await session.moveClickRelative(lease.token,{dx:17,dy:-9,pauseMs:0,durationMs:1});await session.release(lease.token);
  assert.ok(sent.slice(begin).every(r=>r[0]!==3));assert.deepEqual(sum(sent.slice(begin).filter(r=>r[0]===4)),{dx:17,dy:-9});
});
test('relative neutral does not hide a button still held in the absolute collection',async()=>{
  const {session,sent}=fixture(),lease=await session.acquire('collections',15000);
  await session.moveAbsolute(lease.token,{x:123,y:456,buttons:1});await session.moveRelative(lease.token,{buttons:0});const begin=sent.length;
  await assert.rejects(session.moveClickRelative(lease.token,{dx:10}),/held mouse/);assert.equal(sent.length,begin);
  await session.release(lease.token);assert.equal(sent.at(-1).toString('hex'),'03007b00c80100');
});
test('lost absolute button-up acknowledgement retains the pending release',async()=>{
  const sent=[];let failUp=true;
  const session=new HidSession({send:async r=>{sent.push(Buffer.from(r));if(r[0]===3&&!r[1]&&failUp){failUp=false;throw new Error('lost up ack');}}}),lease=await session.acquire('uncertain-up',15000);
  await session.moveAbsolute(lease.token,{x:123,y:456,buttons:1});await assert.rejects(session.moveAbsolute(lease.token,{x:123,y:456,buttons:0}),/lost up ack/);
  assert.equal(sent.filter(r=>r[0]===3&&!r[1]).length,2);assert.equal(session.status().owner,null);
});
test('lost absolute movement acknowledgement without held buttons does not invent an absolute release',async()=>{
  const sent=[];const session=new HidSession({send:async r=>{sent.push(Buffer.from(r));if(sent.length===1)throw new Error('lost move ack');}}),lease=await session.acquire('uncertain-move',15000);
  await assert.rejects(session.moveAbsolute(lease.token,{x:123,y:456}),/lost move ack/);assert.equal(sent.filter(r=>r[0]===3).length,1);
});
test('native desktop reset forgets held absolute state before the next relative gesture',async()=>{
  let epoch=0;const {session,sent}=fixture({status:()=>({inputResetEpoch:epoch})}),lease=await session.acquire('desktop-reset',15000);
  await session.moveAbsolute(lease.token,{x:123,y:456,buttons:1});epoch++;const begin=sent.length;
  await session.moveClickRelative(lease.token,{dx:5,pauseMs:0,durationMs:1});await session.release(lease.token);assert.ok(sent.slice(begin).every(r=>r[0]!==3));
});
test('failed absolute cleanup retains enough state for a later emergency release',async()=>{
  const sent=[];let fail=false;
  const session=new HidSession({send:async r=>{sent.push(Buffer.from(r));if(fail&&r[0]===3&&!r[1])throw new Error('release failed');}}),lease=await session.acquire('retry-release',15000);
  await session.moveAbsolute(lease.token,{x:123,y:456,buttons:1});fail=true;await assert.rejects(session.release(lease.token),/release failed/);fail=false;
  await session.emergencyStop();assert.equal(sent.at(-1).toString('hex'),'03007b00c80100');
});
