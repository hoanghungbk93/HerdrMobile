import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HerdrClient, HerdrError, ipcPath } from '../../src/herdr/client';

const rand = () => Math.random().toString(36).slice(2, 10);
const sockPath = () =>
  process.platform === 'win32' ? `\\\\.\\pipe\\hm-test-${rand()}` : join(tmpdir(), `hm-test-${rand()}.sock`);

const servers: net.Server[] = [];
const clients: HerdrClient[] = [];

/**
 * Fake herdr: one request per connection; `reply` writes the response and
 * (like herdr) the connection is closed afterwards unless `keepOpen`.
 * The connect-time ping is answered automatically; `onRequest` only sees
 * requests made after connect() resolves.
 */
async function fake(onRequest: (sock: net.Socket, msg: any, conns: Map<net.Socket, any>) => void) {
  const path = sockPath();
  let armed = false;
  const conns = new Map<net.Socket, any>();
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (!armed) {
        sock.end(JSON.stringify({ id: msg.id, result: { type: 'pong' } }) + '\n');
        return;
      }
      conns.set(sock, msg);
      onRequest(sock, msg, conns);
    });
    sock.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));
  const client = await HerdrClient.connect(path);
  armed = true;
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) s.close();
});

describe('HerdrClient', () => {
  test('resolves result by id', async () => {
    const c = await fake((sock, m) => {
      expect(m.method).toBe('ping');
      sock.end(JSON.stringify({ id: m.id, result: { type: 'pong' } }) + '\n');
    });
    expect(await c.request('ping')).toEqual({ type: 'pong' });
  });

  test('sequential requests each succeed', async () => {
    const c = await fake((sock, m) => {
      sock.end(JSON.stringify({ id: m.id, result: { method: m.method } }) + '\n');
    });
    expect(await c.request('one')).toEqual({ method: 'one' });
    expect(await c.request('two')).toEqual({ method: 'two' });
    expect(await c.request('three')).toEqual({ method: 'three' });
  });

  test('matches out-of-order concurrent responses', async () => {
    const c = await fake((_sock, _m, conns) => {
      if (conns.size < 2) return;
      for (const [sock, x] of [...conns].reverse()) {
        sock.end(JSON.stringify({ id: x.id, result: { method: x.method } }) + '\n');
      }
    });
    const [a, b] = await Promise.all([c.request('one'), c.request('two')]);
    expect(a).toEqual({ method: 'one' });
    expect(b).toEqual({ method: 'two' });
  });

  test('rejects with herdr error code', async () => {
    const c = await fake((sock, m) => {
      sock.end(JSON.stringify({ id: m.id, error: { code: 'pane_not_found', message: 'nope' } }) + '\n');
    });
    const err: any = await c.request('pane.get', { pane_id: 'x' }).catch((e: any) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe('pane_not_found');
    expect(err.message).toBe('nope');
  });

  test('splits partial lines', async () => {
    const c = await fake(async (sock, m) => {
      const full = JSON.stringify({ id: m.id, result: { type: 'pong' } });
      const a = Math.floor(full.length / 3);
      const b = Math.floor((2 * full.length) / 3);
      sock.write(full.slice(0, a));
      await Bun.sleep(10);
      sock.write(full.slice(a, b));
      await Bun.sleep(10);
      sock.end(full.slice(b) + '\n');
    });
    expect(await c.request('ping')).toEqual({ type: 'pong' });
  });

  test('ignores lines with unknown id', async () => {
    const c = await fake((sock, m) => {
      sock.write(JSON.stringify({ id: 'stray', result: {} }) + '\n');
      sock.write(JSON.stringify({ event: 'pane.changed' }) + '\n');
      sock.end(JSON.stringify({ id: m.id, result: { ok: true } }) + '\n');
    });
    expect(await c.request('ping')).toEqual({ ok: true });
  });

  test('rejects with closed when socket closes before a response', async () => {
    const c = await fake((sock) => sock.destroy());
    const err: any = await c.request('ping').catch((e: any) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe('closed');
  });

  test('times out', async () => {
    const c = await fake(() => {});
    const err: any = await c.request('ping', {}, 50).catch((e: any) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe('timeout');
  });

  test('close() rejects in-flight requests and later requests', async () => {
    const c = await fake(() => {});
    const inflight = c.request('ping').catch((e: any) => e);
    await Bun.sleep(20);
    c.close();
    const e1: any = await inflight;
    expect(e1.code).toBe('closed');
    const e2: any = await c.request('ping').catch((e: any) => e);
    expect(e2.code).toBe('closed');
  });

  test("on('close') fires once on close()", async () => {
    const c = await fake(() => {});
    let n = 0;
    c.on('close', () => n++);
    c.close();
    c.close();
    expect(n).toBe(1);
  });

  test('connect rejects when socket missing', async () => {
    const err: any = await HerdrClient.connect(sockPath()).catch((e: any) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe('closed');
  });
});

describe('ipcPath', () => {
  test('unix: socket_path is dialed as-is', () => {
    expect(ipcPath('/tmp/herdr/herdr.sock', 'darwin')).toBe('/tmp/herdr/herdr.sock');
    expect(ipcPath('/tmp/herdr/herdr.sock', 'linux')).toBe('/tmp/herdr/herdr.sock');
  });
  test('windows: socket_path names a pipe in the \\\\.\\pipe\\ namespace', () => {
    const p = 'C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock';
    expect(ipcPath(p, 'win32')).toBe('\\\\.\\pipe\\C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock');
    expect(ipcPath(ipcPath(p, 'win32'), 'win32')).toBe(ipcPath(p, 'win32'));
  });
});
