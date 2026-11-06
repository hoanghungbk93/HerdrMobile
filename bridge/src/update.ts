import path from 'node:path';
import { VERSION } from './version';

export const DEFAULT_REPO = 'hoanghungbk93/HerdrMobile';

/** a > b for dotted numeric versions ("0.4.10" > "0.4.9"). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** ".../releases/tag/v0.4.3" -> "0.4.3". */
export function tagFromLocation(location: string | null): string | null {
  const m = location?.match(/\/releases\/tag\/v?([0-9][0-9A-Za-z.\-]*)$/);
  return m ? m[1]! : null;
}

/** Latest release version from the releases/latest redirect (no GitHub API, so no API rate limit). */
export async function latestVersion(repo: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const res = await fetchFn(`https://github.com/${repo}/releases/latest`, { redirect: 'manual' });
  return tagFromLocation(res.headers.get('location'));
}

/**
 * The official installer, run against the folder this binary lives in. It replaces the binary and restarts the
 * autostart service; pairing data lives elsewhere and is kept. On Windows install.ps1 stops every running
 * herdr-bridge.exe (this process too), so it runs detached.
 */
export function installerCommand(
  platform: NodeJS.Platform,
  execPath: string,
  repo: string,
): { cmd: string; args: string[]; env: Record<string, string>; detached: boolean } {
  const base = `https://github.com/${repo}/releases/latest/download`;
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${base}/install.ps1 | iex`],
      env: { HERDR_BRIDGE_PREFIX: path.win32.dirname(execPath), HERDR_BRIDGE_UPDATE: '1' },
      detached: true,
    };
  }
  return {
    cmd: 'sh',
    args: ['-c', `curl -fsSL ${base}/install.sh | sh`],
    // WSL networking was set up on first install; don't redo it (or reprint its Windows steps) on every update.
    env: { HERDR_BRIDGE_PREFIX: path.posix.dirname(execPath), HERDR_BRIDGE_SKIP_WSL: '1', HERDR_BRIDGE_UPDATE: '1' },
    detached: false,
  };
}

/** `herdr-bridge update [--force]`. */
export async function updateCmd(rest: string[]): Promise<number> {
  if (/^bun(\.exe)?$/i.test(path.basename(process.execPath))) {
    console.error('Run "update" from the compiled herdr-bridge binary, not through bun.');
    return 1;
  }
  const repo = process.env.HERDR_BRIDGE_REPO || DEFAULT_REPO;
  const force = rest.includes('--force');
  let latest: string | null;
  try {
    latest = await latestVersion(repo);
  } catch (e) {
    console.error(`Could not check for a new version: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  if (!latest) {
    console.error(`Could not read the latest version from github.com/${repo}/releases.`);
    return 1;
  }
  if (!force && !isNewer(latest, VERSION)) {
    console.log(`Already up to date (v${VERSION}).`);
    return 0;
  }
  console.log(`Updating herdr-bridge v${VERSION} -> v${latest}`);
  const c = installerCommand(process.platform, process.execPath, repo);
  const env = { ...process.env, ...c.env };
  if (c.detached) {
    const p = Bun.spawn([c.cmd, ...c.args], { env, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    p.unref();
    console.log('Installing in the background; the bridge restarts in a few seconds. Check with: herdr-bridge version');
    return 0;
  }
  const p = Bun.spawn([c.cmd, ...c.args], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  const code = await p.exited;
  if (code !== 0) console.error(`Update failed (exit ${code}).`);
  return code;
}
