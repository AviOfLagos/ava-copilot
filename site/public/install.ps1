<#
.SYNOPSIS
  Nex Copilot installer for Windows.

.DESCRIPTION
  *** UNTESTED. *** Written without a Windows machine available in the environment that built it
  (see docs/distribution.md's Windows section). It mirrors site/public/install.sh's macOS/Linux
  behavior and has been read over carefully, but nobody has actually run it on a real Windows box
  yet. Treat it as a draft: have someone run it for real (install, re-run, -Uninstall, a corrupted
  download, a missing latest.json) before telling anyone the command works, and fix whatever that
  turns up before this notice comes out.

  Downloads the latest release, verifies its SHA-256, and unpacks it to a stable per-user folder
  (no Administrator rights needed) so the browser's own "Load unpacked" always points at the same
  place - running this again later is how you update (it overwrites the files in that folder; you
  still click Reload on the extensions page, because Chrome does not watch an unpacked folder for
  changes).

  Does not implement an equivalent of install.sh's -WithVoices: the project's own model setup
  scripts (scripts/wake-word-setup.mjs, scripts/voice-models-setup.mjs) shell out to `tar` and
  `unzip`, and `unzip` is not a default part of Windows. Voice features stay available through the
  app's own in-app download instead.

.PARAMETER Dir
  Install into this folder instead of the default, "$env:LOCALAPPDATA\Nex Copilot\extension".

.PARAMETER Browser
  brave, chrome, edge or chromium - which browser's extensions page to try to open and whose name
  to print in the instructions. Default: auto-detect.

.PARAMETER Uninstall
  Remove the installed folder and exit.

.PARAMETER Version
  Print the latest available version (and the installed one, if any) and exit.

.PARAMETER Yes
  Don't ask for confirmation (used by -Uninstall).

.EXAMPLE
  irm https://nex-copilot-one.vercel.app/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Dir C:\Users\me\NexCopilot -Browser edge

.NOTES
  $env:NEX_COPILOT_BASE_URL overrides the download host, e.g. for testing against a local server:
    $env:NEX_COPILOT_BASE_URL = 'http://127.0.0.1:8080'; .\install.ps1 -Dir C:\Temp\test-install
  $env:AVI_COPILOT_BASE_URL is the old name, still accepted if NEX_COPILOT_BASE_URL is not set.
#>
[CmdletBinding()]
param(
  [string]$Dir,
  [ValidateSet('brave', 'chrome', 'edge', 'chromium')]
  [string]$Browser,
  [switch]$WithVoices, # accepted and rejected with a clear message - see the file header
  [switch]$Uninstall,
  [switch]$Version,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$BaseUrl = if ($env:NEX_COPILOT_BASE_URL) { $env:NEX_COPILOT_BASE_URL.TrimEnd('/') }
  elseif ($env:AVI_COPILOT_BASE_URL) { $env:AVI_COPILOT_BASE_URL.TrimEnd('/') }
  else { 'https://nex-copilot-one.vercel.app' }

function Write-Info($Message) { Write-Host $Message }
function Write-Ok($Message) { Write-Host "OK $Message" -ForegroundColor Green }
function Write-Warn($Message) { Write-Warning $Message }
# A file the installer puts in every folder it makes. An update or -Uninstall only ever replaces or removes a
# folder that is missing, empty, or has this file: never a folder of the user's own.
$Marker = 'nex-copilot-install.txt'
# The old marker name, from before the Avi Copilot -> Nex Copilot rename: still recognized, so an
# existing install made by the old installer can still be updated or uninstalled by this one.
$OldMarker = 'avi-copilot-install.txt'

function Test-Ours($Path) {
  if (-not (Test-Path $Path)) { return $true }
  if (-not (Test-Path $Path -PathType Container)) { return $false }
  if (Test-Path (Join-Path $Path $Marker)) { return $true }
  if (Test-Path (Join-Path $Path $OldMarker)) { return $true }
  return -not (Get-ChildItem -Force -Path $Path | Select-Object -First 1)
}

function Assert-Target($Path) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $homeFull = [System.IO.Path]::GetFullPath($HOME).TrimEnd('\', '/')
  if (-not $full -or $full -eq $homeFull -or ($homeFull + '\').StartsWith($full + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $full.Length -le 3) {
    Fail "Refusing to use $Path as the install folder: give it a folder of its own."
  }
  if (-not (Test-Ours $Path)) {
    Fail "$Path already exists and was not made by this installer, so it is left alone. Pick a new or empty folder with -Dir."
  }
}

function Fail($Message) {
  Write-Host "Error: $Message" -ForegroundColor Red
  exit 1
}

function Get-DefaultTargetDir {
  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is not set; pass -Dir explicitly.' }
  Join-Path $env:LOCALAPPDATA 'Nex Copilot\extension'
}

function Get-Sha256([string]$Path) {
  (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-InstalledVersion([string]$TargetDir) {
  $manifestPath = Join-Path $TargetDir 'manifest.json'
  if (-not (Test-Path $manifestPath)) { return $null }
  try { (Get-Content $manifestPath -Raw | ConvertFrom-Json).version } catch { $null }
}

function Find-Browsers {
  $candidates = @{
    brave    = @("$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
      "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
      "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe")
    chrome   = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")
    edge     = @("$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe")
    chromium = @("$env:ProgramFiles\Chromium\Application\chrome.exe")
  }
  $found = @{}
  foreach ($key in $candidates.Keys) {
    foreach ($exePath in $candidates[$key]) {
      if ($exePath -and (Test-Path $exePath)) { $found[$key] = $exePath; break }
    }
  }
  $found
}

function Open-ExtensionsPage([string]$Key, [hashtable]$Browsers) {
  $exePath = $Browsers[$Key]
  if (-not $exePath) { return $false }
  $url = if ($Key -eq 'chromium') { 'chrome://extensions' } else { "$Key://extensions" }
  try {
    Start-Process -FilePath $exePath -ArgumentList $url | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Invoke-Uninstall([string]$TargetDir) {
  if (-not (Test-Path $TargetDir)) {
    Write-Info "Nothing installed at $TargetDir."
    return
  }
  if (-not $Yes) {
    $reply = Read-Host "Remove $TargetDir`? [y/N]"
    if ($reply -notmatch '^(y|yes)$') {
      Write-Info 'Cancelled.'
      return
    }
  }
  Assert-Target $TargetDir
  Remove-Item -Path $TargetDir -Recurse -Force
  Write-Ok "Removed $TargetDir"
}

function Get-LatestRelease {
  $url = "$BaseUrl/download/latest.json"
  try {
    Invoke-RestMethod -Uri $url -UseBasicParsing
  } catch {
    Fail "Could not reach $url. Check your connection, or that NEX_COPILOT_BASE_URL/`$BaseUrl is right, and try again."
  }
}

# ---- main ---------------------------------------------------------------------------------

if ($WithVoices) {
  Fail '-WithVoices is not implemented on Windows (the model setup scripts need `unzip`, which Windows does not ship). Install voices from inside the app instead.'
}

if (-not $Dir) { $Dir = Get-DefaultTargetDir }

if ($Version) {
  $latest = Get-LatestRelease
  Write-Info "latest: $($latest.version) (released $($latest.date))"
  $installed = Get-InstalledVersion $Dir
  if ($installed) { Write-Info "installed: $installed ($Dir)" } else { Write-Info "installed: (none) - default location is $Dir" }
  exit 0
}

if ($Uninstall) {
  Invoke-Uninstall $Dir
  exit 0
}

Write-Info "Checking the latest release at $BaseUrl ..."
$latest = Get-LatestRelease
if (-not $latest.version -or -not $latest.file -or -not $latest.sha256) {
  Fail "$BaseUrl/download/latest.json is missing version, file or sha256 - this installer and the site may be out of sync."
}

$installedVersion = Get-InstalledVersion $Dir
if ($installedVersion) {
  Write-Info "Nex Copilot $installedVersion is installed at $Dir; updating to $($latest.version)..."
} else {
  Write-Info "Installing Nex Copilot $($latest.version) to $Dir..."
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("nex-copilot-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  $zipPath = Join-Path $work 'nex-copilot.zip'
  $zipUrl = "$BaseUrl/$($latest.file)"
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
  } catch {
    Fail "Could not download $zipUrl."
  }

  $gotSha256 = Get-Sha256 $zipPath
  if ($gotSha256 -ne $latest.sha256) {
    Fail "Downloaded file does not match the published checksum.`n  expected: $($latest.sha256)`n       got: $gotSha256`nThe download may be incomplete or corrupted - try again. If this keeps happening, something is wrong on the server side; please report it."
  }
  Write-Ok 'Checksum verified.'

  $extractDir = Join-Path $work 'extracted'
  try {
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  } catch {
    Fail 'The downloaded zip could not be unpacked (it may be corrupted). Try again.'
  }
  if (-not (Test-Path (Join-Path $extractDir 'manifest.json'))) {
    Fail "The downloaded release doesn't look like an extension (no manifest.json) - please report this."
  }

  Set-Content -Path (Join-Path $extractDir $Marker) -Value 'Installed by the Nex Copilot installer. Remove the folder with: install.ps1 -Uninstall'
  Assert-Target $Dir
  $parent = Split-Path -Parent $Dir
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  if (Test-Path $Dir) { Remove-Item -Path $Dir -Recurse -Force }
  Move-Item -Path $extractDir -Destination $Dir
  Write-Ok "Installed Nex Copilot $($latest.version) to $Dir"
} finally {
  Remove-Item -Path $work -Recurse -Force -ErrorAction SilentlyContinue
}

$browsers = Find-Browsers
$targetKey = if ($Browser) { $Browser } elseif ($browsers.Count -gt 0) { @($browsers.Keys)[0] } else { $null }

$copied = $false
try {
  Set-Clipboard -Value $Dir
  $copied = $true
} catch {
  # Set-Clipboard needs a desktop session; keep going without it
}

Write-Host ''
if ($targetKey) {
  Write-Info "Finish it in $($targetKey.Substring(0,1).ToUpper() + $targetKey.Substring(1)):"
} else {
  Write-Info 'Finish it in your browser (Brave, Chrome and Edge all work the same way):'
}
Write-Info '  1. Open the extensions page (chrome://extensions, brave://extensions or edge://extensions)'
Write-Info '  2. Turn on "Developer mode" (bottom-left or top-right toggle)'
if ($copied) {
  Write-Info '  3. Click "Load unpacked" and paste the folder path (already copied to your clipboard):'
} else {
  Write-Info '  3. Click "Load unpacked" and choose this folder:'
}
Write-Info "       $Dir"

if ($targetKey -and (Open-ExtensionsPage $targetKey $browsers)) {
  Write-Host ''
  Write-Info 'Opened the extensions page for you.'
}
