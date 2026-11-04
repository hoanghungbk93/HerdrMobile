import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PushPrefs } from '@herdr-mobile/protocol';

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  pushToken: string | null;
  prefs: PushPrefs;
  createdAt: number;
  lastSeenAt: number;
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export class DeviceStore {
  private readonly file: string;
  private devices: Device[] = [];

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'devices.json');
    if (existsSync(this.file)) this.devices = JSON.parse(readFileSync(this.file, 'utf8')) as Device[];
  }

  add(name: string): { device: Device; token: string } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const device: Device = {
      id: randomBytes(8).toString('hex'),
      name,
      tokenHash: sha256hex(token),
      pushToken: null,
      prefs: { private: true, mutedSessions: [], mutedPanes: [] },
      createdAt: now,
      lastSeenAt: now,
    };
    this.devices.push(device);
    this.save();
    return { device, token };
  }

  verify(token: string): Device | null {
    const hash = Buffer.from(sha256hex(token), 'hex');
    let found: Device | null = null;
    for (const d of this.devices) {
      if (timingSafeEqual(hash, Buffer.from(d.tokenHash, 'hex'))) found = d;
    }
    return found;
  }

  update(id: string, patch: Partial<Pick<Device, 'name' | 'pushToken' | 'prefs'>>): void {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return;
    if (patch.name !== undefined) d.name = patch.name;
    if (patch.pushToken !== undefined) d.pushToken = patch.pushToken;
    if (patch.prefs !== undefined) d.prefs = patch.prefs;
    this.save();
  }

  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  list(): Device[] {
    return [...this.devices];
  }

  pushTargets(): Device[] {
    return this.devices.filter((d) => typeof d.pushToken === 'string' && d.pushToken.length > 0);
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* no-op on Windows */ }
    renameSync(tmp, this.file);
  }
}
