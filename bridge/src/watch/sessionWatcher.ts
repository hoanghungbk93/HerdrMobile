import { EventEmitter } from 'node:events';
import type { AgentStatus, PaneSummary, SessionSnapshot } from '@herdr-mobile/protocol';
import { TESTED_PROTOCOL } from '../config';
import { HerdrClient } from '../herdr/client';
import { subscribe } from '../herdr/subscription';
import { StatusTracker, type AgentObservation, type Transition } from './statusTracker';

// herdr rejects wildcards, so the topology types are spelled out.
const TOPOLOGY_TYPES = [
  'pane.created',
  'pane.closed',
  'pane.moved',
  'pane.updated',
  'pane.agent_detected',
  'pane.exited',
  'tab.created',
  'tab.closed',
  'tab.moved',
  'tab.renamed',
  'workspace.created',
  'workspace.closed',
  'workspace.moved',
  'workspace.renamed',
  'workspace.updated',
];

const BACKOFF_MS = [500, 1000, 2000, 3000];
const DEBOUNCE_MS = 200;
const RESUBSCRIBE_RETRY_MS = 1000;

type Sub = { close(): void };

export function buildSnapshot(session: string, snap: any): SessionSnapshot {
  const agents: any[] = Array.isArray(snap?.agents) ? snap.agents : [];
  const agentName = (paneId: string, pane: any): string | null =>
    agents.find((a) => a.pane_id === paneId)?.agent ?? pane.agent ?? null;
  return {
    session,
    online: true,
    protocol: snap?.protocol,
    workspaces: (snap?.workspaces ?? []).map((w: any) => ({ id: w.workspace_id, label: w.label ?? '' })),
    tabs: (snap?.tabs ?? []).map((t: any) => ({ id: t.tab_id, workspaceId: t.workspace_id, label: t.label ?? '' })),
    panes: (snap?.panes ?? []).map(
      (p: any): PaneSummary => ({
        session,
        paneId: p.pane_id,
        tabId: p.tab_id,
        workspaceId: p.workspace_id,
        agent: agentName(p.pane_id, p),
        label: p.label ?? null,
        status: (p.agent_status ?? 'unknown') as AgentStatus,
        cwd: p.cwd ?? null,
        revision: p.revision ?? 0,
      }),
    ),
  };
}

/** Dedupe key: pane `revision` is herdr metadata bumped by title changes, so it is ignored. */
function dedupeKey(s: SessionSnapshot): string {
  return JSON.stringify({ ...s, panes: s.panes.map(({ revision: _r, ...rest }) => rest) });
}

export class SessionWatcher extends EventEmitter {
  private pollMs: number;
  private ackTimeoutMs: number | undefined;
  private snap: SessionSnapshot;
  private herdr: HerdrClient | null = null;
  private tracker: StatusTracker;
  private topoSub: Sub | null = null;
  private statusSub: Sub | null = null;
  private subscribedPanes = '';
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffIdx = 0;
  private running = false;
  private gen = 0; // bumped on every teardown so stale callbacks are ignored
  private connecting = false;
  private pendingReconnect = false;
  private offlineEmitted = false;

