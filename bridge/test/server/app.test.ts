import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerMsg, SessionSnapshot } from '@herdr-mobile/protocol';
import { parseApproval } from '../../src/approval/parse';
import { Pairing } from '../../src/auth/pairing';
import { DeviceStore } from '../../src/auth/store';
import { HerdrError, type HerdrClient } from '../../src/herdr/client';
import type { PushMessage } from '../../src/notify/expoPush';
import { NotifyPolicy } from '../../src/notify/policy';
import { createApp, type AppDeps } from '../../src/server/app';
import { UploadStore } from '../../src/uploads/store';
import type { Hub } from '../../src/watch/hub';
import type { Transition } from '../../src/watch/statusTracker';

const PANE = 'w1:p1';
const PROMPT = 'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No (esc)';

class FakeHerdr {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  screen = PROMPT;
  paneGone = false;
  /** Called after agent.send_keys, e.g. to make the prompt disappear. */
  onSendKeys: (() => void) | null = null;

  async request(method: string, params: Record<string, unknown> = {}) {
    this.calls.push({ method, params });
    if (method === 'pane.read') {
      if (this.paneGone) throw new HerdrError('pane_not_found', `pane ${params.pane_id} not found`);
      const text = params.source === 'detection' ? this.screen : 'older\nlast useful line\n\n';
      return { type: 'pane_read', read: { pane_id: params.pane_id, source: params.source, text, revision: 7, truncated: true } };
    }
    if (method === 'agent.send_keys') this.onSendKeys?.();
    if (method === 'workspace.close') throw new HerdrError('workspace_not_found', 'no such workspace');
    return { type: 'ok', echo: params };
  }
  calledWith(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

class FakeHub extends EventEmitter {
  herdr = new FakeHerdr();
  status: SessionSnapshot['panes'][number]['status'] = 'blocked';
  cwd = '/x';
  sessions(): SessionSnapshot[] {
    return [
      {
        session: 's1',
        online: true,
        workspaces: [{ id: 'w1', label: 'hana' }],
        tabs: [{ id: 'w1:t1', workspaceId: 'w1', label: 'main' }],
        panes: [
          { session: 's1', paneId: PANE, tabId: 'w1:t1', workspaceId: 'w1', agent: 'claude', label: null, status: this.status, cwd: this.cwd, revision: 7 },
        ],
      },
    ];
  }
  client(session: string) {
    return session === 's1' ? (this.herdr as unknown as HerdrClient) : null;
  }
}

interface Ctx {
  url: string;
  hub: FakeHub;
  devices: DeviceStore;
  pairing: Pairing;
  pushes: { tokens: string[]; msg: PushMessage }[];
  uploadRoot: string;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const LOCAL_KEY = 'test-local-key';

/** fetch for /local/* with the admin key header the CLI sends. */
function lfetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('x-herdr-local-key')) headers.set('x-herdr-local-key', LOCAL_KEY);
  return fetch(url, { ...init, headers });
}

function setup(remoteAddress?: () => string | null, over: Partial<AppDeps> = {}): Ctx {
  const dir = mkdtempSync(path.join(tmpdir(), 'hm-app-'));
  const hub = new FakeHub();
  const devices = new DeviceStore(path.join(dir, 'data'));
  const pairing = new Pairing(devices);
  const uploadRoot = path.join(dir, 'uploads');
  const pushes: Ctx['pushes'] = [];
  const app = createApp({
    hub: hub as unknown as Hub,
    devices,
    pairing,
    uploads: new UploadStore(uploadRoot),
    policy: new NotifyPolicy(),
    push: async (tokens, msg) => {
      pushes.push({ tokens, msg });
      return { invalidTokens: [], failedBatches: 0 };
    },
    machineName: 'mac-mini',
    localKey: LOCAL_KEY,
    uploadLimitBytes: 10,
    remoteAddress: remoteAddress ? () => remoteAddress() : undefined,
    statusInfo: () => ({ port: 7420, tailscale: ['100.1.2.3'] }),
    ...over,
  });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch, websocket: app.websocket });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(async () => {
    app.close();
    await server.stop(true);
  });
  return { url: `http://127.0.0.1:${server.port}`, hub, devices, pairing, pushes, uploadRoot };
}

