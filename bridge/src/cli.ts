import os from 'node:os';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { DEFAULT_PORT } from '@herdr-mobile/protocol';
import { ensurePrivateDir, generateLocalKey, LOCAL_KEY_HEADER, readLocalKey, writeLocalKey } from './auth/localKey';
import { Pairing } from './auth/pairing';
import { DeviceStore } from './auth/store';
import { DATA_DIR } from './config';
import { installCrashHandlers, redirectConsoleToFile } from './log';
import { Binder, tailscaleAddresses } from './net/tailscale';
import { sendExpoPush } from './notify/expoPush';
import { NotifyPolicy } from './notify/policy';
import { createApp, type App } from './server/app';
import { DEFAULT_RELAY_URL, httpRelay } from './notify/liveActivity';
import { installService, uninstallService } from './service/units';
import { readSettings, validHost, writeSettings } from './settings';
import { updateCmd } from './update';
import { UploadStore } from './uploads/store';
import { VERSION } from './version';
import { Hub } from './watch/hub';

const MAX_BODY = 512 * 1024 * 1024;

export function pairUrl(host: string, port: number, secret: string, machineName: string): string {
  return `herdrmobile://pair?h=${encodeURIComponent(host)}&p=${port}&s=${encodeURIComponent(secret)}&m=${encodeURIComponent(machineName)}`;
}

/** "482913" -> "482 913". */
export const splitCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

export const codeLine = (code: string): string => `Pairing code: ${splitCode(code)} · expires in 5 minutes`;

export function parseArgs(argv: string[]): { cmd: string | undefined; rest: string[]; port: number } {
  const rest: string[] = [];
  let port = DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') port = Number(argv[++i]);
    else if (a.startsWith('--port=')) port = Number(a.slice(7));
    else rest.push(a);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1-65535');
  return { cmd: rest[0], rest: rest.slice(1), port };
}

// ---- start ----------------------------------------------------------------

/**
 * One listener for the daemon. development:false keeps Bun's HTML error pages
 * (with stack traces) off the wire; in that mode Bun turns SO_REUSEPORT on by
 * default, which would let a second `start` share the port (and replace
 * local.key) instead of failing, so reusePort is forced off.
 */
export function serveOn(host: string, port: number, app: Pick<App, 'fetch' | 'websocket'>) {
  return Bun.serve({
    hostname: host,
    port,
    development: false,
    reusePort: false,
    fetch: app.fetch,
    websocket: app.websocket,
    maxRequestBodySize: MAX_BODY,
  });
}

export const logPath = () => path.join(DATA_DIR, 'bridge.log');

