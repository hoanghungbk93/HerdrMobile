import type { AgentStatus } from '@herdr-mobile/protocol';

export interface Transition {
  session: string;
  paneId: string;
  from: AgentStatus | null;
  to: AgentStatus;
  agent: string | null;
  workspaceId: string;
  seq: number;
  at: number;
}

export interface AgentObservation {
  pane_id: string;
  agent_status: AgentStatus;
  state_change_seq?: number;
  agent?: string | null;
  display_agent?: string | null;
  workspace_id?: string;
}

/**
 * Turns repeated observations (subscription events and polls) into
 * deduplicated status transitions. First sight of a pane emits nothing.
 */
export class StatusTracker {
  private panes = new Map<string, { status: AgentStatus; seq: number | undefined }>();

  constructor(private session: string) {}

  apply(agents: AgentObservation[], now: number): Transition[] {
    const out: Transition[] = [];
    for (const a of agents) {
      const prev = this.panes.get(a.pane_id);
      this.panes.set(a.pane_id, { status: a.agent_status, seq: a.state_change_seq });
      if (!prev) continue;
      const changed =
        a.state_change_seq !== undefined && prev.seq !== undefined
          ? a.state_change_seq !== prev.seq
          : a.agent_status !== prev.status;
      if (!changed) continue;
      out.push({
        session: this.session,
        paneId: a.pane_id,
        from: prev.status,
        to: a.agent_status,
        agent: a.agent ?? a.display_agent ?? null,
        workspaceId: a.workspace_id ?? '',
        seq: a.state_change_seq ?? 0,
        at: now,
      });
    }
    return out;
  }

  knows(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  remove(paneId: string): void {
    this.panes.delete(paneId);
  }
}
