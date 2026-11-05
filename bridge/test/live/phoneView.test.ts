import { expect, test } from 'bun:test';
import type { HerdrClient } from '../../src/herdr/client';
import { PhoneView, type PtySize } from '../../src/live/phoneView';

function setup(opts: { size?: PtySize | null; max?: number } = {}) {
  // Fake herdr pane scroll state: controller wheel scrolls and pane.scroll both move it; `scrolls` logs each result.
  const scrolls: number[] = [];
  const max = opts.max ?? 500;
  let off = 0;
  const info = () => ({ pane: { scroll: { offset_from_bottom: off, max_offset_from_bottom: max } } });
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'pane.scroll') {
        off = Math.min(Number(params.offset_from_bottom), max);
        scrolls.push(off);
        return info();
      }
      if (method === 'pane.get') {
        scrolls.push(off);
        return info();
      }
      throw new Error(method);
    },
  } as unknown as HerdrClient;
  const controllers: { size: PtySize; sent: object[]; closed: boolean; exit: () => void }[] = [];
  const states: { offset: number; phone: boolean }[] = [];
  let t = 0;
  const pv = new PhoneView({
    getClient: () => client,
    readSize: async () => (opts.size === undefined ? { cols: 119, rows: 40 } : opts.size),
    openController: (_s, _p, size, onExit) => {
      const c = { size, sent: [] as object[], closed: false, exit: onExit };
      controllers.push(c);
      return {
        send: (cmd) => {
          c.sent.push(cmd);
          const k = cmd as { type: string; direction?: string; lines?: number };
          if (k.type === 'terminal.scroll') off = Math.max(0, Math.min(max, off + (k.direction === 'up' ? 1 : -1) * (k.lines ?? 0)));
        },
        close: () => (c.closed = true),
      };
    },
    poke: () => {},
    onState: (s) => states.push({ offset: s.offset, phone: s.phone }),
    idleMs: 1000,
    abandonMs: 5000,
    now: () => t,
    log: () => {},
  });
  const scrollCmds = (i = 0) => controllers[i]!.sent.filter((c) => (c as { type: string }).type === 'terminal.scroll');
  const otherCmds = (i = 0) => controllers[i]!.sent.filter((c) => (c as { type: string }).type !== 'terminal.scroll');
  return { pv, scrolls, controllers, states, scrollCmds, otherCmds, setTime: (n: number) => (t = n) };
}

test('first scroll up resizes the pane to the phone and wheel-scrolls through the controller', async () => {
  const { pv, scrolls, controllers, states, scrollCmds } = setup();
  await pv.scroll('s', 'p', 10, 45, 30);
  await pv.scroll('s', 'p', 5, 45, 30);
  await pv.scroll('s', 'p', -20, 45, 30);
  expect(controllers.length).toBe(1);
  expect(controllers[0]!.size).toEqual({ cols: 45, rows: 30 });
  expect(scrollCmds()).toEqual([
    { type: 'terminal.scroll', direction: 'up', lines: 10 },
    { type: 'terminal.scroll', direction: 'up', lines: 5 },
    { type: 'terminal.scroll', direction: 'down', lines: 20 },
  ]);
  expect(scrolls).toEqual([0, 10, 15, 0]); // first pane.get learns the pane has scrollback
  expect(states.at(-1)).toEqual({ offset: 0, phone: true });
  await pv.stop();
});

test('leaving restores the original size before releasing, and scrolls back to the bottom', async () => {
  const { pv, scrolls, controllers, states, otherCmds } = setup();
  await pv.scroll('s', 'p', 10, 45, 30);
  await pv.leave('s', 'p');
  expect(scrolls).toEqual([0, 10, 0]);
  expect(otherCmds()).toEqual([{ type: 'terminal.resize', cols: 119, rows: 40 }, { type: 'terminal.release' }]);
  expect(controllers[0]!.closed).toBe(true);
  expect(states.at(-1)).toEqual({ offset: 0, phone: false });
  expect(pv.isHeld('s', 'p')).toBe(false);
});

test('a scroll down at the bottom, or toBottom, never takes the pane', async () => {
  const { pv, controllers, scrolls } = setup();
  await pv.scroll('s', 'p', -5, 45, 30);
  await pv.scroll('s', 'p', 3, 45, 30, true);
  expect(controllers.length).toBe(0);
  expect(scrolls).toEqual([]);
});

