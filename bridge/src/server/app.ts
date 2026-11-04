import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { ApprovalInfo, ClientMsg, PushPrefs, ServerMsg, SessionSnapshot } from '@herdr-mobile/protocol';
import { parseApproval } from '../approval/parse';
import { LOCAL_KEY_HEADER, localKeyMatches } from '../auth/localKey';
import type { Pairing } from '../auth/pairing';
import type { DeviceStore } from '../auth/store';
import { HerdrError, type HerdrClient } from '../herdr/client';
import { PaneStreamer } from '../live/paneStreamer';
import type { PushMessage, sendExpoPush } from '../notify/expoPush';
import type { NotifyPolicy } from '../notify/policy';
import { UploadTooLarge, type UploadStore } from '../uploads/store';
import type { Hub } from '../watch/hub';
import type { Transition } from '../watch/statusTracker';
import { RPC_ALLOWLIST } from './allowlist';

export interface AppDeps {
  hub: Hub;
  devices: DeviceStore;
  pairing: Pairing;
  uploads: UploadStore;
  policy: NotifyPolicy;
  push: typeof sendExpoPush;
  machineName: string;
  /** Admin key every /local/* call must send in X-Herdr-Local-Key (written to DATA_DIR/local.key by `start`). */
  localKey: string;
  /** Per-file upload limit; tests inject a tiny one. */
  uploadLimitBytes?: number;
  /** Test seam: remote address of a request (default: server.requestIP). */
  remoteAddress?: (req: Request, server: Server<WsData>) => string | null;
  /** Extra fields for GET /local/status (tailscale addresses, port). */
  statusInfo?: () => Record<string, unknown>;
}

/** 127.0.0.1, ::1 and ::ffff:127.0.0.1 only. */
export function isLoopback(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1';
}

interface WsData {
  id: string;
  deviceId: string;
}

export interface App {
  fetch: (req: Request, server: Server<WsData>) => Response | Promise<Response> | undefined;
  websocket: WebSocketHandler<WsData>;
  /** Clears the cleanup interval, detaches from the hub and stops live polling. */
  close: () => void;
}

const HISTORY_MAX_LINES = 10000;
const HISTORY_DEFAULT_LINES = 1000;
const CLEANUP_EVERY_MS = 6 * 3600_000;

type Foreground = { session: string | null; paneId: string | null };
type Json = Record<string, unknown>;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, code: string, message?: string) =>
  json(message === undefined ? { code } : { code, message }, status);
const stale = () => fail(409, 'stale');
const noContent = () => new Response(null, { status: 204 });

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isPrefs = (v: unknown): v is PushPrefs =>
  isObj(v) && typeof v.private === 'boolean' && isStrArr(v.mutedSessions) && isStrArr(v.mutedPanes);

async function readBody(req: Request): Promise<Json | null> {
  try {
    const b = await req.json();
    return isObj(b) ? b : null;
  } catch {
    return null;
  }
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]! : null;
}

async function readPane(client: HerdrClient, params: Json) {
  const r = await client.request<{ read: { text: string; revision: number; truncated: boolean } }>('pane.read', params);
  return r.read;
}

// Box borders and the selection cursor drawn around approval prompts.
const BOX = /[│┃║╭╮╰╯─━═┌┐└┘]/g;
const OPTION_LINE = /^[❯›>]?\s*\d\.\s/;

/**
 * Preview line for a "blocked" push: the question (last non-option line
 * ending in "?"), else the last non-option line. For Claude Code's box this
 * gives "Do you want to proceed?" rather than the "Bash command" header.
 */
function questionLine(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((l) => l.replace(BOX, '').trim())
    .filter((l) => l !== '' && !OPTION_LINE.test(l));
  return lines.findLast((l) => l.endsWith('?')) ?? lines.at(-1);
}

const lastNonEmptyLine = (text: string) =>
  text.split('\n').map((l) => l.trim()).findLast((l) => l !== '');

