import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StateStore, atomicJson, readJson, externalRoot } from './state.mjs';
import { DesktopController } from './controller.mjs';

export async function startBroker({ dataRoot, simulated = false, executable, transport } = {}) {
  const store = new StateStore(dataRoot); await store.initialize();
  const lockPath = path.join(store.privateRoot, 'broker.lock');
  const instance = randomUUID();
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readJson(lockPath);
    try { process.kill(prior.pid, 0); throw new Error('Local controller already running'); }
    catch (probeError) { if (probeError.code !== 'ESRCH') throw probeError; }
    await fs.rm(lockPath);
    lock = await fs.open(lockPath, 'wx');
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, instance })); await lock.close();
  let controller, server;
  const sockets = new Set();
  const secret = randomBytes(32).toString('hex');
  const endpointPath = path.join(store.privateRoot, 'endpoint.local.json');
  let closing;
  const close = () => closing ??= (async () => {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    await controller?.close();
    if ((await readJson(endpointPath))?.instance === instance) await fs.rm(endpointPath, { force: true });
    if ((await readJson(lockPath))?.instance === instance) await fs.rm(lockPath, { force: true });
  })();
  try {
    controller = await DesktopController.create({ simulated, executable, dataRoot, store, transport });
    server = net.createServer(socket => {
      sockets.add(socket); socket.setNoDelay(true); socket.setEncoding('utf8');
      let client, buffer = '';
      const operations = new Map();
      const authTimeout = setTimeout(() => socket.destroy(), 1500);
      const send = reply => { if (!socket.destroyed) socket.write(JSON.stringify(reply) + '\n'); };
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(authTimeout); sockets.delete(socket);
        for (const abort of operations.values()) abort.abort(new Error('Agent disconnected'));
        if (client) void controller.detach(client).catch(() => {});
      });
      socket.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 65536) { socket.destroy(); return; }
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let request;
          try { request = JSON.parse(line); if (!Number.isSafeInteger(request.id) || request.id < 1 || !request.params || typeof request.params !== 'object') throw new Error(); }
          catch { socket.destroy(); return; }
          const { id, method, params } = request;
          if (!client) {
            if (method !== 'hello' || typeof params.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(params.nonce) || typeof params.proof !== 'string' || !/^[a-f0-9]{64}$/.test(params.proof)) { socket.destroy(); return; }
            const proof = role => createHmac('sha256', secret).update(`${instance}:${params.nonce}:${role}`).digest('hex');
            if (!timingSafeEqual(Buffer.from(params.proof), Buffer.from(proof('client')))) { socket.destroy(); return; }
            clearTimeout(authTimeout); client = controller.attach(params.agent);
            send({ id, result: { clientId: client, instance, simulated, executable, proof: proof('server') } });
          } else if (method === 'call') {
            if (operations.size >= 16 || operations.has(id)) { send({ id, error: 'Too many pending operations' }); continue; }
            const abort = new AbortController(); operations.set(id, abort);
            void controller.call(client, params.name, params.args, { signal: abort.signal }).then(result => send({ id, result }), () => send({ id, error: 'Controller operation failed' })).finally(() => operations.delete(id));
          } else if (method === 'cancel') { operations.get(params.requestId)?.abort(new Error('Agent cancelled request')); send({ id, result: {} }); }
          else if (method === 'shutdown') { send({ id, result: { stopping: true } }); setImmediate(() => { void close(); }); }
          else send({ id, error: 'Unknown local controller method' });
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
    await atomicJson(endpointPath, { host: '127.0.0.1', port: server.address().port, secret, pid: process.pid, instance, simulated, executable });
    return { controller, store, close, address: server.address() };
  } catch (error) { await close(); throw error; }
}

export function parseOptions(args) {
  const options = { autostart: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--simulate') options.simulated = true;
    else if (arg === '--live') { options.simulated = false; options.executable = args[++i]; }
    else if (arg === '--data-root') options.dataRoot = args[++i];
    else if (arg === '--agent') options.agent = args[++i];
    else if (arg === '--connect') options.autostart = false;
    else throw new Error('Unknown argument: ' + arg);
  }
  if (options.dataRoot) options.dataRoot = externalRoot(options.dataRoot);
  if (options.executable && !path.isAbsolute(options.executable)) throw new Error('Native executable must be absolute');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseOptions(process.argv.slice(2));
  if (!options.dataRoot || (!options.simulated && !options.executable)) throw new Error('Usage: broker.mjs --simulate|--live ABSOLUTE_NATIVE_EXE --data-root ABSOLUTE_DATA_ROOT');
  startBroker(options).then(broker => {
    const finish = () => { void broker.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); }); };
    process.once('SIGTERM', finish); process.once('SIGINT', finish);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
