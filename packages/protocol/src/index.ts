export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface PaneSummary {
  session: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  agent: string | null;
  label: string | null;
  status: AgentStatus;
  cwd: string | null;
  /** herdr pane-metadata revision (bumped by terminal-title changes); NOT content freshness. */
  revision: number;
}

export interface SessionSnapshot {
  session: string;
  online: boolean;
  protocol?: number;
  workspaces: { id: string; label: string }[];
  tabs: { id: string; workspaceId: string; label: string }[];
  panes: PaneSummary[];
}

export interface ApprovalInfo {
  session: string;
  paneId: string;
  hash: string;
  text: string;
  options: { key: string; label: string }[];
}

export type ServerMsg =
  | { t: 'snapshot'; machine: string; sessions: SessionSnapshot[] }
  | { t: 'session'; snapshot: SessionSnapshot }
  | { t: 'status'; session: string; paneId: string; status: AgentStatus; at: number }
  | { t: 'frame'; session: string; paneId: string; revision: number; text: string }
  | { t: 'error'; code: string; message: string };

export type ClientMsg =
  | { t: 'watch'; session: string; paneId: string }
  | { t: 'unwatch'; session: string; paneId: string }
  | { t: 'foreground'; session: string | null; paneId: string | null };

export interface PushPrefs {
  private: boolean;
  /** herdr session names (e.g. "default") whose pushes are muted. */
  mutedSessions: string[];
  /** Muted panes as "<session>:<paneId>", e.g. "default:w1:p1" (pane ids are only unique within a session). */
  mutedPanes: string[];
}

export const DEFAULT_PORT = 7420;