async function pair(c: Ctx, deviceName = 'iPhone'): Promise<{ token: string; deviceId: string }> {
  const { code } = c.pairing.create();
  const res = await fetch(`${c.url}/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName }) });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; deviceId: string };
}

function call(c: Ctx, token: string, method: string, p: string, body?: unknown) {
  return fetch(`${c.url}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const blocked = (over: Partial<Transition> = {}): Transition => ({
  session: 's1', paneId: PANE, from: 'working', to: 'blocked', agent: 'claude', workspaceId: 'w1', seq: 2, at: 1000, ...over,
});

const until = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
};

function openWs(c: Ctx, token: string): Promise<{ ws: WebSocket; msgs: ServerMsg[] }> {
  const ws = new WebSocket(`${c.url.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const msgs: ServerMsg[] = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  cleanups.push(() => ws.close());
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, msgs });
    ws.onerror = () => reject(new Error('ws error'));
  });
}

test('401 without token on every route except /pair', async () => {
  const c = setup();
  const routes: [string, string][] = [
    ['PUT', '/device'], ['GET', '/sessions'], ['POST', '/rpc'], ['GET', '/history?session=s1&paneId=w1:p1'],
    ['GET', '/approval?session=s1&paneId=w1:p1'], ['POST', '/approve'], ['POST', '/upload'], ['GET', '/ws'], ['GET', '/nope'],
  ];
  for (const [method, p] of routes) {
    const res = await fetch(`${c.url}${p}`, { method });
    expect([method, p, res.status]).toEqual([method, p, 401]);
    const bad = await fetch(`${c.url}${p}`, { method, headers: { authorization: 'Bearer wrong' } });
    expect([method, p, bad.status]).toEqual([method, p, 401]);
  }
  expect((await fetch(`${c.url}/ws?token=wrong`)).status).toBe(401);
  // /pair needs no token: a wrong code is 401, a missing field is 400
  c.pairing.create();
  expect((await fetch(`${c.url}/pair`, { method: 'POST', body: JSON.stringify({ code: '000000x', deviceName: 'x' }) })).status).toBe(401);
  expect((await fetch(`${c.url}/pair`, { method: 'POST', body: '{nope' })).status).toBe(400);
});

test('pair then authorized GET /sessions', async () => {
  const c = setup();
  const { code } = c.pairing.create();
  const res = await fetch(`${c.url}/pair`, { method: 'POST', body: JSON.stringify({ code, deviceName: 'iPhone' }) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; deviceId: string; machine: string };
  expect(body.machine).toBe('mac-mini');
  expect(c.devices.list().map((d) => [d.id, d.name])).toEqual([[body.deviceId, 'iPhone']]);
  const s = await call(c, body.token, 'GET', '/sessions');
  expect(s.status).toBe(200);
  expect(await s.json()).toEqual(c.hub.sessions());
  expect((await call(c, body.token, 'GET', '/nope')).status).toBe(404);
});

test('PUT /device updates whitelisted fields and validates', async () => {
  const c = setup();
  const { token, deviceId } = await pair(c);
  const prefs = { private: false, mutedSessions: ['s2'], mutedPanes: ['s1:w1:p2'] };
  expect((await call(c, token, 'PUT', '/device', { name: 'Pixel', pushToken: 'ExpoPushToken[a]', prefs })).status).toBe(204);
  const d = c.devices.list().find((x) => x.id === deviceId)!;
  expect([d.name, d.pushToken, d.prefs]).toEqual(['Pixel', 'ExpoPushToken[a]', prefs]);
  expect((await call(c, token, 'PUT', '/device', { prefs: { private: 'no' } })).status).toBe(400);
  expect((await call(c, token, 'PUT', '/device', { name: 5 })).status).toBe(400);
});

test('PUT /device stores the Live Activity start token', async () => {
  const c = setup();
  const { token, deviceId } = await pair(c);
  const liveActivity = { startToken: 'ab'.repeat(32), env: 'production' as const };
  expect((await call(c, token, 'PUT', '/device', { liveActivity })).status).toBe(204);
  expect(c.devices.list().find((x) => x.id === deviceId)!.liveActivity).toEqual(liveActivity);
  expect((await call(c, token, 'PUT', '/device', { liveActivity: { startToken: 'zz', env: 'production' } })).status).toBe(400);
  expect((await call(c, token, 'PUT', '/device', { liveActivity: { startToken: 'ab'.repeat(32), env: 'dev' } })).status).toBe(400);
  expect((await call(c, token, 'PUT', '/device', { liveActivity: null })).status).toBe(204);
  expect((await call(c, token, 'PUT', '/device', { lang: 'vi' })).status).toBe(204);
  expect(c.devices.list().find((x) => x.id === deviceId)!.lang).toBe('vi');
  expect((await call(c, token, 'PUT', '/device', { lang: 'fr' })).status).toBe(400);
  expect(c.devices.list().find((x) => x.id === deviceId)!.liveActivity).toBeNull();
});

test('rpc rejects method outside allowlist', async () => {
  const c = setup();
  const { token } = await pair(c);
  const res = await call(c, token, 'POST', '/rpc', { session: 's1', method: 'server.stop', params: {} });
  expect(res.status).toBe(403);
  expect((await call(c, token, 'POST', '/rpc', { session: 's1', method: 5 })).status).toBe(403);
  expect(c.hub.herdr.calls).toEqual([]);
  expect((await call(c, token, 'POST', '/rpc', { session: 's1' })).status).toBe(400);
});

test('rpc forwards allowed method', async () => {
  const c = setup();
  const { token } = await pair(c);
  const params = { target: PANE, text: 'fix the bug' };
  const res = await call(c, token, 'POST', '/rpc', { session: 's1', method: 'agent.prompt', params });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ type: 'ok', echo: params });
  expect(c.hub.herdr.calls).toEqual([{ method: 'agent.prompt', params }]);
  // herdr errors come back as 422 {code, message}
  const err = await call(c, token, 'POST', '/rpc', { session: 's1', method: 'workspace.close', params: { workspace_id: 'w9' } });
  expect(err.status).toBe(422);
  expect(await err.json()).toEqual({ code: 'workspace_not_found', message: 'no such workspace' });
  // unknown session → 503 offline
  const off = await call(c, token, 'POST', '/rpc', { session: 'zz', method: 'pane.list', params: {} });
  expect(off.status).toBe(503);
  expect(await off.json()).toEqual({ code: 'offline' });
});

test('history reads ansi recent text with capped lines', async () => {
  const c = setup();
  const { token } = await pair(c);
  const res = await call(c, token, 'GET', `/history?session=s1&paneId=${encodeURIComponent(PANE)}&lines=50000&source=recent_unwrapped`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: 'older\nlast useful line\n\n', truncated: true, revision: 7 });
  expect(c.hub.herdr.calls.at(-1)).toEqual({
    method: 'pane.read',
    params: { pane_id: PANE, source: 'recent_unwrapped', lines: 10000, format: 'ansi', strip_ansi: false },
  });
  expect((await call(c, token, 'GET', `/history?session=s1&paneId=${PANE}&source=visible`)).status).toBe(400);
});

test('approval returns parsed prompt', async () => {
  const c = setup();
  const { token } = await pair(c);
  const res = await call(c, token, 'GET', `/approval?session=s1&paneId=${encodeURIComponent(PANE)}`);
  expect(res.status).toBe(200);
  const p = parseApproval(PROMPT);
  expect(await res.json()).toEqual({ session: 's1', paneId: PANE, hash: p.hash, text: p.text, options: p.options });
  expect(c.hub.herdr.calls.at(-1)!.params).toMatchObject({ pane_id: PANE, source: 'detection' });
});

test('approve sends key when hash matches', async () => {
  const c = setup();
  const { token } = await pair(c);
  const hash = parseApproval(PROMPT).hash;
  const res = await call(c, token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: '1' });
  expect(res.status).toBe(204);
  expect(c.hub.herdr.calledWith('agent.send_keys')).toEqual([{ method: 'agent.send_keys', params: { target: PANE, keys: ['1'] } }]);
  // the same prompt can't be answered twice until the pane's status moves again
  expect((await call(c, token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: '2' })).status).toBe(409);
  c.hub.emit('transition', blocked({ seq: 3 }));
  // esc is always allowed; an unknown key is 400 and sends nothing
  expect((await call(c, token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: '7' })).status).toBe(400);
  expect((await call(c, token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: 'esc' })).status).toBe(204);
  expect(c.hub.herdr.calledWith('agent.send_keys').map((x) => x.params.keys)).toEqual([['1'], ['esc']]);
});

test('approve rejects when hash differs', async () => {
  const c = setup();
  const { token } = await pair(c);
  const res = await call(c, token, 'POST', '/approve', { session: 's1', paneId: PANE, hash: 'deadbeef', key: '1' });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ code: 'stale' });
  // pane no longer blocked in the hub, or session offline → stale too
  const hash = parseApproval(PROMPT).hash;
  c.hub.status = 'working';
  expect((await call(c, token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: '1' })).status).toBe(409);
  c.hub.status = 'blocked';
  expect((await call(c, token, 'POST', '/approve', { session: 'zz', paneId: PANE, hash, key: '1' })).status).toBe(409);
  expect(c.hub.herdr.calledWith('agent.send_keys')).toEqual([]);
});

test('approve rejects when pane gone', async () => {
  const c = setup();
  const { token } = await pair(c);
  c.hub.herdr.paneGone = true;
  const res = await call(c, token, 'POST', '/approve', { session: 's1', paneId: PANE, hash: parseApproval(PROMPT).hash, key: '1' });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ code: 'stale' });
  expect(c.hub.herdr.calledWith('agent.send_keys')).toEqual([]);
});

test('second phone approval goes stale after first answered', async () => {
  const c = setup();
  const a = await pair(c, 'A');
  const b = await pair(c, 'B');
  c.hub.herdr.onSendKeys = () => (c.hub.herdr.screen = 'Running rm -rf build…');
  const hash = parseApproval(PROMPT).hash;
  expect((await call(c, a.token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: '1' })).status).toBe(204);
  const res = await call(c, b.token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: '2' });
  expect(res.status).toBe(409);
  expect(c.hub.herdr.calledWith('agent.send_keys').length).toBe(1);
});

test('upload returns absolute paths and 413 over limit', async () => {
  const c = setup();
  const { token } = await pair(c);
  const form = new FormData();
  form.append('file', new Blob(['hello']), 'a.txt');
  form.append('file', new Blob(['world!']), 'b.png');
  const res = await fetch(`${c.url}/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  expect(res.status).toBe(200);
  const { paths } = (await res.json()) as { paths: string[] };
  expect(paths.length).toBe(2);
  for (const p of paths) {
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.startsWith(path.resolve(c.uploadRoot))).toBe(true);
  }
  expect(paths.map((p) => readFileSync(p, 'utf8'))).toEqual(['hello', 'world!']);

  const big = new FormData();
  big.append('file', new Blob(['ok']), 'small.txt');
  big.append('file', new Blob(['x'.repeat(11)]), 'big.bin');
  const tooBig = await fetch(`${c.url}/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: big });
  expect(tooBig.status).toBe(413);
  // nothing from the rejected request is left behind
  expect(existsSync(path.join(path.dirname(paths[0]!), 'small.txt'))).toBe(false);
  expect((await call(c, token, 'POST', '/upload', { not: 'multipart' })).status).toBe(400);
});

test('ws receives snapshot then status on transition', async () => {
  const c = setup();
  const { token } = await pair(c);
  const { msgs } = await openWs(c, token);
  await until(() => msgs.length >= 1);
  expect(msgs[0]).toEqual({ t: 'snapshot', machine: 'mac-mini', sessions: c.hub.sessions() });
  c.hub.emit('transition', blocked());
  await until(() => msgs.length >= 2);
  expect(msgs[1]).toEqual({ t: 'status', session: 's1', paneId: PANE, status: 'blocked', at: 1000 });
  const snap = { ...c.hub.sessions()[0]!, online: false };
  c.hub.emit('snapshot', snap);
  await until(() => msgs.length >= 3);
  expect(msgs[2]).toEqual({ t: 'session', snapshot: snap });
});

test('ws watch streams frames', async () => {
  const c = setup();
  const { token } = await pair(c);
  const { ws, msgs } = await openWs(c, token);
  ws.send(JSON.stringify({ t: 'watch', session: 's1', paneId: PANE }));
  await until(() => msgs.some((m) => m.t === 'frame'));
  expect(msgs.find((m) => m.t === 'frame')).toEqual({ t: 'frame', session: 's1', paneId: PANE, revision: 7, text: 'older\nlast useful line\n\n' });
  ws.send('garbage');
  await until(() => msgs.some((m) => m.t === 'error'));
  expect(msgs.find((m) => m.t === 'error')).toMatchObject({ t: 'error', code: 'bad_request' });
});

async function twoPushDevices(c: Ctx) {
  const a = await pair(c, 'A');
  const b = await pair(c, 'B');
  await call(c, a.token, 'PUT', '/device', { pushToken: 'tokA' });
  await call(c, b.token, 'PUT', '/device', { pushToken: 'tokB' });
  return { a, b };
}

test('push sent to both paired devices on blocked', async () => {
  const c = setup();
  const { a, b } = await twoPushDevices(c);
  c.hub.emit('transition', blocked());
  await until(() => c.pushes.flatMap((p) => p.tokens).length >= 2);
  expect(c.pushes.flatMap((p) => p.tokens).sort()).toEqual(['tokA', 'tokB']);
  const msg = c.pushes[0]!.msg;
  expect(msg.title).toBe('claude · hana');
  expect(msg.body).toBe('Waiting for approval'); // private mode is on by default; English by default
  const hash = parseApproval(PROMPT).hash;
  // each device gets its own payload carrying its deviceId (machine identity on the phone)
  const byToken = new Map(c.pushes.flatMap((p) => p.tokens.map((t) => [t, p.msg.data] as const)));
  expect(c.pushes).toHaveLength(2);
  expect(byToken.get('tokA')).toEqual({ session: 's1', paneId: PANE, kind: 'blocked', hash, deviceId: a.deviceId });
  expect(byToken.get('tokB')).toEqual({ session: 's1', paneId: PANE, kind: 'blocked', hash, deviceId: b.deviceId });
  // exactly one detection read for the whole transition
  expect(c.hub.herdr.calledWith('pane.read').map((x) => x.params.source)).toEqual(['detection']);
});

test('not sent to device viewing that pane', async () => {
  const c = setup();
  const { a } = await twoPushDevices(c);
  const { ws } = await openWs(c, a.token);
  ws.send(JSON.stringify({ t: 'foreground', session: 's1', paneId: PANE }));
  await Bun.sleep(50);
  c.hub.emit('transition', blocked());
  await until(() => c.pushes.length >= 1);
  await Bun.sleep(50);
  expect(c.pushes.flatMap((p) => p.tokens)).toEqual(['tokB']);
  // closing the last socket clears the foreground pane
  ws.close();
  await Bun.sleep(100);
  c.hub.emit('transition', blocked({ seq: 3 }));
  await until(() => c.pushes.flatMap((p) => p.tokens).length >= 3);
  expect(c.pushes.flatMap((p) => p.tokens).sort()).toEqual(['tokA', 'tokB', 'tokB']);
});

test('done push uses last recent line when not private; invalid tokens cleared', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hm-app-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const hub = new FakeHub();
  const devices = new DeviceStore(dir);
  const pushes: PushMessage[] = [];
  const app = createApp({
    hub: hub as unknown as Hub, devices, pairing: new Pairing(devices), uploads: new UploadStore(path.join(dir, 'u')),
    policy: new NotifyPolicy(), machineName: 'm', localKey: LOCAL_KEY,
    push: async (tokens, msg) => {
      pushes.push(msg);
      return { invalidTokens: tokens.filter((t) => t === 'dead'), failedBatches: 0 };
    },
  });
  cleanups.push(() => app.close());
  const a = devices.add('A').device;
  const b = devices.add('B').device;
  devices.update(a.id, { pushToken: 'live', prefs: { private: false, mutedSessions: [], mutedPanes: [] } });
  devices.update(b.id, { pushToken: 'dead', prefs: { private: false, mutedSessions: [], mutedPanes: [] } });
  hub.emit('transition', blocked({ to: 'done', agent: null }));
  await until(() => devices.pushTargets().length === 1);
  expect(pushes[0]!.body).toBe('Done: last useful line');
  expect(pushes[0]!.title).toBe('claude · hana'); // agent label falls back to the pane's agent
  expect(hub.herdr.calledWith('pane.read').map((x) => x.params)).toEqual([{ pane_id: PANE, source: 'recent', lines: 20 }]);
  expect(devices.pushTargets().map((d) => d.id)).toEqual([a.id]);
  expect(devices.list().find((d) => d.id === b.id)!.pushToken).toBeNull();
});

// ---- /local/* (CLI admin routes) --------------------------------------------

test('local routes answer 403 when the caller is not loopback', async () => {
  for (const addr of ['192.168.1.9', '100.88.1.2', '::ffff:192.168.1.9', null]) {
    const c = setup(() => addr);
    expect((await lfetch(`${c.url}/local/pair`, { method: 'POST' })).status).toBe(403);
    expect((await lfetch(`${c.url}/local/devices`)).status).toBe(403);
    expect((await lfetch(`${c.url}/local/status`)).status).toBe(403);
    expect((await lfetch(`${c.url}/local/revoke/abc`, { method: 'POST' })).status).toBe(403);
  }
  const c = setup(() => '192.168.1.9');
  const { deviceId } = await pair(c);
  expect((await lfetch(`${c.url}/local/revoke/${deviceId}`, { method: 'POST' })).status).toBe(403);
  expect(c.devices.list()).toHaveLength(1);
});

test('local routes accept 127.0.0.1, ::1 and ::ffff:127.0.0.1', async () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const c = setup(() => addr);
    expect((await lfetch(`${c.url}/local/devices`)).status).toBe(200);
  }
});

test('POST /local/pair creates a pairing code that /pair accepts', async () => {
  const c = setup();
  const res = await lfetch(`${c.url}/local/pair`, { method: 'POST' });
  expect(res.status).toBe(200);
  const p = (await res.json()) as { code: string; secret: string; expiresAt: number; machineName: string };
  expect(p.code).toMatch(/^\d{6}$/);
  expect(p.machineName).toBe('mac-mini');
  const r = await fetch(`${c.url}/pair`, { method: 'POST', body: JSON.stringify({ code: p.code, deviceName: 'x' }) });
  expect(r.status).toBe(200);
});

test('GET /local/devices and /local/status', async () => {
  const c = setup();
  const a = await pair(c, 'iPhone');
  await openWs(c, a.token);
  const list = (await (await lfetch(`${c.url}/local/devices`)).json()) as { id: string; name: string; connected: number }[];
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: a.deviceId, name: 'iPhone', connected: 1 });
  expect(JSON.stringify(list)).not.toContain('tokenHash');
  const st = (await (await lfetch(`${c.url}/local/status`)).json()) as Record<string, unknown>;
  expect(st).toMatchObject({ port: 7420, devices: 1, sockets: 1, sessions: [{ session: 's1', online: true, panes: 1 }] });
});

test('revoke via /local/revoke closes that device sockets and its token gets 401; the other device keeps working', async () => {
  const c = setup();
  const a = await pair(c, 'phone A');
  const b = await pair(c, 'phone B');
  const wa = await openWs(c, a.token);
  const wb = await openWs(c, b.token);
  const closed = new Promise<void>((r) => (wa.ws.onclose = () => r()));
  expect((await lfetch(`${c.url}/local/revoke/${a.deviceId}`, { method: 'POST' })).status).toBe(204);
  await closed;
  expect(wa.ws.readyState).toBe(WebSocket.CLOSED);
  expect(wb.ws.readyState).toBe(WebSocket.OPEN);
  expect((await call(c, a.token, 'GET', '/sessions')).status).toBe(401);
  expect((await call(c, b.token, 'GET', '/sessions')).status).toBe(200);
  expect((await lfetch(`${c.url}/local/revoke/${a.deviceId}`, { method: 'POST' })).status).toBe(404);
});

test('local routes reject a foreign Host (DNS rebinding) and any Origin, even from loopback', async () => {
  const c = setup();
  const port = new URL(c.url).port;
  const raw = (path: string, headers: Record<string, string>, method = 'GET') =>
    lfetch(`${c.url}${path}`, { method, headers }).then((r) => r.status);
  expect(await raw('/local/devices', { host: `evil.example:${port}` })).toBe(403);
  expect(await raw('/local/pair', { host: 'evil.example:7420' }, 'POST')).toBe(403);
  expect(await raw('/local/devices', { host: '127.0.0.1' })).toBe(403); // wrong/missing port
  expect(await raw('/local/devices', { origin: 'https://evil.example' })).toBe(403);
  expect(await raw('/local/pair', { origin: 'null' }, 'POST')).toBe(403);
  expect(await raw('/local/devices', { host: `localhost:${port}` })).toBe(200);
  expect(await raw('/local/devices', { host: `127.0.0.1:${port}` })).toBe(200);
  expect(c.pairing.redeem('000000', 'x')).toBeNull(); // nothing was minted by the rejected calls
});

test('local routes need the admin key: missing or wrong key is 403, right key works', async () => {
  const c = setup();
  const { deviceId } = await pair(c);
  const noKey = (p: string, method = 'GET') => fetch(`${c.url}${p}`, { method }).then((r) => r.status);
  const badKey = (p: string, method = 'GET') =>
    fetch(`${c.url}${p}`, { method, headers: { 'x-herdr-local-key': 'wrong' } }).then((r) => r.status);
  for (const f of [noKey, badKey]) {
    expect(await f('/local/pair', 'POST')).toBe(403);
    expect(await f('/local/devices')).toBe(403);
    expect(await f('/local/status')).toBe(403);
    expect(await f(`/local/revoke/${deviceId}`, 'POST')).toBe(403);
  }
  expect(await (await fetch(`${c.url}/local/devices`, { headers: { 'x-herdr-local-key': '' } })).status).toBe(403);
  expect(c.devices.list()).toHaveLength(1); // nothing revoked
  expect(c.pairing.redeem('000000', 'x')).toBeNull();
  expect((await lfetch(`${c.url}/local/status`)).status).toBe(200);
  expect((await lfetch(`${c.url}/local/pair`, { method: 'POST' })).status).toBe(200);
  expect((await lfetch(`${c.url}/local/revoke/${deviceId}`, { method: 'POST' })).status).toBe(204);
});

test('an exception inside a /local route returns the app 500 JSON', async () => {
  const c = setup(undefined, {
    statusInfo: () => {
      throw new Error('boom');
    },
  });
  const res = await lfetch(`${c.url}/local/status`);
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ code: 'internal' });
});

test('concurrent approves with the same hash: exactly one send_keys, the other 409', async () => {
  const c = setup();
  const a = await pair(c, 'A');
  const b = await pair(c, 'B');
  const hash = parseApproval(PROMPT).hash;
  const [r1, r2] = await Promise.all([
    call(c, a.token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: '1' }),
    call(c, b.token, 'POST', '/approve', { session: 's1', paneId: PANE, hash, key: '2' }),
  ]);
  expect([r1.status, r2.status].sort()).toEqual([204, 409]);
  expect(c.hub.herdr.calledWith('agent.send_keys')).toHaveLength(1);
});

// ---- files ----------------------------------------------------------------

test('GET /file serves a path relative to the pane cwd, and absolute ones', async () => {
  const c = setup();
  const cwd = mkdtempSync(path.join(tmpdir(), 'hm-cwd-'));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  c.hub.cwd = cwd;
  mkdirSync(path.join(cwd, 'out'));
  writeFileSync(path.join(cwd, 'out', 'kết quả.txt'), 'xin chào');
  const { token } = await pair(c);
  const rel = await call(c, token, 'GET', `/file?session=s1&paneId=${encodeURIComponent(PANE)}&path=${encodeURIComponent('out/kết quả.txt')}`);
  expect(rel.status).toBe(200);
  expect(await rel.text()).toBe('xin chào');
  const abs = await call(c, token, 'GET', `/file?session=s1&paneId=${encodeURIComponent(PANE)}&path=${encodeURIComponent(path.join(cwd, 'out', 'kết quả.txt'))}`);
  expect(abs.status).toBe(200);
  expect((await call(c, token, 'GET', `/file?session=s1&paneId=${encodeURIComponent(PANE)}&path=nope.txt`)).status).toBe(404);
  expect((await call(c, token, 'GET', `/file?session=s1&paneId=${encodeURIComponent(PANE)}`)).status).toBe(400);
});

test('GET /file needs the device token', async () => {
  const c = setup();
  expect((await fetch(`${c.url}/file?session=s1&paneId=x&path=/etc/hosts`)).status).toBe(401);
});
