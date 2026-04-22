#Requires -Version 5.0
# SillyTavern Honcho Plugin Installer (Windows)
# Installs both the client extension and server plugin.
#
# Requires PowerShell 5.0+ (ships with Windows 10; WMF 5.0 for Win 7/8.1).
# The #Requires directive above fails early rather than letting the
# New-Item -ItemType Junction call at line 60 produce a cryptic error
# on older PowerShell.
#
# Usage:
#   From inside your SillyTavern directory (PowerShell):
#     irm https://raw.githubusercontent.com/plastic-labs/sillytavern-honcho/main/install.ps1 | iex
#
#   Or if you've already cloned the repo:
#     powershell -ExecutionPolicy Bypass -File .\path\to\sillytavern-honcho\install.ps1
#     # (or, from inside SillyTavern): cd SillyTavern; .\path\to\sillytavern-honcho\install.ps1

$ST_DIR = if ($env:ST_DIR) { $env:ST_DIR } else { (Get-Location).Path }
$REPO_URL = "https://github.com/plastic-labs/sillytavern-honcho.git"
$EXT_DIR = Join-Path $ST_DIR "public\scripts\extensions\third-party\sillytavern-honcho"
$PLUGIN_DIR = Join-Path $ST_DIR "plugins\honcho-proxy"

# Verify we're in a SillyTavern directory.
# Error if EITHER marker file is missing (match install.sh semantics — both are
# required to proceed, not just one).
if (-not (Test-Path (Join-Path $ST_DIR "server.js")) -or -not (Test-Path (Join-Path $ST_DIR "package.json"))) {
    Write-Host "[!] Could not find SillyTavern at: $ST_DIR"
    Write-Host "    Run this script from your SillyTavern directory, or set ST_DIR:"
    Write-Host '    $env:ST_DIR = "C:\path\to\SillyTavern"; .\install.ps1'
    exit 1
}

Write-Host "[*] Installing SillyTavern Honcho plugin..."
Write-Host "    ST directory: $ST_DIR"

# 1. Install client extension
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

# 2. Set up server plugin (directory junction from extension's plugin/ dir).
# Note: creating a junction does NOT require Administrator or Developer Mode —
# those are symlink requirements. Junctions are a legacy NTFS feature
# available to any user with write access to the target parent. Typical
# junction failures are cross-volume, UNC, or permission-related (see error
# message below).
if (Test-Path $PLUGIN_DIR) {
    Write-Host "[*] Server plugin already exists at $PLUGIN_DIR"
} else {
    Write-Host "[*] Creating directory junction for server plugin..."
    $pluginSource = Join-Path $EXT_DIR "plugin"
    # New-Item -ItemType Junction is native PS 5.0+ and takes PowerShell string
    # parameters directly — no cmd.exe layer, no backtick-escape quoting, no
    # path-with-spaces parsing ambiguity. Equivalent NTFS-level operation to
    # `mklink /J`. -ErrorAction SilentlyContinue so we fall through to our own
    # failure-mode diagnostic below instead of PS's stack trace.
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

# 3. Install SDK dependencies.
# install.sh gets implicit guard against silent npm failures via `set -euo pipefail`;
# PowerShell has no equivalent default, so check $LASTEXITCODE explicitly.
# Without this, a proxy/SSL/AV/registry failure here would cascade into the
# bootstrap step below, surfacing as "config.yaml did not appear" — which would
# misdirect the user to the wrong failure mode.
Write-Host "[*] Installing @honcho-ai/sdk..."
Push-Location $PLUGIN_DIR
$null = npm install --silent 2>&1
$npmExit = $LASTEXITCODE
Pop-Location
if ($npmExit -ne 0) {
    Write-Host "[!] npm install failed (exit $npmExit)."
    Write-Host "    Common causes: corporate proxy (set HTTPS_PROXY), SSL trust chain,"
    Write-Host "    AV locking node_modules, npm registry unreachable."
    Write-Host "    Re-run verbose to see the underlying error:"
    Write-Host "      cd `"$PLUGIN_DIR`"; npm install --verbose"
    exit 1
}

# 3.5 Ensure config.yaml exists. SillyTavern creates it on first `npm start`,
#     not on `npm install`. Without this step, the enable-server-plugins check
#     below runs against a missing file (silent on first-run users — BUG-4) and
#     enableServerPlugins never gets flipped, so the plugin fails to load on
#     first real `npm start`.
$CONFIG = Join-Path $ST_DIR "config.yaml"
if (-not (Test-Path $CONFIG)) {
    Write-Host "[*] Generating config.yaml by starting SillyTavern briefly..."
    $bootLog = Join-Path $env:TEMP "silly-first-launch-$([System.IO.Path]::GetRandomFileName()).log"
    $bootErr = "$bootLog.err"
    # Start npm.cmd directly with Start-Process. Redirection uses the built-in
    # -RedirectStandard* parameters, which .NET wires up via CreateProcess
    # inherited handles — so node.exe (the grandchild) inherits cmd.exe's
    # redirected stdout/stderr and its output IS captured. This avoids the
    # earlier cmd-level-redirection approach, which had a path-with-spaces
    # quoting bug: Start-Process's ArgumentList re-quoted the cmd string on
    # top of already-escaped $bootLog quotes, and cmd.exe's /c parsing of
    # nested quotes truncated the redirect target at the first space (bites
    # OneDrive-redirected $env:TEMP like "C:\Users\First Last\..."). Two
    # separate log files is mildly annoying but quote-safe.
    $stProc = Start-Process -FilePath "npm.cmd" -ArgumentList "start" `
        -WorkingDirectory $ST_DIR -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $bootLog -RedirectStandardError $bootErr
    # Poll up to 60s for config.yaml to appear — but bail early if the
    # bootstrap process died. Without the HasExited check a fast failure
    # (port 8000 in use, missing node_modules, incompatible node version)
    # makes us wait 60s polling a dead process before erroring.
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-Path $CONFIG) { break }
        if ($stProc.HasExited) {
            Write-Host "[!] SillyTavern bootstrap exited early (code $($stProc.ExitCode))."
            Write-Host "    Inspect $bootLog (stdout) and $bootErr (stderr) for details."
            exit 1
        }
        Start-Sleep -Seconds 1
    }
    # Kill the whole process tree (npm + node child). Null-guarded in case
    # Start-Process itself threw; HasExited-guarded to avoid noisy taskkill
    # errors when the process already ended.
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

