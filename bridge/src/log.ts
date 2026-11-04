import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

type ConsoleLike = Pick<Console, 'log' | 'info' | 'warn' | 'error'>;

/**
 * Sends console.log/info/warn/error to `logPath` (append, timestamped) instead
 * of stdout/stderr. Used by `start` when stdout is not a TTY, so the log exists
 * on every OS (Task Scheduler has no stdout redirect; launchd/systemd also point
 * stdout at the same file, which then only catches output from before this runs).
 * Writes synchronously so the last lines before a crash are not lost.
 * Returns a function restoring the original methods.
 */
export function redirectConsoleToFile(logPath: string, con: ConsoleLike = console): () => void {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const orig = { log: con.log, info: con.info, warn: con.warn, error: con.error };
  const write = (level: string) => (...args: unknown[]) => {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${level} ${format(...args)}\n`, { mode: 0o600 });
    } catch {
      /* disk full / permissions: nowhere left to report */
    }
  };
  con.log = write('INFO');
  con.info = write('INFO');
  con.warn = write('WARN');
  con.error = write('ERROR');
  return () => Object.assign(con, orig);
}

const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/**
 * Process-level crash handlers for `start`: an unhandled rejection is logged
 * and the daemon keeps going; an uncaught exception is logged and the process
 * exits non-zero so the supervisor (launchd / systemd / Task Scheduler) restarts it.
 */
export function crashHandlers(
  log: (msg: string) => void = (m) => console.error(m),
  exit: (code: number) => void = (c) => process.exit(c),
) {
  return {
    unhandledRejection: (reason: unknown) => log(`[bridge] unhandled rejection: ${describe(reason)}`),
    uncaughtException: (err: unknown) => {
      log(`[bridge] uncaught exception, exiting: ${describe(err)}`);
      exit(1);
    },
  };
}

export function installCrashHandlers(): void {
  const h = crashHandlers();
  process.on('unhandledRejection', h.unhandledRejection);
  process.on('uncaughtException', h.uncaughtException);
}
