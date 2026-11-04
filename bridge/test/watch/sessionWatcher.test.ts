import { expect, test } from 'bun:test';
import { SessionWatcher } from '../../src/watch/sessionWatcher';
import { startFakeHerdr } from './fakeHerdr';

test('emits one online:false snapshot when herdr is unreachable at start', async () => {
  const w = new SessionWatcher({ name: 's', socketPath: '/nonexistent/herdr.sock' });
  const snaps: boolean[] = [];
  w.on('snapshot', (s) => snaps.push(s.online));
  w.start();
  await Bun.sleep(1800); // spans several retries (0.5s, 1s)
  w.stop();
  expect(snaps).toEqual([false]);
});

test('a subscription ending mid-connect still triggers a reconnect', async () => {
  // Status subscription B acks slowly (1.2s), so connect() is in flight when the topology sub dies.
  const fake = startFakeHerdr((subs) => (subs[0]?.type === 'pane.agent_status_changed' ? 1200 : 0));
  const w = new SessionWatcher({ name: 's', socketPath: fake.socketPath }, { pollMs: 60000 });
  try {
    w.start();
    const t0 = Date.now();
    while (fake.topoSockets.length === 0 && Date.now() - t0 < 3000) await Bun.sleep(10);
    await Bun.sleep(100);
    const snapshotsBefore = fake.requests.filter((m) => m === 'session.snapshot').length;
    fake.topoSockets[0]!.destroy(); // onSubEnd -> retry at +0.5s collides with the in-flight connect
    await Bun.sleep(4000);
    const snapshotsAfter = fake.requests.filter((m) => m === 'session.snapshot').length;
    expect(snapshotsAfter).toBeGreaterThan(snapshotsBefore);
    expect(fake.topoSockets.length).toBeGreaterThanOrEqual(2); // a fresh topology subscription was opened
  } finally {
    w.stop();
    fake.close();
  }
}, 15000);

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(10);
  }
  return cond();
}

test('pane.updated with an unchanged session (e.g. a title change) re-reads but emits no second snapshot', async () => {
  const fake = startFakeHerdr();
  const w = new SessionWatcher({ name: 's', socketPath: fake.socketPath }, { pollMs: 60000 });
  const snaps: unknown[] = [];
  w.on('snapshot', (s) => snaps.push(s));
  try {
    w.start();
    expect(await waitFor(() => snaps.length === 1 && fake.topoSockets.length > 0, 3000)).toBe(true);
    const reads = () => fake.requests.filter((m) => m === 'session.snapshot').length;
    const before = reads();
    fake.emitTopo('pane.updated', { pane_id: 'p1' });
    expect(await waitFor(() => reads() > before, 2000)).toBe(true);
    await Bun.sleep(100);
    expect(snaps).toHaveLength(1);
    // a real change is still broadcast
    fake.state.panes[0].label = 'renamed';
    fake.emitTopo('pane.updated', { pane_id: 'p1' });
    expect(await waitFor(() => snaps.length === 2, 2000)).toBe(true);
  } finally {
    w.stop();
    fake.close();
  }
}, 10000);

test('a new pane first seen via snapshot then blocked emits the transition (no poll in between)', async () => {
  const fake = startFakeHerdr();
  fake.state.agents = [{ pane_id: 'p1', agent: 'claude', agent_status: 'idle', state_change_seq: 1, workspace_id: 'w1' }];
  const w = new SessionWatcher({ name: 's', socketPath: fake.socketPath }, { pollMs: 60000 });
  const transitions: any[] = [];
  w.on('transition', (t) => transitions.push(t));
  try {
    w.start();
    expect(await waitFor(() => w.current().online && fake.statusSockets.length === 1, 3000)).toBe(true);
    // p2 appears already working: first sight via the snapshot must stay silent
    fake.state.panes.push({ pane_id: 'p2', workspace_id: 'w1', tab_id: 't1', agent_status: 'working', revision: 0 });
    fake.state.agents.push({ pane_id: 'p2', agent: 'claude', agent_status: 'working', state_change_seq: 1, workspace_id: 'w1' });
    fake.emitTopo('pane.created', { pane_id: 'p2' });
    expect(await waitFor(() => w.current().panes.length === 2 && fake.statusSockets.length === 2, 3000)).toBe(true);
    expect(transitions).toEqual([]);
    // then it blocks before any poll ran
    fake.state.agents[1] = { ...fake.state.agents[1], agent_status: 'blocked', state_change_seq: 2 };
    fake.emitStatus('pane.agent_status_changed', { pane_id: 'p2', agent_status: 'blocked' });
    expect(await waitFor(() => transitions.length === 1, 2000)).toBe(true);
    expect(transitions[0]).toMatchObject({ session: 's', paneId: 'p2', from: 'working', to: 'blocked', seq: 2 });
  } finally {
    w.stop();
    fake.close();
  }
}, 10000);

test('snapshots differing only in pane revision (title change) emit no second snapshot', async () => {
  const fake = startFakeHerdr();
  const w = new SessionWatcher({ name: 's', socketPath: fake.socketPath }, { pollMs: 60000 });
  const snaps: unknown[] = [];
  w.on('snapshot', (s) => snaps.push(s));
  try {
    w.start();
    expect(await waitFor(() => snaps.length === 1 && fake.topoSockets.length > 0, 3000)).toBe(true);
    const reads = () => fake.requests.filter((m) => m === 'session.snapshot').length;
    const before = reads();
    fake.state.panes[0].revision = 7;
    fake.emitTopo('pane.updated', { pane_id: 'p1' });
    expect(await waitFor(() => reads() > before, 2000)).toBe(true);
    await Bun.sleep(100);
    expect(snaps).toHaveLength(1);
  } finally {
    w.stop();
    fake.close();
  }
}, 10000);

test('a stale snapshot does not roll a known pane back (no backwards transition)', async () => {
  const fake = startFakeHerdr();
  fake.state.agents = [{ pane_id: 'p1', agent: 'claude', agent_status: 'working', state_change_seq: 1, workspace_id: 'w1' }];
  const w = new SessionWatcher({ name: 's', socketPath: fake.socketPath }, { pollMs: 60000 });
  const transitions: any[] = [];
  w.on('transition', (t) => transitions.push(t));
  try {
    w.start();
    expect(await waitFor(() => w.current().online && fake.statusSockets.length === 1, 3000)).toBe(true);
    fake.state.agents[0] = { ...fake.state.agents[0], agent_status: 'blocked', state_change_seq: 2 };
    fake.emitStatus('pane.agent_status_changed', { pane_id: 'p1', agent_status: 'blocked' });
    expect(await waitFor(() => transitions.length === 1, 2000)).toBe(true);
    // a snapshot issued before the change resolves late: carries seq 1 / working
    fake.state.agents[0] = { ...fake.state.agents[0], agent_status: 'working', state_change_seq: 1 };
    const reads = () => fake.requests.filter((m) => m === 'session.snapshot').length;
    const before = reads();
    fake.emitTopo('pane.updated', { pane_id: 'p1' });
    expect(await waitFor(() => reads() > before, 2000)).toBe(true);
    await Bun.sleep(150);
    expect(transitions).toHaveLength(1);
    expect(w.current().panes[0]!.status).toBe('blocked');
  } finally {
    w.stop();
    fake.close();
  }
}, 10000);
