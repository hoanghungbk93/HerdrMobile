import { HERDR_BIN } from '../config';
import type { HerdrClient } from '../herdr/client';

export interface PtySize {
  cols: number;
  rows: number;
}

/** A writable terminal session that holds the pane at a size; `send` takes one JSON command. */
export interface Controller {
  send(cmd: object): void;
  close(): void;
}

export interface PhoneViewDeps {
  getClient: (session: string) => HerdrClient | null;
  /** The pane's real pty size before we touch it (null: unknown, e.g. native Windows; then we never resize). */
  readSize: (session: string, paneId: string) => Promise<PtySize | null>;
  openController: (session: string, paneId: string, size: PtySize, onExit: () => void) => Controller | null;
  /** Something about the pane changed: re-read its screen now. */
  poke: (session: string, paneId: string) => void;
  onState: (state: { session: string; paneId: string; offset: number; max: number; phone: boolean }) => void;
  /** Back at the bottom and untouched this long: give the pane back to the computer. */
  idleMs?: number;
  /** Scrolled up but untouched this long: scroll to the bottom and give it back anyway. */
  abandonMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

interface Held {
  session: string;
  paneId: string;
  orig: PtySize | null;
  size: PtySize | null;
  controller: Controller | null;
  offset: number;
  max: number;
  lastAt: number;
  /** "Fit to phone" is on: never given back for idleness, only when turned off or the phone leaves. */
  pinned: boolean;
  /** Serialises scroll requests for this pane. */
  chain: Promise<void>;
}

interface PaneInfo {
  pane: { scroll?: { offset_from_bottom?: number; max_offset_from_bottom?: number } };
}

const clampSize = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * Lets the phone scroll a pane's history at a readable size, like scrolling on the computer.
 * The first scroll resizes the pane to the phone's screen (herdr `terminal session control`) and scrolls it with
 * `pane.scroll`; the computer shows the same thing meanwhile. Once the phone is back at the bottom and idle, or
 * stops watching, the pane is resized to its original size and released.
 */
export class PhoneView {
  private held = new Map<string, Held>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly idleMs: number;
  private readonly abandonMs: number;
  private readonly now: () => number;
  private readonly log: (m: string) => void;

  constructor(private readonly d: PhoneViewDeps) {
    this.idleMs = d.idleMs ?? 15_000;
    this.abandonMs = d.abandonMs ?? 120_000;
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((m) => console.log(m));
  }

  isHeld(session: string, paneId: string): boolean {
    return this.held.has(`${session}\n${paneId}`);
  }

  scroll(session: string, paneId: string, lines: number, cols: number, rows: number, toBottom = false): Promise<void> {
    const key = `${session}\n${paneId}`;
    let h = this.held.get(key);
    if (!h) {
      if (toBottom || lines <= 0) return Promise.resolve(); // nothing to undo
      h = this.hold(key, session, paneId);
    }
    const target = h;
    target.lastAt = this.now();
    target.chain = target.chain.then(() => this.apply(key, target, lines, { cols, rows }, toBottom)).catch((e) => {
      this.log(`[phone] scroll ${paneId} failed: ${e instanceof Error ? e.message : e}`);
    });
    return target.chain;
  }

  /** "Fit to phone": hold the pane at the phone's size (on), or give it back unless it is scrolled up (off). */
  fit(session: string, paneId: string, on: boolean, cols: number, rows: number): Promise<void> {
    const key = `${session}\n${paneId}`;
    let h = this.held.get(key);
    if (!on) {
      if (!h) return Promise.resolve();
      h.pinned = false;
      return h.offset === 0 ? this.restore(key, h) : Promise.resolve();
    }
    if (!h) h = this.hold(key, session, paneId);
    const target = h;
    target.pinned = true;
    target.lastAt = this.now();
    target.chain = target.chain.then(() => this.take(key, target, { cols, rows })).catch((e) => {
      this.log(`[phone] fit ${paneId} failed: ${e instanceof Error ? e.message : e}`);
    });
    return target.chain;
  }

  private hold(key: string, session: string, paneId: string): Held {
    const h: Held = {
      session,
      paneId,
      orig: null,
      size: null,
      controller: null,
      offset: 0,
      max: 0,
      lastAt: this.now(),
      pinned: false,
      chain: Promise.resolve(),
    };
    this.held.set(key, h);
    if (!this.timer) this.timer = setInterval(() => this.sweep(), 1000);
    return h;
  }

  /** Resize the pane to the phone (first time: remember its size and open the controller). */
  private async take(key: string, h: Held, want: PtySize): Promise<void> {
    if (this.held.get(key) !== h) return;
    const size = { cols: clampSize(want.cols, 20, 300), rows: clampSize(want.rows, 5, 200) };
    if (!h.controller) {
      if (h.orig === null) h.orig = await this.d.readSize(h.session, h.paneId);
      if (h.orig && this.held.get(key) === h) {
        h.controller = this.d.openController(h.session, h.paneId, size, () => {
          // herdr closed the stream (pane gone, or another controller took over): we no longer hold the size.
          if (this.held.get(key) === h) h.controller = null;
        });
        if (h.controller) h.size = size;
      }
    } else if (h.size && (h.size.cols !== size.cols || h.size.rows !== size.rows)) {
      h.controller.send({ type: 'terminal.resize', cols: size.cols, rows: size.rows });
      h.size = size;
    }
    this.d.poke(h.session, h.paneId);
    this.d.onState({ session: h.session, paneId: h.paneId, offset: h.offset, max: h.max, phone: !!h.controller });
  }

