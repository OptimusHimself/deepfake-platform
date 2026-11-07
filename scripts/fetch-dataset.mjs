// Node 22+. Only verified downloads are promoted from .part to their final name.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validate(bytes, filename, expectedHash) {
  if (bytes.length < 1024) throw new Error('INVALID_MEDIA: file smaller than 1KB');
  const ext = path.extname(filename).toLowerCase();
  if (['.jpg', '.jpeg'].includes(ext)) {
    if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)
      throw new Error('INVALID_MEDIA: incomplete JPEG');
  } else if (ext === '.mp4') {
    if (bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('INVALID_MEDIA: MP4 header missing');
  } else throw new Error('UNSUPPORTED_FORMAT: expected JPEG or MP4');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash && sha256 !== expectedHash) throw new Error('CHECKSUM_MISMATCH');
  return sha256;
}

export async function download(sample, root, attempts = 3) {
  for (const key of ['id', 'url', 'filename', 'license', 'source_path']) {
    if (!sample[key]) throw new Error(`MISSING_METADATA: ${key}`);
  }
  const target = path.resolve(root, sample.filename);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('UNSAFE_PATH');
  await fs.mkdir(path.dirname(target), { recursive: true });
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(sample.url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const sha256 = validate(bytes, target, sample.sha256);
      await fs.writeFile(target + '.part', bytes);
      await fs.rename(target + '.part', target);
      return { ...sample, sha256, bytes: bytes.length, downloaded_at: new Date().toISOString() };
    } catch (error) {
      lastError = error;
      if (/HTTP_4\d\d|INVALID_MEDIA|CHECKSUM_MISMATCH|UNSUPPORTED_FORMAT/.test(error.message)) break;
    }
  }
  throw new Error(`${sample.id}: ${lastError.message}`);
}

async function main() {
  const [planFile, output] = process.argv.slice(2);
  if (!planFile || !output) throw new Error('Usage: node scripts/fetch-dataset.mjs plan.json output-directory');
  const samples = JSON.parse(await fs.readFile(planFile, 'utf8'));
  const records = [];
  for (const sample of samples) {
    records.push(await download(sample, output));
    console.log(`Verified ${sample.id}`);
  }
  const manifest = path.join(output, 'manifest.jsonl');
  await fs.writeFile(manifest + '.part', records.map(r => JSON.stringify(r)).join('\n') + '\n');
  await fs.rename(manifest + '.part', manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
