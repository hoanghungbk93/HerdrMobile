import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Header the CLI sends on every /local/* call. */
export const LOCAL_KEY_HEADER = 'x-herdr-local-key';
export const LOCAL_KEY_FILE = 'local.key';

const chmod = (p: string, mode: number) => {
  try {
    chmodSync(p, mode);
  } catch {
    /* no-op on Windows */
  }
};

/** Creates the data directory owner-only (0700; mode is ignored on Windows). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmod(dir, 0o700);
}

export function generateLocalKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Writes DATA_DIR/local.key (0600) atomically, replacing any previous key. */
export function writeLocalKey(dir: string, key: string): string {
  ensurePrivateDir(dir);
  const file = path.join(dir, LOCAL_KEY_FILE);
  const tmp = path.join(dir, `.${LOCAL_KEY_FILE}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, key, { mode: 0o600 });
    chmod(tmp, 0o600);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  return file;
}

/** The running daemon's admin key, or null when there is none (daemon never started here). */
export function readLocalKey(dir: string): string | null {
  try {
    const k = readFileSync(path.join(dir, LOCAL_KEY_FILE), 'utf8').trim();
    return k === '' ? null : k;
  } catch {
    return null;
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time comparison (hashes first so lengths never leak). */
export function localKeyMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}
