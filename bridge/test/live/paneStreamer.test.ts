import { expect, test } from 'bun:test';
import type { ServerMsg } from '@herdr-mobile/protocol';
import type { HerdrClient } from '../../src/herdr/client';
import { PaneStreamer } from '../../src/live/paneStreamer';

type Frame = Extract<ServerMsg, { t: 'frame' }>;

/** pane.read returns a fixed screen; `bump()` advances the revision on demand. */
function fakeClient() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let revision = 1;
  let text: string | null = null;
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      return {
        type: 'pane_read',
        read: { pane_id: params.pane_id, source: params.source, format: 'ansi', text: text ?? `screen r${revision}`, revision, truncated: false },
      };
    },
  };
  return { client: client as unknown as HerdrClient, calls, bump: () => revision++, setText: (t: string) => (text = t) };
}

const HZ = 50; // 20 ms ticks keep the tests fast

test('emits only on revision change', async () => {
  const f = fakeClient();
  const s = new PaneStreamer(() => f.client, HZ);
  const frames: Frame[] = [];
  s.watch('c1', 's1', 'p1', (fr) => frames.push(fr));
  await Bun.sleep(120);
  expect(f.calls.length).toBeGreaterThan(2);
  expect(frames).toEqual([{ t: 'frame', session: 's1', paneId: 'p1', revision: 1, text: 'screen r1' }]);
  expect(f.calls[0]!).toEqual({
    method: 'pane.read',
    params: { pane_id: 'p1', source: 'visible', format: 'ansi', strip_ansi: false },
  });
  f.bump();
  await Bun.sleep(100);
  expect(frames.map((x) => x.revision)).toEqual([1, 2]);
  s.stop();
});

test('stops polling when last watcher leaves', async () => {
  const f = fakeClient();
  const s = new PaneStreamer(() => f.client, HZ);
  s.watch('c1', 's1', 'p1', () => {});
  s.watch('c2', 's1', 'p1', () => {});
  await Bun.sleep(80);
  s.unwatch('c1', 's1', 'p1');
  await Bun.sleep(60);
  const mid = f.calls.length;
  expect(mid).toBeGreaterThan(0);
  s.unwatch('c2'); // all panes for this client
  await Bun.sleep(30); // let an in-flight tick settle
  const after = f.calls.length;
  await Bun.sleep(120);
  expect(f.calls.length).toBe(after);
  expect(after - mid).toBeLessThanOrEqual(2);
});

test('two clients one poll', async () => {
  const f = fakeClient();
  const s = new PaneStreamer(() => f.client, 10); // 100 ms ticks
  const a: Frame[] = [];
  const b: Frame[] = [];
  s.watch('c1', 's1', 'p1', (fr) => a.push(fr));
  s.watch('c2', 's1', 'p1', (fr) => b.push(fr));
  await Bun.sleep(450);
  // ~4 ticks; two watchers on one pane must not double the reads
  expect(f.calls.length).toBeGreaterThanOrEqual(3);
  expect(f.calls.length).toBeLessThanOrEqual(5);
  expect(a.length).toBe(1);
  expect(b.length).toBe(1);
  s.stop();
});

test('late joiner gets the current frame immediately', async () => {
  const f = fakeClient();
  const s = new PaneStreamer(() => f.client, HZ);
  s.watch('c1', 's1', 'p1', () => {});
  await Bun.sleep(60);
  const b: Frame[] = [];
  s.watch('c2', 's1', 'p1', (fr) => b.push(fr));
  expect(b.map((x) => x.revision)).toEqual([1]);
  s.stop();
});

test('skips panes whose session is offline', async () => {
  const s = new PaneStreamer(() => null, HZ);
  const frames: Frame[] = [];
  s.watch('c1', 's1', 'p1', (fr) => frames.push(fr));
  await Bun.sleep(60);
  expect(frames).toEqual([]);
  s.stop();
});

// herdr 0.9.3 keeps `revision` at 0 for shell panes while the screen changes,
// so a changed text with the same revision must still produce a frame.
test('emits when text changes but revision does not', async () => {
  const f = fakeClient();
  const s = new PaneStreamer(() => f.client, HZ);
  const frames: Frame[] = [];
  s.watch('c1', 's1', 'p1', (fr) => frames.push(fr));
  await Bun.sleep(60);
  f.setText('new output');
  await Bun.sleep(60);
  expect(frames.map((x) => [x.revision, x.text])).toEqual([[1, 'screen r1'], [1, 'new output']]);
  s.stop();
});
