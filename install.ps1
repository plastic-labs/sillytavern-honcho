#Requires -Version 5.0
# SillyTavern Honcho Plugin Installer (Windows)
# Installs both the client extension and server plugin.
#
# Usage:
#   From inside your SillyTavern directory (PowerShell):
#     irm https://raw.githubusercontent.com/plastic-labs/sillytavern-honcho/main/install.ps1 | iex
#
#   Or if you've already cloned the repo:
#     powershell -ExecutionPolicy Bypass -File .\path\to\sillytavern-honcho\install.ps1

$ST_DIR = if ($env:ST_DIR) { $env:ST_DIR } else { (Get-Location).Path }
$REPO_URL = "https://github.com/plastic-labs/sillytavern-honcho.git"
$EXT_DIR = Join-Path $ST_DIR "public\scripts\extensions\third-party\sillytavern-honcho"
$PLUGIN_DIR = Join-Path $ST_DIR "plugins\honcho-proxy"

if (-not (Test-Path (Join-Path $ST_DIR "server.js")) -or -not (Test-Path (Join-Path $ST_DIR "package.json"))) {
    Write-Host "[!] Could not find SillyTavern at: $ST_DIR"
    Write-Host "    Run this script from your SillyTavern directory, or set ST_DIR:"
    Write-Host '    $env:ST_DIR = "C:\path\to\SillyTavern"; .\install.ps1'
    exit 1
}

Write-Host "[*] Installing SillyTavern Honcho plugin..."
Write-Host "    ST directory: $ST_DIR"

# 1. Client extension
if (Test-Path $EXT_DIR) {
    Write-Host "[*] Client extension already exists, pulling latest..."
    $null = git -C $EXT_DIR pull --ff-only 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    (pull skipped -- not a git repo or has local changes)"
    }
} else {
    Write-Host "[*] Cloning client extension..."
    $null = git clone $REPO_URL $EXT_DIR 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[!] Failed to clone extension repo"
        exit 1
    }
}

# 2. Server plugin junction
if (Test-Path $PLUGIN_DIR) {
    Write-Host "[*] Server plugin already exists at $PLUGIN_DIR"
} else {
    Write-Host "[*] Creating directory junction for server plugin..."
    $pluginSource = Join-Path $EXT_DIR "plugin"
    $null = New-Item -ItemType Junction -Path $PLUGIN_DIR -Target $pluginSource -ErrorAction SilentlyContinue
    if (-not (Test-Path $PLUGIN_DIR)) {
        $pluginParent = Split-Path $PLUGIN_DIR -Parent
        Write-Host "[!] Failed to create junction at $PLUGIN_DIR."
        Write-Host "    Common causes:"
        Write-Host "    - Source ($pluginSource) and target ($PLUGIN_DIR) are on different drives (junctions can't cross volumes)"
        Write-Host "    - Source or target path is on a network share (junctions require local filesystem)"
        Write-Host "    - Current user lacks write permission on $pluginParent"
        Write-Host "      (run as Administrator only if SillyTavern is in a protected location like Program Files)"
        exit 1
    }
}

# 3. Install SDK dependencies
$npmCmdInfo = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmdInfo) {
    Write-Host "[!] npm was not found on PATH. Install Node.js, reopen PowerShell, and retry."
    exit 1
}
$npmCmd = $npmCmdInfo.Source
Write-Host "[*] Installing @honcho-ai/sdk..."
Push-Location $PLUGIN_DIR
$null = & $npmCmd install --silent 2>&1
$npmExit = if ($?) { $LASTEXITCODE } else { 1 }
Pop-Location
if ($npmExit -ne 0) {
    Write-Host "[!] npm install failed (exit $npmExit)."
    Write-Host "    Common causes: corporate proxy (set HTTPS_PROXY), SSL trust chain,"
    Write-Host "    AV locking node_modules, npm registry unreachable."
    Write-Host "    Re-run verbose to see the underlying error:"
    Write-Host "      cd `"$PLUGIN_DIR`"; npm install --verbose"
    exit 1
}

# 3.5 Bootstrap config.yaml — SillyTavern only creates it on first `npm start`.
$CONFIG = Join-Path $ST_DIR "config.yaml"
if (-not (Test-Path $CONFIG)) {
    Write-Host "[*] Generating config.yaml by starting SillyTavern briefly..."
    $bootLog = Join-Path $env:TEMP "silly-first-launch-$([System.IO.Path]::GetRandomFileName()).log"
    $bootErr = "$bootLog.err"
    $stProc = Start-Process -FilePath $npmCmd -ArgumentList "start" `
        -WorkingDirectory $ST_DIR -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $bootLog -RedirectStandardError $bootErr
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-Path $CONFIG) { break }
        if ($stProc.HasExited) {
            Write-Host "[!] SillyTavern bootstrap exited early (code $($stProc.ExitCode))."
            Write-Host "    Inspect $bootLog (stdout) and $bootErr (stderr) for details."
            exit 1
        }
        Start-Sleep -Seconds 1
    }
    if ($stProc -and -not $stProc.HasExited) {
        $null = & taskkill.exe /F /T /PID $stProc.Id 2>&1
    }
    if (-not (Test-Path $CONFIG)) {
        Write-Host "[!] config.yaml did not appear after 60s."
        Write-Host "    Inspect $bootLog (stdout) and $bootErr (stderr) for details."
        exit 1
    }
    Write-Host "[*] config.yaml created at $CONFIG"
}

