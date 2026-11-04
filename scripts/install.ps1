# herdr-bridge installer (Windows, PowerShell). No admin rights needed.
# Env: HERDR_BRIDGE_REPO, HERDR_BRIDGE_BASE_URL, HERDR_BRIDGE_PREFIX (default %LOCALAPPDATA%\Programs\HerdrBridge),
#      HERDR_BRIDGE_SKIP_SERVICE=1 (skip autostart), HERDR_BRIDGE_SKIP_FIREWALL=1 (no UAC prompt for the firewall rule).
# Messages are ASCII on purpose: "irm | iex" in Windows PowerShell 5.1 decodes this file as Latin-1.
$ErrorActionPreference = 'Stop'

$repo = if ($env:HERDR_BRIDGE_REPO) { $env:HERDR_BRIDGE_REPO } else { 'hoanghungbk93/HerdrMobile' }
$base = if ($env:HERDR_BRIDGE_BASE_URL) { $env:HERDR_BRIDGE_BASE_URL } else { "https://github.com/$repo/releases/latest/download" }
$prefix = if ($env:HERDR_BRIDGE_PREFIX) { $env:HERDR_BRIDGE_PREFIX } else { Join-Path $env:LOCALAPPDATA 'Programs\HerdrBridge' }

$asset = 'herdr-bridge-bun-windows-x64.exe'
$dest = Join-Path $prefix 'herdr-bridge.exe'
New-Item -ItemType Directory -Force -Path $prefix | Out-Null

# Download to a temp file first so a failed download never leaves a broken exe.
$tmp = Join-Path $prefix ("herdr-bridge.download-" + [guid]::NewGuid().ToString('N') + '.exe')
Write-Host "Downloading $base/$asset"
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $tmp
  # Upgrade: a running bridge locks herdr-bridge.exe. Stop the scheduled task (admin installs) and any
  # running instance (Run-key installs). Both fail harmlessly on a first install. 'Continue' so stderr from
  # a native command is not turned into a terminating error by Windows PowerShell 5.1.
  try {
    $ErrorActionPreference = 'Continue'
    & schtasks.exe /End /TN HerdrBridge *> $null
    Get-Process -Name herdr-bridge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  } catch { } finally { $ErrorActionPreference = 'Stop' }
  $global:LASTEXITCODE = 0
  # The process may take a moment to exit: retry the replace briefly, then fall back to renaming the
  # locked exe out of the way (Windows allows renaming a running exe, not overwriting it).
  $moved = $false
  for ($i = 0; $i -lt 10 -and -not $moved; $i++) {
    try { Move-Item -Force -Path $tmp -Destination $dest; $moved = $true } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $moved) {
    $old = "$dest.old"
    if (Test-Path $old) { Remove-Item -Force $old -ErrorAction SilentlyContinue }
    Move-Item -Force -Path $dest -Destination $old
    Move-Item -Force -Path $tmp -Destination $dest
  }
} finally {
  if (Test-Path $tmp) { Remove-Item -Force $tmp }
}
Write-Host "Installed $dest"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $prefix) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$prefix", 'User')
  Write-Host "Added $prefix to PATH (open a new terminal for it to take effect)."
}

if ($env:HERDR_BRIDGE_SKIP_SERVICE -eq '1') {
  Write-Host 'Skipping autostart (HERDR_BRIDGE_SKIP_SERVICE=1).'
} else {
  $ErrorActionPreference = 'Continue'
  & $dest install
  $ErrorActionPreference = 'Stop'
}

# The phone connects over Tailscale, which Windows Firewall blocks unless a rule allows the bridge port.
# Adding a rule needs admin: ask once through UAC.
if ($env:HERDR_BRIDGE_SKIP_FIREWALL -ne '1' -and -not (Get-NetFirewallRule -DisplayName 'herdr-bridge' -ErrorAction SilentlyContinue)) {
  Write-Host 'Allowing the bridge port (7420) through Windows Firewall: click Yes on the Windows prompt.'
  try {
    Start-Process -FilePath netsh.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(
      'advfirewall', 'firewall', 'add', 'rule', 'name=herdr-bridge', 'dir=in', 'action=allow', 'protocol=TCP', 'localport=7420', 'profile=any'
    )
  } catch { }
  if (Get-NetFirewallRule -DisplayName 'herdr-bridge' -ErrorAction SilentlyContinue) {
    Write-Host 'Firewall rule added.'
  } else {
    Write-Host 'No firewall rule: the phone will not be able to connect. In an admin PowerShell run:'
    Write-Host '  netsh advfirewall firewall add rule name=herdr-bridge dir=in action=allow protocol=TCP localport=7420 profile=any'
  }
}
Write-Host 'Done. Next: herdr-bridge pair'