  /** The phone no longer watches this pane (or any pane, without paneId). */
  leave(session?: string, paneId?: string): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const [key, h] of this.held) {
      if (session !== undefined && (h.session !== session || h.paneId !== paneId)) continue;
      jobs.push(this.restore(key, h));
    }
    return Promise.all(jobs).then(() => {});
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.leave();
  }

  private async apply(key: string, h: Held, lines: number, want: PtySize, toBottom: boolean): Promise<void> {
    if (this.held.get(key) !== h) return;
    const client = this.d.getClient(h.session);
    if (!client) return;
    if (!toBottom) await this.take(key, h, want);
    if (this.held.get(key) !== h) return;
    const offset = toBottom ? 0 : Math.max(0, h.offset + Math.round(lines));
    const r = await client.request<PaneInfo>('pane.scroll', { pane_id: h.paneId, offset_from_bottom: offset });
    h.offset = r.pane.scroll?.offset_from_bottom ?? offset;
    h.max = r.pane.scroll?.max_offset_from_bottom ?? h.max;
    this.d.poke(h.session, h.paneId);
    this.d.onState({ session: h.session, paneId: h.paneId, offset: h.offset, max: h.max, phone: !!h.controller });
  }

  private restore(key: string, h: Held): Promise<void> {
    if (this.held.get(key) !== h) return Promise.resolve();
    this.held.delete(key);
    if (this.held.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return h.chain.then(async () => {
      const client = this.d.getClient(h.session);
      if (client && h.offset > 0) {
        await client.request('pane.scroll', { pane_id: h.paneId, offset_from_bottom: 0 }).catch(() => {});
      }
      if (h.controller && h.orig) {
        // herdr keeps the controller's size after release: put the computer's size back first.
        h.controller.send({ type: 'terminal.resize', cols: h.orig.cols, rows: h.orig.rows });
        h.controller.send({ type: 'terminal.release' });
        h.controller.close();
      }
      h.controller = null;
      this.d.poke(h.session, h.paneId);
      this.d.onState({ session: h.session, paneId: h.paneId, offset: 0, max: h.max, phone: false });
    });
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, h] of this.held) {
      const idle = now - h.lastAt;
      if (h.pinned) continue;
      if ((h.offset === 0 && idle >= this.idleMs) || idle >= this.abandonMs) void this.restore(key, h);
    }
  }
}

// ---- real herdr / OS implementations ------------------------------------------------------------

async function run(cmd: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

/** Reads the pane's pty size from its shell's terminal (`stty size` on that tty). macOS/Linux only. */
export function readSizeVia(getClient: (session: string) => HerdrClient | null) {
  return async (session: string, paneId: string): Promise<PtySize | null> => {
    if (process.platform === 'win32') return null;
    const client = getClient(session);
    if (!client) return null;
    try {
      const r = await client.request<{ process_info: { shell_pid?: number } }>('pane.process_info', { pane_id: paneId });
      const pid = r.process_info.shell_pid;
      if (!pid) return null;
      const tty = (await run(['ps', '-o', 'tty=', '-p', String(pid)]))?.trim();
      if (!tty || tty === '?' || tty === '??') return null;
      const dev = tty.startsWith('/') ? tty : `/dev/${tty}`;
      const out = await run(['stty', process.platform === 'darwin' ? '-f' : '-F', dev, 'size']);
      const m = out?.trim().match(/^(\d+) (\d+)$/);
      return m ? { rows: Number(m[1]), cols: Number(m[2]) } : null;
    } catch {
      return null;
    }
  };
}

/** `herdr terminal session control --takeover` at `size`; output is drained and ignored (screens come from pane.read). */
export function openControllerCli(session: string, paneId: string, size: PtySize, onExit: () => void): Controller | null {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [HERDR_BIN, '--session', session, 'terminal', 'session', 'control', paneId, '--takeover', '--cols', String(size.cols), '--rows', String(size.rows)],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
    );
  } catch {
    return null;
  }
  let closed = false;
  // Drain frames so herdr never sees a stalled reader.
  (async () => {
    try {
      for await (const _ of proc.stdout as ReadableStream<Uint8Array>) {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  })();
  proc.exited.then(() => {
    if (!closed) onExit();
  });
  const stdin = proc.stdin as import('bun').FileSink;
  return {
    send(cmd) {
      if (closed) return;
      try {
        stdin.write(JSON.stringify(cmd) + '\n');
        stdin.flush();
      } catch {
        /* process gone */
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        stdin.end();
      } catch {
        /* ignore */
      }
      // Give herdr a moment to apply the resize and release before the process goes away.
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      }, 500);
    },
  };
}
