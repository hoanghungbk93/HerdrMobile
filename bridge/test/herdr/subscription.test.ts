import { expect, test } from 'bun:test';
import { subscribe } from '../../src/herdr/subscription';
import { startFakeHerdr } from '../watch/fakeHerdr';

test('rejects when herdr accepts the connection but never acks', async () => {
  const fake = startFakeHerdr(() => null);
  try {
    const t0 = Date.now();
    await expect(subscribe(fake.socketPath, [{ type: 'pane.created' }], () => {}, () => {}, 150)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);
  } finally {
    fake.close();
  }
});

test('ack within the timeout resolves and does not later fire onEnd', async () => {
  const fake = startFakeHerdr(() => 10);
  const ends: string[] = [];
  try {
    const sub = await subscribe(fake.socketPath, [{ type: 'pane.created' }], () => {}, (r) => ends.push(r), 100);
    await Bun.sleep(250);
    expect(ends).toEqual([]);
    sub.close();
  } finally {
    fake.close();
  }
});
