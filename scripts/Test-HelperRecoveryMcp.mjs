// Explicit live test: neutralization, status and one screenshot only. No keys/clicks.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const [flag,root]=process.argv.slice(2);
if(flag!=='--live'||!path.isAbsolute(root??''))throw Error('--live ABSOLUTE_DATA_ROOT required');
const output=path.join(root,'tests','recovery-0.11','live-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
const sdk=new Client({name:'explicit-helper-recovery-acceptance',version:'0.11.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/mcp.mjs',import.meta.url)),'--connect','--data-root',root,'--agent','helper-recovery-acceptance'],stderr:'pipe'});
const report={startedUtc:new Date().toISOString(),verified:false,applicationInputReplayed:false,servicesChanged:false};let token;
const call=async(name,args={})=>{const r=await sdk.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);return r;};
const json=r=>JSON.parse(r.content[0].text);
try{
 await sdk.connect(transport);report.toolCount=(await sdk.listTools()).tools.length;assert.equal(report.toolCount,28);
 report.before=json(await call('hid_status'));assert.equal(report.before.version,'0.11.0');assert.equal(report.before.simulated,false);
 const controllerPid=report.before.pid;
 report.restart=json(await call('hid_try_restart'));assert.equal(report.restart.replayedInput??false,false);
 report.after=json(await call('hid_status'));assert.equal(report.after.pid,controllerPid);assert.equal(report.after.liveHelperConnected,true);assert.equal(report.after.operatorStop.stopped,false);assert.equal(report.after.control.owner,null);
 const lease=json(await call('hid_acquire',{owner:'helper-recovery-acceptance',ttlMs:10000}));token=lease.token;
 const image=await call('hid_capture',{token,format:'jpeg',maxWidth:640});report.capture=json(image);assert.ok(image.content.some(c=>c.type==='image'&&c.data));
 await call('hid_release',{token});token=undefined;
 const healthy=json(await call('hid_try_restart'));assert.equal(healthy.alreadyHealthy,true);assert.equal(healthy.status.native.processId,report.after.native.processId);
 report.final=json(await call('hid_status'));assert.equal(report.final.control.owner,null);report.verified=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{if(token)await call('hid_release',{token}).catch(()=>{});await sdk.close();await transport.close();report.finishedUtc=new Date().toISOString();await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({verified:report.verified,toolCount:report.toolCount,restarted:report.restart?.restarted,helperPid:report.after?.native?.processId,controllerPid:report.after?.pid,capturePath:report.capture?.path,error:report.error,receipt:output}));}
