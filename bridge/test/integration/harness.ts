import { describe } from 'bun:test';
import { HERDR_BIN } from '../../src/config';
import { HerdrClient } from '../../src/herdr/client';
import { listSessions } from '../../src/herdr/sessions';

const probe = (() => {
  try {
    return Bun.spawnSync([HERDR_BIN, '--version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  } catch {
    return false;
  }
})();

export const herdrAvailable = probe;
export const describeHerdr = describe.skipIf(!herdrAvailable);

async function run(args: string[]): Promise<void> {
  const p = Bun.spawn([HERDR_BIN, ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  await p.exited;
}

export function randomSessionName(): string {
  return `hm-it-${Math.random().toString(36).slice(2, 10)}`;
}

/** A fresh headless named server has no workspaces (herdr 0.9.3); create one so w1:p1 exists. Idempotent. */
async function ensureWorkspace(socketPath: string): Promise<void> {
  const call = async <T>(method: string): Promise<T> => {
    const c = await HerdrClient.connect(socketPath);
    try {
      return await c.request<T>(method, {}, 5000);
    } finally {
      c.close();
    }
  };
  const list = await call<{ workspaces?: unknown[] }>('workspace.list');
  if (!list.workspaces || list.workspaces.length === 0) await call('workspace.create');
}

/**
 * Starts a headless herdr server for a throwaway named session.
 * Command (verified on herdr 0.9.3): `herdr --session <name> server`
 * runs the server in the foreground with no TUI, so we spawn it with stdio
 * ignored. Never use bare `herdr` (attaches a TUI) and never touch `default`.
 * Names must start with `hm-it-`.
 */
export async function startHerdrSession(name: string): Promise<{ socketPath: string; stop(): Promise<void> }> {
  if (!name.startsWith('hm-it-')) throw new Error(`refusing non-throwaway session name: ${name}`);
  const proc = Bun.spawn([HERDR_BIN, '--session', name, 'server'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const stop = async () => {
    await run(['--session', name, 'server', 'stop']);
    // Server exits shortly after `server stop`; kill as a fallback.
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!exited) proc.kill();
    await proc.exited;
    await run(['session', 'delete', name]);
  };
  try {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const info = (await listSessions())?.find((s) => s.name === name && s.running);
      if (info) {
        try {
          // herdr closes the connection after each response, so use a fresh one.
          const c = await HerdrClient.connect(info.socketPath);
          const r = await c.request<{ type: string }>('ping', {}, 2000);
          c.close();
          if (r.type === 'pong') {
            await ensureWorkspace(info.socketPath);
            return { socketPath: info.socketPath, stop };
          }
        } catch {
          /* not ready yet */
        }
      }
      await Bun.sleep(100);
    }
    throw new Error(`herdr session ${name} did not become ready`);
  } catch (e) {
    await stop();
    throw e;
  }
}
