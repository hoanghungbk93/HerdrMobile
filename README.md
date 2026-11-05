**English** · [Tiếng Việt](README.vi.md)

# herdr-bridge

A bridge between [herdr](https://herdr.dev) on your computer and the Herdr Mobile phone app: watch terminals live, type commands, and approve permission requests right from the lock screen notification. The connection goes over Tailscale, so no ports need to be opened to the Internet.

**iPhone app:** [Get Herdr on the App Store](https://apps.apple.com/app/id6830550859)

## Installation

1. Install [Tailscale](https://tailscale.com/download) on your computer and iPhone, and sign in with the same account.
2. Install [herdr](https://herdr.dev) on your computer and run your agents (Claude Code, Codex…) inside herdr.
3. Install herdr-bridge on **the same machine that runs herdr** (commands below).
4. Run `herdr-bridge pair`, open the Herdr app ([App Store](https://apps.apple.com/app/id6830550859)) → Machines tab → "Add machine", and scan the QR code (or enter the 6-digit code).

### macOS / Linux

```sh
curl -fsSL https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.sh | sh
herdr-bridge pair
```

### Windows (herdr running directly on Windows)

In PowerShell:

```powershell
irm https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.ps1 | iex
herdr-bridge pair
```

Click **Yes** when Windows asks for permission to open port 7420 in the firewall. Nothing else needs admin rights.

### Windows + WSL (herdr running in WSL)

Tailscale is installed on Windows, the bridge is installed **inside WSL** (where herdr is). Leave WSL on the default networking mode (NAT); mirrored mode is not needed.

1. In WSL:

   ```sh
   curl -fsSL https://github.com/hoanghungbk93/HerdrMobile/releases/latest/download/install.sh | sh
   ```

   The installer makes the bridge listen on `0.0.0.0` and puts the Windows Tailscale address in the QR code. If it can't read that address, set it manually: `herdr-bridge config host 100.x.y.z`. The installer changes nothing on the Windows side.

2. On Windows, open PowerShell with **Run as Administrator** (one time only) and replace `100.x.y.z` with the Windows Tailscale IP:

   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=100.x.y.z listenport=7420 connectaddress=127.0.0.1 connectport=7420
   netsh advfirewall firewall add rule name=herdr-bridge dir=in action=allow protocol=TCP localport=7420 profile=any
   ```

   The first line forwards port 7420 from Tailscale into WSL (through WSL's localhost forwarding). The second line opens the firewall.

3. In WSL: `herdr-bridge pair`, then scan the QR code.

If you previously installed the Windows version of the bridge, remove it (`herdr-bridge uninstall` in PowerShell) so it doesn't compete for port 7420.

### Common commands

| Command | What it does |
| --- | --- |
| `herdr-bridge pair` | Shows a QR code / 6-digit code to pair a phone (expires after 5 minutes) |
| `herdr-bridge status` | Whether the bridge is running, the Tailscale address, number of paired devices |
| `herdr-bridge config` | View / change `listen` (`tailscale` or `all` = 0.0.0.0) and `host` (the address put in the QR code) |
| `herdr-bridge uninstall` | Removes autostart |

Web version: <https://hoanghungbk93.github.io/HerdrMobile/#install>

Command details, security and technical notes: [bridge/README.md](bridge/README.md).

## Development

Requires [Bun](https://bun.sh) and pnpm.

```
pnpm install
pnpm test
bun scripts/build-bridge.ts   # build binaries for 5 platforms into dist/
```

Components: `bridge/` (server + CLI), `packages/protocol/` (data types shared with the app).

## License

MIT, see [LICENSE](LICENSE).
