# herdr-bridge installer (Windows, PowerShell).
# Env: HERDR_BRIDGE_REPO, HERDR_BRIDGE_BASE_URL, HERDR_BRIDGE_PREFIX (default %LOCALAPPDATA%\Programs\HerdrBridge),
#      HERDR_BRIDGE_SKIP_SERVICE=1 (skip autostart).
$ErrorActionPreference = 'Stop'

$repo = if ($env:HERDR_BRIDGE_REPO) { $env:HERDR_BRIDGE_REPO } else { 'hoanghungbk93/HerdrMobile' }
$base = if ($env:HERDR_BRIDGE_BASE_URL) { $env:HERDR_BRIDGE_BASE_URL } else { "https://github.com/$repo/releases/latest/download" }
$prefix = if ($env:HERDR_BRIDGE_PREFIX) { $env:HERDR_BRIDGE_PREFIX } else { Join-Path $env:LOCALAPPDATA 'Programs\HerdrBridge' }

$asset = 'herdr-bridge-bun-windows-x64.exe'
$dest = Join-Path $prefix 'herdr-bridge.exe'
New-Item -ItemType Directory -Force -Path $prefix | Out-Null

# Download to a temp file first so a failed download never leaves a broken exe.
$tmp = Join-Path $prefix ("herdr-bridge.download-" + [guid]::NewGuid().ToString('N') + '.exe')
Write-Host "Tải $base/$asset"
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $tmp
  # Upgrade: the running bridge locks herdr-bridge.exe; stop the scheduled task before replacing it.
  # Fails when the task does not exist yet (first install): ignore. 'Continue' so stderr from a native
  # command is not turned into a terminating error by Windows PowerShell 5.1.
  try {
    $ErrorActionPreference = 'Continue'
    & schtasks.exe /End /TN HerdrBridge *> $null
  } catch { } finally { $ErrorActionPreference = 'Stop' }
  $global:LASTEXITCODE = 0
  # /End returns before the process is gone: retry the replace briefly, then fall back to renaming the
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
Write-Host "Đã cài $dest"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $prefix) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$prefix", 'User')
  Write-Host "Đã thêm $prefix vào PATH (mở lại terminal để có hiệu lực)."
}

if ($env:HERDR_BRIDGE_SKIP_SERVICE -eq '1') {
  Write-Host 'Bỏ qua đăng ký tự khởi động (HERDR_BRIDGE_SKIP_SERVICE=1).'
} else {
  & $dest install
}
Write-Host 'Xong. Tiếp theo: herdr-bridge pair'
