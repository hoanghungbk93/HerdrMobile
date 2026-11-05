import { afterAll, beforeAll, expect, test } from 'bun:test';
import { HerdrClient } from '../../src/herdr/client';
import { openControllerCli, PhoneView, readSizeVia } from '../../src/live/phoneView';
import { describeHerdr, randomSessionName, startHerdrSession } from './harness';

const hasVim = Bun.spawnSync(['sh', '-c', 'command -v vim']).exitCode === 0;

// Real herdr + vim with the mouse on: a phone tap moves vim's cursor and leaves the pane size alone.
describeHerdr.skipIf(process.platform === 'win32' || !hasVim)('phone tap -> herdr mouse click', () => {
  let session: Awaited<ReturnType<typeof startHerdrSession>>;
  let name: string;
  beforeAll(async () => {
    name = randomSessionName();
    session = await startHerdrSession(name);
  }, 20000);
  afterAll(async () => {
    await session?.stop();
  }, 20000);

  const getClient = () =>
    ({
      request: async <T,>(method: string, params: Record<string, unknown>) => {
        const c = await HerdrClient.connect(session.socketPath);
        try {
          return await c.request<T>(method, params, 5000);
        } finally {
          c.close();
        }
      },
    }) as unknown as HerdrClient;
  const screen = async () =>
    (await getClient().request<{ read: { text: string } }>('pane.read', { pane_id: 'w1:p1', source: 'visible', format: 'text' })).read.text;

  test('click lands in vim at the tapped row', async () => {
    const size = readSizeVia(getClient);
    const orig = await size(name, 'w1:p1');
    await getClient().request('pane.send_text', {
      pane_id: 'w1:p1',
      text: "clear; seq 1 50 | vim -u NONE -c 'set mouse=a ruler' -\r",
    });
    const end = Date.now() + 5000;
    while (!/\b1,1\b/.test(await screen()) && Date.now() < end) await Bun.sleep(100);
    const pv = new PhoneView({ getClient, readSize: size, openController: openControllerCli, poke: () => {}, onState: () => {}, log: () => {} });
    await pv.click(name, 'w1:p1', 0, 4); // fifth screen row = line 5
    const end2 = Date.now() + 5000;
    while (!/\b5,1\b/.test(await screen()) && Date.now() < end2) await Bun.sleep(100);
    expect(await screen()).toMatch(/\b5,1\b/);
    await Bun.sleep(700);
    expect(await size(name, 'w1:p1')).toEqual(orig);
    await getClient().request('pane.send_text', { pane_id: 'w1:p1', text: '\x1b:q!\r' });
  }, 30000);
});
