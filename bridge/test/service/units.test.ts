import { expect, test } from 'bun:test';
import path from 'node:path';
import {
  firewallAddArgs,
  installService,
  launchdPlist,
  RUN_KEY,
  runKeyCommand,
  schtasksArgs,
  systemdUnit,
  uninstallService,
  servicePath,
  TASK_SETTINGS_PS,
  type ServiceDeps,
} from '../../src/service/units';

const BIN = '/opt/my apps/herdr-bridge';
const ENVPATH = '/home/u/.local/bin:/usr/bin:/a&b';
const LOG = '/home/u/.herdr-mobile/bridge.log';

function fakeDeps(over: Partial<ServiceDeps> = {}) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const writes: { path: string; content: string }[] = [];
  const removed: string[] = [];
  const deps: ServiceDeps = {
    binPath: BIN,
    home: '/home/u',
    uid: 501,
    user: 'u',
    logPath: LOG,
    envPath: ENVPATH,
    ensureDir: async (p) => void calls.push(['mkdir', p]),
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return 0;
    },
    writeFile: async (p, c) => void writes.push({ path: p, content: c }),
    removeFile: async (p) => void removed.push(p),
    sleep: async (ms) => void sleeps.push(ms),
    startDetached: async (cmd, args) => void calls.push(['detached', cmd, ...args]),
    pid: 4242,
    port: 7420,
    ...over,
  };
  return { deps, calls, writes, removed, sleeps };
}

test('launchd plist: label, RunAtLoad, KeepAlive, args, log', () => {
  const x = launchdPlist(BIN, LOG, ENVPATH);
  expect(x).toContain('<key>PATH</key><string>/home/u/.local/bin:/usr/bin:/a&amp;b</string>');
  expect(x).toContain('<string>dev.herdr-mobile.bridge</string>');
  expect(x).toContain('<key>KeepAlive</key><true/>');
  expect(x).toContain('<key>RunAtLoad</key><true/>');
  expect(x).toContain(`<string>${BIN}</string>\n    <string>start</string>`);
  expect(x).toContain(`<key>StandardOutPath</key><string>${LOG}</string>`);
  expect(x).toContain(`<key>StandardErrorPath</key><string>${LOG}</string>`);
});

test('launchd plist XML-escapes paths', () => {
  const x = launchdPlist('/a&b/<x>/herdr-bridge', '/l&g');
  expect(x).toContain('<string>/a&amp;b/&lt;x&gt;/herdr-bridge</string>');
  expect(x).toContain('<string>/l&amp;g</string>');
});

test('systemd unit: quoted ExecStart, Restart=always', () => {
  const x = systemdUnit(BIN, LOG, ENVPATH);
  expect(x).toContain('Environment="PATH=/home/u/.local/bin:/usr/bin:/a&b"');
  expect(x).toContain(`ExecStart="${BIN}" start`);
  expect(x).toContain('Restart=always');
  expect(x).toContain('WantedBy=default.target');
  expect(x).toContain(`StandardOutput=append:${LOG}`);
});

test('systemd unit escapes quotes, backslashes and percent in ExecStart', () => {
  expect(systemdUnit('/a"b\\c%d/bin', LOG)).toContain('ExecStart="/a\\"b\\\\c%%d/bin" start');
});

test('schtasks args: ONLOGON, task name, current user, no elevation', () => {
  const a = schtasksArgs('C:\\Program Files\\HB\\herdr-bridge.exe', 'bob');
  const s = a.join(' ');
  expect(s).toContain('/SC ONLOGON');
  expect(s).toContain('/TN HerdrBridge');
  expect(s).toContain('/RU bob');
  expect(s).not.toContain('/RL HIGHEST');
  // hidden console at logon; the binary keeps its console for `pair`
  expect(a[a.indexOf('/TR') + 1]).toBe('conhost.exe --headless "C:\\Program Files\\HB\\herdr-bridge.exe" start');
});