# 4. Enable server plugins in config.yaml (idempotent)
$content = Get-Content -Path $CONFIG -Raw
if ($content -match "(?m)^enableServerPlugins:[ \t]*true") {
    Write-Host "[*] Server plugins already enabled in config.yaml"
} else {
    # (?m) makes ^ match line starts (equivalent to sed's per-line semantics).
    # Only flips `enableServerPlugins: false` -> true; leaves everything else
    # untouched so repeated runs are idempotent.
    # [ \t]* (not \s*) matches horizontal whitespace only. .NET's \s includes
    # \r\n, which could let a pathological line `enableServerPlugins: ` followed
    # by a line starting with `false` match across the newline — sed in
    # install.sh is line-scoped so this can't happen there.
    $newContent = $content -replace "(?m)^enableServerPlugins:[ \t]*false", "enableServerPlugins: true"
    # WriteAllText writes UTF-8 without BOM, matching how SillyTavern's own
    # fs.writeFileSync creates the file. Set-Content on Windows PowerShell 5.1
    # would inject a UTF-8 BOM, which some YAML parsers choke on.
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

# 5. Check for global Honcho config with a resolvable apiKey
$HONCHO_CONFIG = Join-Path $HOME ".honcho\config.json"
if (Test-Path $HONCHO_CONFIG) {
    # Probe the plugin's fallback chain: hosts.sillytavern.apiKey -> root apiKey.
    # File existence alone isn't enough — a config with hosts.sillytavern={}
    # and no root apiKey will not resolve a key, and would make the
    # "auto-populated" message a false promise.
    #
    # PowerShell's ConvertFrom-Json + null-propagation makes this cleaner than
    # install.sh's python3 probe: accessing $cfg.hosts.sillytavern.apiKey when
    # .hosts doesn't exist returns $null (not a crash).
    $resolvableKey = $false
    try {
        $cfg = Get-Content -Path $HONCHO_CONFIG -Raw | ConvertFrom-Json
        $hostKey = $cfg.hosts.sillytavern.apiKey
        $rootKey = $cfg.apiKey
        if ($hostKey -or $rootKey) { $resolvableKey = $true }
    } catch {
        # Malformed JSON — treat as no resolvable key
    }
    if ($resolvableKey) {
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
