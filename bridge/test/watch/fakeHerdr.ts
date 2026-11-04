import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface FakeHerdr {
  socketPath: string;
  requests: string[];
  topoSockets: net.Socket[];
  /** Status subscription (B) connections, newest last. */
  statusSockets: net.Socket[];
  /** Mutable state served by session.snapshot / agent.list. */
  state: { panes: any[]; agents: any[] };
  /** Pushes an event on the newest topology subscription. */
  emitTopo(event: string, data?: object): void;
  /** Pushes an event on the newest status subscription. */
  emitStatus(event: string, data?: object): void;
  close(): void;
}

/**
 * Minimal NDJSON herdr stand-in. Non-subscription requests are answered and the
 * socket closed (like herdr 0.9.3). `subAck(subs)` returns ms to wait before acking
 * a subscribe, or null to never ack.
 */
export function startFakeHerdr(subAck: (subs: any[]) => number | null = () => 0): FakeHerdr {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-herdr-'));
  const socketPath = path.join(dir, 'h.sock');
  const requests: string[] = [];
  const topoSockets: net.Socket[] = [];
  const statusSockets: net.Socket[] = [];
  const sockets = new Set<net.Socket>();
  const state = {
    panes: [{ pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', agent_status: 'idle', revision: 0 }] as any[],
    agents: [] as any[],
  };
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        requests.push(msg.method);
        const reply = (result: object) => sock.write(JSON.stringify({ id: msg.id, result }) + '\n');
        if (msg.method === 'events.subscribe') {
          const subs = msg.params.subscriptions;
          if (subs[0]?.type === 'pane.created') topoSockets.push(sock);
          if (subs[0]?.type === 'pane.agent_status_changed') statusSockets.push(sock);
          const delay = subAck(subs);
          if (delay !== null) setTimeout(() => reply({ type: 'subscription_started' }), delay);
          continue;
        }
        if (msg.method === 'ping') reply({ type: 'pong', protocol: 22 });
        else if (msg.method === 'session.snapshot')
          reply({
            type: 'session_snapshot',
            snapshot: { protocol: 22, workspaces: [], tabs: [], panes: state.panes, agents: state.agents },
          });
        else if (msg.method === 'agent.list') reply({ type: 'agent_list', agents: state.agents });
        else reply({});
        sock.end();
      }
    });
  });
  server.listen(socketPath);
  return {
    socketPath,
    requests,
    topoSockets,
    statusSockets,
    state,
    emitTopo(event, data = {}) {
      topoSockets.at(-1)?.write(JSON.stringify({ event, data }) + '\n');
    },
    emitStatus(event, data = {}) {
      statusSockets.at(-1)?.write(JSON.stringify({ event, data }) + '\n');
    },
    close() {
      for (const s of sockets) s.destroy();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