test('install on darwin writes plist and bootstraps via launchctl', async () => {
  const { deps, calls, writes } = fakeDeps();
  await installService('darwin', deps);
  const plist = path.join('/home/u', 'Library', 'LaunchAgents', 'dev.herdr-mobile.bridge.plist');
  expect(writes).toEqual([{ path: plist, content: launchdPlist(BIN, LOG, ENVPATH) }]);
  expect(calls).toEqual([
    ['mkdir', '/home/u/.herdr-mobile'],
    ['launchctl', 'bootout', 'gui/501/dev.herdr-mobile.bridge'],
    ['launchctl', 'bootstrap', 'gui/501', plist],
  ]);
});

test('install on darwin tolerates a failing bootout but not a bootstrap that keeps failing (5 tries)', async () => {
  let bootstraps = 0;
  const { deps, sleeps } = fakeDeps({
    run: async (_c, a) => (a[0] === 'bootout' ? 3 : (bootstraps++, 5)),
  });
  await expect(installService('darwin', deps)).rejects.toThrow(/launchctl bootstrap/);
  expect(bootstraps).toBe(5);
  expect(sleeps).toEqual([300, 300, 300, 300]);
});

test('upgrade on darwin: bootstrap retried while the old job is still booting out', async () => {
  let bootstraps = 0;
  const { deps, calls, sleeps } = fakeDeps({
    run: async (c, a) => {
      calls.push([c, ...a]);
      return a[0] === 'bootstrap' && ++bootstraps < 3 ? 5 : 0; // EIO twice, then ok
    },
  });
  await installService('darwin', deps);
  const plist = path.join('/home/u', 'Library', 'LaunchAgents', 'dev.herdr-mobile.bridge.plist');
  expect(calls).toEqual([
    ['mkdir', '/home/u/.herdr-mobile'],
    ['launchctl', 'bootout', 'gui/501/dev.herdr-mobile.bridge'],
    ['launchctl', 'bootstrap', 'gui/501', plist],
    ['launchctl', 'bootstrap', 'gui/501', plist],
    ['launchctl', 'bootstrap', 'gui/501', plist],
  ]);
  expect(sleeps).toEqual([300, 300]);
});

test('install on linux writes user unit, enables it and restarts it (picks up an upgraded binary)', async () => {
  const { deps, calls, writes } = fakeDeps();
  await installService('linux', deps);
  expect(writes[0]!.path).toBe(path.join('/home/u', '.config', 'systemd', 'user', 'herdr-bridge.service'));
  expect(writes[0]!.content).toBe(systemdUnit(BIN, LOG, ENVPATH));
  expect(calls).toEqual([
    ['mkdir', '/home/u/.herdr-mobile'],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', 'herdr-bridge.service'],
    ['systemctl', '--user', 'restart', 'herdr-bridge.service'],
  ]);
});

test('install on win32 (admin) creates and runs the scheduled task', async () => {
  const { deps, calls, writes } = fakeDeps({ binPath: 'C:\\x y\\hb.exe' });
  expect(await installService('win32', deps)).toEqual({ mode: 'task', firewall: true });
  expect(writes).toEqual([]);
  expect(calls).toEqual([
    ['schtasks', '/End', '/TN', 'HerdrBridge'], // stop an old instance (fails harmlessly on first install)
    ['taskkill', '/F', '/FI', 'PID ne 4242', '/IM', 'hb.exe'],
    ['schtasks', ...schtasksArgs('C:\\x y\\hb.exe', 'u')],
    ['powershell', '-NoProfile', '-Command', TASK_SETTINGS_PS],
    ['schtasks', '/Run', '/TN', 'HerdrBridge'],
    ['reg', 'delete', RUN_KEY, '/v', 'HerdrBridge', '/f'],
    ['netsh', 'advfirewall', 'firewall', 'show', 'rule', 'name=herdr-bridge'],
  ]);
});

