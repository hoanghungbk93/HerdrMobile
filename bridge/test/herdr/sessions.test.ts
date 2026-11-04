import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listSessions, parseSessionList } from '../../src/herdr/sessions';

describe('parseSessionList', () => {
  test('maps sessions', () => {
    const json = JSON.stringify({
      sessions: [
        { default: true, name: 'default', running: true, session_dir: '/x', socket_path: '/x/herdr.sock' },
        { name: 'b', running: false, socket_path: '/y' },
      ],
    });
    const r = parseSessionList(json)!;
    expect(r).toHaveLength(2);
    expect(r.map((s) => s.running)).toEqual([true, false]);
    expect(r[0]!.socketPath).toBe('/x/herdr.sock');
    expect(r[0]!.name).toBe('default');
  });
  test('a real empty list is [], malformed output is null (a failure, not "no sessions")', () => {
    expect(parseSessionList('{"sessions":[]}')).toEqual([]);
    expect(parseSessionList('not json')).toBeNull();
    expect(parseSessionList('{}')).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('listSessions failures are null', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hm-fake-herdr-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  test('success with no sessions -> []', async () => {
    expect(await listSessions(5000, script('empty', 'echo \'{"sessions":[]}\''))).toEqual([]);
  });
  test('non-zero exit -> null', async () => {
    expect(await listSessions(5000, script('fail', 'echo \'{"sessions":[]}\'; exit 3'))).toBeNull();
  });
  test('missing binary -> null', async () => {
    expect(await listSessions(5000, path.join(dir, 'does-not-exist'))).toBeNull();
  });
  test('hung herdr is killed after the timeout -> null', async () => {
    const t0 = Date.now();
    expect(await listSessions(200, script('hang', 'exec sleep 30'))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
