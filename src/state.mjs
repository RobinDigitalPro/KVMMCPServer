import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {technicalStop,sameStop} from './recovery.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const run = promisify(execFile);
export function externalRoot(value) {
  if (!value || !path.isAbsolute(value)) throw new Error('An absolute external data root is required');
  const root = path.resolve(value);
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const fold = text => process.platform === 'win32' ? text.toLowerCase() : text;
  if (fold(root) === fold(source) || fold(root).startsWith(fold(source) + path.sep)) throw new Error('Operational data must be outside the source tree');
  return root;
}
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try {
    for(let attempt=0;;attempt++){
      try{await fs.rename(temporary,file);break;}
      catch(error){if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=100)throw error;await delay(10);}
    }
  }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}
export async function readJson(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
export async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const { stdout } = await run(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-5-21-(?:\d+-){2}\d+-\d+/)?.[0];
    if (!sid) throw new Error('Cannot identify the current Windows user SID');
    // Only this new controller directory: never change the share's ACL.
    await run(path.join(system, 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
  } else await fs.chmod(directory, 0o700);
}

export class StateStore {
  #tail = Promise.resolve();
  constructor(root) { this.root = externalRoot(root); this.privateRoot = path.join(this.root, 'controller'); }
  async initialize() { await privateDirectory(this.privateRoot); }
  get stopPath() { return path.join(this.privateRoot, 'operator-stop.json'); }
  get manualStopPath() { return path.join(this.privateRoot, 'operator-inhibit.json'); }
  async stopState() { const manual=await readJson(this.manualStopPath);return manual?.stopped?manual:(await readJson(this.stopPath))??{stopped:false}; }
  async persistStop(reason,{kind='operator'}={}) {
    const value={stopped:true,reason,kind,stoppedUtc:new Date().toISOString()};
    // Recovery never deletes this separate, sticky human-inhibit file.
    if(kind==='operator')await atomicJson(this.manualStopPath,value);
    await atomicJson(this.stopPath,value);
  }
  async clearTechnicalStop(expected){
    const current=await this.stopState();
    if(!technicalStop(current)||!sameStop(current,expected))throw Error('Stop changed; local operator control is required');
    await atomicJson(this.stopPath,{stopped:false,recoveredUtc:new Date().toISOString(),previousReason:expected.reason});
    if((await this.stopState()).stopped)throw Error('Operator stopped recovery');
  }
  async recoveryState(){return await readJson(path.join(this.privateRoot,'recovery.json'))??{attempts:[]};}
  saveRecovery(value){return atomicJson(path.join(this.privateRoot,'recovery.json'),value);}
  // Intentionally not exposed through MCP or broker RPC.
  async resume() { await atomicJson(this.stopPath, { stopped: false, resumedUtc: new Date().toISOString() });await fs.rm(this.manualStopPath,{force:true}); }
  publish(status, event) {
    const operation = this.#tail.then(async () => {
      if (event) await fs.appendFile(path.join(this.root, 'events.jsonl'), JSON.stringify({ utc: new Date().toISOString(), ...event }) + '\n');
      await atomicJson(path.join(this.root, 'live-status.json'), status);
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }
  flush() { return this.#tail; }
}
