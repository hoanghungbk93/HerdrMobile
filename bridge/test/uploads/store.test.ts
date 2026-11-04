import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UploadStore, UploadTooLarge } from '../../src/uploads/store';

const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime();
let root: string;
let store: UploadStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'herdr-uploads-'));
  store = new UploadStore(root, () => NOW);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const blob = (s: string) => new Blob([s]);

describe('UploadStore.save', () => {
  test('saves under yyyy-mm-dd', async () => {
    const p = await store.save('a.png', blob('hello'));
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(path.join(root, '2026-11-03') + path.sep)).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('hello');
  });

  test('keeps unicode name', async () => {
    const p = await store.save('ảnh chụp màn hình.png', blob('x'));
    expect(path.basename(p)).toBe('ảnh chụp màn hình.png');
  });

  test('dedupes', async () => {
    const a = await store.save('a.png', blob('1'));
    const b = await store.save('a.png', blob('2'));
    const c = await store.save('a.png', blob('3'));
    expect([a, b, c].map((p) => path.basename(p))).toEqual(['a.png', 'a (1).png', 'a (2).png']);
    expect(await readFile(a, 'utf8')).toBe('1');
  });

  test('long names are cut to 200 UTF-8 bytes on a character boundary, keeping the extension, then deduped', async () => {
    const long = `${'ảnh chụp màn hình rất dài '.repeat(20)}.png`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(255);
    const a = path.basename(await store.save(long, blob('1')));
    const b = path.basename(await store.save(long, blob('2')));
    expect(a.endsWith('.png')).toBe(true);
    expect(Buffer.byteLength(a)).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(a)).toBeGreaterThan(190);
    expect(a).not.toContain('\uFFFD');
    expect(Buffer.from(a, 'utf8').toString('utf8')).toBe(a); // no split multi-byte char
    expect(long.startsWith(a.slice(0, -4))).toBe(true);
    expect(b).toBe(`${a.slice(0, -4)} (1).png`);
    expect(await readFile(path.join(root, '2026-11-03', a), 'utf8')).toBe('1');
    // an absurd "extension" is not kept
    const odd = path.basename(await store.save(`x.${'é'.repeat(150)}`, blob('x')));
    expect(Buffer.byteLength(odd)).toBeLessThanOrEqual(200);
  });

  test.skipIf(process.platform === 'win32')('creates the uploads root owner-only (0700)', async () => {
    const nested = path.join(root, 'fresh', 'uploads');
    await new UploadStore(nested, () => NOW).save('a.txt', blob('x'));
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  test('strips path traversal', async () => {
    const p = await store.save('../../etc/passwd', blob('x'));
    expect(path.dirname(p)).toBe(path.join(root, '2026-11-03'));
    expect(path.basename(p)).toBe('passwd');
    const w = await store.save('..\\..\\evil.png', blob('x'));
    expect(path.dirname(w)).toBe(path.join(root, '2026-11-03'));
    expect(path.basename(w)).toBe('evil.png');
  });

  test('empty or dot names become upload', async () => {
    for (const n of ['', '.', '..', 'a/..']) {
      const p = await store.save(n, blob('x'));
      expect(path.dirname(p)).toBe(path.join(root, '2026-11-03'));
    }
    expect(existsSync(path.join(root, '2026-11-03', 'upload'))).toBe(true);
  });

  test('makes Windows-unsafe names safe', async () => {
    const base = async (n: string) => path.basename(await store.save(n, blob('x')));
    expect(await base('a.png:stream')).toBe('a.png_stream');
    expect(await base('CON.png')).toBe('_CON.png');
    expect(await base('nul')).toBe('_nul');
    expect(await base('com1.tar.gz')).toBe('_com1.tar.gz');
    expect(await base('x.')).toBe('x');
    expect(await base('y. . ')).toBe('y');
    expect(await base('a<b>?.txt')).toBe('a_b__.txt');
    expect(await base('console.png')).toBe('console.png');
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'cancels the stream and leaves no temp file when the write side fails', async () => {
      await store.save('seed.txt', blob('x')); // creates the day dir
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) { c.enqueue(new Uint8Array(4)); },
        cancel() { cancelled = true; },
      });
      await chmod(root, 0o500);
      try {
        await expect(store.save('b.bin', stream)).rejects.toThrow();
      } finally {
        await chmod(root, 0o700);
      }
      expect(cancelled).toBe(true);
      expect((await readdir(root)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

  test('rejects over limit and leaves no partial file', async () => {
    await expect(store.save('big.bin', blob('0123456789'), 5)).rejects.toBeInstanceOf(UploadTooLarge);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(4)); },
    });
    await expect(store.save('big2.bin', stream, 10)).rejects.toBeInstanceOf(UploadTooLarge);
    const all = await readdir(root, { recursive: true });
    expect(all.filter((f) => f.includes('big') || f.endsWith('.tmp'))).toEqual([]);
  });

  test('exactly maxBytes is accepted', async () => {
    const p = await store.save('ok.bin', blob('12345'), 5);
    expect(await readFile(p, 'utf8')).toBe('12345');
  });
});

describe('UploadStore.cleanup', () => {
  test('deletes day dirs older than 7 days only', async () => {
    for (const d of ['2026-10-25', '2026-10-26', '2026-10-27', '2026-11-03', 'notes', '2026-10-1']) {
      await mkdir(path.join(root, d));
    }
    const n = await store.cleanup();
    expect(n).toBe(2);
    const left = (await readdir(root)).sort();
    expect(left).toEqual(['2026-10-1', '2026-10-27', '2026-11-03', 'notes']);
  });
});
