---
description: Set up the Honcho Memory plugin in SillyTavern. Use when installing, configuring, or troubleshooting the Honcho integration for SillyTavern — including SillyTavern itself if it hasn't been run before.
allowed-tools: Read, Glob, Grep, Bash(npm:*), Bash(node:*), Bash(ln:*), Bash(ls:*), Bash(cd:*), Bash(cat:*), Bash(mkdir:*), Bash(sed:*), Bash(cp:*), Edit, Write, AskUserQuestion
user-invocable: true
---

# SillyTavern Honcho Plugin Setup Guide

This skill walks through the complete setup of SillyTavern with the Honcho Memory extension and server plugin. It covers everything from a fresh SillyTavern checkout to a working Honcho integration.

## Overview

The Honcho integration has two parts that work together:

1. **Client-side extension** — lives in `public/scripts/extensions/third-party/sillytavern-honcho/`, hooks into SillyTavern's event system to inject Honcho context into prompts and store conversation messages
2. **Server-side plugin** — lives in `plugins/honcho-proxy/`, proxies requests from the extension to the Honcho API using `@honcho-ai/sdk` v2

Both parts come from a single repo: `sillytavern-honcho`. The extension root is the repo root; the plugin is in the `plugin/` subdirectory.

## Prerequisites

Before starting, confirm the following:

1. **Node.js >= 18** — run `node --version` to check
2. **Git** — run `git --version` to check
3. **Honcho API key** — from https://app.honcho.dev
4. **Honcho workspace ID** — from the Honcho dashboard
5. **SillyTavern source** — a git clone of https://github.com/SillyTavern/SillyTavern
6. **sillytavern-honcho source** — the Honcho extension repo (https://github.com/plastic-labs/sillytavern-honcho)

If the user doesn't have a Honcho API key or workspace ID yet, tell them to sign up at https://app.honcho.dev.

## Setup Workflow

Follow these phases in order. Verify each step succeeds before moving on.

### Phase 1: SillyTavern Setup

If SillyTavern has never been run, it needs initial setup.

#### 1.1 Install SillyTavern dependencies

```bash
cd <sillytavern-directory>
npm install
```

This installs all Node.js dependencies AND runs a `postinstall` script that:
- Copies `default/config.yaml` to `config.yaml` if it doesn't exist
- Synchronizes any missing default files into `public/`

Verify `config.yaml` exists after install:

```bash
ls config.yaml
```

#### 1.2 Enable server plugins

SillyTavern's server plugins are **disabled by default**. Edit `config.yaml` to enable them:

Find this section near the bottom of `config.yaml`:

```yaml
# -- SERVER PLUGIN CONFIGURATION --
enableServerPlugins: false
```

Change it to:

```yaml
enableServerPlugins: true
```

You can do this with sed:

```bash
sed -i '' 's/enableServerPlugins: false/enableServerPlugins: true/' config.yaml
```

Or on Linux (without the `''`):

```bash
sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' config.yaml
```

#### 1.3 Verify SillyTavern starts

```bash
npm start
```

Expected output includes:

```
Node version: v2X.X.X. Running in undefined environment.
Using config path: ./config.yaml
SillyTavern is listening on port 8000
```

SillyTavern auto-opens a browser to `http://localhost:8000`. On first visit, it asks you to create a local username (no password needed in single-user mode).

Stop the server with Ctrl+C before continuing.

### Phase 2: SillyTavern Core Changes

The Honcho integration requires adding a secret key to two files in SillyTavern's source. These are small, safe changes — just adding an entry to existing object literals.

#### 2.1 Add HONCHO to server-side SECRET_KEYS

In `src/endpoints/secrets.js`, find the `SECRET_KEYS` object and add `HONCHO` before the closing brace:

```javascript
// src/endpoints/secrets.js — inside SECRET_KEYS object, before the closing `};`
HONCHO: 'api_key_honcho',
```

The last few lines should look like:

```javascript
    VOLCENGINE_ACCESS_KEY: 'volcengine_access_key',
    HONCHO: 'api_key_honcho',
};
```

#### 2.2 Add HONCHO to client-side SECRET_KEYS and FRIENDLY_NAMES

In `public/scripts/secrets.js`, make two additions:

**In the `SECRET_KEYS` object** (before the closing `};`):

```javascript
    HONCHO: 'api_key_honcho',
```

**In the `FRIENDLY_NAMES` object** (before the closing `};`):

```javascript
    [SECRET_KEYS.HONCHO]: 'Honcho AI',
```

