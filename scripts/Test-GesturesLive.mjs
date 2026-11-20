// Explicit live acceptance in a dedicated, visibly inspected receiver.
// --live ABS_OBSERVER_EXE ABS_OPERATIONAL_ROOT ABS_EXTERNAL_TEST_OUTPUT
// After inspecting the printed screenshot send "run" on stdin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const [mode,observer,dataRoot,output]=process.argv.slice(2);
if(mode!=='--live'||![observer,dataRoot,output].every(x=>x&&path.isAbsolute(x)))throw new Error('Explicit --live and absolute paths required');
await fs.mkdir(output,{recursive:true});const log=path.join(output,'gesture-receiver.jsonl');
const receiver=spawn(observer,[log],{windowsHide:false,stdio:'ignore'});
const client=new Client({name:'gesture-live-acceptance',version:'0.8.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--connect','--data-root',dataRoot,'--agent','gesture-acceptance']});
const input=createInterface({input:process.stdin});const command=new Promise(resolve=>input.once('line',resolve));
const receipt={startedUtc:new Date().toISOString(),verified:false};let token;
const call=async(name,args={},options)=>{const result=await client.callTool({name,arguments:args},options);if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);};
const state=async()=>{for(let n=0;n<20;n++)try{return JSON.parse((await fs.readFile(log+'.state.json','utf8')).replace(/^\uFEFF/,''));}catch(error){if(n===19)throw error;await delay(50);}};
const foreground=async()=>{const current=await state();assert.equal(current.processId,receiver.pid);assert.equal(current.foreground,true);assert.ok(Date.now()-Date.parse(current.observedUtc)<2000);return current;};
const point=(x,y,current)=>({x:Math.round(x*32767/(current.primaryWidth-1)),y:Math.round(y*32767/(current.primaryHeight-1))});
try{
  await state();await client.connect(transport);receipt.toolCount=(await client.listTools()).tools.length;assert.equal(receipt.toolCount,23);
  ({token}=await call('hid_acquire',{owner:'gesture-live-observe',ttlMs:15000}));await call('hid_capture',{token,format:'jpeg',maxWidth:1280});
  receipt.initialFrame=await call('hid_capture',{token,format:'jpeg',maxWidth:1280});await call('hid_release',{token});token=undefined;
  console.log(JSON.stringify({ready:true,receiverPid:receiver.pid,frame:receipt.initialFrame,next:'Inspect our receiver, then send run'}));
  if((await command).trim()!=='run')throw new Error('Receiver inspection not confirmed');
  ({token}=await call('hid_acquire',{owner:'gesture-live-test',ttlMs:60000}));
  let current=await state();await call('hid_click',{token,...point(current.fieldLeft+20,current.fieldTop+15,current)});await delay(150);current=await foreground();
  await call('hid_mouse_absolute',{token,...point(current.buttonLeft+current.buttonWidth/2,current.buttonTop+current.buttonHeight/2,current),buttons:0});
  const clicks=current.clicks;receipt.moveClick=await call('hid_move_click_relative',{token,dx:8,dy:0,pauseMs:100,durationMs:50});await delay(150);current=await foreground();assert.equal(current.clicks,clicks+1);receipt.moveClick.observedClick=true;
  await call('hid_click',{token,...point(current.fieldLeft+10,current.fieldTop+10,current)});await call('hid_type_text',{token,text:'MCP relative drag selection test 0123456789',layout:'Belgian (Period)'});await delay(100);
  current=await foreground();await call('hid_mouse_absolute',{token,...point(current.fieldLeft+8,current.fieldTop+8,current),buttons:0});
  receipt.drag=await call('hid_drag_relative',{token,dx:80,dy:0,holdMs:60,durationMs:500});await delay(150);current=await foreground();assert.ok(current.selectionLength>0);receipt.drag.observedSelectionLength=current.selectionLength;
  const abort=new AbortController();const pending=call('hid_drag_relative',{token,dx:10,dy:0,holdMs:500,durationMs:2000},{signal:abort.signal});
  const cancelled=assert.rejects(pending);await delay(150);abort.abort();await cancelled;await delay(250);
  const status=await call('hid_status');assert.equal(status.control.owner,null);assert.equal(status.control.faulted,false);token=undefined;
  const events=(await fs.readFile(log,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x.replace(/^\uFEFF/,'')));
  const mouse=events.filter(x=>x.kind==='mouse');assert.ok(mouse.some(x=>(x.buttons&1)!==0));assert.ok(mouse.some(x=>(x.buttons&2)!==0));
  receipt.cancel={leaseReleased:true,controllerHealthy:true,lastMouseEvent:mouse.at(-1)};receipt.finalState=await foreground();receipt.verified=true;
}catch(error){receipt.error=error.stack;throw error;}
finally{
  if(token)await call('hid_release',{token}).catch(()=>{});await client.close().catch(()=>{});await transport.close().catch(()=>{});
  receiver.kill();input.close();process.stdin.pause();process.stdin.unref?.();receipt.finishedUtc=new Date().toISOString();
  await fs.writeFile(path.join(output,'gestures-live-acceptance.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}
