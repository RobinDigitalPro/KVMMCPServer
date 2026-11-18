// Explicit, read-only desktop observation acceptance. Never run in the unit suite.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CaptureWorker } from '../src/capture-worker.mjs';
import { externalRoot } from '../src/state.mjs';
const run = promisify(execFile);
if (process.argv[2] !== '--live' || !path.isAbsolute(process.argv[3] ?? '') || !path.isAbsolute(process.argv[4] ?? '')) throw new Error('Usage: --live ABSOLUTE_SCREEN_CAPTURE_EXE ABSOLUTE_EXTERNAL_TEST_ROOT');
const executable = process.argv[3], root = externalRoot(process.argv[4]);
await fs.mkdir(root, { recursive: true });
const worker = new CaptureWorker(executable, root);
const result = { startedUtc: new Date().toISOString(), inputSent: false, systemAudioRequested: true, screenshots: [] };
try {
  for (const options of [{ format: 'png' }, { format: 'jpeg', maxWidth: 1280 }, { format: 'png', maxWidth: 960 }]) {
    const start = performance.now(), image = await worker.snapshot(options);
    const { data, ...metadata } = image;
    result.screenshots.push({ ...metadata, bytes: Buffer.from(data, 'base64').length, elapsedMs: Math.round(performance.now() - start) });
  }
  await assert.rejects(worker.startRecording({ maxSeconds: 601 }));
  const finished = new Promise(resolve => worker.on('recording', value => { if (value.state !== 'recording') resolve(value); }));
  await worker.startRecording({ maxSeconds: 2, fps: 15, maxWidth: 1280 });
  let timer;
  try { result.recording = await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Automatic recording stop timed out')), 10000); })]); } finally { clearTimeout(timer); }
  assert.equal(result.recording.state, 'completed'); assert.equal(result.recording.finalized, true); assert.ok(result.recording.durationMs <= 2000); assert.ok(result.recording.frames > 1);
  const inspected = await run(executable, ['inspect', result.recording.path, path.join(root, 'recording-first-frame.png')], { windowsHide: true });
  result.decoded = JSON.parse(inspected.stdout); assert.equal(result.decoded.decoded, true);
  await worker.startRecording({ maxSeconds: 600, fps: 10, maxWidth: 1280 });
  result.earlyStop = await worker.stopRecording(); assert.equal(result.earlyStop.state, 'stopped'); assert.equal(result.earlyStop.finalized, true);
  result.finishedUtc = new Date().toISOString(); result.passed = true;
} finally {
  await worker.close(); await fs.writeFile(path.join(root, 'capture-acceptance.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
