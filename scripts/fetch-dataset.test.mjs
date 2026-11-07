import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { download, validate } from './fetch-dataset.mjs';

test('reject placeholder responses, truncated JPEG and checksum mismatch', () => {
  assert.throws(() => validate(Buffer.from('Entry not found'), 'photo.jpg'), /INVALID_MEDIA/);
  assert.throws(() => validate(Buffer.alloc(1024), 'photo.jpg'), /INVALID_MEDIA/);
  const jpeg = Buffer.alloc(1024);
  jpeg.writeUInt16BE(0xffd8); jpeg.writeUInt16BE(0xffd9, 1022);
  assert.throws(() => validate(jpeg, 'photo.jpg', 'bad'), /CHECKSUM_MISMATCH/);
});

test('HTTP errors and invalid media never overwrite a destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'df-fetch-test-'));
  const server = createServer((req, res) => {
    if (req.url === '/valid') {
      const bytes = Buffer.alloc(2048);
      bytes.write('ftyp', 4);
      res.end(bytes);
      return;
    }
    res.statusCode = req.url === '/missing' ? 404 : 200;
    res.end('Entry not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fs.writeFile(path.join(root, 'photo.jpg'), 'previous file');
    const sample = { id: 'source', filename: 'photo.jpg', license: 'test', source_path: 'photos/photo.jpg' };
    for (const route of ['/missing', '/placeholder']) {
      await assert.rejects(download({ ...sample, url: `http://127.0.0.1:${server.address().port}${route}` }, root));
      assert.equal(await fs.readFile(path.join(root, 'photo.jpg'), 'utf8'), 'previous file');
    }
    await assert.rejects(download({ ...sample, filename: '../escape.jpg', url: 'http://localhost' }, root), /UNSAFE_PATH/);
    const result = await download({ ...sample, filename: 'video.mp4', url: `http://127.0.0.1:${server.address().port}/valid` }, root);
    assert.equal(result.bytes, 2048);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal((await fs.stat(path.join(root, 'video.mp4'))).size, 2048);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
