import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Device, DeviceStore } from './store';

const TTL_MS = 5 * 60_000;
const MAX_FAILS = 5;

interface Active { code: string; secret: string; expiresAt: number; fails: number }

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Pairing {
  private active: Active | null = null;

  constructor(private readonly store: DeviceStore, private readonly now: () => number = Date.now) {}

  create(): { code: string; secret: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const secret = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + TTL_MS;
    this.active = { code, secret, expiresAt, fails: 0 };
    return { code, secret, expiresAt };
  }

  redeem(codeOrSecret: string, deviceName: string): { device: Device; token: string } | null {
    const a = this.active;
    if (!a) return null;
    if (this.now() > a.expiresAt) {
      this.active = null;
      return null;
    }
    // Evaluate both comparisons (no short-circuit) to keep timing uniform.
    const okCode = safeEq(codeOrSecret, a.code);
    const okSecret = safeEq(codeOrSecret, a.secret);
    if (okCode || okSecret) {
      this.active = null;
      return this.store.add(deviceName);
    }
    if (++a.fails >= MAX_FAILS) this.active = null;
    return null;
  }
}
