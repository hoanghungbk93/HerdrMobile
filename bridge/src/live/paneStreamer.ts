import type { ServerMsg } from '@herdr-mobile/protocol';
import type { HerdrClient } from '../herdr/client';
import type { ObserveFn, PaneObserver } from './observer';

type Frame = Extract<ServerMsg, { t: 'frame' }>;

interface PaneRead {
  read: { text: string; revision: number };
}

interface Watched {
  session: string;
  paneId: string;
  watchers: Map<string, (f: Frame) => void>;
  last: Frame | null;
  busy: boolean;
  /** herdr said the screen changed since the last read started. */
  dirty: boolean;
  observer: PaneObserver | null;
  /** When the observer died, retry it after this time (ms epoch); 0 = try now. */
  observeRetryAt: number;
  lastReadAt: number;
}

export interface StreamerOptions {
  /** Push-based change feed; without it (or when it fails) the pane is polled at `hz`. */
  observe?: ObserveFn;
  /** With a live observer, a safety read this often in case a push was missed. */
  idlePollMs?: number;
  /** Floor between two reads of one pane, so a busy log can't flood the phone. */
  minGapMs?: number;
  /** After an observer exits, poll for this long before trying a new one. */
  retryMs?: number;
  now?: () => number;
}

/**
 * Streams `pane.read` (visible, ANSI kept) for panes some client is watching, one read per pane
 * however many clients watch it. With herdr's terminal observer (0.9.2+) a read happens right after
 * herdr reports a change, and an idle pane costs almost nothing; otherwise it polls at `hz`.
 * A frame is sent only when the revision or the text changed: herdr 0.9.3 leaves `revision`
 * at 0 on shell panes while their screen changes, so revision alone would freeze the view.
 */
export class PaneStreamer {
  private panes = new Map<string, Watched>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly observe?: ObserveFn;
  private readonly idlePollMs: number;
  private readonly minGapMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(
    private readonly getClient: (session: string) => HerdrClient | null,
    private readonly hz = 6,
    opts: StreamerOptions = {},
  ) {
    this.observe = opts.observe;
    this.idlePollMs = opts.idlePollMs ?? 2000;
    this.minGapMs = opts.minGapMs ?? 50;
    this.retryMs = opts.retryMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  watch(clientId: string, session: string, paneId: string, onFrame: (f: Frame) => void): void {
    const key = `${session}\n${paneId}`;
    let w = this.panes.get(key);
    if (!w) {
      w = {
        session,
        paneId,
        watchers: new Map(),
        last: null,
        busy: false,
        dirty: true,
        observer: null,
        observeRetryAt: 0,
        lastReadAt: 0,
      };
      this.panes.set(key, w);
      this.startObserver(key, w);
      this.read(key, w, false);
    }
    w.watchers.set(clientId, onFrame);
    if (w.last) onFrame(w.last);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000 / this.hz);
  }

  /** Without session/paneId, drops every pane this client watches. */
  unwatch(clientId: string, session?: string, paneId?: string): void {
    for (const [key, w] of this.panes) {
      if (session !== undefined && (w.session !== session || w.paneId !== paneId)) continue;
      w.watchers.delete(clientId);
      if (w.watchers.size === 0) this.drop(key, w);
    }
    if (this.panes.size === 0) this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [key, w] of this.panes) this.drop(key, w);
  }

  private drop(key: string, w: Watched): void {
    w.observer?.kill();
    w.observer = null;
    this.panes.delete(key);
  }

  private startObserver(key: string, w: Watched): void {
    if (!this.observe) return;
    const obs = this.observe(
      w.session,
      w.paneId,
      () => {
        if (this.panes.get(key) !== w) return;
        w.dirty = true;
        this.read(key, w, true);
      },
      () => {
        if (this.panes.get(key) !== w) return;
        w.observer = null;
        w.observeRetryAt = this.now() + this.retryMs;
      },
    );
    if (obs) w.observer = obs;
    else w.observeRetryAt = this.now() + this.retryMs;
  }

  private tick(): void {
    const now = this.now();
    for (const [key, w] of this.panes) {
      if (!w.observer && this.observe && now >= w.observeRetryAt) this.startObserver(key, w);
      // With a live observer, reads are driven by its pushes; poll only as a safety net.
      if (w.observer && !w.dirty && now - w.lastReadAt < this.idlePollMs) continue;
      this.read(key, w, false);
    }
  }

  /** `throttle`: push-driven reads keep `minGapMs` apart; timer reads are already spaced by the tick. */
  private read(key: string, w: Watched, throttle: boolean): void {
    if (w.busy) return; // the in-flight read re-runs on completion if still dirty
    const client = this.getClient(w.session);
    if (!client) return;
    const wait = throttle ? w.lastReadAt + this.minGapMs - this.now() : 0;
    if (wait > 0) {
      w.busy = true;
      setTimeout(() => {
        w.busy = false;
        if (this.panes.get(key) === w) this.read(key, w, false);
      }, wait);
      return;
    }
    w.busy = true;
    w.dirty = false;
    w.lastReadAt = this.now();
    client
      .request<PaneRead>('pane.read', { pane_id: w.paneId, source: 'visible', format: 'ansi', strip_ansi: false })
      .then(({ read }) => {
        if (this.panes.get(key) !== w) return; // unwatched meanwhile
        if (w.last && w.last.revision === read.revision && w.last.text === read.text) return;
        w.last = { t: 'frame', session: w.session, paneId: w.paneId, revision: read.revision, text: read.text };
        for (const cb of w.watchers.values()) cb(w.last);
      })
      .catch(() => {
        /* pane gone or herdr unreachable: keep trying until unwatched */
      })
      .finally(() => {
        w.busy = false;
        if (w.dirty && this.panes.get(key) === w) this.read(key, w, true);
      });
  }
}
