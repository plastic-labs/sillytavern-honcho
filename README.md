# Honcho Memory for SillyTavern

Persistent, personalized memory for SillyTavern AI characters via [Honcho](https://honcho.dev).

## Install

From your SillyTavern directory:

**macOS / Linux:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/plastic-labs/sillytavern-honcho/main/install.sh)
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/plastic-labs/sillytavern-honcho/main/install.ps1 | iex
```

Then restart SillyTavern.

> **Internal reviewers / pre-public:** the URL above 404s while the repo is private. Use the local-clone install path in [CONTRIBUTING.md](CONTRIBUTING.md).

### What the script does

1. Clones this repo into `public/scripts/extensions/third-party/sillytavern-honcho`
2. Symlinks the server plugin to `plugins/honcho-proxy`
3. Installs the `@honcho-ai/sdk` dependency
4. Checks that `enableServerPlugins: true` is set in `config.yaml`
5. Detects your `~/.honcho/config.json` if it exists

### Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) running locally
- A Honcho API key from [app.honcho.dev](https://app.honcho.dev)
- Server plugins enabled in `config.yaml`:
  ```yaml
  enableServerPlugins: true
  ```

## Configuration

### Extension settings

Open Extensions (puzzle piece icon) and expand **Honcho Memory**:

1. Check **Enable Honcho Memory**
2. Click the API key field to set your key
3. Enter your workspace ID
4. Status indicator should show **Ready**

### Global config (for multi-tool setups)

`~/.honcho/config.json` is a shared config file that other Honcho integrations (Claude Code, Cursor, Hermes) write when you first set them up. If the file already exists when you install this extension, the server plugin reads it on startup.

**Resolution order** (plugin-side, on startup):

1. `hosts.sillytavern.apiKey` (nested, host-specific)
2. root-level `apiKey` (flat fallback)
3. If neither resolves → plugin falls through; you must enter the key via the Extensions panel

**Precedence against the Extensions panel key:** the Extensions-panel key (SillyTavern's secret manager) takes priority at request time — the plugin checks `SECRET_KEYS.HONCHO` first, then falls back to the global-config key. So entering a key in the UI overrides the file without touching it.

Example `~/.honcho/config.json` the plugin accepts:

```json
{
  "apiKey": "your-honcho-api-key",
  "peerName": "your-name",
  "workspace": "sillytavern",
  "enabled": true
}
```

Nested form (when multiple tools share the file):

```json
{
  "hosts": {
    "sillytavern": {
      "apiKey": "your-honcho-api-key",
      "workspace": "sillytavern"
    }
  }
}
```

## How it works

The extension has two parts:

- **Client extension** (browser) -- hooks into SillyTavern events to inject memory context and store messages
- **Server plugin** (Node.js) -- proxies requests to the Honcho API

### Peer observability

By default, only the user peer accumulates derived memory — Honcho observes the user's messages and derives conclusions about them across sessions. The AI character's persona comes from its character card, not from peer derivation. If you want the character to have its own Honcho-derived state, configure it as an additional peer in session setup (see the `/session` route in `plugin/index.js`).

### Context modes

Every generation injects the peer representation and session summary from `session.context()` as a base layer (stale-while-revalidate -- zero latency after first turn, configurable refresh interval). The enrichment mode controls what happens on top:

| Mode | Behavior |
| --- | --- |
| **Context only** | Base layer only -- peer representation + session summary |
| **Reasoning** (default) | Base layer + dialectic `peer.chat()` queries on an interval |
| **Tool call** | Base layer + function tools the LLM can call on demand (query, save conclusion, search) |

### Peer modes

| Mode | Behavior |
| --- | --- |
| **Single peer** | One user peer shared across all personas |
| **Per-persona** | Each persona gets its own isolated memory |

### Event flow

| Event | Action |
| --- | --- |
| Chat opened | Creates/gets Honcho session + peers |
| Before generation | Injects memory context into prompt |
| User sends message | Stores message in Honcho session |
| AI responds | Stores response in Honcho session |

## Architecture

```text
Browser (Extension)                     Server (Plugin)
+-----------------------+               +------------------------------+
| index.js              |  fetch()      | plugin/index.js              |
|                       | ------------> |                              |
| - Settings UI         | /api/plugins/ | - Express router             |
| - Event hooks         |  honcho-proxy | - Honcho SDK (@honcho-ai/sdk)|
| - Prompt injection    |               | - API key from secrets or    |
| - Tool registration   |               |   ~/.honcho/config.json      |
+-----------------------+               +------------------------------+
```

## File structure

```text
sillytavern-honcho/
+-- manifest.json          Extension manifest
+-- index.js               Client extension
+-- settings.html          Settings panel
+-- style.css              Styles
+-- install.sh             Installer (macOS/Linux)
+-- install.ps1            Installer (Windows)
+-- plugin/
|   +-- index.js           Server plugin (9 routes: 1 GET + 8 POST)
|   +-- package.json       @honcho-ai/sdk dependency
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No "Honcho Memory" in Extensions | Check symlink: `ls public/scripts/extensions/third-party/sillytavern-honcho/manifest.json` |
| Plugin not initializing | Add `enableServerPlugins: true` to `config.yaml` and restart |
| Just installed SillyTavern, plugin silent on first boot | SillyTavern creates `config.yaml` with `enableServerPlugins: false` by default on first launch. Flip it to `true` and restart. |
| 403 on plugin requests | Set Honcho API key in extension settings or `~/.honcho/config.json` |
| SDK import error | Run `cd plugins/honcho-proxy && npm install` |
| Extension loads but nothing happens | Enable the checkbox and ensure workspace ID is set |
| API key modal saves but status never turns Ready | SillyTavern core patches missing (`SECRET_KEYS.HONCHO` not registered upstream). Either apply the patches (see [CONTRIBUTING.md](CONTRIBUTING.md#core-patches)) or configure via `~/.honcho/config.json`. |

## Development

- For local-clone + symlink dev setup, see [CONTRIBUTING.md](CONTRIBUTING.md).
- For Claude Code-assisted install, invoke the setup skill at [`skills/setup/SKILL.md`](skills/setup/SKILL.md).
