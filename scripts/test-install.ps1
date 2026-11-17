# Tests install.ps1 against a local fake release served over HTTP (no Pester).
# Cases: a good download installs the file; a tampered one fails and installs nothing;
# a release with a .gz copy installs from it; a tampered .gz installs nothing; with gh
# logged in, a passing attestation installs and a failing one installs nothing.
# A fake gh comes first on PATH, so a real, logged-in gh never runs here.
# One HTTP server serves every case, each release from its own folder (a server per case
# on the same port is slow to restart).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("overfull-test-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$asset = 'overfull-win-x64.exe'
$server = $null

function Sha([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Start-Server([string]$Dir, [int]$Port) {
  $py = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } else { 'python' }
  $p = Start-Process -FilePath $py -ArgumentList @('-m', 'http.server', "$Port", '--bind', '127.0.0.1') `
    -WorkingDirectory $Dir -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 50; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/good/SHA256SUMS" | Out-Null; return $p } catch { Start-Sleep -Milliseconds 200 }
  }
  Stop-Process -Id $p.Id -Force
  throw 'test-install: server did not start'
}

try {
  # Fake gh: FAKE_GH=out (not logged in, the default), ok (attestation passes) or fail.
  $fakeBin = Join-Path $work 'fakebin'
  New-Item -ItemType Directory -Path $fakeBin | Out-Null
  Set-Content -Encoding ascii -LiteralPath (Join-Path $fakeBin 'gh.cmd') -Value @(
    '@echo off',
    'echo %*>>"%FAKE_GH_LOG%"',
    'if "%1"=="auth" goto auth',
    'if "%1"=="attestation" goto att',
    'exit /b 1',
    ':auth',
    'if "%FAKE_GH%"=="out" exit /b 1',
    'exit /b 0',
    ':att',
    'if "%~3"=="--help" exit /b 0',
    'if "%FAKE_GH%"=="ok" exit /b 0',
    'exit /b 1'
  )
  $env:FAKE_GH_LOG = Join-Path $work 'gh.log'
  $env:FAKE_GH = 'out'
  $env:PATH = "$fakeBin;$env:PATH"

  # Any real executable works as the fake release file.
  $real = Join-Path $env:SystemRoot 'System32\hostname.exe'
  $srv = Join-Path $work 'srv'
  $good = Join-Path $srv 'good'
  $bad = Join-Path $srv 'bad'
  $gzDir = Join-Path $srv 'gz'
  New-Item -ItemType Directory -Path $good, $bad, $gzDir | Out-Null
  Copy-Item -LiteralPath $real -Destination (Join-Path $good $asset)
  "$(Sha (Join-Path $good $asset))  $asset" | Set-Content -Encoding ascii (Join-Path $good 'SHA256SUMS')
  Copy-Item (Join-Path $good 'SHA256SUMS') (Join-Path $bad 'SHA256SUMS')
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\whoami.exe') -Destination (Join-Path $bad $asset)

  $port = Get-Random -Minimum 20000 -Maximum 60000
  $url = "http://127.0.0.1:$port"
  $server = Start-Server $srv $port

  Write-Host 'case 1: good download installs the file'
  $env:OVERFULL_BASE_URL = "$url/good"
  $env:OVERFULL_INSTALL_DIR = Join-Path $work 'out1\bin'
  & (Join-Path $root 'install.ps1')
  $installed = Join-Path $env:OVERFULL_INSTALL_DIR 'overfull.exe'
  if (-not (Test-Path -LiteralPath $installed)) { throw 'FAIL: overfull.exe was not installed' }
  if ((Sha $installed) -ne (Sha (Join-Path $good $asset))) { throw 'FAIL: installed file differs from the release file' }

  Write-Host 'case 2: tampered download fails and installs nothing'
  $env:OVERFULL_BASE_URL = "$url/bad"
  $env:OVERFULL_INSTALL_DIR = Join-Path $work 'out2\bin'
  $failed = $false
  try { & (Join-Path $root 'install.ps1') } catch { $failed = $true; Write-Host "expected failure: $($_.Exception.Message)" }
  if (-not $failed) { throw 'FAIL: install.ps1 succeeded on a tampered download' }
  if (Test-Path -LiteralPath (Join-Path $env:OVERFULL_INSTALL_DIR 'overfull.exe')) { throw 'FAIL: a file was installed' }

  function Write-Gz([string]$From, [string]$To) {
    $in = [System.IO.File]::OpenRead($From)
    $out = [System.IO.File]::Create($To)
    $gz = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionMode]::Compress)
    try { $in.CopyTo($gz) } finally { $gz.Dispose(); $out.Dispose(); $in.Dispose() }
  }

  Write-Host 'case 3: a release with a .gz copy installs from it'
  Write-Gz $real (Join-Path $gzDir "$asset.gz")
  "$(Sha $real)  $asset`n$(Sha (Join-Path $gzDir "$asset.gz"))  $asset.gz" | Set-Content -Encoding ascii (Join-Path $gzDir 'SHA256SUMS')
  $env:OVERFULL_BASE_URL = "$url/gz"
  $env:OVERFULL_INSTALL_DIR = Join-Path $work 'out3\bin'
  & (Join-Path $root 'install.ps1')
  $installed = Join-Path $env:OVERFULL_INSTALL_DIR 'overfull.exe'
  if (-not (Test-Path -LiteralPath $installed)) { throw 'FAIL: overfull.exe was not installed from the .gz' }
  if ((Sha $installed) -ne (Sha $real)) { throw 'FAIL: the file unpacked from the .gz differs from the release file' }

  Write-Host 'case 4: a .gz that does not match its checksum installs nothing'
  Write-Gz (Join-Path $env:SystemRoot 'System32\whoami.exe') (Join-Path $gzDir "$asset.gz")
  $env:OVERFULL_INSTALL_DIR = Join-Path $work 'out4\bin'
  $failed = $false
  try { & (Join-Path $root 'install.ps1') } catch { $failed = $true; Write-Host "expected failure: $($_.Exception.Message)" }
  if (-not $failed) { throw 'FAIL: install.ps1 succeeded on a tampered .gz' }
  if (Test-Path -LiteralPath (Join-Path $env:OVERFULL_INSTALL_DIR 'overfull.exe')) { throw 'FAIL: a file was installed' }

  Write-Host 'case 5: gh logged in and the attestation verifies: installs'
  $env:OVERFULL_BASE_URL = "$url/good"
  $env:FAKE_GH = 'ok'
  $env:OVERFULL_INSTALL_DIR = Join-Path $work 'out5\bin'
  & (Join-Path $root 'install.ps1')
  if (-not (Test-Path -LiteralPath (Join-Path $env:OVERFULL_INSTALL_DIR 'overfull.exe'))) { throw 'FAIL: overfull.exe was not installed' }
  $calls = Get-Content -LiteralPath $env:FAKE_GH_LOG
  if (-not ($calls | Where-Object { $_ -like "attestation verify *$asset --repo amet13/overfull*" })) { throw 'FAIL: gh attestation verify was not run on the download' }

  Write-Host 'case 6: gh logged in and the attestation fails: installs nothing'
  $env:FAKE_GH = 'fail'
  $env:OVERFULL_INSTALL_DIR = Join-Path $work 'out6\bin'
  $failed = $false
  try { & (Join-Path $root 'install.ps1') } catch { $failed = $true; Write-Host "expected failure: $($_.Exception.Message)" }
  if (-not $failed) { throw 'FAIL: install.ps1 succeeded although the attestation failed' }
  if (Test-Path -LiteralPath (Join-Path $env:OVERFULL_INSTALL_DIR 'overfull.exe')) { throw 'FAIL: a file was installed' }
  $env:FAKE_GH = 'out'

  Write-Host 'test-install: ok'
} finally {
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force -LiteralPath $work -ErrorAction SilentlyContinue
}
# The fake release file (hostname.exe) exits 1 for `--version`, which would
# otherwise become this script's exit code. A real failure throws above.
exit 0