test('install on win32 without admin: Run key autostart, started now, firewall rule attempted', async () => {
  const { deps, calls } = fakeDeps({
    binPath: 'C:\\x y\\hb.exe',
    run: async (c, a) => {
      calls.push([c, ...a]);
      if (c === 'schtasks' && a[0] === '/Create') return 1; // Access is denied
      if (c === 'netsh') return 1; // no rule, and no rights to add one
      return 0;
    },
  });
  expect(await installService('win32', deps)).toEqual({ mode: 'runkey', firewall: false });
  expect(calls.slice(2)).toEqual([
    ['schtasks', ...schtasksArgs('C:\\x y\\hb.exe', 'u')],
    ['reg', 'add', RUN_KEY, '/v', 'HerdrBridge', '/t', 'REG_SZ', '/d', runKeyCommand('C:\\x y\\hb.exe'), '/f'],
    ['detached', 'conhost.exe', '--headless', 'C:\\x y\\hb.exe', 'start'],
    ['netsh', 'advfirewall', 'firewall', 'show', 'rule', 'name=herdr-bridge'],
    ['netsh', ...firewallAddArgs(7420)],
  ]);
  expect(runKeyCommand('C:\\x y\\hb.exe')).toBe('conhost.exe --headless "C:\\x y\\hb.exe" start');
});

test('uninstall removes service files but never user data', async () => {
  const d = fakeDeps();
  await uninstallService('darwin', d.deps);
  expect(d.calls).toEqual([['launchctl', 'bootout', 'gui/501/dev.herdr-mobile.bridge']]);
  expect(d.removed).toEqual([path.join('/home/u', 'Library', 'LaunchAgents', 'dev.herdr-mobile.bridge.plist')]);

  const l = fakeDeps();
  await uninstallService('linux', l.deps);
  expect(l.calls).toEqual([
    ['systemctl', '--user', 'disable', '--now', 'herdr-bridge.service'],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
  expect(l.removed).toEqual([path.join('/home/u', '.config', 'systemd', 'user', 'herdr-bridge.service')]);

  const w = fakeDeps();
  await uninstallService('win32', w.deps);
  expect(w.calls).toEqual([
    ['schtasks', '/End', '/TN', 'HerdrBridge'],
    ['schtasks', '/Delete', '/TN', 'HerdrBridge', '/F'],
    ['reg', 'delete', RUN_KEY, '/v', 'HerdrBridge', '/f'],
    ['taskkill', '/F', '/FI', 'PID ne 4242', '/IM', 'herdr-bridge'],
  ]);
  for (const r of [d.removed, l.removed, w.removed]) expect(r.join()).not.toContain('/.herdr-mobile');
});

test('unsupported platform throws', async () => {
  await expect(installService('freebsd', fakeDeps().deps)).rejects.toThrow(/unsupported/i);
});

test('servicePath dedupes and adds herdr locations', () => {
  const p = servicePath('/usr/bin:/opt/homebrew/bin:/usr/bin', '/home/u', ':');
  expect(p).toBe('/usr/bin:/opt/homebrew/bin:/home/u/.local/bin:/usr/local/bin');
});

test('windows: /End failing on first install is not an error', async () => {
  const { deps } = fakeDeps({ run: async (_c, a) => (a[0] === '/End' ? 1 : 0) });
  await installService('win32', deps);
});

test('windows task settings command lifts time limit and battery restrictions, restarts on failure; failure is an install error', async () => {
  expect(TASK_SETTINGS_PS).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)');
  expect(TASK_SETTINGS_PS).toContain('-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries');
  expect(TASK_SETTINGS_PS).toContain('-RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)');
  expect(TASK_SETTINGS_PS.startsWith("$ErrorActionPreference = 'Stop';")).toBe(true);
  expect(TASK_SETTINGS_PS.match(/-ErrorAction Stop/g)).toHaveLength(2);
  expect(TASK_SETTINGS_PS).toContain('Set-ScheduledTask -TaskName HerdrBridge');
  const { deps } = fakeDeps({ run: async (c) => (c === 'powershell' ? 1 : 0) });
  await expect(installService('win32', deps)).rejects.toThrow(/powershell/);
});
