import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config';

/**
 * User settings in DATA_DIR/settings.json.
 * - listen: 'tailscale' (default) binds 127.0.0.1 plus each Tailscale address; 'all' binds 0.0.0.0, for setups
 *   where the Tailscale address lives elsewhere (WSL in NAT mode behind a Windows port proxy).
 * - host: the address the phone should dial, put in the pairing QR; default = first Tailscale IPv4.
 */
export interface Settings {
  listen?: 'tailscale' | 'all';
  host?: string;
  /** Live Activity relay URL; 'off' disables Live Activities. */
  relay?: string;
}

const file = (dir: string) => path.join(dir, 'settings.json');

export function readSettings(dir = DATA_DIR): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    const s: Settings = {};
    if (raw?.listen === 'all' || raw?.listen === 'tailscale') s.listen = raw.listen;
    if (typeof raw?.host === 'string' && raw.host.trim()) s.host = raw.host.trim();
    if (typeof raw?.relay === 'string' && (raw.relay === 'off' || /^https?:\/\/\S+$/.test(raw.relay))) s.relay = raw.relay;
    return s;
  } catch {
    return {};
  }
}

export function writeSettings(s: Settings, dir = DATA_DIR): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file(dir));
}

/** A hostname or IP the phone can dial: no scheme, port, path or spaces. */
export function validHost(h: string): boolean {
  return /^[A-Za-z0-9.-]+$/.test(h) || /^[0-9A-Fa-f:]+$/.test(h);
}
