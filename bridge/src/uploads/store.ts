import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

export class UploadTooLarge extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Upload exceeds ${maxBytes} bytes`);
    this.name = 'UploadTooLarge';
  }
}

const DAY_DIR = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Most filesystems cap a name at 255 bytes; leave room for the " (n)" dedupe suffix. */
export const MAX_NAME_BYTES = 200;
const MAX_EXT_BYTES = 32;

const utf8Len = (s: string) => Buffer.byteLength(s, 'utf8');

/** Longest prefix of `s` within `max` UTF-8 bytes, cut on a code point boundary. */
function truncateUtf8(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = utf8Len(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/** Keeps the extension and shortens the stem so the whole name fits MAX_NAME_BYTES. */
function fitName(base: string): string {
  if (utf8Len(base) <= MAX_NAME_BYTES) return base;
  let ext = path.extname(base);
  if (utf8Len(ext) > MAX_EXT_BYTES) ext = ''; // not a real extension: just cut the whole name
  const stem = truncateUtf8(base.slice(0, base.length - ext.length), MAX_NAME_BYTES - utf8Len(ext)).trimEnd();
  return (stem === '' ? 'upload' : stem) + ext;
}

// Same rules on every platform so behaviour is deterministic; keeps names Windows-safe.
function sanitize(name: string): string {
  let base = path.basename(name.replaceAll('\\', '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (base === '' || base === '.' || base === '..') return 'upload';
  if (RESERVED.test(base.split('.')[0]!.trimEnd())) base = `_${base}`;
  return fitName(base);
}

export class UploadStore {
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  async save(name: string, data: ReadableStream | Blob, maxBytes = 100 * 1024 * 1024): Promise<string> {
    const d = new Date(this.now());
    await mkdir(path.resolve(this.root), { recursive: true, mode: 0o700 }); // owner-only (ignored on Windows)
    const dir = path.join(path.resolve(this.root), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(path.resolve(this.root), `.upload-${randomUUID()}.tmp`);
    try {
      await this.writeTemp(tmp, data, maxBytes);
      return await this.claim(tmp, dir, sanitize(name));
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private async writeTemp(tmp: string, data: ReadableStream | Blob, maxBytes: number): Promise<void> {
    const stream = (data instanceof Blob ? data.stream() : data) as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    let finished = false;
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(tmp, 'wx');
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { finished = true; break; }
        total += value.byteLength;
        if (total > maxBytes) throw new UploadTooLarge(maxBytes);
        await fh.write(value);
      }
    } finally {
      if (!finished) await reader.cancel().catch(() => {});
      await fh?.close().catch(() => {});
    }
  }

  /** Hard-link tmp to the first free name (link fails if the target exists), so no overwrite is possible. */
  private async claim(tmp: string, dir: string, base: string): Promise<string> {
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    for (let i = 0; ; i++) {
      const target = path.join(dir, i === 0 ? base : `${stem} (${i})${ext}`);
      try {
        await link(tmp, target);
        await unlink(tmp);
        return target;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  }

  async cleanup(maxAgeDays = 7): Promise<number> {
    const t = new Date(this.now());
    const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
    let deleted = 0;
    for (const ent of entries) {
      const m = ent.isDirectory() ? DAY_DIR.exec(ent.name) : null;
      if (!m) continue;
      const age = Math.round((today - Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) / DAY_MS);
      if (age > maxAgeDays) {
        await rm(path.join(this.root, ent.name), { recursive: true, force: true });
        deleted++;
      }
    }
    return deleted;
  }
}
