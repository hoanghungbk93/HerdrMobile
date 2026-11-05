import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings, validHost, writeSettings } from '../../src/settings';

test('settings round-trip, ignoring unknown or invalid values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-settings-'));
  expect(readSettings(dir)).toEqual({});
  writeSettings({ listen: 'all', host: '100.64.1.2' }, dir);
  expect(readSettings(dir)).toEqual({ listen: 'all', host: '100.64.1.2' });
  writeSettings({ listen: undefined, host: '100.64.1.2' }, dir);
  expect(readSettings(dir)).toEqual({ host: '100.64.1.2' });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"listen":"everywhere","host":"  "}');
  expect(readSettings(dir)).toEqual({});
  fs.writeFileSync(path.join(dir, 'settings.json'), 'not json');
  expect(readSettings(dir)).toEqual({});
  fs.rmSync(dir, { recursive: true });
});

test('validHost accepts IPs and hostnames, rejects URLs', () => {
  for (const h of ['100.124.189.105', 'desktop-gl1beko', 'box.tail1234.ts.net', 'fd7a:115c:a1e0::1']) expect(validHost(h)).toBe(true);
  for (const h of ['http://x', '1.2.3.4:7420', 'a b', 'x/y', '']) expect(validHost(h)).toBe(false);
});
