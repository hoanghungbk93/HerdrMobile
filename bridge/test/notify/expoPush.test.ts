import { describe, expect, test } from 'bun:test';
import { sendExpoPush, type PushMessage } from '../../src/notify/expoPush';

const msg: PushMessage = {
  title: 'claude · hana', body: 'Đang chờ duyệt',
  data: { session: 's', paneId: 'p', kind: 'blocked', hash: 'h' }, categoryId: 'approval',
};

describe('sendExpoPush', () => {
  test('posts batches of 100 and reports invalid tokens', async () => {
    const calls: { url: string; body: any[] }[] = [];
    const fake = (async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      return new Response(JSON.stringify({
        data: body.map((b: any) => b.to === 'T5'
          ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok', id: 'x' }),
      }));
    }) as unknown as typeof fetch;
    const tokens = Array.from({ length: 150 }, (_, i) => `T${i}`);
    const r = await sendExpoPush(tokens, msg, fake);
    expect(calls.length).toBe(2);
    expect(calls[0]!.url).toBe('https://exp.host/--/api/v2/push/send');
    expect(calls[0]!.body.length).toBe(100);
    expect(calls[1]!.body.length).toBe(50);
    expect(calls[0]!.body[0]).toEqual({
      to: 'T0', title: msg.title, body: msg.body, data: msg.data,
      sound: 'default', categoryId: 'approval', priority: 'high',
    });
    expect(r.invalidTokens).toEqual(['T5']);
  });
  test('omits categoryId when absent', async () => {
    let sent: any[] = [];
    const fake = (async (_u: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ status: 'ok' }] }));
    }) as unknown as typeof fetch;
    const { categoryId: _c, ...plain } = msg;
    await sendExpoPush(['A'], plain, fake);
    expect('categoryId' in sent[0]).toBe(false);
  });

  test('failed batch does not abort later batches; maps cross-batch tokens', async () => {
    let n = 0;
    const fake = (async (_u: string, init: any) => {
      n++;
      const body = JSON.parse(init.body);
      if (n === 1) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({
        data: body.map((b: any, i: number) => i === 4
          ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok' }),
      }));
    }) as unknown as typeof fetch;
    const tokens = Array.from({ length: 150 }, (_, i) => `T${i}`);
    const r = await sendExpoPush(tokens, msg, fake);
    expect(n).toBe(2);
    expect(r.failedBatches).toBe(1);
    expect(r.invalidTokens).toEqual(['T104']);
  });
  test('fetch rejection and bad body count as failed, keep earlier invalids', async () => {
    let n = 0;
    const fake = (async (_u: string, init: any) => {
      n++;
      const body = JSON.parse(init.body);
      if (n === 1) return new Response(JSON.stringify({ data: body.map(() => ({ details: { error: 'DeviceNotRegistered' } })) }));
      if (n === 2) throw new Error('network');
      return new Response(JSON.stringify({ errors: [{ code: 'X' }] }));
    }) as unknown as typeof fetch;
    const tokens = Array.from({ length: 250 }, (_, i) => `T${i}`);
    const r = await sendExpoPush(tokens, msg, fake);
    expect(n).toBe(3);
    expect(r.failedBatches).toBe(2);
    expect(r.invalidTokens.length).toBe(100);
  });
});
