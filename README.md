# herdr-bridge

Cầu nối giữa [herdr](https://herdr.dev) trên máy tính và app điện thoại Herdr Mobile: xem terminal trực tiếp, gõ lệnh, duyệt yêu cầu cấp quyền ngay từ thông báo trên màn khoá. Kết nối đi qua Tailscale, không cần mở cổng ra Internet.

## Cài đặt

1. Cài [Tailscale](https://tailscale.com/download) trên máy tính và iPhone, đăng nhập cùng một tài khoản.
2. Cài [herdr](https://herdr.dev) trên máy tính và chạy các agent (Claude Code, Codex…) trong herdr.
3. Cài herdr-bridge trên **đúng máy đang chạy herdr** (lệnh bên dưới).
4. Chạy `herdr-bridge pair`, mở app Herdr → tab Máy → "Thêm máy", quét mã QR (hoặc nhập mã 6 số).

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

Tailscale cài trên Windows, bridge cài **trong WSL** (cùng chỗ với herdr). Cần Windows 11 22H2 trở lên.

1. PowerShell thường: bật chế độ mạng mirrored để WSL dùng chung địa chỉ Tailscale của Windows, rồi khởi động lại WSL:

   ```powershell
   Add-Content -Encoding ascii "$env:USERPROFILE\.wslconfig" "`n[wsl2]`nnetworkingMode=mirrored"
   wsl --shutdown
   ```

2. PowerShell **Run as Administrator**: cho phép kết nối từ ngoài vào WSL:

   ```powershell
   Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
   ```

3. Mở WSL, kiểm tra có địa chỉ `100.x` của Tailscale, rồi cài bridge:

   ```sh
   ip -4 addr | grep 100.
   curl -fsSL https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.sh | sh
   herdr-bridge pair
   ```

Nếu trước đó đã cài bridge bản Windows thì gỡ đi (`herdr-bridge uninstall` trong PowerShell) để trả cổng 7420 cho bridge trong WSL.

### Lệnh hay dùng

| Lệnh | Việc |
| --- | --- |
| `herdr-bridge pair` | Hiện mã QR / mã 6 số để ghép điện thoại (hết hạn sau 5 phút) |
| `herdr-bridge status` | Bridge có chạy không, địa chỉ Tailscale, số thiết bị đã ghép |
| `herdr-bridge uninstall` | Gỡ tự khởi động |

Bản trên web: <https://hoanghungbk93.github.io/HerdrMobile/#install>

Chi tiết lệnh, bảo mật và ghi chú kỹ thuật: [bridge/README.md](bridge/README.md).

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
