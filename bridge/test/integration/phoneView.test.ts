import { afterAll, beforeAll, expect, test } from 'bun:test';
import { HerdrClient } from '../../src/herdr/client';
import { openControllerCli, PhoneView, readSizeVia } from '../../src/live/phoneView';
import { describeHerdr, randomSessionName, startHerdrSession } from './harness';

// Real herdr: the phone scroll resizes the pty, leaving puts the exact original size back.
describeHerdr.skipIf(process.platform === 'win32')('phone-size scrolling', () => {
  let session: Awaited<ReturnType<typeof startHerdrSession>>;
  let name: string;
  beforeAll(async () => {
    name = randomSessionName();
    session = await startHerdrSession(name);
  }, 20000);
  afterAll(async () => {
    await session?.stop();
  }, 20000);

  const getClient = () => ({
    request: async <T,>(method: string, params: Record<string, unknown>) => {
      const c = await HerdrClient.connect(session.socketPath);
      try {
        return await c.request<T>(method, params, 5000);
      } finally {
        c.close();
      }
    },
  }) as unknown as HerdrClient;

  const size = readSizeVia(getClient);
  const waitSize = async (want: { cols: number; rows: number }) => {
    const end = Date.now() + 5000;
    let got = await size(name, 'w1:p1');
    while ((got?.cols !== want.cols || got?.rows !== want.rows) && Date.now() < end) {
      await Bun.sleep(100);
      got = await size(name, 'w1:p1');
    }
    return got;
  };

  test('resize to the phone while scrolled, original size back after leave', async () => {
    const orig = await size(name, 'w1:p1');
    expect(orig).not.toBeNull();
    await getClient().request('pane.send_text', { pane_id: 'w1:p1', text: 'for i in $(seq 1 200); do echo line$i; done\r' });
    await Bun.sleep(500);
    const pv = new PhoneView({ getClient, readSize: size, openController: openControllerCli, poke: () => {}, onState: () => {}, log: () => {} });
    await pv.scroll(name, 'w1:p1', 20, 41, 22);
    expect(await waitSize({ cols: 41, rows: 22 })).toEqual({ cols: 41, rows: 22 });
    await pv.leave();
    expect(await waitSize(orig!)).toEqual(orig!);
  }, 20000);
});
