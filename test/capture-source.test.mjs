import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceWire} from '../src/capture-source.mjs';
import {parseTool} from '../src/tools.mjs';
test('all visual tools share strict fullscreen, window and region selectors',()=>{
  const sources=[{mode:'fullscreen'},{mode:'region',x:0,y:0,width:640,height:480},{mode:'window',title:'Voorbeeld — venster\tmet tab',area:'client',processId:123}];
  for(const name of ['hid_capture','screen_record_start','media_buffer_start'])for(const source of sources)assert.deepEqual(parseTool(name,{token:'t',...(name==='media_buffer_start'?{mode:'video'}:{}),source}).source,source);
  assert.equal(sourceWire(), 'fullscreen');assert.equal(sourceWire(sources[1]),'region:0:0:640:480');assert.ok(!/[\t\r\n]/.test(sourceWire(sources[2])));
});
test('selectors reject mixed modes, invalid sizes, missing windows and unsupported displays',()=>{
  for(const source of [{mode:'window'},{mode:'window',title:''},{mode:'window',title:'a\0b'},{mode:'window',title:'x',processId:0},{mode:'region',x:-1,y:0,width:3,height:3},{mode:'region',x:0,y:0,width:1,height:3},{mode:'fullscreen',x:10},{mode:'fullscreen',display:'secondary'},{mode:'region',x:0,y:0,width:100,height:100,title:'oops'}])assert.throws(()=>sourceWire(source));
  assert.throws(()=>parseTool('media_buffer_start',{token:'t',mode:'audio',source:{mode:'fullscreen'}}),/Audio-only/);
});
test('fresh-frame wait is bounded and does not change the capture source',()=>{
  assert.equal(parseTool('hid_capture',{token:'t',maxWaitMs:200}).maxWaitMs,200);
  for(const maxWaitMs of [-1,201,1.5])assert.throws(()=>parseTool('hid_capture',{token:'t',maxWaitMs}));
});
