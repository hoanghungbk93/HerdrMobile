import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crashHandlers, redirectConsoleToFile } from '../src/log';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('redirectConsoleToFile appends timestamped lines (creating the dir) and restores', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'hm-log-'));
  dirs.push(d);
  const file = path.join(d, 'sub', 'bridge.log');
  const printed: unknown[] = [];
  const con = {
    log: (...a: unknown[]) => printed.push(a),
    info: (...a: unknown[]) => printed.push(a),
    warn: (...a: unknown[]) => printed.push(a),
    error: (...a: unknown[]) => printed.push(a),
  };
  const restore = redirectConsoleToFile(file, con);
  con.log('hello %s', 'world');
  con.error('bad', 42);
  restore();
  con.log('after');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ INFO hello world$/);
  expect(lines[1]).toMatch(/ ERROR bad 42$/);
  expect(printed).toEqual([['after']]);
});

test('crash handlers: rejection is logged and survives; exception is logged then exits non-zero', () => {
  const logged: string[] = [];
  const exits: number[] = [];
  const h = crashHandlers((m) => logged.push(m), (c) => exits.push(c));
  h.unhandledRejection(new Error('nope'));
  expect(exits).toEqual([]);
  expect(logged[0]).toContain('unhandled rejection');
  expect(logged[0]).toContain('nope');
  h.uncaughtException(new Error('boom'));
  expect(logged[1]).toContain('boom');
  expect(exits).toEqual([1]);
});
