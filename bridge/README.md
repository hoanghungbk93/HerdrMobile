**English** · [Tiếng Việt](README.vi.md)

# herdr-bridge

A bridge between herdr on your computer and the phone app, over Tailscale.

## Installation

1. Install Tailscale on both the computer and the phone, and sign in with the same account.
2. Run the installer (herdr must already be installed):
   - macOS / Linux: `curl -fsSL https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.sh | sh`
     (or run `scripts/install.sh` from the repo). Installs to `~/.local/bin/herdr-bridge`.
   - Windows (PowerShell): `irm https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.ps1 | iex`
     (or run `scripts/install.ps1` from the repo). Installs to `%LOCALAPPDATA%\Programs\HerdrBridge\`.
   The installer registers autostart (launchd / systemd user / Task Scheduler). Run the installer again to upgrade:
   it stops the running bridge, replaces the files and starts the new version.
3. Run `herdr-bridge pair` to show the QR code.
4. In the app, scan the QR code (or enter the 6-digit code).

Installer environment variables: `HERDR_BRIDGE_REPO`, `HERDR_BRIDGE_BASE_URL`, `HERDR_BRIDGE_PREFIX` (install directory), `HERDR_BRIDGE_SKIP_SERVICE=1` (don't register autostart).

## Commands

`start`, `pair`, `devices`, `revoke <id>`, `status`, `install`, `uninstall` (add `--port N` if you change the port; default 7420).
`uninstall` only removes autostart and keeps the data in `~/.herdr-mobile/` (Windows: `%USERPROFILE%\.herdr-mobile\`).
When running in the background (no terminal), `start` logs to `bridge.log` in the data directory on every OS.
On Windows, the HerdrBridge task runs hidden via `conhost.exe --headless`; `install` also removes the 72h time limit and the battery conditions, and sets it to restart every minute on failure (PowerShell `Set-ScheduledTask`).

## Security

- The `/local/*` admin routes (used by `pair`, `devices`, `revoke`, `status`) only accept connections from 127.0.0.1 and require the admin key in `local.key` (regenerated on every `start`, mode 0600). Other users on the same machine can't read the key, so they can't pair a phone.
- The data directory and `uploads/` are created with mode 0700 (chmod is skipped on Windows; it relies on the default permissions of the user directory).

## Build

`bun scripts/build-bridge.ts` produces 5 files in `dist/` (`herdr-bridge-bun-<os>-<arch>`: windows-x64, darwin-arm64, darwin-x64, linux-x64, linux-arm64). CI attaches them to the release automatically when a `v*` tag is pushed.

## Technical notes

- herdr (0.9.3) closes the socket after every non-subscription response; use a new connection for each request.
- herdr on Windows: `socket_path` (`%APPDATA%\herdr\herdr.sock`) is only a marker file; herdr listens on the named pipe `\\.\pipe\<socket_path>` (interprocess crate, GenericNamespaced). The bridge switches to the pipe name automatically (`ipcPath`). CI runs integration tests against real herdr and tests installing via `install.ps1` + Task Scheduler on Windows.

## Live screen

With herdr 0.9.2 or later, the bridge opens `herdr terminal session observe` (read-only, doesn't resize the pane) for each pane a phone is watching. When herdr reports a screen change, the bridge re-reads it right away (`pane.read`); an idle pane costs almost nothing. With older herdr, or when the observer can't run, the bridge falls back to reading 6 times per second and retries the observer after 30 seconds.

## Configuration (`herdr-bridge config`)

Stored in `settings.json` in the data directory.

- `config listen all`: listen on `0.0.0.0` instead of 127.0.0.1 + the Tailscale address. Use this when the Tailscale address is on a different machine (WSL in NAT mode, with Windows forwarding the port in). `config listen tailscale` switches back. Requires restarting the bridge (`herdr-bridge install`).
- `config host <ip>`: the address put in the QR code (defaults to the machine's Tailscale IP). `config host auto` to clear it.
- `relay` (edit `settings.json` by hand, or use the `HERDR_RELAY_URL` environment variable): the Live Activity relay address, default `https://herdr-relay.itmf.com.vn`; `"off"` to disable.

## Live Activity (lock screen / Dynamic Island, iOS 18+)

When an agent is running or waiting for approval, the bridge starts a Live Activity on the phone (even when the app is closed), updates it when the status changes, and ends it 3 minutes after all agents are idle. Sending via APNs requires the app developer's key, so the bridge goes through a small relay that holds that key. The relay only receives a summary status: the number of agents running / waiting, agent names, tab names (or the directory name if the tab only has a number), and the machine name; it never receives terminal content. If the phone has notifications turned off for a machine, that machine won't start a Live Activity either.

The `/local/*` routes still only accept loopback connections and require the key in `local.key`; devices still have to pair with a code.

## Scrolling history from the phone

On the terminal screen, pull down while at the top (or drag up/down while scrolling) to view history. On the first scroll, the bridge opens `herdr terminal session control` at the phone's screen size: the pane shrinks so the text is large and wraps to fit the phone, the computer also sees the pane at that size while scrolling, and then the bridge scrolls with `pane.scroll`. When the phone is back at the bottom and left idle for 15 seconds, leaves the pane or disconnects, the bridge restores the pane to its original size (read from the tty of the shell in the pane) and releases control. On Windows running natively (no tty), the bridge only scrolls and doesn't resize.
