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
  *) echo "Hệ điều hành không hỗ trợ: $(uname -s) (Windows dùng install.ps1)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "Kiến trúc không hỗ trợ: $(uname -m)" >&2; exit 1 ;;
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
    echo "WSL: thấy địa chỉ Tailscale ngay trong WSL, dùng chế độ bình thường."
    return 0
  fi
  WSL_NAT=1
  "$dest" config listen all </dev/null >/dev/null
  echo "WSL: bridge sẽ nghe trên 0.0.0.0 (cổng 7420)."
  if find_powershell; then
    WIN_TS_IP="$(ps_run "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { \$_.IPAddress -match '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.' } | Select-Object -First 1).IPAddress")"
    winexe="$(ps_run '$p = Join-Path $env:LOCALAPPDATA "Programs\HerdrBridge\herdr-bridge.exe"; if (Test-Path $p) { $p }')"
    [ -n "$winexe" ] && echo "WSL: Windows cũng đang cài herdr-bridge ($winexe); nó sẽ tranh cổng 7420. Gỡ trong PowerShell: herdr-bridge uninstall"
  fi
  if [ -n "$WIN_TS_IP" ]; then
    "$dest" config host "$WIN_TS_IP" </dev/null >/dev/null
    echo "WSL: mã QR sẽ dùng địa chỉ Tailscale của Windows: $WIN_TS_IP"
  else
    echo "WSL: chưa đọc được địa chỉ Tailscale của Windows. Đặt tay: herdr-bridge config host 100.x.y.z"
  fi
}

asset="herdr-bridge-bun-${os}-${arch}"
dest="$PREFIX/herdr-bridge"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "Tải $BASE_URL/$asset"
curl -fSL --retry 2 -o "$tmp" "$BASE_URL/$asset" </dev/null
mkdir -p "$PREFIX"
chmod 755 "$tmp"
mv -f "$tmp" "$dest"
trap - EXIT
echo "Đã cài $dest"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "Lưu ý: $PREFIX chưa có trong PATH." ;;
esac

if [ "$os" = linux ] && is_wsl && [ "${HERDR_BRIDGE_SKIP_WSL:-}" != "1" ]; then
  wsl_setup
fi

if [ "${HERDR_BRIDGE_SKIP_SERVICE:-}" = "1" ]; then
  echo "Bỏ qua đăng ký tự khởi động (HERDR_BRIDGE_SKIP_SERVICE=1)."
elif ! "$dest" install </dev/null; then
  if is_wsl; then
    echo "WSL: chưa đăng ký tự khởi động được (WSL cần bật systemd: thêm [boot] systemd=true vào /etc/wsl.conf rồi khởi động lại WSL)."
    echo "     Tạm thời chạy tay: herdr-bridge start"
  else
    exit 1
  fi
fi

if [ "$WSL_NAT" = 1 ]; then
  ip_show="${WIN_TS_IP:-<IP Tailscale của Windows>}"
  echo
  echo "Còn 1 bước trên Windows (làm 1 lần): chuyển cổng 7420 từ Tailscale vào WSL. Mở PowerShell (Run as Administrator):"
  echo "  netsh interface portproxy add v4tov4 listenaddress=$ip_show listenport=7420 connectaddress=127.0.0.1 connectport=7420"
  echo "  netsh advfirewall firewall add rule name=herdr-bridge dir=in action=allow protocol=TCP localport=7420 profile=any"
  echo "Xong thì chạy: herdr-bridge pair"
elif [ "${HERDR_BRIDGE_UPDATE:-}" = "1" ]; then
  echo "Đã cập nhật. Điện thoại đã ghép vẫn dùng tiếp, không cần pair lại."
else
  echo "Xong. Tiếp theo: herdr-bridge pair"
fi
}
main "$@"
