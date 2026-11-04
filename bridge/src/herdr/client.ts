import net from 'node:net';
import type { HerdrResponse } from './types';

export class HerdrError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HerdrError';
  }
}

interface Inflight {
  socket: net.Socket;
  fail: (e: HerdrError) => void;
}

/**
 * herdr closes the socket after every non-subscription response, so each
 * request uses its own short-lived connection.
 */
/**
 * Address to dial for a herdr `socket_path`. On Windows herdr writes only a marker file at
 * socket_path and listens on a named pipe named after that path (interprocess
 * GenericNamespaced), i.e. `\\.\pipe\<socket_path>`.
 */
export function ipcPath(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || socketPath.startsWith('\\\\.\\pipe\\')) return socketPath;
  return `\\\\.\\pipe\\${socketPath}`;
}

export class HerdrClient {
  private counter = 0;
  private closed = false;
  private inflight = new Set<Inflight>();
  private closeListeners: (() => void)[] = [];

  private constructor(private socketPath: string) {}

  /** Verifies reachability with one ping on a fresh connection. */
  static async connect(socketPath: string): Promise<HerdrClient> {
    const client = new HerdrClient(socketPath);
    await client.request('ping');
    return client;
  }

  request<T = unknown>(method: string, params: object = {}, timeoutMs = 10000): Promise<T> {
    if (this.closed) return Promise.reject(new HerdrError('closed', 'client closed'));
    const id = `b${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const socket = net.connect({ path: ipcPath(this.socketPath) });
      socket.setEncoding('utf8');
      let buf = '';
      let done = false;
      const entry: Inflight = { socket, fail: (e) => finish(() => reject(e)) };
      const timer = setTimeout(
        () => entry.fail(new HerdrError('timeout', `${method} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.inflight.delete(entry);
        socket.destroy();
        settle();
      };
      this.inflight.add(entry);

      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('error', (e) => entry.fail(new HerdrError('closed', `connection error: ${e.message}`)));
      socket.on('close', () => entry.fail(new HerdrError('closed', 'connection closed before response')));
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg: HerdrResponse;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg?.id !== id) continue; // event push or stray line
          if (msg.error) {
            const err = new HerdrError(msg.error.code, msg.error.message);
            finish(() => reject(err));
          } else {
            finish(() => resolve(msg.result as T));
          }
          return;
        }
      });
    });
  }

  on(event: 'close', cb: () => void): void {
    if (event === 'close') this.closeListeners.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const e of [...this.inflight]) e.fail(new HerdrError('closed', 'client closed'));
    for (const cb of this.closeListeners) cb();
  }
}
