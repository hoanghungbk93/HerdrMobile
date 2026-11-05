// Live Activity on the phone's lock screen / Dynamic Island: one per (phone, machine), driven from herdr status.
// The relay (holder of the APNs key) starts it with push-to-start into a broadcast channel; the bridge then
// broadcasts updates to that channel and ends it a while after every agent went quiet.
import type { SessionSnapshot } from '@herdr-mobile/protocol';
import type { ApnsEnv, Device, DeviceStore } from '../auth/store';

export const DEFAULT_RELAY_URL = 'https://herdr-relay.itmf.com.vn';

export interface ActivityRow {
  /** agent, e.g. "claude" */
  a: string;
  /** tab name the user gave it, else the pane's folder (never terminal content, so shown in private mode too) */
  t: string;
  s: 'working' | 'blocked';
}

/** Props the widget renders (keep in sync with app/src/liveActivity). */
export interface ActivityProps {
  /** machine name */
  m: string;
  /** number of agents working / waiting for approval */
  w: number;
  b: number;
  rows: ActivityRow[];
  /** every agent is quiet (shown before the activity ends) */
  done: boolean;
  /** text language of the phone */
  l: 'en' | 'vi';
}

const MAX_ROWS = 3;

/** Tab label, unless it is herdr's default number: then the pane's folder name. */
function placeOf(tab: string | undefined, label: string | null, cwd: string | null): string {
  const named = [label, tab].find((x) => x && !/^\d+$/.test(x.trim()));
  if (named) return named.trim();
  const dir = cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return dir || tab || '';
}

export function summarize(sessions: SessionSnapshot[], machine: string, l: 'en' | 'vi' = 'en'): ActivityProps {
  const rows: ActivityRow[] = [];
  let w = 0;
  let b = 0;
  for (const snap of sessions) {
    for (const p of snap.panes) {
      if (p.status !== 'working' && p.status !== 'blocked') continue;
      if (p.status === 'working') w++;
      else b++;
      const tab = snap.tabs.find((t) => t.id === p.tabId)?.label;
      rows.push({ a: p.agent ?? 'agent', t: placeOf(tab, p.label, p.cwd).slice(0, 40), s: p.status });
    }
  }
  rows.sort((x, y) => (x.s === y.s ? 0 : x.s === 'blocked' ? -1 : 1));
  return { m: machine.slice(0, 30), w, b, rows: rows.slice(0, MAX_ROWS), done: w + b === 0, l };
}

export interface RelayResult {
  status: number;
  channelId?: string;
}

export interface Relay {
  start(body: { env: ApnsEnv; startToken: string; props: string; alert: { title: string; body: string }; staleAt?: number }): Promise<RelayResult>;
  update(body: {
    env: ApnsEnv;
    channelId: string;
    props: string;
    event: 'update' | 'end';
    urgent?: boolean;
    alert?: { title: string; body: string };
    staleAt?: number;
  }): Promise<RelayResult>;
}

export function httpRelay(baseUrl: string, fetchImpl: typeof fetch = fetch): Relay {
  const call = async (path: string, body: object): Promise<RelayResult> => {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { channelId?: string };
    return { status: res.status, channelId: j.channelId };
  };
  return { start: (b) => call('/v1/la/start', b), update: (b) => call('/v1/la/update', b) };
}

export interface LiveActivityOptions {
  devices: DeviceStore;
  relay: Relay;
  machineName: string;
  sessions: () => SessionSnapshot[];
  now?: () => number;
  /** coalesce bursts of status changes */
  debounceMs?: number;
  /** keep the "done" state this long before ending (an agent often starts again right away) */
  endAfterMs?: number;
  /** iOS ends an activity after 8 h; restart it before that */
  maxAgeMs?: number;
  log?: (m: string) => void;
}

interface Live {
  props: string;
  quietSince: number | null;
}

