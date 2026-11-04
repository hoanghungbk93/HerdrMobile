import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensurePrivateDir, generateLocalKey, localKeyMatches, readLocalKey, writeLocalKey } from '../../src/auth/localKey';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'hm-key-'));
  dirs.push(d);
  return d;
};

test('generated key is 32 random bytes, base64url', () => {
  const k = generateLocalKey();
  expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(k, 'base64url')).toHaveLength(32);
  expect(generateLocalKey()).not.toBe(k);
});

test('write/read round-trip; overwrite replaces; no temp files left; missing file -> null', () => {
  const d = path.join(tmp(), 'data');
  expect(readLocalKey(d)).toBeNull();
  writeLocalKey(d, 'first');
  writeLocalKey(d, 'second');
  expect(readLocalKey(d)).toBe('second');
  expect(readFileSync(path.join(d, 'local.key'), 'utf8')).toBe('second');
  expect(readdirSync(d)).toEqual(['local.key']);
});

test.skipIf(process.platform === 'win32')('local.key is 0600 and the data dir 0700', () => {
  const d = path.join(tmp(), 'data');
  writeLocalKey(d, generateLocalKey());
  expect(statSync(path.join(d, 'local.key')).mode & 0o777).toBe(0o600);
  expect(statSync(d).mode & 0o777).toBe(0o700);
});

test.skipIf(process.platform === 'win32')('ensurePrivateDir tightens an existing directory to 0700', async () => {
  const d = tmp();
  const { chmodSync } = await import('node:fs');
  chmodSync(d, 0o755);
  ensurePrivateDir(d);
  expect(statSync(d).mode & 0o777).toBe(0o700);
});

test('localKeyMatches is exact', () => {
  expect(localKeyMatches('abc', 'abc')).toBe(true);
  expect(localKeyMatches('abc', 'abd')).toBe(false);
  expect(localKeyMatches('abc', 'abcd')).toBe(false);
  expect(localKeyMatches('abc', '')).toBe(false);
  expect(localKeyMatches('abc', null)).toBe(false);
});
