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

# 4. Check config.yaml for server plugins
CONFIG="$ST_DIR/config.yaml"
if [[ -f "$CONFIG" ]]; then
    if grep -q "enableServerPlugins: true" "$CONFIG"; then
        echo "[*] Server plugins already enabled in config.yaml"
    else
        echo ""
        echo "[!] Server plugins are NOT enabled in config.yaml."
        echo "    Add or change this line in $CONFIG:"
        echo "      enableServerPlugins: true"
    fi
fi

# 5. Check for global Honcho config
HONCHO_CONFIG="$HOME/.honcho/config.json"
if [[ -f "$HONCHO_CONFIG" ]]; then
    echo "[*] Found global Honcho config at $HONCHO_CONFIG"
    echo "    API key, workspace, and peer name will be auto-populated."
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
