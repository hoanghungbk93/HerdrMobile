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
  /** Scroll position of a pane the phone scrolled; `phone`: the pane is resized to the phone's screen. */
  | { t: 'scroll'; session: string; paneId: string; offset: number; max: number; phone: boolean }
  | { t: 'error'; code: string; message: string };

export type ClientMsg =
  | { t: 'watch'; session: string; paneId: string }
  | { t: 'unwatch'; session: string; paneId: string }
  | { t: 'foreground'; session: string | null; paneId: string | null }
  /**
   * Scroll a pane into its history (`lines` > 0 = up, < 0 = down; `toBottom` jumps back). The first scroll resizes
   * the pane to `cols` x `rows` (the phone's screen) until the phone goes back to the bottom and stays idle.
   */
  | { t: 'scroll'; session: string; paneId: string; lines: number; cols: number; rows: number; toBottom?: boolean }
  /** Hold the pane at the phone's size (`on`) until turned off or the phone leaves; off = give it back now. */
  | { t: 'fit'; session: string; paneId: string; on: boolean; cols: number; rows: number }
  /** A tap on the pane at a zero-based cell; herdr delivers it only to apps that enabled mouse reporting. */
  | { t: 'click'; session: string; paneId: string; col: number; row: number };

export interface PushPrefs {
  private: boolean;
  /** herdr session names (e.g. "default") whose pushes are muted. */
  mutedSessions: string[];
  /** Muted panes as "<session>:<paneId>", e.g. "default:w1:p1" (pane ids are only unique within a session). */
  mutedPanes: string[];
}

export const DEFAULT_PORT = 7420;
