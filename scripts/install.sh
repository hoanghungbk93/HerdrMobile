#!/bin/sh
# herdr-bridge installer (macOS / Linux).
# Env: HERDR_BRIDGE_REPO (default hoanghungbk93/HerdrMobile), HERDR_BRIDGE_BASE_URL (override download dir),
#      HERDR_BRIDGE_PREFIX (install dir, default ~/.local/bin), HERDR_BRIDGE_SKIP_SERVICE=1 (skip autostart),
#      HERDR_BRIDGE_SKIP_WSL=1 (inside WSL: do not touch Windows settings).
set -eu

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

# --- WSL: the phone reaches the bridge through the Windows Tailscale address. WSL only sees that address
# in mirrored networking mode, and Hyper-V's firewall must let inbound connections into WSL.
is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; }
has_tailscale_ip() { ip -4 -o addr 2>/dev/null | grep -Eq 'inet 100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'; }
ps_run() { powershell.exe -NoProfile -NonInteractive -Command "$1" 2>/dev/null | tr -d '\r'; }
WSL_RESTART=0

wsl_setup() {
  command -v powershell.exe >/dev/null 2>&1 || { echo "WSL: không gọi được powershell.exe (interop tắt?), bỏ qua cấu hình Windows."; return 0; }

  # A bridge installed on Windows itself would hold port 7420 on the same address.
  winexe="$(ps_run '$p = Join-Path $env:LOCALAPPDATA "Programs\HerdrBridge\herdr-bridge.exe"; if (Test-Path $p) { $p }')"
  if [ -n "$winexe" ]; then
    echo "WSL: gỡ bridge bản Windows ($winexe) để nhường cổng 7420 cho bridge trong WSL."
    ps_run "& '$winexe' uninstall; Get-Process -Name herdr-bridge -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null || true
  fi

  if has_tailscale_ip; then
    echo "WSL: đã thấy địa chỉ Tailscale trong WSL (mirrored networking đang bật)."
  else
    build="$(ps_run '[Environment]::OSVersion.Version.Build')"
    if [ -n "$build" ] && [ "$build" -lt 22621 ] 2>/dev/null; then
      echo "WSL: Windows build $build chưa hỗ trợ mirrored networking (cần Windows 11 22H2+)."
      echo "     Điện thoại sẽ không kết nối được tới bridge trong WSL. Cài bridge bản Windows thay thế nếu herdr chạy trên Windows."
      return 0
    fi
    winhome="$(ps_run '$env:USERPROFILE')"
    cfg="$(wslpath -u "$winhome")/.wslconfig"
    if [ -f "$cfg" ] && tr -d '\r' <"$cfg" | grep -Eiq '^[[:space:]]*networkingMode[[:space:]]*=[[:space:]]*mirrored'; then
      echo "WSL: $cfg đã có networkingMode=mirrored nhưng WSL chưa khởi động lại."
    else
      cp "$cfg" "$cfg.bak" 2>/dev/null || true
      tmpcfg="$(mktemp)"
      if [ -f "$cfg" ] && tr -d '\r' <"$cfg" | grep -Eiq '^[[:space:]]*\[wsl2\]'; then
        # Replace an existing networkingMode in [wsl2], or add one right after the header.
        tr -d '\r' <"$cfg" | awk '
          BEGIN { done = 0 }
          /^[[:space:]]*\[/ { insec = tolower($0) ~ /^[[:space:]]*\[wsl2\]/; print; if (insec && !done) { print "networkingMode=mirrored"; done = 1 }; next }
          insec && tolower($0) ~ /^[[:space:]]*networkingmode[[:space:]]*=/ { next }
          { print }' >"$tmpcfg"
      else
        { [ -f "$cfg" ] && tr -d '\r' <"$cfg"; printf '\n[wsl2]\nnetworkingMode=mirrored\n'; } >"$tmpcfg"
      fi
      sed 's/$/\r/' "$tmpcfg" >"$cfg"
      rm -f "$tmpcfg"
      echo "WSL: đã bật networkingMode=mirrored trong $cfg (bản cũ: .wslconfig.bak)."
    fi
    WSL_RESTART=1
  fi

  hv="$(ps_run "(Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -ErrorAction SilentlyContinue).DefaultInboundAction")"
  if [ "$hv" != "Allow" ] && [ "$hv" != "1" ]; then
    echo "WSL: cho phép kết nối từ ngoài vào WSL (tường lửa Hyper-V): bấm Yes trên hộp thoại của Windows."
    inner="Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow"
    enc="$(printf '%s' "$inner" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)"
    ps_run "try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','$enc' } catch { }" >/dev/null || true
    hv="$(ps_run "(Get-NetFirewallHyperVVMSetting -PolicyStore ActiveStore -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -ErrorAction SilentlyContinue).DefaultInboundAction")"
    if [ "$hv" = "Allow" ] || [ "$hv" = "1" ]; then
      echo "WSL: đã mở tường lửa Hyper-V cho WSL."
    else
      echo "WSL: chưa mở được tường lửa Hyper-V. Trong PowerShell (Run as Administrator) chạy:"
      echo "     $inner"
    fi
  fi
}

asset="herdr-bridge-bun-${os}-${arch}"
dest="$PREFIX/herdr-bridge"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "Tải $BASE_URL/$asset"
curl -fSL --retry 2 -o "$tmp" "$BASE_URL/$asset"
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
elif ! "$dest" install; then
  if is_wsl; then
    echo "WSL: chưa đăng ký tự khởi động được (WSL cần bật systemd: thêm [boot] systemd=true vào /etc/wsl.conf rồi khởi động lại WSL)."
    echo "     Tạm thời chạy tay: herdr-bridge start"
  else
    exit 1
  fi
fi

if [ "$WSL_RESTART" = 1 ]; then
  echo
  echo "Còn 1 bước: khởi động lại WSL để nhận địa chỉ Tailscale. Việc này dừng mọi thứ đang chạy trong WSL (kể cả herdr)."
  echo "  1. Trong PowerShell trên Windows: wsl --shutdown"
  echo "  2. Mở lại WSL, chạy herdr, rồi: herdr-bridge pair"
else
  echo "Xong. Tiếp theo: herdr-bridge pair"
fi
