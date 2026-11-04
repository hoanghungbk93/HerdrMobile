export interface PushMessage {
  title: string;
  body: string;
  /** `deviceId` lets the phone tell which paired machine sent the push (session:paneId can collide across machines). */
  data: { session: string; paneId: string; kind: 'blocked' | 'done'; hash?: string; deviceId?: string };
  categoryId?: 'approval';
}

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100;

export async function sendExpoPush(
  tokens: string[],
  msg: PushMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<{ invalidTokens: string[]; failedBatches: number }> {
  const invalidTokens: string[] = [];
  let failedBatches = 0;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const payload = batch.map((to) => ({
      to,
      title: msg.title,
      body: msg.body,
      data: msg.data,
      sound: 'default',
      ...(msg.categoryId ? { categoryId: msg.categoryId } : {}),
      priority: 'high',
    }));
    try {
      const res = await fetchImpl(EXPO_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`expo push HTTP ${res.status}`);
      const json = (await res.json()) as { data?: unknown; errors?: unknown };
      if (!Array.isArray(json.data)) throw new Error('expo push: response has no data array');
      (json.data as { details?: { error?: string } }[]).forEach((ticket, idx) => {
        if (ticket?.details?.error === 'DeviceNotRegistered' && batch[idx]) invalidTokens.push(batch[idx]);
      });
    } catch (err) {
      failedBatches++;
      console.warn('[expoPush] batch failed:', err instanceof Error ? err.message : err);
    }
  }
  return { invalidTokens, failedBatches };
}
