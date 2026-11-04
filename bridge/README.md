# herdr-bridge

Cầu nối giữa herdr trên máy tính và app điện thoại, đi qua Tailscale.

## Cài đặt

1. Cài Tailscale trên cả máy tính và điện thoại, đăng nhập cùng một tài khoản.
2. Chạy installer (cần có sẵn herdr):
   - macOS / Linux: `curl -fsSL https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.sh | sh`
     (hoặc chạy `scripts/install.sh` trong repo). Cài vào `~/.local/bin/herdr-bridge`.
   - Windows (PowerShell): `irm https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.ps1 | iex`
     (hoặc chạy `scripts/install.ps1` trong repo). Cài vào `%LOCALAPPDATA%\Programs\HerdrBridge\`.
   Installer tự đăng ký tự khởi động (launchd / systemd user / Task Scheduler). Chạy lại installer để nâng cấp:
   nó dừng bridge đang chạy, thay file rồi khởi động lại bản mới.
3. Chạy `herdr-bridge pair` để hiện mã QR.
4. Trong app, quét mã QR (hoặc nhập mã 6 số).

Biến môi trường của installer: `HERDR_BRIDGE_REPO`, `HERDR_BRIDGE_BASE_URL`, `HERDR_BRIDGE_PREFIX` (thư mục cài), `HERDR_BRIDGE_SKIP_SERVICE=1` (không đăng ký tự khởi động).

## Lệnh

`start`, `pair`, `devices`, `revoke <id>`, `status`, `install`, `uninstall` (thêm `--port N` nếu đổi cổng, mặc định 7420).
`uninstall` chỉ gỡ tự khởi động, giữ nguyên dữ liệu trong `~/.herdr-mobile/` (Windows: `%USERPROFILE%\.herdr-mobile\`).
Khi chạy nền (không có terminal), `start` ghi log vào `bridge.log` trong thư mục dữ liệu trên mọi hệ điều hành.
Trên Windows, tác vụ HerdrBridge chạy ẩn qua `conhost.exe --headless`; `install` còn gỡ giới hạn thời gian 72h và điều kiện pin, và đặt tự khởi động lại mỗi phút nếu lỗi (PowerShell `Set-ScheduledTask`).

## Bảo mật

- Các route quản trị `/local/*` (dùng bởi `pair`, `devices`, `revoke`, `status`) chỉ nhận kết nối từ 127.0.0.1 và cần khoá quản trị trong `local.key` (tạo mới mỗi lần `start`, quyền 0600). User khác trên cùng máy không đọc được khoá nên không ghép được điện thoại.
- Thư mục dữ liệu và `uploads/` được tạo với quyền 0700 (trên Windows bỏ qua chmod; dựa vào quyền mặc định của thư mục user).

## Build

`bun scripts/build-bridge.ts` tạo 5 file trong `dist/` (`herdr-bridge-bun-<os>-<arch>`: windows-x64, darwin-arm64, darwin-x64, linux-x64, linux-arm64). CI tự đính kèm vào release khi push tag `v*`.

## Ghi chú kỹ thuật

- herdr (0.9.3) đóng socket sau mỗi phản hồi không phải subscription; dùng kết nối mới cho mỗi request.
- herdr trên Windows: `socket_path` (`%APPDATA%\herdr\herdr.sock`) chỉ là file đánh dấu; herdr lắng nghe named pipe `\\.\pipe\<socket_path>` (crate interprocess, GenericNamespaced). Bridge tự đổi sang tên pipe (`ipcPath`). CI chạy test tích hợp với herdr thật và thử cài qua `install.ps1` + Task Scheduler trên Windows.
