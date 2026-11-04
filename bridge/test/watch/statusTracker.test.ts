import { describe, expect, test } from 'bun:test';
import { StatusTracker } from '../../src/watch/statusTracker';

const a = (status: any, seq?: number, extra: object = {}) => ({
  pane_id: 'p1',
  agent_status: status,
  state_change_seq: seq,
  workspace_id: 'w1',
  agent: 'claude',
  ...extra,
});

describe('StatusTracker', () => {
  test('first sight emits nothing', () => {
    const t = new StatusTracker('s');
    expect(t.apply([a('blocked', 3)], 1)).toEqual([]);
  });

  test('emits transition', () => {
    const t = new StatusTracker('s');
    t.apply([a('working', 1)], 1);
    const r = t.apply([a('blocked', 2)], 5);
    expect(r).toEqual([
      { session: 's', paneId: 'p1', from: 'working', to: 'blocked', agent: 'claude', workspaceId: 'w1', seq: 2, at: 5 },
    ]);
  });

  test('dedupes by seq', () => {
    const t = new StatusTracker('s');
    t.apply([a('working', 1)], 1);
    expect(t.apply([a('blocked', 2)], 2)).toHaveLength(1);
    expect(t.apply([a('blocked', 2)], 3)).toEqual([]);
  });

  test('same status new seq', () => {
    const t = new StatusTracker('s');
    t.apply([a('blocked', 4)], 1);
    const r = t.apply([a('blocked', 6)], 2);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ from: 'blocked', to: 'blocked', seq: 6 });
  });

  test('missing seq falls back to status change', () => {
    const t = new StatusTracker('s');
    t.apply([a('working')], 1);
    expect(t.apply([a('working')], 2)).toEqual([]);
    expect(t.apply([a('blocked')], 3)).toHaveLength(1);
    expect(t.apply([a('blocked')], 4)).toEqual([]);
  });

  test('remove forgets pane', () => {
    const t = new StatusTracker('s');
    t.apply([a('working', 1)], 1);
    t.remove('p1');
    expect(t.apply([a('blocked', 2)], 2)).toEqual([]);
  });

  test('uses display_agent fallback and null agent', () => {
    const t = new StatusTracker('s');
    t.apply([a('working', 1, { agent: null, display_agent: 'Claude' })], 1);
    const r = t.apply([a('idle', 2, { agent: null, display_agent: 'Claude' })], 2);
    expect(r[0]!.agent).toBe('Claude');
  });

  test('seq regression after herdr restart still emits', () => {
    const t = new StatusTracker('s');
    t.apply([a('working', 40)], 1);
    const r = t.apply([a('blocked', 2)], 2);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ from: 'working', to: 'blocked', seq: 2 });
  });
});
