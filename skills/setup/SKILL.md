---
name: sillytavern-honcho-setup
description: Install the Honcho Memory extension + plugin into a SillyTavern checkout. Use when installing, re-installing, or troubleshooting the integration — including on a fresh SillyTavern checkout. Safe to re-run; every patch step is idempotent.
allowed-tools: Read, Glob, Grep, Bash(npm:*), Bash(node:*), Bash(ln:*), Bash(ls:*), Bash(cd:*), Bash(cat:*), Bash(mkdir:*), Bash(cp:*), Bash(rm:*), Bash(git:*), Bash(curl:*), Bash(lsof:*), Bash(pgrep:*), Bash(pkill:*), Bash(kill:*), Bash(sleep:*), Edit, Write, AskUserQuestion
user-invocable: true
---

# Install the Honcho Memory extension into SillyTavern

- Follow each phase in order. Do not skip preflight.
- Verify every patch is idempotent with `grep -q` before running the Edit.
- If any phase fails, stop and surface the failure — do not route around it.

## When to use / can be skipped

Use when: setting up the integration on a new SillyTavern checkout, re-installing after a failed attempt, or diagnosing a broken install.

Skip when: the install is already verified working (Phase 4 smoke test passes) and you don't need to change configuration.

## Skill discoverability (read this before invoking)

This skill lives inside the `sillytavern-honcho` repo at `skills/setup/SKILL.md`. Claude Code does not auto-discover it. To invoke as `/sillytavern-honcho-setup` in a new session, either:

1. **Symlink into the project's `.claude/skills/` directory**, then restart the Claude Code session:
   ```bash
   mkdir -p <cwd>/.claude/skills/sillytavern-honcho-setup
   ln -sf <repo>/skills/setup/SKILL.md \
          <cwd>/.claude/skills/sillytavern-honcho-setup/SKILL.md
   ```
2. **Or read the file directly** and execute each phase as a checklist (what Path B's executor fell back to).

The repo's README should document option 1 as the supported path.

## Phase 0 — Preflight

Run these checks in parallel. If any fails, stop and report — do not proceed.

```bash
node --version                               # require >= 18
git --version                                # required
[[ -d "$ST_DIR" ]] && git -C "$ST_DIR" status --short   # expect clean tree
[[ -d "$SH_DIR" ]] && git -C "$SH_DIR" branch --show-current  # capture branch for logs
lsof -i :8000 -P 2>/dev/null | grep LISTEN   # detect pre-existing SillyTavern
[[ -f ~/.honcho/config.json ]] && echo "global config present"
```

Where:
- `$ST_DIR` = SillyTavern checkout. Ask the user if not set.
- `$SH_DIR` = `sillytavern-honcho` checkout. Ask the user if not set.

### Gate: pre-existing SillyTavern on port 8000

If port 8000 is already listening, ask the user before proceeding. Running this skill will start a new server on the same port and can clobber their live session.

Use **AskUserQuestion**: "A SillyTavern instance is already running on port 8000 (PID `<pid>`). I'll need to stop it to complete this install. Stop it? [yes / no — I'll pick a different port]".

If the user picks a different port, export `ST_PORT=8099` and add `--port $ST_PORT` to every subsequent `npm start` / `node server.js` call.

### Gate: existing vs cold-start user

Use **AskUserQuestion** with two options:

- **Existing Honcho user** — "I already use Honcho in another tool (Claude Code, Cursor, Hermes). I have `~/.honcho/config.json` with a real API key and workspace." → Phase 5 Branch A.
- **Cold-start user** — "First time using Honcho. I'll need to enter an API key and workspace ID by hand." → Phase 5 Branch B.

If `~/.honcho/config.json` is absent OR present but `hosts.sillytavern = {}` AND no root-level `apiKey`, treat the user as cold-start regardless of answer — the file won't help the plugin resolve a key.

## Phase 1 — SillyTavern baseline and `config.yaml`

### 1.1 Install dependencies

```bash
cd "$ST_DIR" && npm install
```

Expect `npm warn` lines and a vulnerability count. Skill does not fix these; they're upstream. Note: v1 claimed a `postinstall` script copies `default/config.yaml` → `config.yaml`. That is not true on current SillyTavern. See 1.2.

### 1.2 Generate `config.yaml`

`config.yaml` is created by SillyTavern's server on first launch, not by `npm install`. Start the server once to generate it, then stop.

```bash
cd "$ST_DIR" && npm start > /tmp/silly-first-launch.log 2>&1 &
ST_PID=$!
# Wait for config.yaml to appear, up to 30s
for _ in $(seq 1 30); do [[ -f "$ST_DIR/config.yaml" ]] && break; sleep 1; done
kill "$ST_PID" 2>/dev/null
sleep 2
pkill -f "node.*server.js" 2>/dev/null || true
[[ -f "$ST_DIR/config.yaml" ]] || { echo "config.yaml did not appear — abort"; exit 1; }
```

### 1.3 Enable server plugins; disable auto-update

Two edits in `config.yaml`. Both are idempotent (precheck before editing).

```bash
cd "$ST_DIR"
grep -q '^enableServerPlugins: true'             config.yaml || \
  sed -i '' 's/^enableServerPlugins: false/enableServerPlugins: true/' config.yaml
grep -q '^enableServerPluginsAutoUpdate: false'  config.yaml || \
  sed -i '' 's/^enableServerPluginsAutoUpdate: true/enableServerPluginsAutoUpdate: false/' config.yaml
```

Why disable auto-update: this install symlinks a local dev checkout of `sillytavern-honcho`. If auto-update is on, SillyTavern tries to `git pull` that checkout on every boot, which surprises anyone actively editing the repo. Re-enable after shipping.

Verify:

```bash
grep -E '^enableServerPlugins(|AutoUpdate):' config.yaml
# expect: enableServerPlugins: true
#         enableServerPluginsAutoUpdate: false
```

## Phase 2 — Apply core patches (idempotent)

These add a `HONCHO` entry to SillyTavern's `SECRET_KEYS` object in two files, plus a `FRIENDLY_NAMES` entry on the client side. They're required for the Extensions-panel API-key input (SillyTavern secret manager) to persist a key. Not required for the plugin to load, and not required for the `~/.honcho/config.json` config path.

### 2.1 Server-side `SECRET_KEYS`

```bash
cd "$ST_DIR"
if ! grep -q "HONCHO: 'api_key_honcho'" src/endpoints/secrets.js; then
  # Insert before the closing `};` of the SECRET_KEYS object (the first `};` in the file)
  # v1 pinned this to a specific neighbor key (VOLCENGINE_ACCESS_KEY). Current staging
  # has WORKERS_AI last — the neighbor drifts. Patch by structure, not neighbor name.
  awk '
    /^export const SECRET_KEYS = \{/ { in_sk=1 }
    in_sk && /^\};/ && !done { print "    HONCHO: '\''api_key_honcho'\'',"; in_sk=0; done=1 }
    { print }
  ' src/endpoints/secrets.js > src/endpoints/secrets.js.new && mv src/endpoints/secrets.js.new src/endpoints/secrets.js
fi
grep -q "HONCHO: 'api_key_honcho'" src/endpoints/secrets.js   # verify
```

