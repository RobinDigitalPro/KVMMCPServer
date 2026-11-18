// Explicit screen/system-audio acceptance. No microphone or HID input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { CaptureWorker } from '../src/capture-worker.mjs';
import { externalRoot } from '../src/state.mjs';
const run = promisify(execFile);
if (process.argv[2] !== '--live' || !path.isAbsolute(process.argv[3] ?? '')) throw new Error('Usage: --live ABSOLUTE_CAPTURE_EXE ABSOLUTE_TEST_ROOT');
const executable = process.argv[3], root = externalRoot(process.argv[4]);
const seconds = Number(process.argv[5] ?? 5);
if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) throw new Error('Optional loopback duration must be 5..600 seconds');
await fs.mkdir(root, { recursive: true });
const command = async args => JSON.parse((await run(executable, args, { windowsHide: true, timeout: 20000 })).stdout.trim());
const receipt = { startedUtc: new Date().toISOString(), inputSent: false, microphone: false };
const worker = new CaptureWorker(executable, root);
async function record(options, play) {
  const recording = await worker.startRecording(options);
  let finished;
  const done = new Promise((resolve, reject) => {
    const listener = value => { if (value.recordingId === recording.recordingId && value.state !== 'recording') { clearTimeout(timer); worker.off('recording', listener); resolve(value); } };
    const timer = setTimeout(() => { worker.off('recording', listener); reject(new Error('Audio recording deadline exceeded')); }, ((options.maxSeconds ?? 600) + 10) * 1000);
    worker.on('recording', listener);
    if (worker.recording.state !== 'recording') { clearTimeout(timer); worker.off('recording', listener); resolve(worker.recording); }
  });
  done.catch(() => {});
  try { await play?.(); finished = await done; }
  catch (error) { await worker.stopRecording(); throw error; }
  assert.equal(finished.state, 'completed'); assert.equal(finished.finalized, true);
  return { recording: finished, decoded: await command(['inspect-audio', finished.path]) };
}
try {
  receipt.probe = await command(['audio-probe']);
  // Same production muxer/clock, but explicitly marked synthetic diagnostic.
  const synthetic = await command(['self-test-av', root, randomUUID()]);
  assert.equal(synthetic.audioSource, 'synthetic_test'); assert.equal(synthetic.audio, true);
  receipt.synthetic = { recording: synthetic, decoded: await command(['inspect-audio', synthetic.path]) };
  assert.equal(receipt.synthetic.decoded.endOfStream, true); assert.ok(receipt.synthetic.decoded.peak > 2000);
  assert.ok(receipt.synthetic.decoded.firstSignalMs >= 450 && receipt.synthetic.decoded.firstSignalMs <= 550);
  assert.ok(Math.abs(receipt.synthetic.decoded.lastSignalMs - 2000) < 80);
  if (receipt.probe.available) {
    // A quiet 440-Hz test signal is played through Windows, never injected into
    // the recording. Nonzero decoded AAC therefore exercises real loopback.
    const rate = 48000, toneSeconds = 2, samples = rate * toneSeconds, wav = Buffer.alloc(44 + samples * 4);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 4, 40);
    for (let n = 0; n < samples; n++) { const value = Math.round(1000 * Math.sin(2 * Math.PI * 440 * n / rate)); wav.writeInt16LE(value, 44 + n * 4); wav.writeInt16LE(value, 46 + n * 4); }
    const tone = path.join(root, 'quiet-test-tone.wav'); await fs.writeFile(tone, wav);
    receipt.loopback = await record({ maxSeconds: seconds, maxWidth: 1280 }, async () => {
      const began = performance.now(); await new Promise(resolve => setTimeout(resolve, 750)); await command(['test-tone', tone]);
      if (seconds >= 10) { await new Promise(resolve => setTimeout(resolve, Math.max(0, (seconds - 3) * 1000 - (performance.now() - began)))); await command(['test-tone', tone]); }
    });
    assert.equal(receipt.loopback.recording.audio, true); assert.equal(receipt.loopback.recording.audioSource, 'default_render_loopback');
    assert.equal(receipt.loopback.recording.maxSeconds, seconds);
    assert.ok(receipt.loopback.recording.durationMs >= seconds * 1000 - 100);
    assert.equal(receipt.loopback.decoded.audio, true); assert.equal(receipt.loopback.decoded.endOfStream, true); assert.ok(receipt.loopback.decoded.peak > 100); assert.ok(receipt.loopback.decoded.rms > 0.0001);
    if (seconds >= 10) assert.ok(receipt.loopback.decoded.lastSignalMs >= (seconds - 5) * 1000);
    receipt.loopbackVerified = true;
  } else {
    receipt.unavailable = await record({ maxSeconds: 2, maxWidth: 640 });
    assert.equal(receipt.unavailable.recording.systemAudioRequested, true); assert.equal(receipt.unavailable.recording.audio, false); assert.equal(receipt.unavailable.recording.audioStatus, 'unavailable'); assert.equal(receipt.unavailable.decoded.audio, false);
    receipt.loopbackVerified = false;
  }
  receipt.disabled = await record({ maxSeconds: 2, maxWidth: 640, systemAudio: false });
  assert.equal(receipt.disabled.recording.audioStatus, 'disabled'); assert.equal(receipt.disabled.decoded.audio, false);
  receipt.passed = true;
} finally {
  await worker.close(); await fs.writeFile(path.join(root, 'audio-acceptance.json'), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify(receipt, null, 2));
