[English](README.md) · **Tiếng Việt**

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

`start`, `pair`, `devices`, `revoke <id>`, `status`, `install`, `uninstall`, `update [--force]`, `version` (thêm `--port N` nếu đổi cổng, mặc định 7420).
`update` cài bản mới nhất trên GitHub đè lên file hiện tại rồi khởi động lại; dữ liệu ghép được giữ. Bridge trước v0.4.4 chưa có `update`: chạy lại lệnh cài một lần.
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

## Màn hình trực tiếp

Với herdr 0.9.2 trở lên, bridge mở `herdr terminal session observe` (chỉ đọc, không đổi kích thước pane) cho mỗi pane đang có điện thoại xem. herdr báo màn hình đổi thì bridge đọc lại ngay (`pane.read`), pane đứng yên thì gần như không tốn gì. herdr cũ hơn, hoặc khi observer không chạy được, bridge quay về đọc 6 lần/giây và thử lại observer sau 30 giây.

## Cấu hình (`herdr-bridge config`)

Lưu trong `settings.json` ở thư mục dữ liệu.

- `config listen all`: nghe trên `0.0.0.0` thay vì 127.0.0.1 + địa chỉ Tailscale. Dùng khi địa chỉ Tailscale nằm ở máy khác (WSL chế độ NAT, Windows chuyển cổng vào). `config listen tailscale` để quay lại. Cần khởi động lại bridge (`herdr-bridge install`).
- `config host <ip>`: địa chỉ ghi vào mã QR (mặc định là IP Tailscale của máy). `config host auto` để bỏ.
- `relay` (sửa tay trong `settings.json`, hoặc biến môi trường `HERDR_RELAY_URL`): địa chỉ relay Live Activity, mặc định `https://herdr-relay.itmf.com.vn`; `"off"` để tắt.

## Live Activity (màn khoá / Dynamic Island, iOS 18+)

Khi có agent đang chạy hoặc chờ duyệt, bridge bật Live Activity trên điện thoại (kể cả khi app đang tắt), cập nhật khi trạng thái đổi, và kết thúc 3 phút sau khi mọi agent rảnh. Gửi APNs cần khoá của nhà phát triển app, nên bridge đi qua một relay nhỏ giữ khoá đó. Relay chỉ nhận trạng thái tóm tắt: số agent đang chạy / chờ, tên agent, tên tab (hoặc tên thư mục nếu tab chỉ có số), tên máy; không bao giờ nhận nội dung terminal. Điện thoại tắt thông báo cho máy nào thì máy đó cũng không bật Live Activity.

Các route `/local/*` vẫn chỉ nhận từ loopback và cần khoá trong `local.key`; thiết bị vẫn phải ghép bằng mã.

## Cuộn lịch sử từ điện thoại

Trên màn terminal, kéo xuống khi đang ở đầu trang (hoặc kéo lên/xuống khi đang cuộn) để xem lại lịch sử. Lần cuộn đầu, bridge mở `herdr terminal session control` ở khổ màn hình điện thoại: pane co lại cho chữ to và xuống dòng vừa điện thoại, máy tính cũng thấy pane ở khổ đó trong lúc cuộn, rồi bridge cuộn bằng `pane.scroll`. Khi điện thoại về cuối và để yên 15 giây, rời pane hoặc mất kết nối, bridge trả pane về đúng kích thước cũ (đọc từ tty của shell trong pane) rồi thả quyền điều khiển. Trên Windows chạy trực tiếp (không có tty), bridge chỉ cuộn, không đổi kích thước.