export function createApp(deps: AppDeps): App {
  const { hub, devices, pairing, uploads, policy } = deps;
  const uploadLimit = deps.uploadLimitBytes ?? 100 * 1024 * 1024;
  const streamer = new PaneStreamer((s) => hub.client(s));
  const sockets = new Set<ServerWebSocket<WsData>>();
  const socketsPerDevice = new Map<string, number>();
  const foreground = new Map<string, Foreground>();
  /** Hash already answered per "<session>:<paneId>", until the pane's status moves again. */
  const answered = new Map<string, string>();
  /** Serialises /approve per pane so two phones can't both pass the stale check. */
  const approveLocks = new Map<string, Promise<unknown>>();

  const send = (ws: ServerWebSocket<WsData>, msg: ServerMsg): void => {
    ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) ws.send(s);
  };

  // ---- hub wiring -------------------------------------------------------

  const onSnapshot = (snapshot: SessionSnapshot) => broadcast({ t: 'session', snapshot });
  const onTransition = (t: Transition) => {
    answered.delete(`${t.session}:${t.paneId}`);
    broadcast({ t: 'status', session: t.session, paneId: t.paneId, status: t.to, at: t.at });
    notify(t).catch((e) => console.error('[app] push failed:', e instanceof Error ? e.message : e));
  };
  hub.on('snapshot', onSnapshot);
  hub.on('transition', onTransition);

  async function notify(t: Transition): Promise<void> {
    const targets = devices.pushTargets();
    if (targets.length === 0) return;
    const isBlocked = t.to === 'blocked';
    const isDone = t.from === 'working' && (t.to === 'done' || t.to === 'idle');
    if (!isBlocked && !isDone) return; // the policy would drop it; skip the pane.read

    const snap = hub.sessions().find((s) => s.session === t.session);
    const pane = snap?.panes.find((p) => p.paneId === t.paneId);
    const workspaceId = t.workspaceId || pane?.workspaceId || '';
    const agentLabel = t.agent ?? pane?.agent ?? 'agent';
    const workspaceLabel = snap?.workspaces.find((w) => w.id === workspaceId)?.label ?? workspaceId;

    let detectionFirstLine: string | undefined;
    let hash: string | undefined;
    const client = hub.client(t.session);
    if (client) {
      try {
        if (isBlocked) {
          const parsed = parseApproval((await readPane(client, { pane_id: t.paneId, source: 'detection' })).text);
          hash = parsed.hash;
          detectionFirstLine = questionLine(parsed.text);
        } else if (targets.some((d) => !d.prefs.private)) {
          const read = await readPane(client, { pane_id: t.paneId, source: 'recent', lines: 20 });
          detectionFirstLine = lastNonEmptyLine(read.text);
        }
      } catch {
        /* pane gone / herdr down: push without preview */
      }
    }

    const now = Date.now();
    const groups = new Map<string, { msg: PushMessage; tokens: string[] }>();
    for (const d of targets) {
      const msg = policy.decide(
        t,
        {
          agentLabel,
          workspaceLabel,
          prefs: d.prefs,
          foreground: foreground.get(d.id) ?? { session: null, paneId: null },
          detectionFirstLine,
          hash,
          deviceId: d.id,
        },
        now,
      );
      if (!msg) continue;
      msg.data.deviceId = d.id; // per-device payload: the app resolves the machine by its own deviceId
      const key = JSON.stringify(msg);
      const g = groups.get(key) ?? { msg, tokens: [] };
      g.tokens.push(d.pushToken!);
      groups.set(key, g);
    }
    for (const { msg, tokens } of groups.values()) {
      const r = await deps.push(tokens, msg);
      if (r.failedBatches > 0) console.warn(`[app] ${r.failedBatches} expo push batch(es) failed`);
      for (const tok of r.invalidTokens) {
        for (const d of devices.list()) if (d.pushToken === tok) devices.update(d.id, { pushToken: null });
      }
    }
  }

  // ---- upload cleanup ---------------------------------------------------

  const cleanup = () => {
    uploads.cleanup().catch((e) => console.warn('[app] upload cleanup failed:', e instanceof Error ? e.message : e));
  };
  cleanup();
  const cleanupTimer = setInterval(cleanup, CLEANUP_EVERY_MS);

  // ---- routes -----------------------------------------------------------

  async function pair(req: Request): Promise<Response> {
    const b = await readBody(req);
    if (!b || !isStr(b.code) || !isStr(b.deviceName) || b.deviceName.trim() === '') return fail(400, 'bad_request');
    const r = pairing.redeem(b.code, b.deviceName.trim());
    if (!r) return fail(401, 'unauthorized');
    return json({ token: r.token, deviceId: r.device.id, machine: deps.machineName });
  }

  async function putDevice(req: Request, deviceId: string): Promise<Response> {
    const b = await readBody(req);
    if (!b) return fail(400, 'bad_request');
    const patch: { name?: string; pushToken?: string | null; prefs?: PushPrefs } = {};
    if (b.name !== undefined) {
      if (!isStr(b.name) || b.name.trim() === '') return fail(400, 'bad_request', 'name');
      patch.name = b.name.trim();
    }
    if (b.pushToken !== undefined) {
      if (b.pushToken !== null && !isStr(b.pushToken)) return fail(400, 'bad_request', 'pushToken');
      patch.pushToken = b.pushToken || null;
    }
    if (b.prefs !== undefined) {
      if (!isPrefs(b.prefs)) return fail(400, 'bad_request', 'prefs');
      patch.prefs = { private: b.prefs.private, mutedSessions: b.prefs.mutedSessions, mutedPanes: b.prefs.mutedPanes };
    }
    devices.update(deviceId, patch);
    return noContent();
  }

  async function rpc(req: Request): Promise<Response> {
    const b = await readBody(req);
    if (!b || !isStr(b.session) || b.method === undefined) return fail(400, 'bad_request');
    if (!isStr(b.method) || !RPC_ALLOWLIST.has(b.method)) return fail(403, 'forbidden');
    const params = b.params ?? {};
    if (!isObj(params)) return fail(400, 'bad_request', 'params');
    const client = hub.client(b.session);
    if (!client) return fail(503, 'offline');
    try {
      return json((await client.request(b.method, params)) ?? null);
    } catch (e) {
      if (e instanceof HerdrError) return fail(422, e.code, e.message);
      throw e;
    }
  }

  async function history(url: URL): Promise<Response> {
    const session = url.searchParams.get('session');
    const paneId = url.searchParams.get('paneId');
    const source = url.searchParams.get('source') ?? 'recent';
    const linesParam = url.searchParams.get('lines');
    const lines = linesParam === null ? HISTORY_DEFAULT_LINES : Number(linesParam);
    if (!session || !paneId || (source !== 'recent' && source !== 'recent_unwrapped')) return fail(400, 'bad_request');
    if (!Number.isInteger(lines) || lines < 1) return fail(400, 'bad_request', 'lines');
    const client = hub.client(session);
    if (!client) return fail(503, 'offline');
    try {
      const r = await readPane(client, {
        pane_id: paneId,
        source,
        lines: Math.min(lines, HISTORY_MAX_LINES),
        format: 'ansi',
        strip_ansi: false,
      });
      return json({ text: r.text, truncated: r.truncated, revision: r.revision });
    } catch (e) {
      if (e instanceof HerdrError) return fail(422, e.code, e.message);
      throw e;
    }
  }

  async function approval(url: URL): Promise<Response> {
    const session = url.searchParams.get('session');
    const paneId = url.searchParams.get('paneId');
    if (!session || !paneId) return fail(400, 'bad_request');
    const client = hub.client(session);
    if (!client) return fail(503, 'offline');
    try {
      const p = parseApproval((await readPane(client, { pane_id: paneId, source: 'detection' })).text);
      const info: ApprovalInfo = { session, paneId, hash: p.hash, text: p.text, options: p.options };
      return json(info);
    } catch (e) {
      if (e instanceof HerdrError) return fail(422, e.code, e.message);
      throw e;
    }
  }

  async function approve(req: Request): Promise<Response> {
    const b = await readBody(req);
    if (!b || !isStr(b.session) || !isStr(b.paneId) || !isStr(b.hash) || !isStr(b.key)) return fail(400, 'bad_request');
    const { session, paneId, hash, key } = b as { session: string; paneId: string; hash: string; key: string };
    const lockKey = `${session}:${paneId}`;
    const prev = approveLocks.get(lockKey) ?? Promise.resolve();
    const run = prev.then(async (): Promise<Response> => {
      // Never send keys on doubt: anything uncertain is "stale".
      const client = hub.client(session);
      if (!client) return stale();
      const pane = hub.sessions().find((s) => s.session === session)?.panes.find((p) => p.paneId === paneId);
      if (pane?.status !== 'blocked') return stale();
      if (answered.get(lockKey) === hash) return stale();
      let parsed;
      try {
        parsed = parseApproval((await readPane(client, { pane_id: paneId, source: 'detection' })).text);
      } catch {
        return stale();
      }
      if (parsed.hash !== hash) return stale();
      if (key !== 'esc' && !parsed.options.some((o) => o.key === key)) return fail(400, 'bad_request', 'key');
      try {
        await client.request('agent.send_keys', { target: paneId, keys: [key] });
      } catch (e) {
        if (e instanceof HerdrError) return fail(422, e.code, e.message);
        throw e;
      }
      answered.set(lockKey, hash);
      return noContent();
    });
    const settled = run.catch(() => {});
    approveLocks.set(lockKey, settled);
    void settled.then(() => {
      if (approveLocks.get(lockKey) === settled) approveLocks.delete(lockKey);
    });
    return run;
  }

  async function upload(req: Request): Promise<Response> {
    if (!(req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) return fail(400, 'bad_request');
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(400, 'bad_request');
    }
    const files = form.getAll('file').filter((f): f is File => f instanceof Blob);
    if (files.length === 0) return fail(400, 'bad_request', 'file');
    const tooLarge = () => json({ code: 'too_large', maxBytes: uploadLimit }, 413);
    if (files.some((f) => f.size > uploadLimit)) return tooLarge();
    const paths: string[] = [];
    try {
      for (const f of files) paths.push(await uploads.save(f.name || 'upload', f, uploadLimit));
    } catch (e) {
      await Promise.all(paths.map((p) => rm(p, { force: true })));
      if (e instanceof UploadTooLarge) return tooLarge();
      throw e;
    }
    return json({ paths });
  }

  /** Localhost-only admin routes used by the CLI; need the local admin key (DATA_DIR/local.key), not a device token. */
  function local(req: Request, url: URL, server: Server<WsData>): Response {
    const remote = deps.remoteAddress ? deps.remoteAddress(req, server) : (server.requestIP(req)?.address ?? null);
    if (!isLoopback(remote)) return fail(403, 'forbidden');
    // Anti DNS-rebinding / cross-site: exact loopback Host for the port we serve, and no browser Origin.
    const port = server.port;
    const host = (req.headers.get('host') ?? '').toLowerCase();
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]).has(host)) return fail(403, 'forbidden');
    if (req.headers.has('origin')) return fail(403, 'forbidden');
    // Other local OS users can reach loopback too: only someone who can read our 0600 key file may administer.
    if (!localKeyMatches(deps.localKey, req.headers.get(LOCAL_KEY_HEADER))) return fail(403, 'forbidden');
    const key = `${req.method} ${url.pathname}`;
    if (key === 'POST /local/pair') return json({ ...pairing.create(), machineName: deps.machineName });
    if (key === 'GET /local/devices') {
      return json(
        devices.list().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, connected: socketsPerDevice.get(d.id) ?? 0 })),
      );
    }
    if (key === 'GET /local/status') {
      return json({
        ...(deps.statusInfo?.() ?? {}),
        machineName: deps.machineName,
        sessions: hub.sessions().map((s) => ({ session: s.session, online: s.online, panes: s.panes.length })),
        devices: devices.list().length,
        sockets: sockets.size,
      });
    }
    const m = /^\/local\/revoke\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]!);
      const ok = devices.revoke(id);
      for (const ws of [...sockets]) if (ws.data.deviceId === id) ws.close(4401, 'revoked');
      return ok ? noContent() : fail(404, 'not_found');
    }
    return fail(404, 'not_found');
  }

  async function route(req: Request, url: URL, deviceId: string): Promise<Response> {
    switch (`${req.method} ${url.pathname}`) {
      case 'PUT /device':
        return putDevice(req, deviceId);
      case 'GET /sessions':
        return json(hub.sessions());
      case 'POST /rpc':
        return rpc(req);
      case 'GET /history':
        return history(url);
      case 'GET /approval':
        return approval(url);
      case 'POST /approve':
        return approve(req);
      case 'POST /upload':
        return upload(req);
      default:
        return fail(404, 'not_found');
    }
  }

  const internal = (e: unknown) => {
    console.error('[app] request failed:', e instanceof Error ? e.message : e);
    return fail(500, 'internal');
  };

  return {
    fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname === '/pair') return pair(req).catch(internal);
      if (url.pathname.startsWith('/local/')) {
        try {
          return local(req, url, server);
        } catch (e) {
          return internal(e);
        }
      }
      const isWs = url.pathname === '/ws';
      const token = isWs ? url.searchParams.get('token') : bearer(req);
      const device = token ? devices.verify(token) : null;
      if (!device) return fail(401, 'unauthorized');
      if (isWs) {
        if (req.method === 'GET' && server.upgrade(req, { data: { id: randomUUID(), deviceId: device.id } })) return undefined;
        return fail(400, 'bad_request', 'expected websocket upgrade');
      }
      return route(req, url, device.id).catch(internal);
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
        socketsPerDevice.set(ws.data.deviceId, (socketsPerDevice.get(ws.data.deviceId) ?? 0) + 1);
        send(ws, { t: 'snapshot', machine: deps.machineName, sessions: hub.sessions() });
      },
      message(ws, raw) {
        let msg: unknown;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return send(ws, { t: 'error', code: 'bad_request', message: 'invalid JSON' });
        }
        if (!isObj(msg)) return send(ws, { t: 'error', code: 'bad_request', message: 'expected an object' });
        const m = msg as unknown as ClientMsg;
        if ((m.t === 'watch' || m.t === 'unwatch') && isStr(msg.session) && isStr(msg.paneId)) {
          if (m.t === 'watch') streamer.watch(ws.data.id, m.session, m.paneId, (f) => send(ws, f));
          else streamer.unwatch(ws.data.id, m.session, m.paneId);
        } else if (
          m.t === 'foreground' &&
          (msg.session === null || isStr(msg.session)) &&
          (msg.paneId === null || isStr(msg.paneId))
        ) {
          foreground.set(ws.data.deviceId, { session: m.session, paneId: m.paneId });
        } else {
          send(ws, { t: 'error', code: 'bad_request', message: 'unknown message' });
        }
      },
      close(ws) {
        sockets.delete(ws);
        streamer.unwatch(ws.data.id);
        const left = (socketsPerDevice.get(ws.data.deviceId) ?? 1) - 1;
        if (left > 0) socketsPerDevice.set(ws.data.deviceId, left);
        else {
          socketsPerDevice.delete(ws.data.deviceId);
          foreground.delete(ws.data.deviceId);
        }
      },
    },

    close() {
      clearInterval(cleanupTimer);
      hub.off('snapshot', onSnapshot);
      hub.off('transition', onTransition);
      streamer.stop();
    },
  };
}
