import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../../src/auth/store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('DeviceStore', () => {
  test('add returns token whose hash is stored, not the token', () => {
    const s = new DeviceStore(dir);
    const { device, token } = s.add('phone');
    const raw = readFileSync(join(dir, 'devices.json'), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(device.tokenHash);
  });

  test('verify succeeds with right token and null for wrong', () => {
    const s = new DeviceStore(dir);
    const { device, token } = s.add('phone');
    expect(s.verify(token)?.id).toBe(device.id);
    expect(s.verify('nope')).toBeNull();
  });

  test('revoke one keeps the other', () => {
    const s = new DeviceStore(dir);
    const a = s.add('a');
    const b = s.add('b');
    expect(s.revoke(a.device.id)).toBe(true);
    expect(s.revoke(a.device.id)).toBe(false);
    expect(s.verify(a.token)).toBeNull();
    expect(s.verify(b.token)).not.toBeNull();
  });

  test('persists across instances', () => {
    const { token } = new DeviceStore(dir).add('phone');
    expect(new DeviceStore(dir).verify(token)?.name).toBe('phone');
  });

  test('default prefs', () => {
    expect(new DeviceStore(dir).add('p').device.prefs).toEqual({
      private: true,
      mutedSessions: [],
      mutedPanes: [],
    });
  });

  test('update and pushTargets', () => {
    const s = new DeviceStore(dir);
    const a = s.add('a');
    s.add('b');
    expect(s.pushTargets()).toEqual([]);
    s.update(a.device.id, { pushToken: 'ExpoPushToken[x]', name: 'a2' });
    const t = s.pushTargets();
    expect(t.length).toBe(1);
    expect(t[0].name).toBe('a2');
    expect(new DeviceStore(dir).list().length).toBe(2);
  });

  test('update ignores non-whitelisted keys', () => {
    const s = new DeviceStore(dir);
    const { device, token } = s.add('a');
    const { id, tokenHash, createdAt } = device;
    s.update(id, { name: 'n', tokenHash: 'evil', id: 'x', createdAt: 1 } as any);
    const d = new DeviceStore(dir).list()[0];
    expect(d.name).toBe('n');
    expect(d.id).toBe(id);
    expect(d.tokenHash).toBe(tokenHash);
    expect(d.createdAt).toBe(createdAt);
    expect(s.verify(token)?.id).toBe(id);
  });

  test('undefined or empty pushToken is not a push target', () => {
    const s = new DeviceStore(dir);
    const a = s.add('a');
    const b = s.add('b');
    s.update(a.device.id, { pushToken: undefined });
    s.update(b.device.id, { pushToken: '' });
    expect(s.pushTargets()).toEqual([]);
    expect(new DeviceStore(dir).pushTargets()).toEqual([]);
  });

  test('two phones both get push; revoking one leaves the other', () => {
    const s = new DeviceStore(dir);
    const a = s.add('a');
    const b = s.add('b');
    s.update(a.device.id, { pushToken: 'tA' });
    s.update(b.device.id, { pushToken: 'tB' });
    expect(s.pushTargets().map((d) => d.id).sort()).toEqual([a.device.id, b.device.id].sort());
    s.revoke(a.device.id);
    expect(s.pushTargets().map((d) => d.id)).toEqual([b.device.id]);
    expect(s.verify(b.token)?.id).toBe(b.device.id);
  });
});

test('a push token moves to the device that claims it (re-paired phone)', () => {
  const s = new DeviceStore(mkdtempSync(join(tmpdir(), 'st-')));
  const a = s.add('old').device;
  const b = s.add('new').device;
  s.update(a.id, { pushToken: 'tok', liveActivity: { startToken: 'ab'.repeat(32), env: 'production' } });
  s.update(b.id, { pushToken: 'tok', liveActivity: { startToken: 'ab'.repeat(32), env: 'production' } });
  const [x, y] = s.list();
  expect(x!.pushToken).toBeNull();
  expect(x!.liveActivity).toBeNull();
  expect(y!.pushToken).toBe('tok');
  expect(s.pushTargets().map((d) => d.id)).toEqual([b.id]);
});