  constructor(
    private session: { name: string; socketPath: string },
    opts: { pollMs?: number; ackTimeoutMs?: number } = {},
  ) {
    super();
    this.pollMs = opts.pollMs ?? 5000;
    this.ackTimeoutMs = opts.ackTimeoutMs;
    this.tracker = new StatusTracker(session.name);
    this.snap = this.offlineSnapshot();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    this.teardown();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  current(): SessionSnapshot {
    return this.snap;
  }

  client(): HerdrClient | null {
    return this.herdr;
  }

  private offlineSnapshot(): SessionSnapshot {
    return { session: this.session.name, online: false, workspaces: [], tabs: [], panes: [] };
  }

  private teardown(): void {
    this.gen++;
    this.topoSub?.close();
    this.statusSub?.close();
    this.topoSub = this.statusSub = null;
    this.subscribedPanes = '';
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = this.debounceTimer = null;
    this.herdr?.close();
    this.herdr = null;
  }

  /** Connects, snapshots and subscribes. On any failure schedules a retry. */
  private async connect(): Promise<void> {
    if (!this.running) return;
    if (this.connecting) {
      this.pendingReconnect = true; // run once the in-flight attempt settles
      return;
    }
    this.connecting = true;
    this.teardown();
    const gen = this.gen;
    try {
      const client = await HerdrClient.connect(this.session.socketPath);
      this.herdr = client;
      const { snap, agents } = await this.readSnapshot(client);
      if (gen !== this.gen) return;
      if (snap.protocol !== undefined && snap.protocol !== TESTED_PROTOCOL) {
        console.warn(
          `[bridge] session ${this.session.name}: herdr protocol ${snap.protocol}, tested ${TESTED_PROTOCOL}; continuing`,
        );
      }
      this.topoSub = await subscribe(
        this.session.socketPath,
        TOPOLOGY_TYPES.map((type) => ({ type })),
        () => this.scheduleRefresh(),
        () => this.onSubEnd(gen),
        this.ackTimeoutMs,
      );
      if (gen !== this.gen) {
        this.topoSub.close();
        return;
      }
      this.setSnapshot(snap, agents); // seeds the tracker (or reports real changes after a gap)
      await this.pollOnce(gen, client);
      if (gen !== this.gen) return;
      await this.resubscribeStatus(gen, snap);
      if (gen !== this.gen) return;
      this.backoffIdx = 0;
      this.schedulePoll(gen);
    } catch {
      if (gen === this.gen || this.running) this.goOffline();
    } finally {
      this.connecting = false;
      if (this.pendingReconnect) {
        this.pendingReconnect = false;
        this.scheduleRetry();
      }
    }
  }

  private async readSnapshot(
    client: HerdrClient,
  ): Promise<{ snap: { protocol?: number } & SessionSnapshot; agents: AgentObservation[] }> {
    const r = await client.request<{ snapshot: any }>('session.snapshot');
    const agents = Array.isArray(r.snapshot?.agents) ? (r.snapshot.agents as AgentObservation[]) : [];
    return { snap: buildSnapshot(this.session.name, r.snapshot), agents };
  }

  /**
   * Swaps in a fresh snapshot. Emits 'snapshot' only when something changed:
   * herdr fires pane.updated for every terminal-title change, which must not
   * re-broadcast an identical session to every phone. The snapshot's agents
   * (with state_change_seq) seed the tracker, so a pane created since the last
   * poll is known before its first status change (first sight stays silent).
   */
  private setSnapshot(next: SessionSnapshot, agents: AgentObservation[]): void {
    const ids = new Set(next.panes.map((p) => p.paneId));
    for (const p of this.snap.panes) if (!ids.has(p.paneId)) this.tracker.remove(p.paneId);
    // The snapshot may be stale (requested before a status change, resolved after it).
    // Panes the tracker already knows keep their tracked status; only unknown panes are seeded.
    const prevById = new Map(this.snap.panes.map((p) => [p.paneId, p]));
    const fresh: AgentObservation[] = [];
    for (const a of agents) {
      if (!a || typeof a.pane_id !== 'string' || !ids.has(a.pane_id)) continue;
      if (this.tracker.knows(a.pane_id)) {
        const prev = prevById.get(a.pane_id);
        const p = next.panes.find((x) => x.paneId === a.pane_id);
        if (prev && p) {
          p.status = prev.status;
          p.agent = prev.agent;
        }
      } else fresh.push(a);
    }
    const changed = this.offlineEmitted || dedupeKey(next) !== dedupeKey(this.snap);
    this.snap = next;
    this.offlineEmitted = false;
    if (changed) this.emit('snapshot', next);
    this.applyAgents(fresh);
  }

  private goOffline(): void {
    this.teardown();
    // A fresh tracker: panes seen again after an outage are "first sight" and emit nothing.
    this.tracker = new StatusTracker(this.session.name);
    if (!this.offlineEmitted) {
      this.offlineEmitted = true;
      this.snap = this.offlineSnapshot();
      this.emit('snapshot', this.snap);
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer) return;
    const delay = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)]!;
    this.backoffIdx++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  /** A subscription ended (events_lost / closed / rejected): reconnect, keeping the tracker if herdr is still there. */
  private onSubEnd(gen: number): void {
    if (gen !== this.gen || !this.running) return;
    this.backoffIdx = 0;
    this.scheduleRetry();
    this.teardown();
  }

