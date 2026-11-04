import { afterEach, expect, test } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { Binder, tailscaleAddresses } from '../../src/net/tailscale';

const ni = (address: string, family: 'IPv4' | 'IPv6'): NetworkInterfaceInfo =>
  ({ address, family, internal: false }) as NetworkInterfaceInfo;

test('tailscaleAddresses keeps only the tailscale ranges', () => {
  const got = tailscaleAddresses({
    utun3: [ni('100.101.5.9', 'IPv4'), ni('fd7a:115c:a1e0::1234', 'IPv6')],
    en0: [ni('192.168.1.5', 'IPv4'), ni('100.128.0.1', 'IPv4'), ni('fe80::1', 'IPv6')],
  });
  expect(got).toEqual(['100.101.5.9', 'fd7a:115c:a1e0::1234']);
});

const timers: Binder[] = [];
afterEach(() => timers.splice(0).forEach((b) => b.stop()));

test('binds when tailscale address appears, unbinds when it disappears', async () => {
  const started: string[] = [];
  const stopped: string[] = [];
  let addrs: string[] = [];
  const b = new Binder(
    (host) => {
      started.push(host);
      return { stop: () => void stopped.push(host) };
    },
    { recheckMs: 10, log: () => {}, getAddrs: () => addrs },
  );
  timers.push(b);
  b.start();
  expect(started).toEqual(['127.0.0.1']);
  addrs = ['100.88.1.2'];
  await Bun.sleep(40);
  expect(started).toEqual(['127.0.0.1', '100.88.1.2']);
  addrs = [];
  await Bun.sleep(40);
  expect(stopped).toEqual(['100.88.1.2']);
  b.stop();
  expect(stopped).toEqual(['100.88.1.2', '127.0.0.1']);
});

test('a failing bind is retried on the next check', async () => {
  let fails = true;
  const started: string[] = [];
  const b = new Binder(
    (host) => {
      if (host !== '127.0.0.1' && fails) throw new Error('EADDRNOTAVAIL');
      started.push(host);
      return { stop() {} };
    },
    { recheckMs: 10, log: () => {}, getAddrs: () => ['100.88.1.2'] },
  );
  timers.push(b);
  b.start();
  await Bun.sleep(25);
  expect(started).toEqual(['127.0.0.1']);
  fails = false;
  await Bun.sleep(40);
  expect(started).toEqual(['127.0.0.1', '100.88.1.2']);
});
