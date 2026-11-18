// Download the official, immutable Microsoft EWDK release using bounded ranges.
// No installation or execution. Existing serial prefix downloads are preserved.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const url = 'https://download.microsoft.com/download/be985897-caaa-4497-9ea4-17fa7065cd8a/EWDK_ge_release_svc_prod1_26100_250904-1728.iso';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../toolchain');
const target = path.join(root, 'EWDK-26100.iso');
const prefix = target + '.partial';
const chunksDir = path.join(root, 'ewdk-download');
await fsp.mkdir(chunksDir, { recursive: true });
if (fs.existsSync(target)) throw new Error('EWDK already downloaded');
const head = await fetch(url, { method: 'HEAD' });
if (!head.ok) throw new Error(`Microsoft HEAD: ${head.status}`);
const total = Number(head.headers.get('content-length'));
if (!Number.isSafeInteger(total) || total < 1) throw new Error('Invalid release size');
const manifestPath = path.join(chunksDir, 'manifest.json');
let manifest;
if (fs.existsSync(manifestPath)) {
  manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (manifest.url !== url || manifest.total !== total) throw new Error('Release changed; inspect download');
} else {
  manifest = { url, total, prefixBytes: fs.existsSync(prefix) ? (await fsp.stat(prefix)).size : 0, chunkSize: 256 * 1024 * 1024 };
  if (manifest.prefixBytes > total) throw new Error('Invalid serial prefix');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
if (manifest.prefixBytes && (await fsp.stat(prefix)).size !== manifest.prefixBytes) throw new Error('Serial download still running or prefix changed');
const chunks = [];
for (let start = manifest.prefixBytes; start < total; start += manifest.chunkSize) {
  const end = Math.min(total - 1, start + manifest.chunkSize - 1);
  chunks.push({ start, end, file: path.join(chunksDir, `${start}-${end}.part`) });
}
let cursor = 0, completed = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (cursor < chunks.length) {
    const c = chunks[cursor++];
    const expected = c.end - c.start + 1;
    if (!fs.existsSync(c.file) || (await fsp.stat(c.file)).size !== expected) {
      let error;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(url, { headers: { Range: `bytes=${c.start}-${c.end}` }, signal: AbortSignal.timeout(180000) });
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${c.start}-${c.end}/${total}`) throw new Error('Range response mismatch');
          await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(c.file));
          if ((await fsp.stat(c.file)).size !== expected) throw new Error('Short download');
          error = undefined; break;
        } catch (e) { error = e; }
      }
      if (error) throw error;
    }
    completed++;
    if (completed % 8 === 0 || completed === chunks.length) console.log(JSON.stringify({ downloadedChunks: completed, chunks: chunks.length, totalBytes: total }));
  }
}));
const merged = target + '.merging';
const out = fs.createWriteStream(merged, { highWaterMark: 16 * 1024 * 1024 });
try {
  for (const file of [...(manifest.prefixBytes ? [prefix] : []), ...chunks.map(c => c.file)]) {
    for await (const buffer of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) if (!out.write(buffer)) await once(out, 'drain');
  }
  out.end(); await once(out, 'finish');
} catch (error) { out.destroy(); throw error; }
if ((await fsp.stat(merged)).size !== total) throw new Error('Merged release size mismatch');
await fsp.rename(merged, target);
// Remove only the exact successful download fragments listed in this manifest.
for (const c of chunks) await fsp.unlink(c.file);
if (manifest.prefixBytes) await fsp.unlink(prefix);
await fsp.unlink(manifestPath);
await fsp.rmdir(chunksDir);
console.log(JSON.stringify({ downloaded: target, bytes: total }));
