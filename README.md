# herdr-bridge

Cầu nối giữa [herdr](https://herdr.dev) trên máy tính và app điện thoại Herdr Mobile: xem terminal trực tiếp, gõ lệnh, duyệt yêu cầu cấp quyền ngay từ thông báo trên màn khoá. Kết nối đi qua Tailscale, không cần mở cổng ra Internet.

## Cài đặt

1. Cài Tailscale trên máy tính và điện thoại, đăng nhập cùng tài khoản.
2. Cài bridge (cần có sẵn herdr):
   - macOS / Linux: `curl -fsSL https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.sh | sh`
   - Windows (PowerShell): `irm https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.ps1 | iex`
3. Chạy `herdr-bridge pair`, mở app Herdr trên điện thoại và quét mã QR.

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
