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
import { installService, uninstallService } from './service/units';
import { UploadStore } from './uploads/store';
import { Hub } from './watch/hub';

const MAX_BODY = 512 * 1024 * 1024;

export function pairUrl(host: string, port: number, secret: string, machineName: string): string {
  return `herdrmobile://pair?h=${encodeURIComponent(host)}&p=${port}&s=${encodeURIComponent(secret)}&m=${encodeURIComponent(machineName)}`;
}

/** "482913" -> "482 913". */
export const splitCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

export const codeLine = (code: string): string => `Mã ghép: ${splitCode(code)} · hết hạn sau 5 phút`;

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
  const app = createApp({
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
  const b = new Binder((host) => serveOn(host, port, app));
  binder.current = b;
  try {
    b.start();
  } catch (e) {
    app.close();
    console.error(`Cannot listen on 127.0.0.1:${port}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  // Only once we own the port: a second `start` that fails to bind must not replace the running daemon's key.
  writeLocalKey(DATA_DIR, localKey);
  hub.start();
  console.log(`herdr-bridge "${machineName}" listening on port ${port} (${b.hosts().join(', ')}); data in ${DATA_DIR}`);
  if (tailscaleAddresses().length === 0) console.log('Tailscale not up: serving on localhost only, re-checking every 10 s');

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
  console.error(`Bridge trên cổng ${port} không phản hồi; không sửa devices.json. Thử lại sau.`);

/** 403 from a /local route: the key in local.key is not the running daemon's (another data dir / another user). */
const keyRejected = (port: number) =>
  console.error(
    `Bridge trên cổng ${port} từ chối khoá quản trị trong ${path.join(DATA_DIR, 'local.key')} ` +
      '(bridge đó chạy với thư mục dữ liệu hoặc user khác?). Khởi động lại bridge rồi thử lại.',
  );

interface DeviceRow { id: string; name: string; createdAt: number; lastSeenAt: number; connected?: number }

function printDevices(rows: DeviceRow[]): void {
  if (rows.length === 0) return console.log('Chưa có thiết bị nào được ghép.');
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
    console.error(`Bridge chưa chạy trên cổng ${port}. Chạy "start" trước.`);
    return 1;
  }
  const p = (await res.json()) as { code: string; secret: string; machineName: string };
  const host = tailscaleAddresses().find((a) => !a.includes(':'));
  if (!host) {
    console.warn('Cảnh báo: không thấy địa chỉ Tailscale, dùng 127.0.0.1 (điện thoại sẽ không kết nối được).');
    if (isWsl()) {
      console.warn('Đang chạy trong WSL: cần bật networkingMode=mirrored để WSL thấy địa chỉ Tailscale của Windows.');
      console.warn('Xem: https://hoanghungbk93.github.io/HerdrMobile/#wsl');
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
    console.log(`(đọc trực tiếp devices.json vì không có bridge nào chạy trên cổng ${port})`);
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
    if (res.status === 204) console.log(`Đã thu hồi ${id}.`);
    else if (res.status === 404) console.error(`Không tìm thấy thiết bị ${id}.`);
    else console.error(`Lỗi ${res.status}`);
    return res.status === 204 ? 0 : 1;
  }
  console.log(`(sửa trực tiếp devices.json vì không có bridge nào chạy trên cổng ${port})`);
  if (new DeviceStore(DATA_DIR).revoke(id)) {
    console.log(`Đã thu hồi ${id}.`);
    return 0;
  }
  console.error(`Không tìm thấy thiết bị ${id}.`);
  return 1;
}

async function status(port: number): Promise<number> {
  const res = await daemon(port, 'GET', '/local/status');
  if (typeof res !== 'string' && res.status === 403) {
    keyRejected(port);
    return 1;
  }
  if (typeof res === 'string' || !res.ok) {
    console.log(`Bridge: không chạy (cổng ${port})`);
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
  console.log(`Bridge: đang chạy (${s.machineName}), cổng ${s.port}`);
  console.log(`Tailscale: ${s.tailscale?.length ? s.tailscale.join(', ') : 'chưa có địa chỉ'}`);
  console.log(`Đang lắng nghe: ${s.listening?.join(', ') ?? '?'}`);
  if (s.sessions.length === 0) console.log('herdr: không có phiên nào đang chạy');
  for (const x of s.sessions) console.log(`herdr "${x.session}": ${x.online ? 'online' : 'offline'}, ${x.panes} pane`);
  console.log(`Thiết bị đã ghép: ${s.devices}, đang kết nối: ${s.sockets}`);
  return 0;
}

async function serviceCmd(cmd: 'install' | 'uninstall'): Promise<number> {
  try {
    if (cmd === 'install') {
      if (/^bun(\.exe)?$/i.test(path.basename(process.execPath))) {
        console.error('Hãy chạy "install" từ file herdr-bridge đã biên dịch, không phải qua bun.');
        return 1;
      }
      const r = await installService();
      console.log(`Đã đăng ký tự khởi động: ${process.execPath} start (log: ${logPath()})`);
      if (r.mode === 'runkey')
        console.log('(Không có quyền admin nên dùng khoá Run của user thay cho Task Scheduler; vẫn tự chạy khi đăng nhập.)');
      if (r.firewall === false)
        console.log(
          'Cảnh báo: chưa có luật tường lửa cho cổng bridge, điện thoại sẽ không kết nối được. Mở PowerShell (Admin) và chạy:\n' +
            '  netsh advfirewall firewall add rule name=herdr-bridge dir=in action=allow protocol=TCP localport=7420 profile=any',
        );
    } else {
      await uninstallService();
      console.log(`Đã gỡ tự khởi động. Dữ liệu trong ${DATA_DIR} được giữ nguyên.`);
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
    case 'install':
    case 'uninstall':
      return serviceCmd(a.cmd);
    default:
      console.error('Usage: herdr-bridge <start|pair|devices|revoke <id>|status|install|uninstall> [--port N]');
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
