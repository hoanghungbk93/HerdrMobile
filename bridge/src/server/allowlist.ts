/** herdr methods the app may call through POST /rpc. Anything else is 403. */
export const RPC_ALLOWLIST: ReadonlySet<string> = new Set([
  'agent.list', 'agent.get', 'agent.prompt', 'agent.send_keys', 'agent.rename', 'agent.start',
  'pane.list', 'pane.get', 'pane.read', 'pane.send_text', 'pane.send_keys', 'pane.send_input',
  'pane.split', 'pane.close', 'pane.rename', 'pane.zoom', 'pane.layout',
  'tab.list', 'tab.create', 'tab.close', 'tab.rename',
  'workspace.list', 'workspace.create', 'workspace.close', 'workspace.rename',
  'session.snapshot',
]);