  private scheduleRefresh(delay = DEBOUNCE_MS): void {
    if (this.debounceTimer) return;
    const gen = this.gen;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh(gen);
    }, delay);
  }

  private async refresh(gen: number): Promise<void> {
    const client = this.herdr;
    if (gen !== this.gen || !client) return;
    try {
      const { snap, agents } = await this.readSnapshot(client);
      if (gen !== this.gen) return;
      this.setSnapshot(snap, agents);
      await this.resubscribeStatus(gen, snap);
    } catch {
      if (gen === this.gen) this.goOffline();
    }
  }

  /** Opens status subscription B for the current pane set; swaps it in only after the new one is acknowledged. */
  private async resubscribeStatus(gen: number, snap: SessionSnapshot): Promise<void> {
    const key = snap.panes
      .map((p) => p.paneId)
      .sort()
      .join(',');
    if (key === this.subscribedPanes) return;
    if (snap.panes.length === 0) {
      // Ruling: never subscribe with an empty list; topology sub + poll cover it.
      this.statusSub?.close();
      this.statusSub = null;
      this.subscribedPanes = key;
      return;
    }
    try {
      const next = await subscribe(
        this.session.socketPath,
        snap.panes.map((p) => ({ type: 'pane.agent_status_changed', pane_id: p.paneId })),
        (e) => void this.onStatusEvent(gen, e),
        () => this.onSubEnd(gen),
        this.ackTimeoutMs,
      );
      if (gen !== this.gen) {
        next.close();
        return;
      }
      const old = this.statusSub;
      this.statusSub = next;
      this.subscribedPanes = key;
      old?.close();
    } catch {
      // Rejected (e.g. a pane vanished meanwhile) or herdr briefly unavailable: poll covers it, retry soon.
      if (gen === this.gen) this.scheduleRefresh(RESUBSCRIBE_RETRY_MS);
    }
  }

  private async onStatusEvent(gen: number, e: any): Promise<void> {
    if (e?.event !== 'pane.agent_status_changed' || gen !== this.gen) return;
    // Events carry no state_change_seq; agent.list does, so fetch it for proper dedupe.
    const client = this.herdr;
    try {
      if (client) {
        const r = await client.request<{ agents: AgentObservation[] }>('agent.list');
        if (gen !== this.gen) return;
        this.applyAgents(r.agents);
        return;
      }
    } catch {
      /* fall through to the bare event */
    }
    if (gen !== this.gen || !e.data?.pane_id) return;
    this.applyAgents([e.data as AgentObservation]);
  }

  private applyAgents(agents: AgentObservation[]): void {
    const transitions = this.tracker.apply(agents, Date.now());
    for (const a of agents) {
      const p = this.snap.panes.find((x) => x.paneId === a.pane_id);
      if (p) {
        p.status = a.agent_status;
        p.agent = a.agent ?? p.agent;
      }
    }
    for (const t of transitions) this.emit('transition', t as Transition);
  }

  private async pollOnce(gen: number, client: HerdrClient): Promise<void> {
    const r = await client.request<{ agents: AgentObservation[] }>('agent.list');
    if (gen !== this.gen) return;
    this.applyAgents(r.agents);
  }

  private schedulePoll(gen: number): void {
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      const client = this.herdr;
      if (gen !== this.gen || !client) return;
      try {
        await this.pollOnce(gen, client);
      } catch {
        if (gen === this.gen) return this.goOffline();
        return;
      }
      if (gen === this.gen) this.schedulePoll(gen);
    }, this.pollMs);
  }
}
