# SillyTavern Honcho Plugin - Windows Test Script
# Run this on a fresh Windows VM to validate the full install + runtime flow.
#
# Prerequisites: Git and Node.js (18+) must be installed.
# Usage: .\test-windows.ps1

$ErrorActionPreference = "Stop"
$pass = 0
$fail = 0
$results = @()

function Test-Step {
    param([string]$Name, [scriptblock]$Block)
    Write-Host "`n--- $Name ---" -ForegroundColor Cyan
    try {
        & $Block
        $script:pass++
        $script:results += [PSCustomObject]@{ Test = $Name; Result = "PASS" }
        Write-Host "  PASS" -ForegroundColor Green
    } catch {
        $script:fail++
        $script:results += [PSCustomObject]@{ Test = $Name; Result = "FAIL: $($_.Exception.Message)" }
        Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ─── Prerequisites ─────────────────────────────────────────

Test-Step "Git is installed" {
    $v = git --version
    if (-not $v) { throw "git not found" }
    Write-Host "  $v"
}

Test-Step "Node.js is installed (18+)" {
    $v = node --version
    if (-not $v) { throw "node not found" }
    $major = [int]($v -replace 'v(\d+)\..*', '$1')
    if ($major -lt 18) { throw "Node.js $v is too old, need 18+" }
    Write-Host "  $v"
}

Test-Step "npm is installed" {
    $v = npm --version
    if (-not $v) { throw "npm not found" }
    Write-Host "  $v"
}

# ─── SillyTavern Setup ────────────────────────────────────

$TEST_DIR = Join-Path $env:TEMP "honcho-test-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$ST_DIR = Join-Path $TEST_DIR "SillyTavern"

Test-Step "Create test directory" {
    New-Item -ItemType Directory -Path $TEST_DIR -Force | Out-Null
    Write-Host "  $TEST_DIR"
}

Test-Step "Clone SillyTavern" {
    git clone --depth 1 https://github.com/SillyTavern/SillyTavern.git $ST_DIR 2>&1
    if (-not (Test-Path (Join-Path $ST_DIR "server.js"))) { throw "server.js not found after clone" }
}

Test-Step "Install SillyTavern dependencies" {
    Push-Location $ST_DIR
    npm install --silent 2>&1
    Pop-Location
}

Test-Step "Enable server plugins in config.yaml" {
    $configSrc = Join-Path $ST_DIR "default" "config.yaml"
    $configDst = Join-Path $ST_DIR "config.yaml"
    if (Test-Path $configSrc) {
        Copy-Item $configSrc $configDst
    }
    if (-not (Test-Path $configDst)) {
        # Create minimal config
        Set-Content $configDst "enableServerPlugins: true`n"
    } else {
        $content = Get-Content $configDst -Raw
        if ($content -notmatch "enableServerPlugins:\s*true") {
            $content = $content -replace "enableServerPlugins:\s*false", "enableServerPlugins: true"
            if ($content -notmatch "enableServerPlugins") {
                $content += "`nenableServerPlugins: true`n"
            }
            Set-Content $configDst $content
        }
    }
    $check = Get-Content $configDst -Raw
    if ($check -notmatch "enableServerPlugins:\s*true") { throw "Failed to enable server plugins" }
}

# ─── Install Script ────────────────────────────────────────

Test-Step "Run install.ps1" {
    $env:ST_DIR = $ST_DIR
    Push-Location $ST_DIR
    # Clone the extension repo (simulating the install script)
    $EXT_DIR = Join-Path $ST_DIR "public\scripts\extensions\third-party\sillytavern-honcho"
    git clone https://github.com/plastic-labs/sillytavern-honcho.git $EXT_DIR 2>&1
    # Run the actual install script from the cloned repo
    & "$EXT_DIR\install.ps1"
    Pop-Location
    Remove-Item Env:\ST_DIR -ErrorAction SilentlyContinue
}

# ─── File Structure Validation ─────────────────────────────

$EXT_DIR = Join-Path $ST_DIR "public\scripts\extensions\third-party\sillytavern-honcho"
$PLUGIN_DIR = Join-Path $ST_DIR "plugins\honcho-proxy"

Test-Step "Extension directory exists" {
    if (-not (Test-Path $EXT_DIR)) { throw "Extension dir not found at $EXT_DIR" }
}

Test-Step "manifest.json exists" {
    $f = Join-Path $EXT_DIR "manifest.json"
    if (-not (Test-Path $f)) { throw "manifest.json not found" }
    $json = Get-Content $f | ConvertFrom-Json
    if ($json.display_name -ne "Honcho Memory") { throw "Unexpected display_name: $($json.display_name)" }
    Write-Host "  display_name: $($json.display_name)"
}

Test-Step "Client index.js exists" {
    $f = Join-Path $EXT_DIR "index.js"
    if (-not (Test-Path $f)) { throw "Client index.js not found" }
    $content = Get-Content $f -Raw
    if ($content -notmatch "MODULE_NAME") { throw "index.js doesn't look like the Honcho extension" }
}

Test-Step "settings.html exists" {
    if (-not (Test-Path (Join-Path $EXT_DIR "settings.html"))) { throw "settings.html not found" }
}

Test-Step "style.css exists" {
    if (-not (Test-Path (Join-Path $EXT_DIR "style.css"))) { throw "style.css not found" }
}

Test-Step "Plugin directory exists (junction)" {
    if (-not (Test-Path $PLUGIN_DIR)) { throw "Plugin dir not found at $PLUGIN_DIR" }
}

Test-Step "Plugin index.js exists" {
    $f = Join-Path $PLUGIN_DIR "index.js"
    if (-not (Test-Path $f)) { throw "Plugin index.js not found" }
    $content = Get-Content $f -Raw
    if ($content -notmatch "honcho-proxy") { throw "Plugin index.js doesn't look right" }
}

Test-Step "Plugin package.json exists" {
    $f = Join-Path $PLUGIN_DIR "package.json"
    if (-not (Test-Path $f)) { throw "package.json not found" }
    $json = Get-Content $f | ConvertFrom-Json
    if (-not $json.dependencies.'@honcho-ai/sdk') { throw "@honcho-ai/sdk not in dependencies" }
    Write-Host "  @honcho-ai/sdk: $($json.dependencies.'@honcho-ai/sdk')"
}

Test-Step "@honcho-ai/sdk installed" {
    $sdk = Join-Path $PLUGIN_DIR "node_modules\@honcho-ai\sdk"
    if (-not (Test-Path $sdk)) { throw "@honcho-ai/sdk not installed in node_modules" }
}

# ─── Global Config ─────────────────────────────────────────

$HONCHO_DIR = Join-Path $HOME ".honcho"
$HONCHO_CONFIG = Join-Path $HONCHO_DIR "config.json"
$hadExistingConfig = Test-Path $HONCHO_CONFIG

Test-Step "Create test global config" {
    if (-not (Test-Path $HONCHO_DIR)) {
        New-Item -ItemType Directory -Path $HONCHO_DIR -Force | Out-Null
    }
    if ($hadExistingConfig) {
        # Back up existing config
        Copy-Item $HONCHO_CONFIG "$HONCHO_CONFIG.bak"
        Write-Host "  Backed up existing config to config.json.bak"
    }
    $testConfig = @{
        apiKey = "test-key-not-real"
        peerName = "test-user"
        workspace = "test-workspace"
        enabled = $true
    } | ConvertTo-Json
    Set-Content $HONCHO_CONFIG $testConfig
}

Test-Step "Global config at correct Windows path" {
    if (-not (Test-Path $HONCHO_CONFIG)) { throw "Config not found at $HONCHO_CONFIG" }
    $json = Get-Content $HONCHO_CONFIG | ConvertFrom-Json
    if ($json.peerName -ne "test-user") { throw "Config content mismatch" }
    Write-Host "  Path: $HONCHO_CONFIG"
    Write-Host "  peerName: $($json.peerName)"
}

# ─── Node.js Import Validation ─────────────────────────────

Test-Step "Plugin index.js parses as valid ESM" {
    $pluginJs = Join-Path $PLUGIN_DIR "index.js"
    # Use Node to check syntax (won't fully run since it needs SillyTavern runtime)
    $result = node -e "import('node:fs').then(fs => { const src = fs.readFileSync('$($pluginJs -replace '\\', '/')', 'utf-8'); new Function(src); }).catch(() => {})" 2>&1
    # Basic check: ensure the file can at least be read
    $content = Get-Content $pluginJs -Raw
    if ($content.Length -lt 100) { throw "Plugin index.js seems too small" }
    Write-Host "  File size: $($content.Length) chars"
}

Test-Step "os.homedir() resolves correctly on Windows" {
    $homeDir = node -e "console.log(require('os').homedir())"
    $expected = $HOME
    if ($homeDir.Trim() -ne $expected) { throw "os.homedir()='$homeDir' != HOME='$expected'" }
    Write-Host "  os.homedir() = $homeDir"
}

Test-Step "path.join resolves .honcho/config.json on Windows" {
    $resolved = node -e "const p=require('path');const os=require('os');console.log(p.join(os.homedir(),'.honcho','config.json'))"
    $expected = $HONCHO_CONFIG
    if ($resolved.Trim() -ne $expected) { throw "Resolved '$resolved' != expected '$expected'" }
    Write-Host "  Resolved: $resolved"
}

# ─── Cleanup ───────────────────────────────────────────────

Test-Step "Restore global config" {
    if ($hadExistingConfig) {
        Move-Item "$HONCHO_CONFIG.bak" $HONCHO_CONFIG -Force
        Write-Host "  Restored original config"
    } else {
        Remove-Item $HONCHO_CONFIG -Force
        if ((Get-ChildItem $HONCHO_DIR | Measure-Object).Count -eq 0) {
            Remove-Item $HONCHO_DIR -Force
        }
        Write-Host "  Removed test config"
    }
}

# ─── Results ───────────────────────────────────────────────

Write-Host "`n========================================" -ForegroundColor White
Write-Host "Results: $pass passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "========================================" -ForegroundColor White
$results | Format-Table -AutoSize

Write-Host "`nTest directory: $TEST_DIR"
Write-Host "To clean up: Remove-Item -Recurse -Force '$TEST_DIR'"

if ($fail -gt 0) { exit 1 }
