// Explicit live acceptance console. No implicit click or elevation approval.
// Usage: node scripts/Test-LiveUac.mjs --live ABS_HID_EXE ABS_EXTERNAL_TEST_ROOT
// Commands on stdin: acquire, capture, status, record, record-status, probe,
// click (HID x/y supplied after visual inspection), emergency-stop, release, quit.
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { LocalClient } from '../src/local-client.mjs';
const [mode, executable, root] = process.argv.slice(2);
if (mode !== '--live' || !path.isAbsolute(executable ?? '') || !path.isAbsolute(root ?? '')) throw new Error('Explicit live mode and absolute paths required');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (path.resolve(root).toLowerCase().startsWith(source.toLowerCase() + path.sep)) throw new Error('Use an external artifact root');
await fs.mkdir(root, { recursive: true });
const client = new Client({ name: 'uac-acceptance', version: '0.5.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(source, 'src/mcp.mjs'), '--live', executable, '--data-root', root, '--agent', 'uac-acceptance'] });
let token, recordingId, probe, probeResult;
const receipt = { startedUtc: new Date().toISOString(), events: [], liveUacVerified: false };
const emit = value => { console.log(JSON.stringify(value)); };
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
};
try {
  await client.connect(transport);
  emit({ ready: true, status: await call('hid_status'), tools: (await client.listTools()).tools.length });
  for await (const line of createInterface({ input: process.stdin })) {
    let operation;
    try {
      const command = JSON.parse(line); operation = command.op; let result;
      if (command.op === 'quit') break;
      if (command.op === 'acquire') {
        if (token) await call('hid_release', { token }).catch(() => {});
        const lease = await call('hid_acquire', { owner: 'uac-acceptance', ttlMs: 60000 }); token = lease.token;
        result = { acquired: true, inputSent: false };
      } else if (command.op === 'capture') result = await call('hid_capture', { token, format: 'png', maxWidth: 1280 });
      else if (command.op === 'status') result = await call('hid_status');
      else if (command.op === 'record') { result = await call('screen_record_start', { token, maxSeconds: command.seconds ?? 30, fps: 10, maxWidth: 1280 }); recordingId = result.recordingId; }
      else if (command.op === 'record-status') result = await call('screen_record_status', { recordingId });
      else if (command.op === 'record-stop') result = await call('screen_record_stop', { recordingId });
      else if (command.op === 'emergency-stop') { result = await call('hid_emergency_stop'); token = undefined; }
      else if (command.op === 'click') {
        // Service independently verifies fresh dialog, program hash and button.
        result = await call('hid_mouse_absolute', { token, x: command.x, y: command.y, buttons: 1 });
        await call('hid_mouse_absolute', { token, x: command.x, y: command.y, buttons: 0 });
      } else if (command.op === 'release') { result = await call('hid_release', { token }); token = undefined; }
      else if (command.op === 'probe') {
        if (probe) throw new Error('A probe is already pending');
        let expected = path.join(process.env.ProgramFiles, 'KVMMCPServer', 'SecureDesktop', 'UacProbe.exe');
        await fs.access(expected);
        if (command.variant === 'unapproved') { const copy = path.join(root, `unapproved-probe-${Date.now()}.exe`); await fs.copyFile(expected, copy, 1); expected = copy; }
        else if (command.variant !== undefined) throw new Error('Unknown probe variant');
        const escaped = expected.replaceAll("'", "''");
        const script = `$ErrorActionPreference='Stop';$p=Start-Process -FilePath '${escaped}' -Verb RunAs -PassThru -Wait;Write-Output $p.ExitCode`;
        probe = spawn(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', error = ''; probe.stdout.on('data', data => { out += data; }); probe.stderr.on('data', data => { error += data; });
        probe.once('exit', code => { probeResult = { launcherExitCode: code, elevatedProbeExitCode: code === 0 ? Number(out.trim()) : null, error: error.trim().slice(0, 500) }; receipt.probe = probeResult; receipt.events.push({ at: new Date().toISOString(), op: 'probe-exit', expectedApplication: expected, result: probeResult }); emit({ probe: probeResult }); probe = undefined; });
        result = { probeStarted: true, expectedApplication: expected, approvalSent: false };
      } else throw new Error('Unknown acceptance command');
      receipt.events.push({ at: new Date().toISOString(), op: command.op, result });
      await fs.writeFile(path.join(root, 'uac-live-receipt.json'), JSON.stringify(receipt, null, 2));
      emit({ op: command.op, result });
    } catch (error) {
      receipt.events.push({ at: new Date().toISOString(), op: operation, error: error.message });
      await fs.writeFile(path.join(root, 'uac-live-receipt.json'), JSON.stringify(receipt, null, 2));
      emit({ error: error.message });
    }
  }
} finally {
  if (probe) probe.kill();
  if (token) await call('hid_release', { token }).catch(() => {});
  if (recordingId) await call('screen_record_stop', { recordingId }).catch(() => {});
  await client.close(); await transport.close();
  try { const broker = await LocalClient.connect(root, 'uac-test-cleanup'); try { await broker.request('shutdown'); } finally { broker.close(); } } catch {}
  receipt.finishedUtc = new Date().toISOString();
  receipt.probe = probeResult;
  await fs.writeFile(path.join(root, 'uac-live-receipt.json'), JSON.stringify(receipt, null, 2));
}
