[English](README.md) · **Tiếng Việt**

# herdr-bridge

Cầu nối giữa [herdr](https://herdr.dev) trên máy tính và app điện thoại Herdr Mobile: xem terminal trực tiếp, gõ lệnh, duyệt yêu cầu cấp quyền ngay từ thông báo trên màn khoá. Kết nối đi qua Tailscale, không cần mở cổng ra Internet.

**App iPhone:** [Tải Herdr trên App Store](https://apps.apple.com/app/id6830550859)

## Cài đặt

1. Cài [Tailscale](https://tailscale.com/download) trên máy tính và iPhone, đăng nhập cùng một tài khoản.
2. Cài [herdr](https://herdr.dev) trên máy tính và chạy các agent (Claude Code, Codex…) trong herdr.
3. Cài herdr-bridge trên **đúng máy đang chạy herdr** (lệnh bên dưới).
4. Chạy `herdr-bridge pair`, mở app Herdr ([App Store](https://apps.apple.com/app/id6830550859)) → tab Máy → "Thêm máy", quét mã QR (hoặc nhập mã 6 số).

### macOS / Linux

```sh
curl -fsSL https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.sh | sh
herdr-bridge pair
```

### Windows (herdr chạy trực tiếp trên Windows)

Trong PowerShell:

```powershell
irm https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.ps1 | iex
herdr-bridge pair
```

Bấm **Yes** khi Windows hỏi quyền mở cổng 7420 trên tường lửa. Không cần quyền admin cho phần còn lại.

### Windows + WSL (herdr chạy trong WSL)

Tailscale cài trên Windows, bridge cài **trong WSL** (cùng chỗ với herdr). WSL để chế độ mạng mặc định (NAT), không cần mirrored.

1. Trong WSL:

   ```sh
   curl -fsSL https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.sh | sh
   ```

   Trình cài cho bridge nghe trên `0.0.0.0` và ghi địa chỉ Tailscale của Windows vào mã QR. Nếu không đọc được địa chỉ này, đặt tay: `herdr-bridge config host 100.x.y.z`. Trình cài không sửa gì bên Windows.

2. Trên Windows, mở PowerShell **Run as Administrator** (làm 1 lần), thay `100.x.y.z` bằng IP Tailscale của Windows:

   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=100.x.y.z listenport=7420 connectaddress=127.0.0.1 connectport=7420
   netsh advfirewall firewall add rule name=herdr-bridge dir=in action=allow protocol=TCP localport=7420 profile=any
   ```

   Dòng đầu chuyển cổng 7420 từ Tailscale vào WSL (qua localhost forwarding của WSL). Dòng sau mở tường lửa.

3. Trong WSL: `herdr-bridge pair`, quét mã QR.

Nếu đã cài bridge bản Windows thì gỡ đi (`herdr-bridge uninstall` trong PowerShell) để nó không tranh cổng 7420.

### Lệnh hay dùng

| Lệnh | Việc |
| --- | --- |
| `herdr-bridge pair` | Hiện mã QR / mã 6 số để ghép điện thoại (hết hạn sau 5 phút) |
| `herdr-bridge status` | Bridge có chạy không, địa chỉ Tailscale, số thiết bị đã ghép |
| `herdr-bridge config` | Xem / đổi `listen` (`tailscale` hoặc `all` = 0.0.0.0) và `host` (địa chỉ ghi vào mã QR) |
| `herdr-bridge update` | Cài bản mới nhất và khởi động lại bridge; điện thoại đã ghép vẫn dùng tiếp (`--force` để cài lại) |
| `herdr-bridge version` | In phiên bản đang cài |
| `herdr-bridge uninstall` | Gỡ tự khởi động |

Bản trên web: <https://hoanghungbk93.github.io/HerdrMobile/#install>

Chi tiết lệnh, bảo mật và ghi chú kỹ thuật: [bridge/README.vi.md](bridge/README.vi.md).

## Phát triển

Cần [Bun](https://bun.sh) và pnpm.

```
pnpm install
pnpm test
bun scripts/build-bridge.ts   # build binary cho 5 nền tảng vào dist/
```

Thành phần: `bridge/` (server + CLI), `packages/protocol/` (kiểu dữ liệu dùng chung với app).

## Giấy phép

MIT, xem [LICENSE](LICENSE).
