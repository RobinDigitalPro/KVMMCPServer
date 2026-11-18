import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  try { await fs.rename(temporary, file); }
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
  async stopState() { return (await readJson(this.stopPath)) ?? { stopped: false }; }
  persistStop(reason) { return atomicJson(this.stopPath, { stopped: true, reason, stoppedUtc: new Date().toISOString() }); }
  // Intentionally not exposed through MCP or broker RPC.
  async resume() { await atomicJson(this.stopPath, { stopped: false, resumedUtc: new Date().toISOString() }); }
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
