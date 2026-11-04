import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseApproval } from '../../src/approval/parse';

const fx = (n: string) => fs.readFileSync(path.join(import.meta.dir, '../fixtures', n), 'utf8');

describe('parseApproval', () => {
  test('claude code prompt', () => {
    const r = parseApproval(fx('detection-claude.txt'));
    expect(r.options.map((o) => o.key)).toEqual(['1', '2', '3']);
    expect(r.options[0].label).toBe('Yes');
    expect(r.options[1].label).toBe("Yes, and don't ask again for rm commands");
    expect(r.options[2].label).toBe('No, and tell Claude what to do differently (esc)');
    expect(r.text.split('\n').length).toBeLessThanOrEqual(12);
  });
  test('codex prompt', () => {
    const r = parseApproval(fx('detection-codex.txt'));
    expect(r.options.map((o) => o.key)).toEqual(['1', '2']);
    expect(r.options[0].label).toBe('Yes, proceed');
  });
  test('no list', () => {
    expect(parseApproval('hello\nworld').options).toEqual([]);
  });
  test('a single numbered line is not a prompt', () => {
    expect(parseApproval('Steps:\n1. foo').options).toEqual([]);
    expect(parseApproval('Proceed?\n❯ 1. Yes').options).toEqual([]);
    expect(parseApproval('Proceed?\n❯ 1. Yes\n  2. No').options.map((o) => o.key)).toEqual(['1', '2']);
  });
  test('not starting at 1 or non-consecutive', () => {
    expect(parseApproval('2. a\n3. b').options).toEqual([]);
    expect(parseApproval('1. a\n3. b').options).toEqual([]);
  });
  test('hash ignores ANSI', () => {
    const a = parseApproval('\x1b[1mDo it?\x1b[0m\n1. Yes\n2. No');
    const b = parseApproval('Do it?\n1. Yes\n\x1b[31m2. No\x1b[0m');
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
