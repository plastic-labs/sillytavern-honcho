# Honcho Memory Integration for SillyTavern

## Implementation Report

### What Was Built

A two-part integration that gives SillyTavern AI characters persistent, personalized memory about users via Honcho:

1. **Client-side extension** (browser) — hooks into SillyTavern's event system to inject Honcho context into prompts and store conversation messages
2. **Server-side plugin** (Node.js) — proxies requests from the extension to the Honcho API using the `@honcho-ai/sdk` v2

### Architecture

```
Browser (Extension)                          Server (Plugin)
┌──────────────────────┐                    ┌──────────────────────────────┐
│ index.js             │   fetch()          │ plugin/index.js              │
│                      │ ────────────────── │                              │
│ - Settings UI        │ /api/plugins/      │ - Express router             │
│ - Event hooks        │  honcho-proxy/...  │ - Honcho SDK (@honcho-ai/sdk)│
│ - Prompt injection   │                    │ - API key from secrets store │
│ - Tool registration  │                    │ - Client caching             │
└──────────────────────┘                    └──────────────────────────────┘
```

---

## Files Created

### New Repo: `sillytavern-honcho/`

| File                  | Lines | Purpose                             |
| --------------------- | ----- | ----------------------------------- |
| `manifest.json`       | 11    | SillyTavern extension manifest      |
| `index.js`            | 449   | Client-side extension logic         |
| `settings.html`       | 113   | Settings UI (inline-drawer pattern) |
| `style.css`           | 34    | Minimal styling                     |
| `plugin/index.js`     | 217   | Server-side Honcho proxy (5 routes) |
| `plugin/package.json` | 10    | ESM module, `@honcho-ai/sdk` dep    |
| `.gitignore`          | 2     | Ignores node_modules                |

### SillyTavern Core Changes (tiny — 3 lines across 2 files)

**`src/endpoints/secrets.js`** — Added to SECRET_KEYS:

```javascript
HONCHO: 'api_key_honcho',
```

**`public/scripts/secrets.js`** — Added to SECRET_KEYS + FRIENDLY_NAMES:

```javascript
HONCHO: 'api_key_honcho',
// ...
[SECRET_KEYS.HONCHO]: 'Honcho AI',
```

---

## How It Works

### Event Flow

| SillyTavern Event            | Handler          | What Happens                                                                       |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `CHAT_CHANGED`               | `onChatChanged`  | Creates/gets Honcho session + peers, stores IDs in `chat_metadata.honcho`          |
| `GENERATION_AFTER_COMMANDS`  | `onGeneration`   | Queries Honcho for context and injects it into the prompt via `setExtensionPrompt` |
| `MESSAGE_SENT`               | `onMessageSent`  | Stores the user's message in the Honcho session                                    |
| `CHARACTER_MESSAGE_RENDERED` | `onCharResponse` | Stores the AI's response in the Honcho session (runs last via `makeLast`)          |

### Context Modes

1. **Pre-fetch** (default) — Before each generation, runs configurable queries against `peer.chat()` and injects combined results into the system prompt
2. **Tool call** — Registers `honcho_query_memory` as a function tool the LLM can invoke on demand
3. **Context()** — Uses Honcho's `session.context()` endpoint with configurable token budget and summary toggle

### Peer Modes

- **Single peer** — One user peer (`st-user-{name}`) shared across all personas
- **Per-persona** — Uses `user_avatar` filename as peer ID, so each persona gets isolated memory

### Server Plugin Routes

| Route                    | Body                                                        | Purpose                    |
| ------------------------ | ----------------------------------------------------------- | -------------------------- |
| `POST /peer`             | `{ workspaceId, peerId, observeMe }`                        | Create/get a Honcho peer   |
| `POST /session`          | `{ workspaceId, sessionId, userPeerId, charPeerId }`        | Create session + add peers |
| `POST /session/messages` | `{ workspaceId, sessionId, messages[] }`                    | Store messages             |
| `POST /chat`             | `{ workspaceId, peerId, query, sessionId? }`                | Dialectic chat query       |
| `POST /context`          | `{ workspaceId, sessionId, userPeerId, tokens?, summary? }` | Get session context        |

All routes go through middleware that reads the Honcho API key from SillyTavern's secrets store (`req.user.directories` → `SecretManager`).

### Notable Implementation Details

- **Symlink-safe imports**: The plugin uses `process.cwd()` + `pathToFileURL()` to dynamically import SillyTavern's secrets module, since Node.js resolves symlinks to their real paths before resolving relative imports
- **Client caching**: Honcho SDK clients are cached by `workspaceId:apiKeyLast8` to avoid re-initialization on every request
- **Race protection**: `sessionSetupInProgress` flag prevents double-init when `CHAT_CHANGED` fires multiple times
- **Swipe handling**: `onCharResponse` only stores the message if it's the latest in the chat (skips swiped-away responses)
- **Graceful failure**: All Honcho errors are caught and logged — they never block generation

---

## Testing Guide

### Prerequisites

1. A Honcho API key from https://app.honcho.dev
2. Your Honcho workspace ID
3. SillyTavern running locally (this was built against the `staging` branch)

### Setup Steps

#### 1. Enable Server Plugins

