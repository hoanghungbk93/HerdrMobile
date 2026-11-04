#!/bin/sh
# herdr-bridge installer (macOS / Linux).
# Env: HERDR_BRIDGE_REPO (default hoanghungbk93/HerdrMobile), HERDR_BRIDGE_BASE_URL (override download dir),
#      HERDR_BRIDGE_PREFIX (install dir, default ~/.local/bin), HERDR_BRIDGE_SKIP_SERVICE=1 (skip autostart).
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

if [ "${HERDR_BRIDGE_SKIP_SERVICE:-}" = "1" ]; then
  echo "Bỏ qua đăng ký tự khởi động (HERDR_BRIDGE_SKIP_SERVICE=1)."
else
  "$dest" install
fi
echo "Xong. Tiếp theo: herdr-bridge pair"
