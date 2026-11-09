import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, openSync, closeSync, ftruncateSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILE_MAX_BYTES, mimeFor, resolveUserPath, serveFile } from '../../src/files/serve';

const dir = mkdtempSync(`${os.tmpdir()}/hm-file-`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('resolveUserPath: absolute, ~/ and relative to the pane cwd (with this OS path rules)', () => {
  const root = path.resolve('/');
  const w = path.join(root, 'w');
  const h = path.join(root, 'h');
  expect(resolveUserPath(path.join(root, 'a', 'b.txt'), w, h)).toBe(path.join(root, 'a', 'b.txt'));
  expect(resolveUserPath('~/a.txt', w, h)).toBe(path.join(h, 'a.txt'));
  expect(resolveUserPath('src/x.ts', w, h)).toBe(path.join(w, 'src', 'x.ts'));
  expect(resolveUserPath('./x.ts', w, h)).toBe(path.join(w, 'x.ts'));
  expect(resolveUserPath('x.ts', null, h)).toBeNull();
});

test.skipIf(process.platform !== 'win32')('Windows: drive paths are absolute, ~\\ is home', () => {
  expect(resolveUserPath('C:\\Users\\me\\a.png', 'D:\\w', 'C:\\h')).toBe('C:\\Users\\me\\a.png');
  expect(resolveUserPath('~\\a.png', 'D:\\w', 'C:\\h')).toBe('C:\\h\\a.png');
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
