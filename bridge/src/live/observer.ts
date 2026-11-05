import { HERDR_BIN } from '../config';

/** A live change feed for one pane. `onChange` fires whenever herdr pushes a frame. */
export interface PaneObserver {
  kill(): void;
}

export type ObserveFn = (
  session: string,
  paneId: string,
  onChange: () => void,
  onExit: () => void,
) => PaneObserver | null;

/**
 * The viewport is only a trigger: herdr sends a frame whenever the visible cells inside it change,
 * and the screen itself is still read with `pane.read`. It must cover the whole pane, so it is
 * deliberately oversized. An observer never resizes the pane (a controller would).
 */
const VIEW_COLS = '400';
const VIEW_ROWS = '200';

/**
 * Spawns `herdr terminal session observe` (herdr 0.9.2+). Older herdr, or a platform without
 * terminal sessions, exits at once; the streamer then falls back to polling.
 */
export const observeWithCli: ObserveFn = (session, paneId, onChange, onExit) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [HERDR_BIN, '--session', session, 'terminal', 'session', 'observe', paneId, '--cols', VIEW_COLS, '--rows', VIEW_ROWS],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
    );
  } catch {
    return null;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onExit();
  };
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          // Frames carry base64 screen bytes we never decode; a cheap type check is enough.
          if (line.includes('"terminal.frame"')) onChange();
          else if (line.includes('"terminal.closed"')) finish();
        }
      }
    } catch {
      /* stream broke: treated as exit */
    }
    finish();
  })();
  proc.exited.then(finish, finish);
  return {
    kill() {
      done = true; // a deliberate stop is not an exit the streamer should react to
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
};
