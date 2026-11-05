import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStatus, SessionSnapshot } from '@herdr-mobile/protocol';
import { DeviceStore } from '../../src/auth/store';
import { LiveActivities, summarize, type Relay } from '../../src/notify/liveActivity';

const TOKEN = 'ab'.repeat(32);

function snap(statuses: AgentStatus[]): SessionSnapshot[] {
  return [
    {
      session: 'default',
      online: true,
      workspaces: [{ id: 'w1', label: 'main' }],
      tabs: statuses.map((_, i) => ({ id: `t${i}`, workspaceId: 'w1', label: `tab ${i}` })),
      panes: statuses.map((s, i) => ({
        session: 'default', paneId: `p${i}`, tabId: `t${i}`, workspaceId: 'w1', agent: 'claude', label: null, status: s, cwd: null, revision: 1,
      })),
    },
  ];
}

function setup(relayStatus: { start?: number; update?: number } = {}) {
  const devices = new DeviceStore(mkdtempSync(join(tmpdir(), 'la-')));
  const { device } = devices.add('phone');
  devices.update(device.id, { liveActivity: { startToken: TOKEN, env: 'production' }, prefs: { private: false, mutedSessions: [], mutedPanes: [] } });
  const calls: { kind: string; body: Record<string, unknown> }[] = [];
  const relay: Relay = {
    start: async (b) => (calls.push({ kind: 'start', body: b }), { status: relayStatus.start ?? 200, channelId: 'CH1' }),
    update: async (b) => (calls.push({ kind: b.event, body: b }), { status: relayStatus.update ?? 200 }),
  };
  let sessions = snap([]);
  let t = 1_000_000;
  const la = new LiveActivities({ devices, relay, machineName: 'mac', sessions: () => sessions, now: () => t, endAfterMs: 60_000, log: () => {} });
  return {
    devices, id: device.id, calls, la,
    set: (s: AgentStatus[]) => (sessions = snap(s)),
    tick: (ms: number) => (t += ms),
  };
}

describe('summarize', () => {
  test('counts, blocked first, max 3 rows, private hides labels', () => {
    const p = summarize(snap(['working', 'idle', 'blocked', 'working', 'working']), 'mac', false);
    expect(p).toMatchObject({ m: 'mac', w: 3, b: 1, done: false });
    expect(p.rows.length).toBe(3);
    expect(p.rows[0]).toEqual({ a: 'claude', t: 'tab 2', s: 'blocked' });
    expect(summarize(snap(['working']), 'mac', true).rows[0]!.t).toBe('');
    expect(summarize(snap(['idle', 'done']), 'mac', false).done).toBe(true);
  });
});

describe('LiveActivities', () => {
  test('starts when an agent works, updates on change, no resend of the same state', async () => {
    const h = setup();
    h.la.refresh();
    await h.la.settle();
    expect(h.calls.length).toBe(0); // nothing running: no activity
    h.set(['working']);
    h.la.refresh();
    await h.la.settle();
    expect(h.calls.map((c) => c.kind)).toEqual(['start']);
    expect(h.devices.list()[0]!.activity).toMatchObject({ channelId: 'CH1', env: 'production' });
    h.la.refresh();
    await h.la.settle();
    expect(h.calls.length).toBe(1);
    h.set(['blocked']);
    h.la.refresh(true);
    await h.la.settle();
    expect(h.calls[1]).toMatchObject({ kind: 'update', body: { channelId: 'CH1', urgent: true } });
    expect(h.calls[1]!.body.alert).toBeDefined();
    h.la.close();
  });

  test('ends a while after everything went quiet; a new run starts a new activity', async () => {
    const h = setup();
    h.set(['working']);
    h.la.refresh();
    await h.la.settle();
    h.set(['idle']);
    h.la.refresh();
    await h.la.settle();
    expect(h.calls.at(-1)!.kind).toBe('update'); // shows the done state first
    expect(JSON.parse(h.calls.at(-1)!.body.props as string).done).toBe(true);
    h.tick(61_000);
    h.la.refresh();
    await h.la.settle();
    expect(h.calls.at(-1)!.kind).toBe('end');
    expect(h.devices.list()[0]!.activity).toBeNull();
    h.set(['working']);
    h.la.refresh();
    await h.la.settle();
    expect(h.calls.at(-1)!.kind).toBe('start');
    h.la.close();
  });

  test('agent back to work during the grace period keeps the same activity', async () => {
    const h = setup();
    h.set(['working']);
    h.la.refresh();
    await h.la.settle();
    h.set(['idle']);
    h.la.refresh();
    await h.la.settle();
    h.tick(30_000);
    h.set(['working']);
    h.la.refresh();
    await h.la.settle();
    h.tick(40_000);
    h.la.refresh();
    await h.la.settle();
    expect(h.calls.map((c) => c.kind)).toEqual(['start', 'update', 'update']);
    h.la.close();
  });

  test('rejected start token is dropped; gone channel is forgotten', async () => {
    const a = setup({ start: 410 });
    a.set(['working']);
    a.la.refresh();
    await a.la.settle();
    expect(a.devices.list()[0]!.liveActivity).toBeNull();
    a.la.close();

    const b = setup({ update: 410 });
    b.set(['working']);
    b.la.refresh();
    await b.la.settle();
    b.set(['blocked']);
    b.la.refresh();
    await b.la.settle();
    expect(b.devices.list()[0]!.activity).toBeNull();
    b.la.close();
  });
});
