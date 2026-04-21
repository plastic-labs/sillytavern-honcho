#!/usr/bin/env bash
set -euo pipefail

# SillyTavern Honcho Plugin Installer
# Installs both the client extension and server plugin.
#
# Usage:
#   From inside your SillyTavern directory:
#     bash <(curl -fsSL https://raw.githubusercontent.com/plastic-labs/sillytavern-honcho/main/install.sh)
#
#   Or if you've already cloned the repo:
#     cd SillyTavern && bash path/to/sillytavern-honcho/install.sh

ST_DIR="${ST_DIR:-$(pwd)}"
REPO_URL="https://github.com/plastic-labs/sillytavern-honcho.git"
EXT_DIR="$ST_DIR/public/scripts/extensions/third-party/sillytavern-honcho"
PLUGIN_DIR="$ST_DIR/plugins/honcho-proxy"

# Verify we're in a SillyTavern directory
if [[ ! -f "$ST_DIR/server.js" ]] || [[ ! -f "$ST_DIR/package.json" ]]; then
    echo "[!] Could not find SillyTavern at: $ST_DIR"
    echo "    Run this script from your SillyTavern directory, or set ST_DIR:"
    echo "    ST_DIR=/path/to/SillyTavern bash install.sh"
    exit 1
fi

echo "[*] Installing SillyTavern Honcho plugin..."
echo "    ST directory: $ST_DIR"

# 1. Install client extension
if [[ -d "$EXT_DIR" ]]; then
    echo "[*] Client extension already exists, pulling latest..."
    git -C "$EXT_DIR" pull --ff-only 2>/dev/null || echo "    (pull skipped — not a git repo or has local changes)"
else
    echo "[*] Cloning client extension..."
    git clone "$REPO_URL" "$EXT_DIR"
fi

# 2. Set up server plugin (symlink from extension's plugin/ dir)
if [[ -L "$PLUGIN_DIR" ]] || [[ -d "$PLUGIN_DIR" ]]; then
    echo "[*] Server plugin already exists at $PLUGIN_DIR"
else
    echo "[*] Symlinking server plugin..."
    ln -s "$EXT_DIR/plugin" "$PLUGIN_DIR"
fi

# 3. Install SDK dependencies
echo "[*] Installing @honcho-ai/sdk..."
cd "$PLUGIN_DIR" && npm install --silent
cd "$ST_DIR"

# 3.5 Ensure config.yaml exists. SillyTavern creates it on first `npm start`,
#     not on `npm install`. Without this step, the check below runs against a
#     missing file (silent on first-run users — BUG-4) and enableServerPlugins
#     never gets flipped, so the plugin fails to load on first npm start.
CONFIG="$ST_DIR/config.yaml"
if [[ ! -f "$CONFIG" ]]; then
    echo "[*] Generating config.yaml by starting SillyTavern briefly..."
    BOOT_LOG=$(mktemp -t silly-first-launch.XXXXXX.log)
    # exec npm so $! captures the node process directly (not the subshell),
    # making `kill "$ST_BOOT_PID"` reach node and avoiding the need for a
    # broad `pkill -f "node.*server.js"` footgun that would nuke unrelated
    # SillyTavern instances on the same host.
    ( cd "$ST_DIR" && exec npm start > "$BOOT_LOG" 2>&1 ) &
    ST_BOOT_PID=$!
    for _ in $(seq 1 60); do
        [[ -f "$CONFIG" ]] && break
        sleep 1
    done
    { kill "$ST_BOOT_PID" 2>/dev/null; wait "$ST_BOOT_PID" 2>/dev/null; } || true
    if [[ ! -f "$CONFIG" ]]; then
        echo "[!] config.yaml did not appear — inspect $BOOT_LOG"
        exit 1
    fi
    echo "[*] config.yaml created at $CONFIG"
fi

# 4. Enable server plugins in config.yaml (idempotent)
if grep -q "^enableServerPlugins: true" "$CONFIG"; then
    echo "[*] Server plugins already enabled in config.yaml"
else
    sed -i.bak 's/^enableServerPlugins: false/enableServerPlugins: true/' "$CONFIG"
    rm -f "$CONFIG.bak"
    if grep -q "^enableServerPlugins: true" "$CONFIG"; then
        echo "[*] Enabled server plugins in config.yaml"
    else
        echo "[!] Could not set enableServerPlugins: true in $CONFIG"
        echo "    Add this line manually and restart SillyTavern:"
        echo "      enableServerPlugins: true"
    fi
fi

# 5. Check for global Honcho config with a resolvable apiKey
HONCHO_CONFIG="$HOME/.honcho/config.json"
if [[ -f "$HONCHO_CONFIG" ]]; then
    # Probe the plugin's fallback chain: hosts.sillytavern.apiKey → root apiKey.
    # File existence alone isn't enough — a config with hosts.sillytavern={}
    # and no root apiKey will not resolve a key and would make the
    # "auto-populated" message a false promise.
    #
    # python3 is preferred over jq/yq because it's a hard dep of macOS + most
    # Linux dev envs. If it's still missing (minimal Alpine / Debian-slim),
    # we fall back to the honest "check it yourself" message instead of
    # crashing the installer on `set -e`.
    if ! command -v python3 >/dev/null 2>&1; then
        echo "[*] Found $HONCHO_CONFIG (python3 not available — skipping apiKey probe)."
        echo "    Verify a resolvable apiKey is set, or enter one via the Extensions panel."
    # Path passed via argv (not heredoc interpolation) so a pathological
    # HONCHO_CONFIG value can't inject Python code.
    elif python3 - "$HONCHO_CONFIG" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    h = d.get('hosts', {}).get('sillytavern', {})
    sys.exit(0 if (h.get('apiKey') or d.get('apiKey')) else 1)
except Exception:
    sys.exit(1)
PY
    then
        echo "[*] Found global Honcho config with resolvable apiKey at $HONCHO_CONFIG"
        echo "    API key, workspace, and peer name will be auto-populated."
    else
        echo "[*] Found $HONCHO_CONFIG but no resolvable apiKey."
        echo "    (plugin checks hosts.sillytavern.apiKey, then root apiKey.)"
        echo "    Enter your Honcho API key via the Extensions panel after restart."
    fi
else
    echo ""
    echo "[i] No global Honcho config found at $HONCHO_CONFIG"
    echo "    You can configure Honcho in the SillyTavern Extensions panel,"
    echo "    or create ~/.honcho/config.json with:"
    echo '    {'
    echo '      "apiKey": "your-honcho-api-key",'
    echo '      "peerName": "your-name",'
    echo '      "workspace": "sillytavern",'
    echo '      "enabled": true'
    echo '    }'
fi

echo ""
echo "[*] Done! Restart SillyTavern and enable Honcho in Extensions."
