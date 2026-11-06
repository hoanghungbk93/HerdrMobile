#!/bin/sh
# herdr-bridge installer (macOS / Linux).
# Env: HERDR_BRIDGE_REPO (default hoanghungbk93/HerdrMobile), HERDR_BRIDGE_BASE_URL (override download dir),
#      HERDR_BRIDGE_PREFIX (install dir, default ~/.local/bin), HERDR_BRIDGE_SKIP_SERVICE=1 (skip autostart),
#      HERDR_BRIDGE_SKIP_WSL=1 (inside WSL: skip the NAT-mode setup), HERDR_BRIDGE_UPDATE=1 (set by `herdr-bridge update`).
set -eu
# Run as `curl ... | sh`: everything below is inside main() so the shell reads the whole script before running
# any of it (a command that reads stdin can no longer swallow the rest of the script).
main() {

REPO="${HERDR_BRIDGE_REPO:-hoanghungbk93/HerdrMobile}"
BASE_URL="${HERDR_BRIDGE_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"
PREFIX="${HERDR_BRIDGE_PREFIX:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "Unsupported OS: $(uname -s) (on Windows use install.ps1)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# --- WSL (NAT mode): the phone dials the Windows Tailscale address, which WSL cannot see. The bridge then
# listens on 0.0.0.0 and the user forwards the port on Windows (portproxy + firewall); we only print the commands.
is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; }
has_tailscale_ip() { ip -4 -o addr 2>/dev/null | grep -Eq 'inet 100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'; }
PS_EXE=""
# powershell.exe is often missing from PATH (wsl.conf appendWindowsPath=false): fall back to its full path.
find_powershell() {
  PS_EXE="$(command -v powershell.exe 2>/dev/null || true)"
  if [ -z "$PS_EXE" ]; then
    for p in /mnt/*/Windows/System32/WindowsPowerShell/v1.0/powershell.exe; do
      [ -f "$p" ] && { PS_EXE="$p"; break; }
    done
  fi
  [ -n "$PS_EXE" ] && "$PS_EXE" -NoProfile -NonInteractive -Command 'exit 0' </dev/null >/dev/null 2>&1
}
ps_run() { "$PS_EXE" -NoProfile -NonInteractive -Command "$1" </dev/null 2>/dev/null | tr -d '\r'; }
WSL_NAT=0
WIN_TS_IP=""

# Read-only: never changes Windows settings.
wsl_setup() {
  if has_tailscale_ip; then
    echo "WSL: Tailscale address found inside WSL, using normal mode."
    return 0
  fi
  WSL_NAT=1
  "$dest" config listen all </dev/null >/dev/null
  echo "WSL: the bridge will listen on 0.0.0.0 (port 7420)."
  if find_powershell; then
    WIN_TS_IP="$(ps_run "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { \$_.IPAddress -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' } | Select-Object -First 1).IPAddress")"
    winexe="$(ps_run '$p = Join-Path $env:LOCALAPPDATA "Programs\HerdrBridge\herdr-bridge.exe"; if (Test-Path $p) { $p }')"
    [ -n "$winexe" ] && echo "WSL: herdr-bridge is also installed on Windows ($winexe) and will compete for port 7420. Remove it in PowerShell: herdr-bridge uninstall"
  fi
  if [ -n "$WIN_TS_IP" ]; then
    "$dest" config host "$WIN_TS_IP" </dev/null >/dev/null
    echo "WSL: the QR code will use the Windows Tailscale address: $WIN_TS_IP"
  else
    echo "WSL: could not read the Windows Tailscale address. Set it by hand: herdr-bridge config host 100.x.y.z"
  fi
}

asset="herdr-bridge-bun-${os}-${arch}"
dest="$PREFIX/herdr-bridge"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "Downloading $BASE_URL/$asset"
curl -fSL --retry 2 -o "$tmp" "$BASE_URL/$asset" </dev/null
mkdir -p "$PREFIX"
chmod 755 "$tmp"
mv -f "$tmp" "$dest"
trap - EXIT
echo "Installed $dest"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "Note: $PREFIX is not in PATH." ;;
esac

if [ "$os" = linux ] && is_wsl && [ "${HERDR_BRIDGE_SKIP_WSL:-}" != "1" ]; then
  wsl_setup
fi

if [ "${HERDR_BRIDGE_SKIP_SERVICE:-}" = "1" ]; then
  echo "Skipping autostart (HERDR_BRIDGE_SKIP_SERVICE=1)."
elif ! "$dest" install </dev/null; then
  if is_wsl; then
    echo "WSL: could not register autostart (WSL needs systemd: add [boot] systemd=true to /etc/wsl.conf, then restart WSL)."
    echo "     For now run it by hand: herdr-bridge start"
  else
    exit 1
  fi
fi

if [ "$WSL_NAT" = 1 ]; then
  ip_show="${WIN_TS_IP:-<Windows Tailscale IP>}"
  echo
  echo "One more step on Windows (once): forward port 7420 from Tailscale into WSL. Open PowerShell (Run as Administrator):"
  echo "  netsh interface portproxy add v4tov4 listenaddress=$ip_show listenport=7420 connectaddress=127.0.0.1 connectport=7420"
  echo "  netsh advfirewall firewall add rule name=herdr-bridge dir=in action=allow protocol=TCP localport=7420 profile=any"
  echo "Then run: herdr-bridge pair"
elif [ "${HERDR_BRIDGE_UPDATE:-}" = "1" ]; then
  echo "Updated. Paired phones keep working; no need to pair again."
else
  echo "Done. Next: herdr-bridge pair"
fi
}
main "$@"
