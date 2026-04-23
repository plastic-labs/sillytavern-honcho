# Contributing to sillytavern-honcho

This file is for developers working on the Honcho memory integration for SillyTavern — not for end users. If you just want to install the extension, see the [integration guide](https://docs.honcho.dev/v3/guides/integrations/sillytavern).

## Why a local-clone install (not `install.sh`)

`install.sh` is for end users. It `git clone`s the extension into SillyTavern's directory tree, which is the right call for someone who just wants the integration running — but wrong for anyone editing the code. Live edits need symlinks so changes appear immediately in SillyTavern without re-running the installer.

The dev-install path below uses symlinks for both the extension and the plugin.

## Prerequisites

- Node.js >= 18
- A Honcho instance (local or cloud)
- A Honcho API key from [app.honcho.dev](https://app.honcho.dev)

## Dev install

```bash
# 1. Clone both repos
git clone https://github.com/plastic-labs/sillytavern-honcho.git
git clone --branch staging https://github.com/SillyTavern/SillyTavern.git

# 2. Install SillyTavern's own dependencies (its setup docs require this)
cd SillyTavern && npm install && cd ..

# 3. Symlink the extension and plugin into SillyTavern
ln -s "$(pwd)/sillytavern-honcho" \
      "$(pwd)/SillyTavern/public/scripts/extensions/third-party/sillytavern-honcho"
ln -s "$(pwd)/sillytavern-honcho/plugin" \
      "$(pwd)/SillyTavern/plugins/honcho-proxy"

# 4. Install plugin dependencies
cd SillyTavern/plugins/honcho-proxy && npm install && cd ../..

# 5. Create and configure config.yaml
# SillyTavern ships its default config under default/config.yaml (not at root as
# config.yaml.example). Copy it to the root, then enable server plugins.
cp SillyTavern/default/config.yaml SillyTavern/config.yaml
sed -i '' 's/enableServerPlugins: false/enableServerPlugins: true/' SillyTavern/config.yaml

# 6. Apply SillyTavern core patches — see "Core patches" below
# (required for the in-app Extensions-panel API-key flow; NOT required
#  if you only configure via ~/.honcho/config.json)

# 7. Boot SillyTavern
cd SillyTavern && ./start.sh
```

Open `http://localhost:8000`, go to Extensions (puzzle piece icon), expand "Honcho Memory," set your API key + workspace.

## Repo layout

```text
sillytavern-honcho/
├── manifest.json          SillyTavern extension manifest
├── index.js               Client-side (browser) extension
├── settings.html          Extension settings UI
├── style.css              Styling
├── install.sh             End-user installer (macOS/Linux)
├── install.ps1            End-user installer (Windows)
├── plugin/
│   ├── index.js           Server-side (Node) plugin
│   └── package.json       Plugin dependencies (@honcho-ai/sdk)
└── skills/
    └── setup/SKILL.md     AI-agent-assisted install skill (Claude Code)
```

## Core patches

The extension references `SECRET_KEYS.HONCHO` at `index.js:75` and `plugin/index.js:152`. Stock SillyTavern doesn't define this key. Until an upstream SillyTavern PR adds it, you need to patch three lines manually:

**`SillyTavern/src/endpoints/secrets.js`** — insert before the closing `};` of the `SECRET_KEYS` object:

```js
    HONCHO: 'api_key_honcho',
```

**`SillyTavern/public/scripts/secrets.js`** — two inserts:

```js
// In SECRET_KEYS — insert before the closing `};`:
    HONCHO: 'api_key_honcho',

// In FRIENDLY_NAMES — insert before the closing `};`:
    [SECRET_KEYS.HONCHO]: 'Honcho AI',
```

> **Note:** SillyTavern evolves — the last entry in `SECRET_KEYS` may change across staging commits. Insert before the closing `};` structurally; don't anchor to a specific neighbor key (a `grep -q` precheck also makes the patch idempotent).

The skill at `skills/setup/SKILL.md` automates these patches for Claude Code users.

### Do I actually need the patches?

- **Path 1 — global config (`~/.honcho/config.json`):** no patches needed. The plugin falls back to this file if `SECRET_KEYS.HONCHO` is undefined.
- **Path 2 — in-app API key via SillyTavern Extensions panel:** patches required. Without them, the panel's API key input silently fails to persist.

## Testing changes

Before approving a PR or shipping a change:

- [ ] Install path runs end-to-end on a clean SillyTavern clone
- [ ] Extensions panel shows "Honcho Memory" with a Ready status indicator
- [ ] Messages round-trip to Honcho (check writes via dashboard or plugin logs)
- [ ] All three enrichment modes: Context only, Reasoning, Tool Call
- [ ] Both peer modes: single peer, per-persona — verify isolation claim
- [ ] Session persistence: close chat, reopen, memory survives
- [ ] Failure modes: invalid API key, Honcho unreachable, persona switch mid-session, long context

## PR conventions

Follows Plastic Labs house style ([Conventional Commits](https://www.conventionalcommits.org/)):

- **Title:** `<type>(<scope>): <description>` — types: `feat`, `fix`, `docs`, `chore`. Scope optional.
- **Branch:** `<firstname>/<slug-or-ticket>` for internal contributors; `<type>/<slug>` for external.

## Uninstall (dev install)

Tear down the symlinked install + revert core patches. Run from the parent directory containing both checkouts.

```bash
# Remove symlinks
rm -f SillyTavern/public/scripts/extensions/third-party/sillytavern-honcho
rm -f SillyTavern/plugins/honcho-proxy

# Revert core patches (idempotent — no-op if not applied)
sed -i '' "/HONCHO: 'api_key_honcho',/d"            SillyTavern/src/endpoints/secrets.js
sed -i '' "/HONCHO: 'api_key_honcho',/d"            SillyTavern/public/scripts/secrets.js
sed -i '' "/\[SECRET_KEYS.HONCHO\]: 'Honcho AI',/d" SillyTavern/public/scripts/secrets.js

# Optional: disable server plugins again
sed -i '' 's/enableServerPlugins: true/enableServerPlugins: false/' SillyTavern/config.yaml
```

For the agent-automated version with `grep -q` prechecks, see [`skills/setup/SKILL.md`](skills/setup/SKILL.md) under "Uninstall."

## Questions or stuck?

File an issue, or comment on the relevant PR / Linear issue.
