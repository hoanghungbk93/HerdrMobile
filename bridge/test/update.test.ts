import { expect, test } from 'bun:test';
import { installerCommand, isNewer, latestVersion, tagFromLocation } from '../src/update';
import { VERSION } from '../src/version';

test('VERSION comes from package.json', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test('isNewer compares numerically, not as strings', () => {
  expect(isNewer('0.4.10', '0.4.9')).toBe(true);
  expect(isNewer('0.5.0', '0.4.9')).toBe(true);
  expect(isNewer('1.0.0', '0.99.99')).toBe(true);
  expect(isNewer('0.4.3', '0.4.3')).toBe(false);
  expect(isNewer('0.4.2', '0.4.3')).toBe(false);
});

test('tagFromLocation reads the version from the releases/latest redirect', () => {
  expect(tagFromLocation('https://github.com/o/r/releases/tag/v0.4.3')).toBe('0.4.3');
  expect(tagFromLocation('https://github.com/o/r/releases')).toBeNull();
  expect(tagFromLocation(null)).toBeNull();
});

test('latestVersion follows no redirect and reads the Location header', async () => {
  let seen: { url: string; redirect?: string } | null = null;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen = { url, redirect: init?.redirect };
    return new Response(null, { status: 302, headers: { location: 'https://github.com/o/r/releases/tag/v1.2.3' } });
  }) as unknown as typeof fetch;
  expect(await latestVersion('o/r', fetchFn)).toBe('1.2.3');
  expect(seen!).toEqual({ url: 'https://github.com/o/r/releases/latest', redirect: 'manual' });
});

test('installer command: install.sh into the current binary folder on macOS/Linux, skipping the WSL setup', () => {
  const c = installerCommand('linux', '/home/u/.local/bin/herdr-bridge', 'o/r');
  expect(c.cmd).toBe('sh');
  expect(c.args).toEqual(['-c', 'curl -fsSL https://github.com/o/r/releases/latest/download/install.sh | sh']);
  expect(c.env).toEqual({ HERDR_BRIDGE_PREFIX: '/home/u/.local/bin', HERDR_BRIDGE_SKIP_WSL: '1', HERDR_BRIDGE_UPDATE: '1' });
  expect(c.detached).toBe(false);
});

test('installer command: install.ps1 detached on Windows (it stops the running herdr-bridge.exe, us included)', () => {
  const c = installerCommand('win32', 'C:\\Users\\u\\AppData\\Local\\Programs\\HerdrBridge\\herdr-bridge.exe', 'o/r');
  expect(c.cmd).toBe('powershell.exe');
  expect(c.args).toEqual([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    'irm https://github.com/o/r/releases/latest/download/install.ps1 | iex',
  ]);
  expect(c.env).toEqual({ HERDR_BRIDGE_PREFIX: 'C:\\Users\\u\\AppData\\Local\\Programs\\HerdrBridge', HERDR_BRIDGE_UPDATE: '1' });
  expect(c.detached).toBe(true);
});
