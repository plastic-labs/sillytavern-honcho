# SillyTavern Honcho Plugin Installer (Windows)
# Installs both the client extension and server plugin.
#
# Usage:
#   From inside your SillyTavern directory (PowerShell):
#     irm https://raw.githubusercontent.com/plastic-labs/sillytavern-honcho/main/install.ps1 | iex
#
#   Or if you've already cloned the repo:
#     cd SillyTavern; .\path\to\sillytavern-honcho\install.ps1

$ErrorActionPreference = "Stop"

$ST_DIR = if ($env:ST_DIR) { $env:ST_DIR } else { Get-Location }
$REPO_URL = "https://github.com/plastic-labs/sillytavern-honcho.git"
$EXT_DIR = Join-Path $ST_DIR "public\scripts\extensions\third-party\sillytavern-honcho"
$PLUGIN_DIR = Join-Path $ST_DIR "plugins\honcho-proxy"

# Verify we're in a SillyTavern directory
if (-not (Test-Path (Join-Path $ST_DIR "server.js")) -and -not (Test-Path (Join-Path $ST_DIR "package.json"))) {
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
    try {
        git -C $EXT_DIR pull --ff-only 2>$null
    } catch {
        Write-Host "    (pull skipped -- not a git repo or has local changes)"
    }
} else {
    Write-Host "[*] Cloning client extension..."
    git clone $REPO_URL $EXT_DIR
}

# 2. Set up server plugin (directory junction from extension's plugin/ dir)
if (Test-Path $PLUGIN_DIR) {
    Write-Host "[*] Server plugin already exists at $PLUGIN_DIR"
} else {
    Write-Host "[*] Creating directory junction for server plugin..."
    $pluginSource = Join-Path $EXT_DIR "plugin"
    cmd /c mklink /J $PLUGIN_DIR $pluginSource
}

# 3. Install SDK dependencies
Write-Host "[*] Installing @honcho-ai/sdk..."
Push-Location $PLUGIN_DIR
npm install --silent
Pop-Location

# 4. Check config.yaml for server plugins
$CONFIG = Join-Path $ST_DIR "config.yaml"
if (Test-Path $CONFIG) {
    $content = Get-Content $CONFIG -Raw
    if ($content -match "enableServerPlugins:\s*true") {
        Write-Host "[*] Server plugins already enabled in config.yaml"
    } else {
        Write-Host ""
        Write-Host "[!] Server plugins are NOT enabled in config.yaml."
        Write-Host "    Add or change this line in ${CONFIG}:"
        Write-Host "      enableServerPlugins: true"
    }
}

# 5. Check for global Honcho config
$HONCHO_CONFIG = Join-Path $HOME ".honcho\config.json"
if (Test-Path $HONCHO_CONFIG) {
    Write-Host "[*] Found global Honcho config at $HONCHO_CONFIG"
    Write-Host "    API key, workspace, and peer name will be auto-populated."
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