async function start(port: number): Promise<void> {
  ensurePrivateDir(DATA_DIR);
  ensurePrivateDir(path.join(DATA_DIR, 'uploads'));
  // Under a service (launchd / systemd / Task Scheduler) there is no terminal: log to DATA_DIR/bridge.log on every OS.
  if (!process.stdout.isTTY) redirectConsoleToFile(logPath());
  installCrashHandlers();
  const localKey = generateLocalKey();
  const machineName = os.hostname();
  const hub = new Hub();
  const devices = new DeviceStore(DATA_DIR);
  const binder: { current: Binder | null } = { current: null };
  const settings = readSettings();
  const relayUrl = process.env.HERDR_RELAY_URL ?? settings.relay ?? DEFAULT_RELAY_URL;
  const app = createApp({
    relay: relayUrl === 'off' ? null : httpRelay(relayUrl),
    hub,
    devices,
    pairing: new Pairing(devices),
    uploads: new UploadStore(path.join(DATA_DIR, 'uploads')),
    policy: new NotifyPolicy(),
    push: sendExpoPush,
    machineName,
    localKey,
    statusInfo: () => ({ port, tailscale: tailscaleAddresses(), listening: binder.current?.hosts() ?? [] }),
  });
  const b = new Binder((host) => serveOn(host, port, app), { listenAll: settings.listen === 'all' });
  binder.current = b;
  try {
    b.start();
  } catch (e) {
    app.close();
    console.error(`Cannot listen on ${settings.listen === 'all' ? '0.0.0.0' : '127.0.0.1'}:${port}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  // Only once we own the port: a second `start` that fails to bind must not replace the running daemon's key.
  writeLocalKey(DATA_DIR, localKey);
  hub.start();
  console.log(`herdr-bridge "${machineName}" listening on port ${port} (${b.hosts().join(', ')}); data in ${DATA_DIR}`);
  if (settings.listen !== 'all' && tailscaleAddresses().length === 0)
    console.log('Tailscale not up: serving on localhost only, re-checking every 10 s');

  const shutdown = () => {
    b.stop();
    hub.stop();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---- client commands ------------------------------------------------------

export type DaemonResult = Response | 'no-daemon' | 'unresponsive';

/**
 * Calls a /local route on the running daemon, sending the admin key from
 * DATA_DIR/local.key. 'no-daemon' when there is no key file (no daemon was
 * ever started with this data dir) or the connection was refused; any other
 * failure (timeout, reset, ...) is 'unresponsive' since a daemon may still be alive.
 */
export async function daemon(
  port: number,
  method: string,
  p: string,
  fetchImpl: typeof fetch = fetch,
  key: string | null = readLocalKey(DATA_DIR),
): Promise<DaemonResult> {
  if (!key) return 'no-daemon';
  try {
    return await fetchImpl(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { [LOCAL_KEY_HEADER]: key },
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    return (e as { code?: string })?.code === 'ECONNREFUSED' ? 'no-daemon' : 'unresponsive';
  }
}

const notResponding = (port: number) =>
  console.error(`The bridge on port ${port} is not responding; devices.json was left unchanged. Try again later.`);

/** 403 from a /local route: the key in local.key is not the running daemon's (another data dir / another user). */
const keyRejected = (port: number) =>
  console.error(
    `The bridge on port ${port} rejected the admin key in ${path.join(DATA_DIR, 'local.key')} ` +
      '(is it running with a different data folder or user?). Restart the bridge and try again.',
  );

interface DeviceRow { id: string; name: string; createdAt: number; lastSeenAt: number; connected?: number }

function printDevices(rows: DeviceRow[]): void {
  if (rows.length === 0) return console.log('No devices paired yet.');
  for (const d of rows) {
    const seen = new Date(d.lastSeenAt).toISOString();
    console.log(`${d.id}  ${d.name}  last seen ${seen}${d.connected ? `  (online x${d.connected})` : ''}`);
  }
}

async function pair(port: number): Promise<number> {
  const res = await daemon(port, 'POST', '/local/pair');
  if (typeof res !== 'string' && res.status === 403) {
    keyRejected(port);
    return 1;
  }
  if (typeof res === 'string' || !res.ok) {
    console.error(`The bridge is not running on port ${port}. Run "start" first.`);
    return 1;
  }
  const p = (await res.json()) as { code: string; secret: string; machineName: string };
  const settings = readSettings();
  const host = settings.host ?? tailscaleAddresses().find((a) => !a.includes(':'));
  if (!host) {
    console.warn('Warning: no Tailscale address found, using 127.0.0.1 (the phone will not be able to connect).');
    if (isWsl()) {
      console.warn('Running in WSL: make the bridge listen on all addresses and put the Windows Tailscale address in the QR code:');
      console.warn('  herdr-bridge config listen all');
      console.warn('  herdr-bridge config host <Windows Tailscale IP, e.g. 100.x.y.z>');
      console.warn('then forward port 7420 from Windows into WSL. See: https://hoanghungbk93.github.io/HerdrMobile/#wsl');
    }
  }
  const url = pairUrl(host ?? '127.0.0.1', port, p.secret, p.machineName);
  qrcode.generate(url, { small: true });
  console.log(codeLine(p.code));
  return 0;
}

async function devicesCmd(port: number): Promise<number> {
  const res = await daemon(port, 'GET', '/local/devices');
  if (res === 'unresponsive') {
    notResponding(port);
    return 1;
  }
  if (res !== 'no-daemon' && res.status === 403) {
    keyRejected(port);
    return 1;
  }
  if (res !== 'no-daemon' && res.ok) printDevices((await res.json()) as DeviceRow[]);
  else {
    console.log(`(read devices.json directly: no bridge is running on port ${port})`);
    printDevices(new DeviceStore(DATA_DIR).list());
  }
  return 0;
}

async function revoke(port: number, id: string | undefined): Promise<number> {
  if (!id) {
    console.error('Usage: revoke <id>');
    return 2;
  }
  const res = await daemon(port, 'POST', `/local/revoke/${encodeURIComponent(id)}`);
  if (res === 'unresponsive') {
    notResponding(port);
    return 1;
  }
  if (res !== 'no-daemon') {
    if (res.status === 403) {
      keyRejected(port);
      return 1;
    }
    if (res.status === 204) console.log(`Revoked ${id}.`);
    else if (res.status === 404) console.error(`Device ${id} not found.`);
    else console.error(`Error ${res.status}`);
    return res.status === 204 ? 0 : 1;
  }
  console.log(`(edited devices.json directly: no bridge is running on port ${port})`);
  if (new DeviceStore(DATA_DIR).revoke(id)) {
    console.log(`Revoked ${id}.`);
    return 0;
  }
  console.error(`Device ${id} not found.`);
  return 1;
}

async function status(port: number): Promise<number> {
  const res = await daemon(port, 'GET', '/local/status');
  if (typeof res !== 'string' && res.status === 403) {
    keyRejected(port);
    return 1;
  }
  if (typeof res === 'string' || !res.ok) {
    console.log(`Bridge: not running (port ${port})`);
    return 1;
  }
  const s = (await res.json()) as {
    machineName: string;
    port: number;
    tailscale?: string[];
    listening?: string[];
    sessions: { session: string; online: boolean; panes: number }[];
    devices: number;
    sockets: number;
  };
  console.log(`Bridge: running (${s.machineName}), port ${s.port}`);
  console.log(`Tailscale: ${s.tailscale?.length ? s.tailscale.join(', ') : 'no address yet'}`);
  console.log(`Listening on: ${s.listening?.join(', ') ?? '?'}`);
  if (s.sessions.length === 0) console.log('herdr: no running sessions');
  for (const x of s.sessions) console.log(`herdr "${x.session}": ${x.online ? 'online' : 'offline'}, ${x.panes} pane`);
  console.log(`Paired devices: ${s.devices}, connected: ${s.sockets}`);
  return 0;
}

function configCmd(args: string[]): number {
  const s = readSettings();
  const [key, value] = args;
  if (!key) {
    console.log(`listen: ${s.listen ?? 'tailscale'}  (tailscale = 127.0.0.1 + Tailscale addresses; all = 0.0.0.0)`);
    console.log(`host:   ${s.host ?? 'auto'}  (address put in the QR code; auto = this machine's Tailscale IP)`);
    return 0;
  }
  if (key === 'listen' && (value === 'all' || value === 'tailscale')) {
    writeSettings({ ...s, listen: value === 'all' ? 'all' : undefined });
    console.log(`Set listen = ${value}. Restart the bridge to apply it: herdr-bridge install`);
    if (value === 'all')
      console.log('Note: the bridge now accepts connections from every network this machine is on; restrict it with a firewall if needed.');
    return 0;
  }
  if (key === 'host' && value) {
    if (value === 'auto') writeSettings({ ...s, host: undefined });
    else if (!validHost(value)) {
      console.error(`Invalid address: ${value}`);
      return 2;
    } else writeSettings({ ...s, host: value });
    console.log(`Set host = ${value}. Run herdr-bridge pair again for a new QR code.`);
    return 0;
  }
  console.error('Usage: herdr-bridge config [listen all|tailscale] [host <ip>|auto]');
  return 2;
}

async function serviceCmd(cmd: 'install' | 'uninstall'): Promise<number> {
  try {
    if (cmd === 'install') {
      if (/^bun(\.exe)?$/i.test(path.basename(process.execPath))) {
        console.error('Run "install" from the compiled herdr-bridge binary, not through bun.');
        return 1;
      }
      const r = await installService();
      console.log(`Autostart registered: ${process.execPath} start (log: ${logPath()})`);
      if (r.mode === 'runkey')
        console.log('(No admin rights, so the per-user Run key is used instead of Task Scheduler; it still starts at login.)');
      if (r.firewall === false)
        console.log(
          'Warning: no firewall rule for the bridge port, so the phone cannot connect. Open PowerShell (Admin) and run:\n' +
            '  netsh advfirewall firewall add rule name=herdr-bridge dir=in action=allow protocol=TCP localport=7420 profile=any',
        );
    } else {
      await uninstallService();
      console.log(`Autostart removed. Data in ${DATA_DIR} is kept.`);
    }
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}

export async function main(argv: string[]): Promise<number | 'running'> {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return 2;
  }
  switch (a.cmd) {
    case 'start':
      await start(a.port);
      return 'running';
    case 'pair':
      return pair(a.port);
    case 'devices':
      return devicesCmd(a.port);
    case 'revoke':
      return revoke(a.port, a.rest[0]);
    case 'status':
      return status(a.port);
    case 'config':
      return configCmd(a.rest);
    case 'install':
    case 'uninstall':
      return serviceCmd(a.cmd);
    case 'update':
      return updateCmd(a.rest);
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return 0;
    default:
      console.error('Usage: herdr-bridge <start|pair|devices|revoke <id>|status|config|install|uninstall|update [--force]|version> [--port N]');
      return 2;
  }
}

if (import.meta.main) {
  const r = await main(process.argv.slice(2));
  if (r !== 'running') process.exit(r);
}

/** WSL sets WSL_DISTRO_NAME; older builds only show "microsoft" in the kernel version. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(require('node:fs').readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}
