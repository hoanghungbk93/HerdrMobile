import { afterAll, beforeAll, expect, test } from 'bun:test';
import { HerdrClient } from '../../src/herdr/client';
import { observeWithCli } from '../../src/live/observer';
import { describeHerdr, randomSessionName, startHerdrSession } from './harness';

describeHerdr('herdr terminal observer', () => {
  let session: Awaited<ReturnType<typeof startHerdrSession>>;
  let name: string;
  beforeAll(async () => {
    name = randomSessionName();
    session = await startHerdrSession(name);
  }, 20000);
  afterAll(async () => {
    await session?.stop();
  }, 20000);

  const sendText = async (text: string) => {
    const c = await HerdrClient.connect(session.socketPath);
    try {
      await c.request('pane.send_text', { pane_id: 'w1:p1', text });
    } finally {
      c.close();
    }
  };

  test('reports a change soon after the pane output changes, and stops cleanly', async () => {
    let changes = 0;
    let exited = false;
    const obs = observeWithCli(name, 'w1:p1', () => changes++, () => (exited = true));
    expect(obs).not.toBeNull();
    const deadline = Date.now() + 5000;
    while (changes === 0 && Date.now() < deadline) await Bun.sleep(20); // initial full frame
    expect(changes).toBeGreaterThan(0);
    const before = changes;
    await sendText('echo observed\r');
    const d2 = Date.now() + 3000;
    while (changes === before && Date.now() < d2) await Bun.sleep(10);
    expect(changes).toBeGreaterThan(before);
    obs!.kill();
    await Bun.sleep(100);
    expect(exited).toBe(false); // a deliberate kill is not reported as an exit
  }, 15000);

  test('an unknown pane ends the observer', async () => {
    let exited = false;
    observeWithCli(name, 'w9:p9', () => {}, () => (exited = true));
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await Bun.sleep(20);
    expect(exited).toBe(true);
  }, 10000);
});
