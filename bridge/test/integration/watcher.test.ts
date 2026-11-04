import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { HERDR_BIN } from '../../src/config';
import { SessionWatcher } from '../../src/watch/sessionWatcher';
import type { Transition } from '../../src/watch/statusTracker';
import type { SessionSnapshot } from '@herdr-mobile/protocol';
import { describeHerdr, randomSessionName, startHerdrSession } from './harness';

async function herdr(name: string, args: string[]): Promise<string> {
  const p = Bun.spawn([HERDR_BIN, '--session', name, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

describeHerdr('SessionWatcher', () => {
  const name = randomSessionName();
  let session: Awaited<ReturnType<typeof startHerdrSession>>;
  let watcher: SessionWatcher | undefined;
  let extraStops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    session = await startHerdrSession(name);
  }, 20000);
  afterEach(async () => {
    watcher?.stop();
    watcher = undefined;
  });
  afterAll(async () => {
    await session?.stop();
    for (const s of extraStops) await s();
  }, 20000);

  const report = (pane: string, state: string) =>
    herdr(name, ['pane', 'report-agent', '--source', 'hm-test', '--agent', 'claude', '--state', state, pane]);

  function track(w: SessionWatcher) {
    const transitions: Transition[] = [];
    const snapshots: SessionSnapshot[] = [];
    w.on('transition', (t) => transitions.push(t));
    w.on('snapshot', (s) => snapshots.push(s));
    return { transitions, snapshots };
  }

  test('emits blocked transition', async () => {
    // pollMs 300: the status subscription goes live a bit after the first online snapshot;
    // the poll guarantees the transition is seen even if 'working' is reported before it.
    watcher = new SessionWatcher({ name, socketPath: session.socketPath }, { pollMs: 300 });
    const { transitions, snapshots } = track(watcher);
    watcher.start();
    expect(await waitFor(() => snapshots.some((s) => s.online && s.panes.length > 0), 5000)).toBe(true);
    await report('w1:p1', 'working');
    await Bun.sleep(700);
    await report('w1:p1', 'blocked');
    expect(await waitFor(() => transitions.some((t) => t.to === 'blocked'), 2000)).toBe(true);
    const t = transitions.find((t) => t.to === 'blocked')!;
    expect(t).toMatchObject({ session: name, paneId: 'w1:p1', agent: 'claude' });
    expect(watcher.client()).not.toBeNull();
  }, 15000);

  test('subscribe rejection falls back to poll', async () => {
    // Split so a second pane exists, then close it while the other pane goes blocked.
    await herdr(name, ['pane', 'split', 'w1:p1', '--direction', 'right']);
    watcher = new SessionWatcher({ name, socketPath: session.socketPath }, { pollMs: 300 });
    const { transitions, snapshots } = track(watcher);
    watcher.start();
    expect(await waitFor(() => snapshots.some((s) => s.panes.length >= 2), 5000)).toBe(true);
    await report('w1:p1', 'working');
    await Bun.sleep(500);
    const mark = transitions.length;
    const other = watcher.current().panes.find((p) => p.paneId !== 'w1:p1')!.paneId;
    await herdr(name, ['pane', 'close', other]);
    await report('w1:p1', 'blocked');
    expect(await waitFor(() => transitions.slice(mark).some((t) => t.to === 'blocked'), 1500)).toBe(true);
  }, 15000);

  test('reconnects after server restart', async () => {
    const n2 = randomSessionName();
    const s2 = await startHerdrSession(n2);
    extraStops.push(s2.stop);
    await herdr(n2, ['pane', 'report-agent', '--source', 'hm-test', '--agent', 'claude', '--state', 'working', 'w1:p1']);
    watcher = new SessionWatcher({ name: n2, socketPath: s2.socketPath }, { pollMs: 300 });
    const { transitions, snapshots } = track(watcher);
    watcher.start();
    expect(await waitFor(() => snapshots.some((s) => s.online), 5000)).toBe(true);
    await herdr(n2, ['server', 'stop']);
    expect(await waitFor(() => snapshots.some((s) => !s.online), 8000)).toBe(true);
    expect(snapshots.filter((s) => !s.online)).toHaveLength(1);
    const before = snapshots.length;
    // Restart the same session's server.
    const proc = Bun.spawn([HERDR_BIN, '--session', n2, 'server'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    extraStops.push(async () => {
      proc.kill();
    });
    expect(await waitFor(() => snapshots.slice(before).some((s) => s.online), 15000)).toBe(true);
    await Bun.sleep(800);
    expect(transitions).toHaveLength(0);
  }, 40000);
});
