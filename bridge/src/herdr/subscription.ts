import net from 'node:net';

import { ipcPath } from './client';

export type SubscriptionEnd = 'events_lost' | 'closed' | 'rejected';

/**
 * Opens a long-lived events.subscribe connection. Resolves once herdr
 * acknowledges (subscription_started); rejects if herdr refuses or is
 * unreachable. After that, `onEvent` gets each pushed event and `onEnd`
 * fires once when the stream ends for any reason other than close().
 */
export function subscribe(
  socketPath: string,
  subs: object[],
  onEvent: (e: any) => void,
  onEnd: (reason: SubscriptionEnd) => void,
  ackTimeoutMs = 10000,
): Promise<{ close(): void }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: ipcPath(socketPath) });
    socket.setEncoding('utf8');
    let buf = '';
    let acked = false;
    let ended = false;
    let manual = false;

    const ackTimer = setTimeout(() => end('closed'), ackTimeoutMs);
    const end = (reason: SubscriptionEnd) => {
      if (ended) return;
      ended = true;
      clearTimeout(ackTimer);
      socket.destroy();
      if (!acked) reject(new Error(`subscription ${reason}`));
      else if (!manual) onEnd(reason);
    };

    socket.on('connect', () =>
      socket.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: subs } }) + '\n'),
    );
    socket.on('error', () => end('closed'));
    socket.on('close', () => end('closed'));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (acked && line.includes('events_lost')) return end('events_lost');
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!acked && msg?.id === 'sub') {
          if (msg.error) return end('rejected');
          acked = true;
          clearTimeout(ackTimer);
          resolve({
            close() {
              manual = true;
              ended = true;
              socket.destroy();
            },
          });
          continue;
        }
        if (msg?.event) onEvent(msg);
      }
    });
  });
}