### 2.2 Client-side `SECRET_KEYS` and `FRIENDLY_NAMES`

Two inserts in `public/scripts/secrets.js`. Same idempotency pattern.

```bash
cd "$ST_DIR"
# SECRET_KEYS insert — first `};` after the SECRET_KEYS open
if ! grep -q "HONCHO: 'api_key_honcho'" public/scripts/secrets.js; then
  awk '
    /^export const SECRET_KEYS = \{/ { in_sk=1 }
    in_sk && /^\};/ && !sk_done { print "    HONCHO: '\''api_key_honcho'\'',"; in_sk=0; sk_done=1 }
    { print }
  ' public/scripts/secrets.js > public/scripts/secrets.js.new && mv public/scripts/secrets.js.new public/scripts/secrets.js
fi
# FRIENDLY_NAMES insert — second `};`, scoped to the FRIENDLY_NAMES block
if ! grep -q "\[SECRET_KEYS.HONCHO\]: 'Honcho AI'" public/scripts/secrets.js; then
  awk '
    /^const FRIENDLY_NAMES = \{/ { in_fn=1 }
    in_fn && /^\};/ && !fn_done { print "    [SECRET_KEYS.HONCHO]: '\''Honcho AI'\'',"; in_fn=0; fn_done=1 }
    { print }
  ' public/scripts/secrets.js > public/scripts/secrets.js.new && mv public/scripts/secrets.js.new public/scripts/secrets.js
fi
grep -c 'HONCHO' public/scripts/secrets.js   # expect >= 2
```

## Phase 3 — Install extension and plugin

### 3.1 Symlink extension

```bash
cd "$ST_DIR"
EXT_DIR="public/scripts/extensions/third-party/sillytavern-honcho"
if [[ ! -e "$EXT_DIR" ]]; then
  mkdir -p "$(dirname "$EXT_DIR")"
  ln -s "$SH_DIR" "$EXT_DIR"
fi
[[ -f "$EXT_DIR/manifest.json" ]] || { echo "manifest.json unreachable — abort"; exit 1; }
```

### 3.2 Symlink plugin + install SDK

