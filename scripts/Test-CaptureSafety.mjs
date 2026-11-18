// Explicit native protocol tests: invalid duration, parent EOF and heartbeat loss.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { externalRoot } from '../src/state.mjs';
if (process.argv[2] !== '--live' || !path.isAbsolute(process.argv[3] ?? '')) throw new Error('Usage: --live ABSOLUTE_EXE ABSOLUTE_TEST_ROOT');
const executable = process.argv[3], root = externalRoot(process.argv[4]);
await fs.mkdir(root, { recursive: true });
async function worker(folder) {
  const child = spawn(executable, ['serve', '--data-root', path.join(root, folder)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [], waiting = new Set();
  const exit = new Promise(resolve => child.once('exit', resolve));
  createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); messages.push(value); for (const item of waiting) if (item.test(value)) { waiting.delete(item); clearTimeout(item.timer); item.resolve(value); } });
  const wait = test => {
    const found = messages.find(test); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => { const item = { test, resolve, timer: setTimeout(() => { waiting.delete(item); reject(new Error('Native acceptance response timed out')); }, 12000) }; waiting.add(item); });
  };
  await wait(value => value.type === 'ready');
  return { child, wait, close: async () => { child.stdin.end(); let timer; await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 2000); })]); clearTimeout(timer); } };
}
const result = { startedUtc: new Date().toISOString(), inputSent: false };
for (const mode of ['parent_eof', 'heartbeat_loss']) {
  const w = await worker(mode);
  try {
    w.child.stdin.write(`record\t1\t${randomUUID()}\t601\t10\t640\t1000000\n`);
    const rejected = await w.wait(value => value.id === 1); assert.equal(rejected.ok, false); result.native601Rejected = true;
    w.child.stdin.write(`record\t2\t${randomUUID()}\t600\t10\t640\t1000000\n`);
    assert.equal((await w.wait(value => value.id === 2)).ok, true);
    const start = performance.now();
    if (mode === 'parent_eof') w.child.stdin.end();
    const finish = await w.wait(value => value.type === 'recording_finished');
    assert.equal(finish.state, 'interrupted'); assert.equal(finish.finalized, true);
    assert.equal(finish.reason, mode === 'parent_eof' ? 'parent_disconnected' : 'controller_heartbeat_lost');
    result[mode] = { ...finish, elapsedMs: Math.round(performance.now() - start) };
  } finally { await w.close(); }
}
result.passed = true; await fs.writeFile(path.join(root, 'safety-acceptance.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
