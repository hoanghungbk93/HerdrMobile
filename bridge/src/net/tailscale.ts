import os, { type NetworkInterfaceInfo } from 'node:os';

const isTailscaleV4 = (a: string): boolean => {
  const p = a.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n)) && p[0] === 100 && p[1]! >= 64 && p[1]! <= 127;
};
const isTailscaleV6 = (a: string): boolean => a.toLowerCase().startsWith('fd7a:115c:a1e0:');

/** IPv4 in 100.64.0.0/10 and IPv6 in fd7a:115c:a1e0::/48 found on local interfaces. */
export function tailscaleAddresses(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      const ok = String(i.family) === 'IPv4' || String(i.family) === '4' ? isTailscaleV4(i.address) : isTailscaleV6(i.address);
      if (ok && !out.includes(i.address)) out.push(i.address);
    }
  }
  return out;
}

export interface BinderOptions {
  recheckMs?: number;
  getAddrs?: () => string[];
  log?: (msg: string) => void;
  /** Bind 0.0.0.0 only (covers loopback too) instead of 127.0.0.1 + Tailscale addresses. */
  listenAll?: boolean;
}

const LOCALHOST = '127.0.0.1';
const ALL = '0.0.0.0';

/**
 * Keeps one listener on 127.0.0.1 plus one per Tailscale address, adding and
 * removing them as the addresses come and go.
 */
export class Binder {
  private servers = new Map<string, { stop(): void }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly recheckMs: number;
  private readonly getAddrs: () => string[];
  private readonly log: (msg: string) => void;
  private readonly listenAll: boolean;

  constructor(private readonly startServer: (host: string) => { stop(): void }, opts: BinderOptions = {}) {
    this.recheckMs = opts.recheckMs ?? 10_000;
    this.getAddrs = opts.getAddrs ?? (() => tailscaleAddresses());
    this.log = opts.log ?? ((m) => console.log(m));
    this.listenAll = opts.listenAll ?? false;
  }

  /** Throws if localhost cannot be bound. Tailscale binds are best-effort and retried. */
  start(): void {
    if (this.listenAll) {
      this.servers.set(ALL, this.startServer(ALL));
      return;
    }
    this.servers.set(LOCALHOST, this.startServer(LOCALHOST));
    this.check();
    this.timer = setInterval(() => this.check(), this.recheckMs);
  }

  hosts(): string[] {
    return [...this.servers.keys()];
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.servers.values()) s.stop();
    this.servers.clear();
  }

  private check(): void {
    const want = new Set(this.getAddrs());
    for (const [host, s] of [...this.servers]) {
      if (host !== LOCALHOST && !want.has(host)) {
        s.stop();
        this.servers.delete(host);
        this.log(`[net] tailscale address ${host} gone, stopped listening`);
      }
    }
    for (const host of want) {
      if (this.servers.has(host)) continue;
      try {
        this.servers.set(host, this.startServer(host));
        this.log(`[net] listening on ${host}`);
      } catch (e) {
        this.log(`[net] cannot bind ${host}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