export class LiveActivities {
  private readonly o: Required<Omit<LiveActivityOptions, 'log'>> & { log: (m: string) => void };
  private live = new Map<string, Live>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private urgent = false;
  private chain: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(o: LiveActivityOptions) {
    this.o = {
      now: Date.now,
      debounceMs: 1500,
      endAfterMs: 3 * 60_000,
      maxAgeMs: 7.5 * 3600_000,
      log: (m) => console.info(m),
      ...o,
    };
    // Ends quiet activities even when no status change comes.
    this.sweepTimer = setInterval(() => this.refresh(), 30_000);
  }

  /** Call on every status change / snapshot. `urgent`: an agent now waits for approval. */
  refresh(urgent = false): void {
    this.urgent ||= urgent;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const u = this.urgent;
      this.urgent = false;
      this.chain = this.chain.then(() => this.flush(u)).catch((e) => this.o.log(`[live-activity] ${e instanceof Error ? e.message : e}`));
    }, this.o.debounceMs);
  }

  /** For tests: run pending work now. */
  async settle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      const u = this.urgent;
      this.urgent = false;
      this.chain = this.chain.then(() => this.flush(u));
    }
    await this.chain;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.sweepTimer);
  }

  private async flush(urgent: boolean): Promise<void> {
    const sessions = this.o.sessions();
    for (const d of this.o.devices.list()) {
      if (!d.liveActivity?.startToken) continue;
      await this.flushDevice(d, summarize(sessions, this.o.machineName, d.lang ?? 'en'), urgent);
    }
  }

  private async flushDevice(d: Device, p: ActivityProps, urgent: boolean): Promise<void> {
    const now = this.o.now();
    const reg = d.liveActivity!;
    const props = JSON.stringify(p);
    let act = d.activity ?? null;
    let live = this.live.get(d.id);

    if (act && now - act.startedAt >= this.o.maxAgeMs) {
      await this.end(d, props);
      act = null;
      live = undefined;
    }

    if (!act) {
      if (p.done) return;
      const r = await this.o.relay.start({ env: reg.env, startToken: reg.startToken, props, alert: alertFor(p) });
      if (r.status === 200 && r.channelId) {
        this.o.devices.update(d.id, { activity: { channelId: r.channelId, env: reg.env, startedAt: now } });
        this.live.set(d.id, { props, quietSince: null });
        this.o.log(`[live-activity] started on ${d.name}`);
      } else if (r.status === 410) {
        this.o.devices.update(d.id, { liveActivity: null });
        this.o.log(`[live-activity] ${d.name}: start token rejected, waiting for a new one`);
      } else {
        this.o.log(`[live-activity] ${d.name}: start failed (${r.status})`);
      }
      return;
    }

    if (!live) {
      // Bridge restarted while an activity was up: resend the current state.
      live = { props: '', quietSince: null };
      this.live.set(d.id, live);
    }

    if (p.done) {
      live.quietSince ??= now;
      if (now - live.quietSince >= this.o.endAfterMs) {
        await this.end(d, props);
        return;
      }
    } else {
      live.quietSince = null;
    }

    if (props === live.props) return;
    const r = await this.o.relay.update({
      env: act.env,
      channelId: act.channelId,
      props,
      event: 'update',
      urgent: urgent || p.b > 0,
      ...(urgent && p.b > 0 ? { alert: alertFor(p) } : {}),
    });
    if (r.status === 200) live.props = props;
    else if (r.status === 410) this.drop(d);
  }

  private async end(d: Device, props: string): Promise<void> {
    const act = d.activity;
    if (act) {
      const r = await this.o.relay.update({ env: act.env, channelId: act.channelId, props, event: 'end' });
      if (r.status !== 200 && r.status !== 410) this.o.log(`[live-activity] ${d.name}: end failed (${r.status})`);
      else this.o.log(`[live-activity] ended on ${d.name}`);
    }
    this.drop(d);
  }

  private drop(d: Device): void {
    this.o.devices.update(d.id, { activity: null });
    this.live.delete(d.id);
  }
}

function alertFor(p: ActivityProps): { title: string; body: string } {
  const vi = p.l === 'vi';
  if (p.b > 0) return { title: p.m, body: vi ? `${p.b} agent đang chờ duyệt` : `${p.b} waiting for approval` };
  return { title: p.m, body: vi ? `${p.w} agent đang chạy` : `${p.w} running` };
}
