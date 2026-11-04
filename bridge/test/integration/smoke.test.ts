import { afterAll, beforeAll, expect, test } from 'bun:test';
import { HerdrClient } from '../../src/herdr/client';
import { TESTED_PROTOCOL } from '../../src/config';
import { describeHerdr, randomSessionName, startHerdrSession } from './harness';

describeHerdr('herdr smoke', () => {
  let session: Awaited<ReturnType<typeof startHerdrSession>>;
  beforeAll(async () => {
    session = await startHerdrSession(randomSessionName());
  }, 20000);
  afterAll(async () => {
    await session?.stop();
  }, 20000);

  // herdr closes the socket after each non-subscription response.
  async function once<T>(method: string): Promise<T> {
    const c = await HerdrClient.connect(session.socketPath);
    try {
      return await c.request<T>(method);
    } finally {
      c.close();
    }
  }

  test('ping returns pong', async () => {
    const r = await once<{ type: string; protocol: number }>('ping');
    expect(r.type).toBe('pong');
    expect(r.protocol).toBe(TESTED_PROTOCOL);
  });

  test('session.snapshot reports protocol', async () => {
    const r = await once<{ snapshot: { protocol: number } }>('session.snapshot');
    expect(typeof r.snapshot.protocol).toBe('number');
  });
});