```bash
cd "$ST_DIR"
if [[ ! -e "plugins/honcho-proxy" ]]; then
  ln -s "$SH_DIR/plugin" "plugins/honcho-proxy"
fi
[[ -f "plugins/honcho-proxy/index.js" ]] || { echo "plugin index.js unreachable — abort"; exit 1; }

# Install once; npm install is idempotent
( cd "plugins/honcho-proxy" && npm install )
[[ -f "plugins/honcho-proxy/node_modules/@honcho-ai/sdk/package.json" ]] || { echo "SDK install failed"; exit 1; }
```

## Phase 4 — Start and verify (programmatic, no browser)

### 4.1 Start the server

```bash
cd "$ST_DIR"
rm -f /tmp/silly-server.log
npm start > /tmp/silly-server.log 2>&1 &
ST_PID=$!
# Wait for "listening" line, up to 30s
for _ in $(seq 1 30); do grep -q "is listening on" /tmp/silly-server.log && break; sleep 1; done
```

### 4.2 Verify plugin loaded (substring match only)

v1 grepped for `"Honcho SDK loaded successfully"` and `"Plugin initialized with 5 routes"`. Both are brittle. Check substrings instead.

```bash
grep -q "\[honcho-proxy\] Honcho SDK loaded"  /tmp/silly-server.log || { echo "plugin did not load"; exit 1; }
grep -q "\[honcho-proxy\] Plugin initialized" /tmp/silly-server.log || { echo "plugin failed to init"; exit 1; }
grep "\[honcho-proxy\]" /tmp/silly-server.log  # surface any other messages for the user
```

### 4.3 Verify extension served

```bash
PORT="${ST_PORT:-8000}"
for f in manifest.json settings.html index.js style.css; do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    "http://127.0.0.1:$PORT/scripts/extensions/third-party/sillytavern-honcho/$f")
  [[ "$code" == "200" ]] || { echo "$f returned $code — abort"; exit 1; }
done
```

### 4.4 Verify plugin route is mounted

A POST with a bogus workspaceId should return 403/400/500, not 404. A 404 means the route isn't mounted.

```bash
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"workspaceId":"smoke","peerId":"smoke"}' \
  "http://127.0.0.1:$PORT/api/plugins/honcho-proxy/peer")
[[ "$code" != "404" ]] || { echo "plugin route not mounted — abort"; exit 1; }
echo "plugin route mounted (HTTP $code — expected 400/403/500 without CSRF+key)"
```

## Phase 5 — Configuration (branch on user type)

### Branch A — Existing Honcho user

The plugin reads `~/.honcho/config.json` at startup. Confirm the keys it actually uses are resolvable:

```bash
python3 -c '
import json, sys
d = json.load(open(open("/dev/stdin").name))
h = d.get("hosts", {}).get("sillytavern", {})
ok = bool(h.get("apiKey") or d.get("apiKey"))
print("resolvable" if ok else "EMPTY — treat as cold-start", file=sys.stderr)
sys.exit(0 if ok else 1)
' < ~/.honcho/config.json
```

If the check prints `EMPTY — treat as cold-start`, jump to Branch B. "Auto-populated" is a false promise when `hosts.sillytavern = {}` with no root-level fallback.

If resolvable, no further config action — the plugin will read the keys on startup. Verify with a real API call in Phase 6.

### Branch B — Cold-start user

Use **AskUserQuestion** twice:

1. "Paste your Honcho API key from https://app.honcho.dev (stored only in SillyTavern's secret manager, never logged)." → save as `HONCHO_API_KEY`.
2. "Enter your Honcho workspace ID (e.g. `sillytavern`, or copy from your Honcho dashboard)." → save as `HONCHO_WORKSPACE_ID`.

Entry happens in the SillyTavern UI (Phase 6, browser step) — this skill does not POST the key to the plugin directly because the SillyTavern secret manager is the intended persistence surface and hitting it from the CLI requires an authenticated session cookie. Surface both values to the user when they open the browser.

## Phase 6 — End-to-end verification

### 6.1 Agent-path verification (required — no browser)

Round-trip a real request through the plugin. Requires the user's Honcho API key.

```bash
# Obtain a CSRF token by hitting the root — SillyTavern returns it in a cookie/header
# pattern, then POST with it. (If SillyTavern's single-user mode skips CSRF, adjust.)
PORT="${ST_PORT:-8000}"
# Minimal probe: hit /chat with a known-bad workspace to confirm the SDK initializes
# without throwing and returns a structured Honcho error (not a crash).
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: <captured>" \
  -d "{\"workspaceId\":\"$HONCHO_WORKSPACE_ID\",\"peerId\":\"smoke-test-peer\",\"query\":\"hello\"}" \
  "http://127.0.0.1:$PORT/api/plugins/honcho-proxy/chat" | tee /tmp/honcho-probe.json
```

