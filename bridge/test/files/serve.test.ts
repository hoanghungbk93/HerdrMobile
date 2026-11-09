import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { FILE_MAX_BYTES, mimeFor, resolveUserPath, serveFile } from '../../src/files/serve';

const dir = mkdtempSync(`${os.tmpdir()}/hm-file-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('resolveUserPath: absolute, ~/ and relative to the pane cwd', () => {
  expect(resolveUserPath('/a/b.txt', '/w', '/h')).toBe('/a/b.txt');
  expect(resolveUserPath('~/a.txt', '/w', '/h')).toBe('/h/a.txt');
  expect(resolveUserPath('src/x.ts', '/w', '/h')).toBe('/w/src/x.ts');
  expect(resolveUserPath('./x.ts', '/w', '/h')).toBe('/w/x.ts');
  expect(resolveUserPath('x.ts', null, '/h')).toBeNull();
});

test('mimeFor by extension', () => {
  expect(mimeFor('a.PNG')).toBe('image/png');
  expect(mimeFor('a.jpeg')).toBe('image/jpeg');
  expect(mimeFor('a.pdf')).toBe('application/pdf');
  expect(mimeFor('a.unknown')).toBe('application/octet-stream');
});

test('serves exact bytes with a UTF-8 filename', async () => {
  const p = `${dir}/ảnh chụp.png`;
  writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const res = await serveFile(p);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  expect(res.headers.get('content-length')).toBe('7');
  expect(res.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('ảnh chụp.png')}`);
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
});

test('a symlink is followed', async () => {
  writeFileSync(`${dir}/real.txt`, 'hi');
  symlinkSync(`${dir}/real.txt`, `${dir}/link.txt`);
  expect(await (await serveFile(`${dir}/link.txt`)).text()).toBe('hi');
});

test('directory, missing and too large', async () => {
  mkdirSync(`${dir}/d`);
  const d = await serveFile(`${dir}/d`);
  expect(d.status).toBe(400);
  expect(await d.json()).toEqual({ code: 'not_file' });
  expect((await serveFile(`${dir}/nope`)).status).toBe(404);
  const big = `${dir}/big.bin`;
  const fd = openSync(big, 'w');
  ftruncateSync(fd, FILE_MAX_BYTES + 1); // sparse: nothing is written or read
  closeSync(fd);
  const r = await serveFile(big);
  expect(r.status).toBe(413);
  expect(await r.json()).toEqual({ code: 'too_large' });
});
