import test from 'node:test';
import assert from 'node:assert/strict';
import {BitmapTracking} from '../src/bitmap-tracking.mjs';
import {decodeTemplate} from '../src/bitmap-template.mjs';
import {parseTool} from '../src/tools.mjs';
function png(w=32,h=32){const chunk=(type,data=Buffer.alloc(0))=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);return b;};const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',Buffer.from([1])),chunk('IEND')]).toString('base64');}
test('PNG dimensions, bytes and anchors are bounded before a native decoder runs',()=>{
  assert.equal(decodeTemplate(png(48,48),48).width,48);
  for(const value of [png(49,32),png(32,49),png(1,32),png(100000,32),'not-png','A'.repeat(43696)])assert.throws(()=>decodeTemplate(value,48));
  assert.equal(decodeTemplate(png(128,128),128).height,128);
  assert.throws(()=>parseTool('activate_tracking',{token:'t',bitmapPngBase64:png(),minScore:.5}));
  assert.throws(()=>parseTool('locate_tracking',{trackingId:'bad'}));
});
test('one tracker is connection-owned and lease release does not transfer its ownership',async()=>{
  let metadata,listener,stops=0;const transport={onTracking:f=>(listener=f,()=>{}),startTracking:async o=>(metadata={trackingId:o.trackingId,state:'tracking',valid:true,position:{x:4,y:5}}),locateTracking:async()=>metadata,stopTracking:async()=>{stops++;return {...metadata,state:'stopped',valid:false};}};
  const tracker=new BitmapTracking(transport);const start=await tracker.start('one',{}, {},()=>true);
  await assert.rejects(tracker.call('two','locate_tracking',{trackingId:start.trackingId}),/another connection/);
  await assert.rejects(tracker.start('two',{}, {},()=>true),/already owns/);
  metadata={...metadata,state:'lost',valid:false,position:null};listener(metadata);
  assert.equal((await tracker.call('one','locate_tracking',{trackingId:start.trackingId})).state,'lost');
  await tracker.detach('two');assert.equal(stops,0);await tracker.detach('one');assert.equal(stops,1);
  await tracker.call('one','stop_tracking',{trackingId:start.trackingId});assert.equal(stops,1);
  tracker.close();
});
test('cancelled startup and disconnect cannot strand background tracking',async()=>{
  let stops=0;const tracker=new BitmapTracking({startTracking:async o=>({trackingId:o.trackingId,state:'tracking'}),stopTracking:async()=>{stops++;return {state:'stopped'};}});
  await assert.rejects(tracker.start('one',{}, {},()=>false),/cancelled/);assert.equal(stops,1);assert.equal(tracker.status().state,'stopped');
});