Success criteria:
- HTTP 200 with a non-empty JSON body, OR
- HTTP 4xx/5xx with a structured Honcho error message (not a stack trace, not "ECONNREFUSED").

If the probe returns a stack trace or connection refused, Honcho is unreachable or the SDK failed to initialize — stop and report.

### 6.2 Browser-path verification (recommended)

Some of the skill's guarantees (drawer render, status indicator, UI-entered key persistence) can only be verified in a browser. Surface this to the user:

> Open http://127.0.0.1:$PORT in your browser. Click the puzzle-piece icon (top-right) → Extensions → expand "Honcho Memory". Check **Enable**. Click the API Key field and paste `$HONCHO_API_KEY`. Enter `$HONCHO_WORKSPACE_ID` in the Workspace ID field. Status should change from "Not ready" to "Ready". Open any character chat, send "hello", and watch the browser DevTools console for `[Honcho] Session ready for chat: ...`.

The skill's agent-path stop condition is Phase 6.1 passing. Browser-path is user-driven and optional from the agent's perspective.

## Troubleshooting

| Symptom | Most likely cause | Fix |
|---|---|---|
| `config.yaml did not appear — abort` in 1.2 | SillyTavern server failed to start | Read `/tmp/silly-first-launch.log` — usually missing Node modules (rerun 1.1) |
| `sed: config.yaml: No such file` | 1.2 skipped | Run 1.2 before 1.3 |
| Phase 2 patch inserted twice | `grep -q` precheck failed to match due to whitespace | Open the file, remove the duplicate line, rerun from Phase 2 |
| `plugin did not load` in 4.2 | `enableServerPlugins: false` OR plugin symlink broken | Re-verify 1.3 and 3.2; check `/tmp/silly-server.log` for symlink errors |
| 4.3 returns 404 for manifest | Extension symlink target doesn't resolve | `ls -la "$EXT_DIR"` to confirm target; `readlink` the path |
| 4.4 returns 404 | Plugin not mounted by SillyTavern | Confirm `plugins/honcho-proxy/info.id === "honcho-proxy"` and server was restarted after Phase 3 |
| 6.1 ECONNREFUSED to Honcho | Honcho unreachable or wrong base URL | Verify Honcho dashboard is up; check API key; check `HONCHO_BASE_URL` env if set |
| "Auto-populated" message misleading | `hosts.sillytavern = {}` with no root fallback | Treat as cold-start; enter key via UI |

## Uninstall (appendix)

```bash
cd "$ST_DIR"
rm -f plugins/honcho-proxy
rm -f public/scripts/extensions/third-party/sillytavern-honcho

# Revert the two edits (idempotent — grep-guarded)
sed -i '' "/HONCHO: 'api_key_honcho',/d"              src/endpoints/secrets.js
sed -i '' "/HONCHO: 'api_key_honcho',/d"              public/scripts/secrets.js
sed -i '' "/\[SECRET_KEYS.HONCHO\]: 'Honcho AI',/d"   public/scripts/secrets.js

# Optional: revert config.yaml changes
grep -q '^enableServerPlugins: false' config.yaml || \
  sed -i '' 's/^enableServerPlugins: true/enableServerPlugins: false/' config.yaml
```

## Anti-patterns (things this skill tends to get wrong)

| Anti-pattern | Correction |
|---|---|
| Assume `npm install` creates `config.yaml` | It doesn't. Phase 1.2 runs `npm start` briefly to generate it. |
| Patch by line number or neighbor key name | Anchors drift as SillyTavern adds keys. Patch by structure (first `};` inside the named object) and always `grep -q` before editing. |
| Grep for exact log strings like "loaded successfully" | The plugin's log wording changes. Use stable substrings (`\[honcho-proxy\] Honcho SDK loaded`). |
| Assert "5 routes" in the verification | The route count evolves. Don't assert it. |
| Kill SillyTavern on port 8000 without asking | The user may have a live chat session. Phase 0 asks first. |
| Skip Phase 6.1 because "the plugin loaded" | A loaded plugin can still fail to reach Honcho. The round-trip is the real stop condition. |
| Treat `~/.honcho/config.json` existence as "configured" | The plugin needs resolvable keys. Probe them; don't just stat the file. |
| Leave `enableServerPluginsAutoUpdate: true` on a dev install | Surprises anyone actively editing the symlinked repo. Set `false` during dev; flip back for release. |

## Handoff

After Phase 6 passes, the install is complete. For per-feature follow-ups (peer modes, context modes, chat-time event flow), refer to the extension's settings reference at `<repo>/README.md` or hand off to a future `sillytavern-honcho-tune` skill (not yet built).