test('unknown pty size (native Windows): scrolls without resizing', async () => {
  const { pv, controllers, scrolls, states } = setup({ size: null });
  await pv.scroll('s', 'p', 10, 45, 30);
  expect(controllers.length).toBe(0);
  expect(scrolls).toEqual([10]);
  expect(states.at(-1)).toEqual({ offset: 10, phone: false });
  await pv.stop();
});

test('rotating the phone resizes the held pane', async () => {
  const { pv, otherCmds } = setup();
  await pv.scroll('s', 'p', 10, 45, 30);
  await pv.scroll('s', 'p', 1, 90, 20);
  expect(otherCmds()).toEqual([{ type: 'terminal.resize', cols: 90, rows: 20 }]);
  await pv.stop();
});

test('idle at the bottom gives the pane back; scrolled up is given back only after abandonMs', async () => {
  const a = setup();
  await a.pv.scroll('s', 'p', 10, 45, 30);
  await a.pv.scroll('s', 'p', -10, 45, 30);
  a.setTime(1500);
  await Bun.sleep(1100); // sweep runs every second
  expect(a.pv.isHeld('s', 'p')).toBe(false);

  const b = setup();
  await b.pv.scroll('s', 'p', 10, 45, 30);
  b.setTime(2000);
  await Bun.sleep(1100);
  expect(b.pv.isHeld('s', 'p')).toBe(true);
  b.setTime(6000);
  await Bun.sleep(1100);
  expect(b.pv.isHeld('s', 'p')).toBe(false);
  expect(b.scrolls.at(-1)).toBe(0);
}, 10000);

test('fit holds the pane at phone size without idle release; off gives it back', async () => {
  const { pv, controllers, states, setTime } = setup();
  await pv.fit('s', 'p', true, 45, 30);
  expect(controllers.length).toBe(1);
  expect(states.at(-1)).toEqual({ offset: 0, phone: true });
  setTime(10_000); // way past idle and abandon
  await Bun.sleep(1100);
  expect(pv.isHeld('s', 'p')).toBe(true);
  await pv.scroll('s', 'p', 5, 45, 30); // scrolling while fitted reuses the controller
  await pv.scroll('s', 'p', 0, 45, 30, true);
  expect(controllers.length).toBe(1);
  await pv.fit('s', 'p', false, 45, 30);
  expect(pv.isHeld('s', 'p')).toBe(false);
  expect(controllers[0]!.sent.at(-2)).toEqual({ type: 'terminal.resize', cols: 119, rows: 40 });
}, 10000);

test('fit off while scrolled up keeps the scroll hold until the phone comes back down', async () => {
  const { pv } = setup();
  await pv.fit('s', 'p', true, 45, 30);
  await pv.scroll('s', 'p', 10, 45, 30);
  await pv.fit('s', 'p', false, 45, 30);
  expect(pv.isHeld('s', 'p')).toBe(true);
  await pv.stop();
});

test('an app that owns scrolling (no herdr scrollback) gets one wheel notch per ~3 lines', async () => {
  const { pv, scrollCmds } = setup({ max: 0 });
  await pv.scroll('s', 'p', 10, 45, 30);
  expect(scrollCmds()).toEqual(Array(4).fill({ type: 'terminal.scroll', direction: 'up', lines: 1 }));
  await pv.stop();
});

test('click reuses the held controller', async () => {
  const { pv, controllers } = setup();
  await pv.fit('s', 'p', true, 45, 30);
  await pv.click('s', 'p', 3, 7);
  expect(controllers.length).toBe(1);
  expect(controllers[0]!.sent.slice(-2)).toEqual([
    { type: 'terminal.mouse', action: 'down', button: 'left', column: 3, row: 7 },
    { type: 'terminal.mouse', action: 'up', button: 'left', column: 3, row: 7 },
  ]);
  await pv.stop();
});

test('click on a pane not held: a short controller at the pane size, released at once', async () => {
  const { pv, controllers } = setup();
  await pv.click('s', 'p', 1, 2);
  expect(controllers.length).toBe(1);
  expect(controllers[0]!.size).toEqual({ cols: 119, rows: 40 });
  expect(controllers[0]!.sent.slice(-2)).toEqual([{ type: 'terminal.resize', cols: 119, rows: 40 }, { type: 'terminal.release' }]);
  expect(controllers[0]!.closed).toBe(true);
  expect(pv.isHeld('s', 'p')).toBe(false);
});

test('click with unknown pane size does nothing', async () => {
  const { pv, controllers } = setup({ size: null });
  await pv.click('s', 'p', 1, 2);
  expect(controllers.length).toBe(0);
});
