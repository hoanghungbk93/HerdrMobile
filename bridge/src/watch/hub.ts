import { EventEmitter } from 'node:events';
import type { SessionSnapshot } from '@herdr-mobile/protocol';
import type { HerdrClient } from '../herdr/client';
import { listSessions as realListSessions, type SessionInfo } from '../herdr/sessions';
import { SessionWatcher } from './sessionWatcher';

export interface HubOptions {
  /** Resolves null when the listing failed (as opposed to [] = no sessions). */
  listSessions?: () => Promise<SessionInfo[] | null>;
  refreshMs?: number;
  /** Test seam: builds the watcher for a session. */
  createWatcher?: (s: { name: string; socketPath: string }) => SessionWatcher;
}

export class Hub extends EventEmitter {
  private watchers = new Map<string, SessionWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private list: () => Promise<SessionInfo[] | null>;
  private refreshMs: number;
  private create: (s: { name: string; socketPath: string }) => SessionWatcher;
  private running = false;
  private refreshing = false;

  constructor(opts: HubOptions = {}) {
    super();
    this.list = opts.listSessions ?? (() => realListSessions());
    this.refreshMs = opts.refreshMs ?? 10000;
    this.create = opts.createWatcher ?? ((s) => new SessionWatcher(s));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
  }

  sessions(): SessionSnapshot[] {
    return [...this.watchers.values()].map((w) => w.current());
  }

  client(session: string): HerdrClient | null {
    return this.watchers.get(session)?.client() ?? null;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return; // a slow `herdr session list` must not pile up
    this.refreshing = true;
    try {
      const all = await this.list();
      // A failed listing says nothing about which sessions are gone: keep every watcher as is.
      if (!this.running || all === null) return;
      const live = new Map(all.filter((s) => s.running).map((s) => [s.name, s]));
      for (const [name, w] of [...this.watchers]) {
        if (!live.has(name)) {
          w.stop();
          this.watchers.delete(name);
          this.emit('snapshot', { session: name, online: false, workspaces: [], tabs: [], panes: [] } as SessionSnapshot);
        }
      }
      for (const [name, info] of live) {
        if (this.watchers.has(name)) continue;
        const w = this.create({ name, socketPath: info.socketPath });
        w.on('transition', (t) => this.emit('transition', t));
        w.on('snapshot', (s) => this.emit('snapshot', s));
        this.watchers.set(name, w);
        w.start();
      }
    } catch (e) {
      console.warn('[hub] session refresh failed:', e instanceof Error ? e.message : e);
    } finally {
      this.refreshing = false;
    }
  }
}
