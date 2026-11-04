import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Hub } from '../../src/watch/hub';
import type { SessionWatcher } from '../../src/watch/sessionWatcher';

class FakeWatcher extends EventEmitter {
  started = false;
  stopped = false;
  constructor(public name: string) {
    super();
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  current() {
    return { session: this.name, online: true, workspaces: [], tabs: [], panes: [] };
  }
  client() {
    return null;
  }
}

test('starts and stops watchers as sessions change', async () => {
  let infos = [{ name: 'a', socketPath: '/a', running: true }];
  const made: FakeWatcher[] = [];
  const hub = new Hub({
    listSessions: async () => infos,
    refreshMs: 20,
    createWatcher: (s) => {
      const w = new FakeWatcher(s.name);
      made.push(w);
      return w as unknown as SessionWatcher;
    },
  });
  const transitions: unknown[] = [];
  hub.on('transition', (t) => transitions.push(t));
  hub.start();
  await Bun.sleep(60);
  expect(made.map((w) => w.name)).toEqual(['a']);
  expect(made[0]!.started).toBe(true);

  infos = [
    { name: 'a', socketPath: '/a', running: false },
    { name: 'b', socketPath: '/b', running: true },
  ];
  await Bun.sleep(80);
  expect(made.map((w) => w.name)).toEqual(['a', 'b']);
  expect(made[0]!.stopped).toBe(true);
  expect(hub.sessions().map((s) => s.session)).toEqual(['b']);

  made[1]!.emit('transition', { x: 1 });
  expect(transitions).toEqual([{ x: 1 }]);
  hub.stop();
  expect(made[1]!.stopped).toBe(true);
}, 5000);

function fakeHub(list: () => Promise<{ name: string; socketPath: string; running: boolean }[] | null>, refreshMs = 20) {
  const made: FakeWatcher[] = [];
  const hub = new Hub({
    listSessions: list,
    refreshMs,
    createWatcher: (s) => {
      const w = new FakeWatcher(s.name);
      made.push(w);
      return w as unknown as SessionWatcher;
    },
  });
  return { hub, made };
}

test('a failed listing (null) or a throwing one keeps every watcher; only a successful listing removes one', async () => {
  let result: 'ok' | 'null' | 'throw' | 'empty' = 'ok';
  const { hub, made } = fakeHub(async () => {
    if (result === 'throw') throw new Error('spawn failed');
    if (result === 'null') return null;
    if (result === 'empty') return [];
    return [{ name: 'a', socketPath: '/a', running: true }];
  });
  const offline: string[] = [];
  hub.on('snapshot', (s) => !s.online && offline.push(s.session));
  hub.start();
  await Bun.sleep(60);
  expect(made.map((w) => w.name)).toEqual(['a']);
  result = 'null';
  await Bun.sleep(80);
  result = 'throw';
  await Bun.sleep(80);
  expect(made[0]!.stopped).toBe(false);
  expect(hub.sessions().map((s) => s.session)).toEqual(['a']);
  expect(offline).toEqual([]);
  result = 'empty';
  await Bun.sleep(80);
  expect(made[0]!.stopped).toBe(true);
  expect(hub.sessions()).toEqual([]);
  expect(offline).toEqual(['a']);
  hub.stop();
}, 5000);

test('refreshes never overlap while a listing hangs', async () => {
  let calls = 0;
  let release: (() => void) | null = null;
  const { hub } = fakeHub(() => {
    calls++;
    return new Promise((r) => (release = () => r([])));
  }, 10);
  hub.start();
  await Bun.sleep(120);
  expect(calls).toBe(1);
  release!();
  await Bun.sleep(40);
  expect(calls).toBeGreaterThanOrEqual(2);
  hub.stop();
  release!();
}, 5000);
