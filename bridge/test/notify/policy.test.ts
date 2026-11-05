import { describe, expect, test } from 'bun:test';
import type { PushPrefs } from '@herdr-mobile/protocol';
import { NotifyPolicy } from '../../src/notify/policy';
import type { Transition } from '../../src/watch/statusTracker';

const t = (from: Transition['from'], to: Transition['to'], over: Partial<Transition> = {}): Transition => ({
  session: 's1', paneId: 'p1', from, to, agent: 'claude', workspaceId: 'w1', seq: 1, at: 0, ...over,
});
const prefs: PushPrefs = { private: true, mutedSessions: [], mutedPanes: [] };
const ctx = (over: Record<string, unknown> = {}) => ({
  agentLabel: 'claude', workspaceLabel: 'hana', prefs,
  foreground: { session: null, paneId: null }, lang: 'vi' as const, ...over,
});

describe('NotifyPolicy', () => {
  test('blocked gives approval message', () => {
    const m = new NotifyPolicy().decide(t('working', 'blocked'), ctx({ hash: 'h1' }), 0)!;
    expect(m.title).toBe('claude · hana');
    expect(m.body).toBe('Đang chờ duyệt');
    expect(m.categoryId).toBe('approval');
    expect(m.data).toEqual({ session: 's1', paneId: 'p1', kind: 'blocked', hash: 'h1' });
  });
  test('done and idle give "Đã xong"', () => {
    for (const to of ['done', 'idle'] as const) {
      const m = new NotifyPolicy().decide(t('working', to), ctx(), 0)!;
      expect(m.body).toBe('Đã xong');
      expect(m.categoryId).toBeUndefined();
      expect(m.data.kind).toBe('done');
    }
  });
  test('no message for idle->working or blocked->idle', () => {
    const p = new NotifyPolicy();
    expect(p.decide(t('idle', 'working'), ctx(), 0)).toBeNull();
    expect(p.decide(t('blocked', 'idle'), ctx(), 0)).toBeNull();
  });
  test('non-private appends detection line truncated to 120', () => {
    const np = { ...prefs, private: false };
    const m = new NotifyPolicy().decide(t('working', 'blocked'), ctx({ prefs: np, detectionFirstLine: 'Bash(pnpm test)' }), 0)!;
    expect(m.body).toBe('Đang chờ duyệt: Bash(pnpm test)');
    const long = new NotifyPolicy().decide(t('working', 'blocked'), ctx({ prefs: np, detectionFirstLine: 'x'.repeat(300) }), 0)!;
    expect(long.body).toBe('Đang chờ duyệt: ' + 'x'.repeat(120));
  });
  test('private never includes detection line', () => {
    const m = new NotifyPolicy().decide(t('working', 'blocked'), ctx({ detectionFirstLine: 'secret' }), 0)!;
    expect(m.body).toBe('Đang chờ duyệt');
  });
  test('muted pane and session', () => {
    const p = new NotifyPolicy();
    expect(p.decide(t('working', 'blocked'), ctx({ prefs: { ...prefs, mutedPanes: ['s1:p1'] } }), 0)).toBeNull();
    expect(p.decide(t('working', 'blocked'), ctx({ prefs: { ...prefs, mutedSessions: ['s1'] } }), 0)).toBeNull();
  });
  test('foreground suppresses same pane only', () => {
    const p = new NotifyPolicy();
    expect(p.decide(t('working', 'blocked'), ctx({ foreground: { session: 's1', paneId: 'p1' } }), 0)).toBeNull();
    expect(p.decide(t('working', 'blocked'), ctx({ foreground: { session: 's1', paneId: 'p2' } }), 0)).not.toBeNull();
  });
  test('coalesces done per pane, blocked bypasses', () => {
    const p = new NotifyPolicy();
    expect(p.decide(t('working', 'done'), ctx(), 1000)).not.toBeNull();
    expect(p.decide(t('working', 'idle'), ctx(), 2000)).toBeNull();
    expect(p.decide(t('working', 'done', { paneId: 'p2' }), ctx(), 2000)).not.toBeNull();
    expect(p.decide(t('blocked', 'blocked', { seq: 2 }), ctx(), 2100)).not.toBeNull();
    expect(p.decide(t('working', 'done'), ctx(), 4001)).not.toBeNull();
  });
  test('coalescing is per device when deviceId is given', () => {
    const p = new NotifyPolicy();
    expect(p.decide(t('working', 'done'), ctx({ deviceId: 'a' }), 1000)).not.toBeNull();
    expect(p.decide(t('working', 'done'), ctx({ deviceId: 'b' }), 1000)).not.toBeNull();
    expect(p.decide(t('working', 'done'), ctx({ deviceId: 'a' }), 2000)).toBeNull();
  });
});

describe('NotifyPolicy language', () => {
  test('English by default', () => {
    const p = new NotifyPolicy();
    expect(p.decide(t('working', 'blocked'), ctx({ lang: undefined }), 0)!.body).toBe('Waiting for approval');
    expect(p.decide(t('working', 'done'), ctx({ lang: 'en' }), 0)!.body).toBe('Done');
  });
});