Edit your SillyTavern `config.yaml` (create one by copying `default/config.yaml` if it doesn't exist):

```yaml
enableServerPlugins: true
```

#### 2. Symlink the Plugin

If you cloned the repo separately (not via SillyTavern's extension installer):

```bash
# From SillyTavern root:
ln -s /path/to/sillytavern-honcho/plugin plugins/honcho-proxy
ln -s /path/to/sillytavern-honcho public/scripts/extensions/third-party/sillytavern-honcho
```

These symlinks already exist if the implementation was done in-place.

#### 3. Install Plugin Dependencies

```bash
cd plugins/honcho-proxy
npm install
```

#### 4. Start SillyTavern

```bash
node server.js
# or
npm start
```

**Check console for**: `[honcho-proxy] Honcho SDK loaded successfully` followed by `[honcho-proxy] Plugin initialized with 5 routes`

If you see `@honcho-ai/sdk not found`, the npm install in step 3 didn't work.

### Verification Checklist

#### A. Plugin Loading

- [ ] Start SillyTavern and confirm `[honcho-proxy] Plugin initialized with 5 routes` appears in the server console

#### B. Extension Settings

- [ ] Open SillyTavern in your browser
- [ ] Go to Extensions panel (puzzle piece icon)
- [ ] Find "Honcho Memory" drawer and expand it
- [ ] Status should show "Not ready: disabled, no workspace ID, no API key"
- [ ] Check "Enable Honcho Memory"
- [ ] Click the API key field → set your Honcho API key
- [ ] Enter your workspace ID
- [ ] Status should change to "Ready"

#### C. Session Creation

- [ ] Open any chat with a character
- [ ] Open browser DevTools console (F12)
- [ ] Look for `[Honcho] Session ready for chat: <chat-id>`
- [ ] Verify `chat_metadata.honcho` exists:
  ```javascript
  // In browser console:
  JSON.stringify(SillyTavern.getContext().chat_metadata.honcho);
  ```
  Should return something like:
  ```json
  {
    "sessionId": "char_name_chat_id",
    "userPeerId": "st-user-User",
    "charPeerId": "char_avatar.png"
  }
  ```

#### D. Message Storage

- [ ] Send a message in the chat
- [ ] Check server console for any errors on `POST /session/messages`
- [ ] Wait for AI response
- [ ] Check server console again — both user and AI messages should be stored

#### E. Pre-fetch Context Injection

- [ ] Ensure context mode is set to "Pre-fetch" (default)
- [ ] Add a query like "What do you know about the user?" in the queries textarea
- [ ] Send a few messages to build up some conversation history
- [ ] On next generation, check browser console for Honcho context injection
- [ ] To inspect the injected prompt, use SillyTavern's Prompt Manager (if available) or check:
  ```javascript
  // In browser console:
  SillyTavern.getContext().extensionPrompts.honcho;
  ```

#### F. Tool Call Mode

- [ ] Switch context mode to "Tool call" in settings
- [ ] Ensure your selected LLM API supports function calling (OpenAI, Claude, etc.)
- [ ] Start a generation — the `honcho_query_memory` tool should appear in the API request's function definitions
- [ ] The LLM may or may not invoke it depending on the conversation context

#### G. Context() Mode

- [ ] Switch context mode to "Context()"
- [ ] Set a token budget (default: 2000)
- [ ] Toggle "Include session summary" as desired
- [ ] Send a message — Honcho's session context will be fetched and injected

#### H. Peer Mode

- [ ] Switch between "Single peer" and "Separate peer per persona"
- [ ] Change personas and open a new chat
- [ ] Check `chat_metadata.honcho.userPeerId` — it should change based on the mode:
  - Single: `st-user-{name}` (stable)
  - Per-persona: persona avatar filename

#### I. Group Chats

- [ ] Open a group chat
- [ ] Check that `chat_metadata.honcho.charPeerId` is `group-{groupId}`

### Troubleshooting

| Symptom                            | Cause                         | Fix                                                                                         |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| No "Honcho Memory" in Extensions   | Extension not discovered      | Verify symlink: `ls public/scripts/extensions/third-party/sillytavern-honcho/manifest.json` |
| Plugin not initializing            | `enableServerPlugins` not set | Add `enableServerPlugins: true` to `config.yaml` and restart                                |
| 403 on all plugin requests         | No API key configured         | Set the Honcho API key via the extension settings UI                                        |
| 404 on plugin requests             | Plugin not loaded             | Check server logs at startup; verify symlink in `plugins/`                                  |
| SDK import error                   | Dependencies not installed    | Run `cd plugins/honcho-proxy && npm install`                                                |
| Extension loads but no events fire | Extension disabled            | Check the "Enable" checkbox and ensure workspace ID is set                                  |
| Messages not stored                | Session not initialized       | Open DevTools, check for `[Honcho] Session ready` log on chat open                          |

### File Locations Reference

```
SillyTavern/
├── config.yaml                                          ← enableServerPlugins: true
├── plugins/
│   └── honcho-proxy -> .../sillytavern-honcho/plugin/   ← symlink
├── public/scripts/
│   ├── secrets.js                                       ← HONCHO key added
│   └── extensions/third-party/
│       └── sillytavern-honcho -> .../sillytavern-honcho/ ← symlink
└── src/endpoints/
    └── secrets.js                                       ← HONCHO key added

sillytavern-honcho/                                      ← new repo
├── manifest.json
├── index.js                                             ← client extension
├── settings.html
├── style.css
└── plugin/
    ├── package.json
    └── index.js                                         ← server plugin
```
