import type { ServerMsg } from '@herdr-mobile/protocol';
import type { HerdrClient } from '../herdr/client';

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
}

/**
 * Polls `pane.read` (visible, ANSI kept) for panes some client is watching,
 * one read per pane per tick however many clients watch it. A frame is sent
 * only when the revision or the text changed: herdr 0.9.3 leaves `revision`
 * at 0 on shell panes while their screen changes, so revision alone would
 * freeze the view.
 */
export class PaneStreamer {
  private panes = new Map<string, Watched>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getClient: (session: string) => HerdrClient | null,
    private readonly hz = 6,
  ) {}

  watch(clientId: string, session: string, paneId: string, onFrame: (f: Frame) => void): void {
    const key = `${session}\n${paneId}`;
    let w = this.panes.get(key);
    if (!w) {
      w = { session, paneId, watchers: new Map(), last: null, busy: false };
      this.panes.set(key, w);
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
      if (w.watchers.size === 0) this.panes.delete(key);
    }
    if (this.panes.size === 0) this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.panes.clear();
  }

  private tick(): void {
    for (const [key, w] of this.panes) {
      if (w.busy) continue; // previous read still in flight
      const client = this.getClient(w.session);
      if (!client) continue;
      w.busy = true;
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
        });
    }
  }
}