### Phase 3: Install the Honcho Extension + Plugin

#### 3.1 Symlink the extension

The extension must appear at `public/scripts/extensions/third-party/sillytavern-honcho/` for SillyTavern to discover it.

```bash
# From SillyTavern root:
ln -s <path-to-sillytavern-honcho-repo> \
      public/scripts/extensions/third-party/sillytavern-honcho
```

Verify `manifest.json` is reachable:

```bash
ls public/scripts/extensions/third-party/sillytavern-honcho/manifest.json
```

#### 3.2 Symlink the plugin

The server plugin must appear at `plugins/honcho-proxy/` (the `honcho-proxy` name matches the plugin's `info.id`).

```bash
# From SillyTavern root:
ln -s <path-to-sillytavern-honcho-repo>/plugin \
      plugins/honcho-proxy
```

Verify the plugin entry point is reachable:

```bash
ls plugins/honcho-proxy/index.js
```

#### 3.3 Install plugin dependencies

The plugin depends on `@honcho-ai/sdk`:

```bash
cd plugins/honcho-proxy && npm install && cd -
```

Verify the SDK is installed:

```bash
ls plugins/honcho-proxy/node_modules/@honcho-ai/sdk/package.json
```

### Phase 4: Start and Configure

#### 4.1 Start SillyTavern

```bash
npm start
```

In the terminal output, look for these lines confirming the plugin loaded:

```
[honcho-proxy] Honcho SDK loaded successfully
[honcho-proxy] Plugin initialized with 5 routes
```

If you see `@honcho-ai/sdk not found`, the `npm install` in Phase 3.3 didn't work — go back and retry.

If there's no mention of `honcho-proxy` at all, `enableServerPlugins` is not set to `true` — check `config.yaml`.

#### 4.2 Connect an LLM backend

In the browser at `http://localhost:8000`:

1. Click the **plug icon** (API Connections) in the top navigation bar
2. Select a Chat Completion source (OpenAI, Claude, OpenRouter, etc.)
3. Enter your API key for that provider
4. Click **Connect** and verify the connection succeeds

#### 4.3 Enable and configure Honcho Memory

1. Click the **puzzle piece icon** (Extensions) in the top-right area
2. Scroll to find **"Honcho Memory"** and expand the drawer
3. Check **"Enable Honcho Memory"**
4. Click the **API Key** field — enter your Honcho API key in the popup
5. Enter your **Workspace ID** in the text field
6. The status indicator should change from "Not ready" to **"Ready"**

#### 4.4 Test with a character

1. Click the character icon to create or select an AI character
2. Open a chat
3. Send a message

In the browser console (F12 / Cmd+Option+I), you should see:

```
[Honcho] Session ready for chat: <chat-id>
```

In the server terminal, there should be no errors from `honcho-proxy` routes.

## Extension Settings Reference

| Setting | Options | Default | Description |
|---|---|---|---|
| Enable | checkbox | off | Master on/off switch |
| API Key | secret field | — | Honcho API key (stored in SillyTavern's secret manager) |
| Workspace ID | text | — | Your Honcho workspace identifier |
| Peer Mode | single / per_persona | single | Whether all personas share one peer or each gets its own |
| Context Mode | prefetch / tool_call / context | prefetch | How Honcho context is fetched and injected |
| Queries | textarea | "What do you know about the user?" | Pre-fetch queries (one per line, only for prefetch mode) |
| Token Budget | number | 2000 | Max tokens for context() mode |
| Include Summary | checkbox | on | Include session summary in context() mode |
| Injection Position | after/before main prompt, in-chat | after main prompt | Where in the prompt Honcho context appears |
| Injection Depth | number | 4 | Chat depth for in-chat injection position |
| Prompt Template | textarea | `[Honcho Memory]\n{{text}}` | Wrapper template; `{{text}}` is replaced with Honcho's response |

## Context Modes Explained

### Pre-fetch (default)

Before each generation, runs each query from the "Queries" textarea against Honcho's `peer.chat()` endpoint. Combines results and injects them into the system prompt.

Best for: Simple setups where you know what context the AI always needs.

### Tool Call

Registers a `honcho_query_memory` function tool that the LLM can invoke on demand. The LLM decides when to query memory.

Best for: Agentic setups with LLMs that support function calling (OpenAI, Claude, etc.).

### Context()

Uses Honcho's `session.context()` endpoint to get a summarized context window with optional session summary. Respects the token budget setting.

Best for: When you want Honcho to decide what context is relevant.

## Server Plugin Routes

All routes are at `/api/plugins/honcho-proxy/` and require `workspaceId` in the request body.

| Route | Body | Purpose |
|---|---|---|
| `POST /peer` | `{ workspaceId, peerId, observeMe }` | Create or get a Honcho peer |
| `POST /session` | `{ workspaceId, sessionId, userPeerId, charPeerId }` | Create session + add peers |
| `POST /session/messages` | `{ workspaceId, sessionId, messages: [{ peerId, content }] }` | Store messages in session |
| `POST /chat` | `{ workspaceId, peerId, query, sessionId? }` | Dialectic chat query |
| `POST /context` | `{ workspaceId, sessionId, userPeerId, tokens?, summary? }` | Get session context |

## Architecture Details

### Event Flow

| SillyTavern Event | Handler | Action |
|---|---|---|
| `CHAT_CHANGED` | `onChatChanged` | Creates/gets Honcho session + peers, stores IDs in `chat_metadata.honcho` |
| `GENERATION_AFTER_COMMANDS` | `onGeneration` | Queries Honcho for context and injects via `setExtensionPrompt` |
| `MESSAGE_SENT` | `onMessageSent` | Stores user message in Honcho session |
| `CHARACTER_MESSAGE_RENDERED` | `onCharResponse` | Stores AI response in Honcho session (runs last via `makeLast`) |

### Peer ID Resolution

- **Single mode**: `st-user-{userName}` — stable across persona switches
- **Per-persona mode**: `user_avatar` filename — unique per persona, with fallback chain: `user_avatar || context.name1 || 'default-user'`
- **Character**: `characters[this_chid].avatar` or `char-{charId}` fallback
- **Group chats**: `group-{groupId}`

### Safety / Error Handling

- All Honcho errors are caught and logged — they **never block generation**
- `isReady()` guard checks `enabled && workspaceId && api_key_exists` — all handlers early-return if not ready
- `sessionSetupInProgress` flag prevents race conditions on rapid `CHAT_CHANGED` events
- Swipe detection: only the latest message is stored (swiped-away responses are skipped)
- Plugin returns 403 if no API key, 400 for bad params, 500 for SDK errors with clear messages

### Symlink-Safe Imports

The server plugin uses `process.cwd()` + `pathToFileURL()` to dynamically import SillyTavern's secrets module because Node.js resolves symlinks to real paths before resolving relative imports. A static `import from '../../src/endpoints/secrets.js'` would fail since the real path of the plugin is outside SillyTavern's directory tree.

## File Locations

```
SillyTavern/
├── config.yaml                     <- enableServerPlugins: true
├── server.js                       <- entry point (npm start)
├── src/endpoints/secrets.js        <- HONCHO secret key (server-side)
├── public/scripts/secrets.js       <- HONCHO secret key + friendly name (client-side)
├── plugins/
│   └── honcho-proxy/               <- symlink to sillytavern-honcho/plugin/
└── public/scripts/extensions/third-party/
    └── sillytavern-honcho/         <- symlink to sillytavern-honcho repo root

sillytavern-honcho/
├── manifest.json                   <- extension manifest
├── index.js                        <- client-side extension (event hooks, UI, tool registration)
├── settings.html                   <- settings panel HTML
├── style.css                       <- settings panel CSS
└── plugin/
    ├── package.json                <- ESM module, @honcho-ai/sdk dependency
    └── index.js                    <- server-side Express router (5 proxy routes)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm start` fails with missing modules | Dependencies not installed | Run `npm install` in SillyTavern root |
| No "Honcho Memory" in Extensions panel | Extension not found | Verify symlink: `ls public/scripts/extensions/third-party/sillytavern-honcho/manifest.json` |
| No `[honcho-proxy]` in server logs | Plugins disabled | Set `enableServerPlugins: true` in `config.yaml`, restart |
| `@honcho-ai/sdk not found` | Plugin deps missing | Run `cd plugins/honcho-proxy && npm install` |
| 403 from plugin routes | No API key set | Set the Honcho API key in Extensions > Honcho Memory |
| 404 from plugin routes | Plugin didn't load | Check server startup logs for errors |
| Status says "Not ready" | Missing config | Ensure enabled + workspace ID + API key are all set |
| `[Honcho] Session ready` not appearing | Extension disabled or no chat open | Enable extension, open a chat with a character |
| Port 8000 already in use | Another process | Change `port:` in `config.yaml` or kill the other process |
| Symlink target doesn't resolve | Wrong path | Use absolute paths for `ln -s` and verify with `ls -la` |
