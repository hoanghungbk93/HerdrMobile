import { HERDR_BIN } from '../config';

export interface SessionInfo {
  name: string;
  socketPath: string;
  running: boolean;
}

/** Parses `herdr session list --json`; null when the output is not a session list. */
export function parseSessionList(json: string): SessionInfo[] | null {
  try {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.sessions)) return null;
    return data.sessions
      .filter((s: any) => s && typeof s.name === 'string' && typeof s.socket_path === 'string')
      .map((s: any) => ({ name: s.name, socketPath: s.socket_path, running: s.running === true }));
  } catch {
    return null;
  }
}

export const LIST_TIMEOUT_MS = 5000;

/**
 * Lists herdr sessions. Never throws. Returns null when the listing failed
 * (herdr missing, non-zero exit, unparseable output, or no answer within
 * `timeoutMs`, after which the process is killed) so callers can tell a failed
 * listing from a real empty one ([]).
 */
export async function listSessions(timeoutMs = LIST_TIMEOUT_MS, bin = HERDR_BIN): Promise<SessionInfo[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([bin, 'session', 'list', '--json'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (timedOut || code !== 0) return null;
    return parseSessionList(out);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
