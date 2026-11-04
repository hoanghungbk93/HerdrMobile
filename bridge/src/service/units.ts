import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../config';

export const LAUNCHD_LABEL = 'dev.herdr-mobile.bridge';
export const SYSTEMD_UNIT = 'herdr-bridge.service';
export const TASK_NAME = 'HerdrBridge';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** PATH for the service: current PATH plus the usual herdr locations, deduped. */
export function servicePath(current: string, home: string, sep = path.delimiter): string {
  const extra = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const seen = new Set<string>();
  return [...current.split(sep), ...extra].filter((x) => x && !seen.has(x) && seen.add(x)).join(sep);
}

export function launchdPlist(
  binPath: string,
  logPath = path.join(DATA_DIR, 'bridge.log'),
  envPath = '/usr/bin:/bin:/usr/sbin:/sbin',
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binPath)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(envPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** Quote for a systemd ExecStart word: escape \ and ", and % (specifier). */
const sdQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

export function systemdUnit(
  binPath: string,
  logPath = path.join(DATA_DIR, 'bridge.log'),
  envPath = '/usr/local/bin:/usr/bin:/bin',
): string {
  return `[Unit]
Description=herdr-bridge (herdr mobile companion)
After=network-online.target

[Service]
Environment=${sdQuote(`PATH=${envPath}`)}
ExecStart=${sdQuote(binPath)} start
Restart=always
RestartSec=3
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

/**
 * Task Scheduler registration. The action runs through `conhost.exe --headless`
 * so no console window pops up at logon (the binary itself keeps a console so
 * `pair` can print its QR code); `start` then logs to DATA_DIR\bridge.log.
 */
export function schtasksArgs(binPath: string, user = os.userInfo().username): string[] {
  return ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/RU', user, '/TR', `conhost.exe --headless "${binPath}" start`, '/F'];
}

/**
 * Lifts schtasks' defaults (72h limit, battery conditions) and restarts the task
 * every minute if it fails. Any error is terminating, so powershell exits non-zero.
 */
export const TASK_SETTINGS_PS =
  "$ErrorActionPreference = 'Stop'; " +
  '$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries ' +
  '-RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ErrorAction Stop; ' +
  `Set-ScheduledTask -TaskName ${TASK_NAME} -Settings $s -ErrorAction Stop | Out-Null`;

/** launchctl bootout returns before the job is fully gone; bootstrap is retried meanwhile. */
export const BOOTSTRAP_ATTEMPTS = 5;
export const BOOTSTRAP_RETRY_MS = 300;

export interface ServiceDeps {
  binPath: string;
  home: string;
  uid: number;
  user: string;
  logPath: string;
  /** PATH captured at install time, written into the service definition. */
  envPath: string;
  /** Creates a directory (recursive). */
  ensureDir(p: string): Promise<void>;
  /** Runs a command, resolves with its exit code. */
  run(cmd: string, args: string[]): Promise<number>;
  writeFile(p: string, content: string): Promise<void>;
  removeFile(p: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function defaultDeps(): ServiceDeps {
  return {
    binPath: process.execPath,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    user: os.userInfo().username,
    logPath: path.join(DATA_DIR, 'bridge.log'),
    envPath: servicePath(process.env.PATH ?? '', os.homedir()),
    ensureDir: async (p) => void (await fs.mkdir(p, { recursive: true, mode: 0o700 })),
    run: async (cmd, args) => {
      const p = Bun.spawn([cmd, ...args], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
      return p.exited;
    },
    writeFile: async (p, c) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, c);
    },
    removeFile: (p) => fs.rm(p, { force: true }),
    sleep: (ms) => Bun.sleep(ms),
  };
}

const plistPath = (d: ServiceDeps) => path.join(d.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const unitPath = (d: ServiceDeps) => path.join(d.home, '.config', 'systemd', 'user', SYSTEMD_UNIT);

async function must(d: ServiceDeps, cmd: string, args: string[]): Promise<void> {
  const code = await d.run(cmd, args);
  if (code !== 0) throw new Error(`${cmd} ${args[0]} failed (exit ${code})`);
}

export async function installService(platform: string = process.platform, d: ServiceDeps = defaultDeps()): Promise<void> {
  if (platform !== 'win32') await d.ensureDir(path.dirname(d.logPath)); // launchd/systemd won't create it
  switch (platform) {
    case 'darwin': {
      const p = plistPath(d);
      await d.writeFile(p, launchdPlist(d.binPath, d.logPath, d.envPath));
      await d.run('launchctl', ['bootout', `gui/${d.uid}/${LAUNCHD_LABEL}`]); // ok if not loaded yet
      // bootout is asynchronous: bootstrap fails (EIO) until the old job is gone, so retry a few times.
      const args = ['bootstrap', `gui/${d.uid}`, p];
      for (let i = 1; ; i++) {
        const code = await d.run('launchctl', args);
        if (code === 0) return;
        if (i >= BOOTSTRAP_ATTEMPTS) throw new Error(`launchctl bootstrap failed (exit ${code})`);
        await d.sleep(BOOTSTRAP_RETRY_MS);
      }
    }
    case 'linux':
      await d.writeFile(unitPath(d), systemdUnit(d.binPath, d.logPath, d.envPath));
      await must(d, 'systemctl', ['--user', 'daemon-reload']);
      await must(d, 'systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
      // enable --now leaves an already-running (old) binary alone; restart so an upgrade takes effect.
      await must(d, 'systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
      return;
    case 'win32':
      // Stop a running (old) instance so /Run below starts the freshly installed binary; fails harmlessly if absent.
      await d.run('schtasks', ['/End', '/TN', TASK_NAME]);
      await must(d, 'schtasks', schtasksArgs(d.binPath, d.user));
      // schtasks /Create defaults to a 72h time limit and battery restrictions; lift both.
      await must(d, 'powershell', ['-NoProfile', '-Command', TASK_SETTINGS_PS]);
      await must(d, 'schtasks', ['/Run', '/TN', TASK_NAME]);
      return;
    default:
      throw new Error(`unsupported platform: ${platform}`);
  }
}

/** Removes the autostart registration only; never touches the data directory. */
export async function uninstallService(platform: string = process.platform, d: ServiceDeps = defaultDeps()): Promise<void> {
  switch (platform) {
    case 'darwin':
      await d.run('launchctl', ['bootout', `gui/${d.uid}/${LAUNCHD_LABEL}`]);
      await d.removeFile(plistPath(d));
      return;
    case 'linux':
      await d.run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
      await d.removeFile(unitPath(d));
      await d.run('systemctl', ['--user', 'daemon-reload']);
      return;
    case 'win32':
      await d.run('schtasks', ['/End', '/TN', TASK_NAME]);
      await d.run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
      return;
    default:
      throw new Error(`unsupported platform: ${platform}`);
  }
}
