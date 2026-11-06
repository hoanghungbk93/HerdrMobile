import { expect, test } from 'bun:test';
import { codeLine, daemon, pairUrl, parseArgs, serveOn, splitCode } from '../src/cli';

test('code line is split 3+3', () => {
  expect(splitCode('482913')).toBe('482 913');
  expect(codeLine('482913')).toBe('Pairing code: 482 913 · expires in 5 minutes');
});

test('pair URL encodes machine name and secret', () => {
  expect(pairUrl('100.88.1.2', 7420, 'a-b_c', "Hung's Mac mini")).toBe(
    "herdrmobile://pair?h=100.88.1.2&p=7420&s=a-b_c&m=Hung's%20Mac%20mini",
  );
  expect(pairUrl('100.88.1.2', 7420, 'a/b+c=', 'x&y')).toContain('s=a%2Fb%2Bc%3D&m=x%26y');
});

test('parseArgs reads command, rest and --port', () => {
  expect(parseArgs(['start'])).toEqual({ cmd: 'start', rest: [], port: 7420 });
  expect(parseArgs(['revoke', 'abc', '--port', '8000'])).toEqual({ cmd: 'revoke', rest: ['abc'], port: 8000 });
  expect(parseArgs(['status', '--port=9000']).port).toBe(9000);
  expect(() => parseArgs(['start', '--port', 'x'])).toThrow();
});

test('daemon(): only ECONNREFUSED means no daemon; timeouts and other errors are unresponsive', async () => {
  const failWith = (code: string) => (async () => { throw Object.assign(new TypeError('x'), { code }); }) as unknown as typeof fetch;
  expect(await daemon(1, 'GET', '/x', failWith('ECONNREFUSED'), 'k')).toBe('no-daemon');
  expect(await daemon(1, 'GET', '/x', failWith('ECONNRESET'), 'k')).toBe('unresponsive');
  expect(await daemon(1, 'GET', '/x', (async () => { throw new DOMException('t', 'TimeoutError'); }) as unknown as typeof fetch, 'k')).toBe('unresponsive');
  expect(await daemon(1, 'GET', '/x', (async () => new Response('ok')) as unknown as typeof fetch, 'k')).toBeInstanceOf(Response);
});

test('daemon() against a closed port reports no-daemon', async () => {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = s.port!;
  await s.stop(true);
  expect(await daemon(port, 'GET', '/local/devices', fetch, 'k')).toBe('no-daemon');
});

test('daemon() sends the local admin key; no key file means no daemon (fetch not called)', async () => {
  const seen: (string | null)[] = [];
  const spy = (async (_u: string, init: RequestInit) => {
    seen.push(new Headers(init.headers).get('x-herdr-local-key'));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  expect(await daemon(1, 'POST', '/local/pair', spy, 'the-key')).toBeInstanceOf(Response);
  expect(seen).toEqual(['the-key']);
  expect(await daemon(1, 'POST', '/local/pair', spy, null)).toBe('no-daemon');
  expect(seen).toHaveLength(1);
});

test('serveOn: a second listener on the same port fails (no SO_REUSEPORT sharing)', async () => {
  const app = { fetch: () => new Response('ok'), websocket: { message() {} } } as unknown as Parameters<typeof serveOn>[2];
  const a = serveOn('127.0.0.1', 0, app);
  try {
    expect(() => serveOn('127.0.0.1', a.port!, app)).toThrow();
    expect(await (await fetch(`http://127.0.0.1:${a.port}/`)).text()).toBe('ok');
  } finally {
    await a.stop(true);
  }
});
