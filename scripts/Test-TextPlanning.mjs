// Read-only native planning regression. No device is opened or input injected.
// node scripts/Test-TextPlanning.mjs ABS_HID_EXE ABS_OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const [executable,output]=process.argv.slice(2);
if(![executable,output].every(value=>value&&path.isAbsolute(value)))throw new Error('Absolute executable and external output directory required');
const plan=text=>new Promise((resolve,reject)=>{
  const child=execFile(executable,['plan-text'],{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:128*1024},(error,stdout,stderr)=>{
    try{const reply=JSON.parse(stdout);resolve({reply,exitCode:error?.code??0,jsonChars:stdout.trim().length,stderr});}catch{reject(error??new Error('Invalid native plan reply'));}
  });child.stdin.on('error',reject);child.stdin.end(JSON.stringify({text,layout:'Belgian (Period)'})+'\n');
});
const cases=[['short','MCP',true,3],['long_ascii','a'.repeat(78),true,78],['maximum_ascii','a'.repeat(1024),true,1024],['maximum_accents','ê'.repeat(1024),true,2048],['too_long','a'.repeat(1025),false],['unsupported','prefix😀',false],['normalization_expands','\u0344'.repeat(1024),false]];
const receipt={startedUtc:new Date().toISOString(),inputSent:false,tests:[]};
for(const [name,text,success,strokes] of cases){
  const result=await plan(text);assert.equal(result.reply.ok,success,name);assert.ok(result.jsonChars<=65536,name);
  if(success){assert.equal(result.exitCode,0);assert.equal(result.reply.inputSent,false);assert.equal(result.reply.plan.strokes.length,strokes,name);assert.ok(result.reply.plan.characters<=1024);}
  else assert.notEqual(result.exitCode,0,name);
  receipt.tests.push({name,inputUtf16Units:text.length,ok:result.reply.ok,exitCode:result.exitCode,jsonChars:result.jsonChars,strokes:result.reply.plan?.strokes.length});
}
receipt.verified=true;receipt.finishedUtc=new Date().toISOString();await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'planning-regressions.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
