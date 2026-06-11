# fe-ai-flow portable launcher (Windows)
# NOTE: ASCII-only on purpose -- Windows PowerShell 5.1 mis-decodes BOM-less UTF-8,
#       Chinese comments here could corrupt parsing on colleague machines.
#
# What it does, in order:
#   1. Query the latest GitHub release tag (fail-open: any network failure is
#      silently ignored and never blocks startup).
#   2. If server already running on the port:
#        - no newer version -> just open browser (daily fast path);
#        - newer version    -> stop the old server process (found by port PID)
#          so the update can proceed. Re-clicking the desktop icon is the
#          official "update" gesture -- no task manager needed.
#   3. Self-update: download zip and overwrite package files (data/ preserved).
#   4. Start the bundled node + standalone server (hidden window, logs to logs/).
#   5. Wait until the port is up, open browser, ensure a desktop shortcut exists.

$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $PSScriptRoot   # launcher/.. = package root
$Port = 8876
$Url = "http://localhost:$Port"
$Repo = "jianger666/fe-ai-flow"
$AssetName = "fe-ai-flow-win-x64.zip"

function Test-PortUp {
  try {
    $client = New-Object Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(500)
    $up = $ok -and $client.Connected
    $client.Close()
    return $up
  } catch { return $false }
}

function Ensure-Shortcut {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $lnk = Join-Path $desktop "fe-ai-flow.lnk"
  if (Test-Path $lnk) { return }
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
  $sc.Arguments = "`"$Root\launcher\launch.vbs`""
  $sc.WorkingDirectory = $Root
  $sc.IconLocation = (Join-Path $env:WINDIR "System32\shell32.dll") + ",220"
  $sc.Description = "fe-ai-flow"
  $sc.Save()
}

function Stop-ServerOnPort {
  # Kill only the process(es) LISTENING on our port -- never touches other node apps.
  $procIds = @()
  try {
    $procIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    # Fallback for systems without Get-NetTCPConnection: parse netstat output.
    $netstatLines = netstat -ano | Select-String "LISTENING" | Select-String ":$Port\s"
    foreach ($line in $netstatLines) {
      $candidateId = ($line.ToString().Trim() -split "\s+")[-1]
      if ($candidateId -match "^\d+$") { $procIds += [int]$candidateId }
    }
  }
  foreach ($procId in ($procIds | Select-Object -Unique)) {
    if ($procId -gt 0) { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue }
  }
}

# --- 1. query latest release (fail-open) ---
$updateAvailable = $false
$latest = $null
try {
  $localVersion = (Get-Content (Join-Path $Root "VERSION") -ErrorAction Stop | Select-Object -First 1).Trim()
  $latest = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest" -TimeoutSec 5
  if ($latest.tag_name -and $latest.tag_name -ne $localVersion) { $updateAvailable = $true }
} catch { }

# --- 2. already running? ---
if (Test-PortUp) {
  if (-not $updateAvailable) {
    Start-Process $Url
    Ensure-Shortcut
    exit
  }
  # Newer version available: stop the old server so files can be overwritten,
  # then fall through to update + restart below.
  Stop-ServerOnPort
  for ($i = 0; $i -lt 40; $i++) {
    if (-not (Test-PortUp)) { break }
    Start-Sleep -Milliseconds 250
  }
}

# --- 3. self-update (fail-open) ---
try {
  if ($updateAvailable -and $latest) {
    $asset = $latest.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
    if ($asset) {
      $zipPath = Join-Path $env:TEMP "fe-ai-flow-update.zip"
      $tmpDir = Join-Path $env:TEMP "fe-ai-flow-update"
      Invoke-WebRequest $asset.browser_download_url -OutFile $zipPath -TimeoutSec 600 -UseBasicParsing
      if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
      Expand-Archive $zipPath -DestinationPath $tmpDir -Force
      # zip has a top-level fe-ai-flow/ folder; tolerate flat layout too
      $srcDir = Join-Path $tmpDir "fe-ai-flow"
      if (-not (Test-Path $srcDir)) { $srcDir = $tmpDir }
      # overwrite package files; keep data/ (tasks, oauth) and logs/
      robocopy $srcDir $Root /E /XD data logs /NFL /NDL /NJH /NJS /NP | Out-Null
      Remove-Item $zipPath -Force
      Remove-Item $tmpDir -Recurse -Force
    }
  }
} catch { }

# --- 4. start server ---
$logsDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$env:PORT = "$Port"
$env:HOSTNAME = "127.0.0.1"
$env:NODE_ENV = "production"
$startArgs = @{
  FilePath = Join-Path $Root "node\node.exe"
  ArgumentList = "server.js"
  WorkingDirectory = $Root
  WindowStyle = "Hidden"
  RedirectStandardOutput = Join-Path $logsDir "server.log"
  RedirectStandardError = Join-Path $logsDir "server.err.log"
}
Start-Process @startArgs

# --- 5. wait ready -> open browser + shortcut ---
for ($i = 0; $i -lt 60; $i++) {
  if (Test-PortUp) { break }
  Start-Sleep -Milliseconds 500
}
Start-Process $Url
Ensure-Shortcut
