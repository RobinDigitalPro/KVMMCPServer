import path from 'node:path';
import { parseOptions } from './broker.mjs';
import { StateStore, readJson } from './state.mjs';
import { LocalClient, ensureLocalClient } from './local-client.mjs';

const [action, ...argv] = process.argv.slice(2);
const confirm = argv.indexOf('--confirm');
const confirmation = confirm >= 0 ? argv.splice(confirm, 2)[1] : undefined;
const options = parseOptions(argv);
if (!options.dataRoot) throw new Error('Absolute --data-root required');
try {
  if (action === 'resume') {
    if (confirmation !== 'RESUME') throw new Error('Explicit local operator command requires --confirm RESUME');
    const endpoint = await readJson(path.join(options.dataRoot, 'controller', 'broker.lock'));
    if (endpoint) {
      try { process.kill(endpoint.pid, 0); throw new Error('Stop the running controller before resuming'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const store = new StateStore(options.dataRoot); await store.initialize(); await store.resume();
    console.log(JSON.stringify({ resumed: true, inputSent: false }));
  } else if (action === 'emergency-stop') {
    const store = new StateStore(options.dataRoot); await store.initialize(); await store.persistStop('operator_cli');
    let client;
    try { client = await LocalClient.connect(options.dataRoot, 'local-operator'); }
    catch (error) {
      const lock = await readJson(path.join(store.privateRoot, 'broker.lock'));
      let running = false;
      if (lock?.pid) { try { process.kill(lock.pid, 0); running = true; } catch {} }
      if (running) throw new Error('Stop persisted; controller release not confirmed: ' + error.message);
    }
    if (client) { try { console.log(JSON.stringify(await client.call('hid_emergency_stop', {}))); } finally { client.close(); } }
    else console.log(JSON.stringify({ operatorStopped: true, persisted: true, running: false }));
  } else if (action === 'status') {
    const status = await readJson(path.join(options.dataRoot, 'live-status.json')) ?? { running: false };
    status.stale = !status.updatedUtc || Date.now() - Date.parse(status.updatedUtc) > 3000;
    console.log(JSON.stringify(status, null, 2));
  } else {
    const client = action === 'start' ? await ensureLocalClient(options) : await LocalClient.connect(options.dataRoot, 'local-operator');
    try {
      if (action === 'start') console.log((await client.call('hid_status', {})).content[0].text);
      else if (action === 'stop') console.log(JSON.stringify(await client.request('shutdown')));
      else throw new Error('Use start, status, stop, emergency-stop, or resume');
    } finally { client.close(); }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
