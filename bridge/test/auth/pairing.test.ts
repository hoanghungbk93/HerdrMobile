import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../../src/auth/store';
import { Pairing } from '../../src/auth/pairing';

let dir: string;
let store: DeviceStore;
let t: number;
let pairing: Pairing;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-pair-'));
  store = new DeviceStore(dir);
  t = 1_000_000;
  pairing = new Pairing(store, () => t);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Pairing', () => {
  test('redeem by code once', () => {
    const { code } = pairing.create();
    expect(code).toMatch(/^\d{6}$/);
    const r = pairing.redeem(code, 'phone');
    expect(r).not.toBeNull();
    expect(store.verify(r!.token)).not.toBeNull();
    expect(pairing.redeem(code, 'phone2')).toBeNull();
  });

  test('redeem by secret', () => {
    const { secret } = pairing.create();
    expect(pairing.redeem(secret, 'phone')).not.toBeNull();
  });

  test('expired after 5 min', () => {
    const { code, expiresAt } = pairing.create();
    expect(expiresAt).toBe(t + 5 * 60_000);
    t += 5 * 60_000 + 1;
    expect(pairing.redeem(code, 'phone')).toBeNull();
  });

  test('5 wrong codes invalidates current pairing', () => {
    const { code } = pairing.create();
    for (let i = 0; i < 5; i++) expect(pairing.redeem('x' + i, 'p')).toBeNull();
    expect(pairing.redeem(code, 'phone')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  test('create replaces previous pairing', () => {
    const a = pairing.create();
    const b = pairing.create();
    expect(pairing.redeem(a.code, 'p')).toBeNull();
    expect(pairing.redeem(b.code, 'p')).not.toBeNull();
  });
});