# 4. Enable server plugins in config.yaml
$content = Get-Content -Path $CONFIG -Raw
if ($content -match "(?m)^enableServerPlugins:[ \t]*true") {
    Write-Host "[*] Server plugins already enabled in config.yaml"
} else {
    # [ \t]* (not \s*) — .NET's \s matches \r\n; sed in install.sh is line-scoped.
    $newContent = $content -replace "(?m)^enableServerPlugins:[ \t]*false", "enableServerPlugins: true"
    # WriteAllText writes UTF-8 without BOM; Set-Content on PS 5.1 would inject a BOM that some YAML parsers reject.
    [System.IO.File]::WriteAllText($CONFIG, $newContent)
    $content = Get-Content -Path $CONFIG -Raw
    if ($content -match "(?m)^enableServerPlugins:[ \t]*true") {
        Write-Host "[*] Enabled server plugins in config.yaml"
    } else {
        Write-Host "[!] Could not set enableServerPlugins: true in $CONFIG"
        Write-Host "    Add this line manually and restart SillyTavern:"
        Write-Host "      enableServerPlugins: true"
    }
}

# 5. Probe global Honcho config for a resolvable apiKey
$HONCHO_CONFIG = Join-Path $HOME ".honcho\config.json"
if (Test-Path $HONCHO_CONFIG) {
    $resolvableKey = $false
    $parseFailed = $false
    try {
        $cfg = Get-Content -Path $HONCHO_CONFIG -Raw | ConvertFrom-Json
        $hostKey = $cfg.hosts.sillytavern.apiKey
        $rootKey = $cfg.apiKey
        if ($hostKey -or $rootKey) { $resolvableKey = $true }
    } catch {
        $parseFailed = $true
    }
    if ($parseFailed) {
        Write-Host "[!] Found malformed Honcho config at $HONCHO_CONFIG"
        Write-Host "    Fix or remove it before re-running, or the plugin may recreate a minimal config and wipe existing settings."
        exit 1
    } elseif ($resolvableKey) {
        Write-Host "[*] Found global Honcho config with resolvable apiKey at $HONCHO_CONFIG"
        Write-Host "    API key, workspace, and peer name will be auto-populated."
    } else {
        Write-Host "[*] Found $HONCHO_CONFIG but no resolvable apiKey."
        Write-Host "    (plugin checks hosts.sillytavern.apiKey, then root apiKey.)"
        Write-Host "    Enter your Honcho API key via the Extensions panel after restart."
    }
} else {
    Write-Host ""
    Write-Host "[i] No global Honcho config found at $HONCHO_CONFIG"
    Write-Host "    You can configure Honcho in the SillyTavern Extensions panel,"
    Write-Host "    or create ~/.honcho/config.json with:"
    Write-Host '    {'
    Write-Host '      "apiKey": "your-honcho-api-key",'
    Write-Host '      "peerName": "your-name",'
    Write-Host '      "workspace": "sillytavern",'
    Write-Host '      "enabled": true'
    Write-Host '    }'
}

Write-Host ""
Write-Host "[*] Done! Restart SillyTavern and enable Honcho in Extensions."
