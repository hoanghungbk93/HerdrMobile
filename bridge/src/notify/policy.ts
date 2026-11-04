import type { PushPrefs } from '@herdr-mobile/protocol';
import type { Transition } from '../watch/statusTracker';
import type { PushMessage } from './expoPush';

export type { PushMessage };

export interface DecideContext {
  agentLabel: string;
  workspaceLabel: string;
  prefs: PushPrefs;
  foreground: { session: string | null; paneId: string | null };
  detectionFirstLine?: string;
  hash?: string;
  /** When set, "done" coalescing is tracked per device, so one phone's push doesn't swallow another's. */
  deviceId?: string;
}

const MAX_LINE = 120;

export class NotifyPolicy {
  private readonly coalesceMs: number;
  private readonly lastDone = new Map<string, number>();

  constructor(opts: { coalesceMs?: number } = {}) {
    this.coalesceMs = opts.coalesceMs ?? 3000;
  }

  decide(t: Transition, ctx: DecideContext, now: number): PushMessage | null {
    let kind: 'blocked' | 'done';
    if (t.to === 'blocked') kind = 'blocked';
    else if (t.from === 'working' && (t.to === 'done' || t.to === 'idle')) kind = 'done';
    else return null;

    const key = `${t.session}:${t.paneId}`;
    if (ctx.prefs.mutedSessions.includes(t.session) || ctx.prefs.mutedPanes.includes(key)) return null;
    if (ctx.foreground.session === t.session && ctx.foreground.paneId === t.paneId) return null;

    if (kind === 'done') {
      const doneKey = ctx.deviceId === undefined ? key : `${ctx.deviceId}|${key}`;
      const last = this.lastDone.get(doneKey);
      if (last !== undefined && now - last < this.coalesceMs) return null;
      this.lastDone.set(doneKey, now);
    }

    let body = kind === 'blocked' ? 'Đang chờ duyệt' : 'Đã xong';
    if (!ctx.prefs.private && ctx.detectionFirstLine) {
      body += `: ${ctx.detectionFirstLine.slice(0, MAX_LINE)}`;
    }
    const msg: PushMessage = {
      title: `${ctx.agentLabel} · ${ctx.workspaceLabel}`,
      body,
      data: { session: t.session, paneId: t.paneId, kind },
    };
    if (kind === 'blocked') {
      msg.categoryId = 'approval';
      if (ctx.hash) msg.data.hash = ctx.hash;
    }
    return msg;
  }
}
