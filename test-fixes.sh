#!/usr/bin/env bash
# test-fixes.sh — offline smoke tests for CodeRabbit fixes
# Tests: hash fix, sanitizeId, plugin config seeding, install.sh validation, pendingChatId queue
set -uo pipefail

PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; ((PASS++)) || true; }
fail() { echo "  FAIL  $1"; ((FAIL++)) || true; }

run_node() {
    node --input-type=module 2>&1
}

separator() { echo; echo "── $1 ──────────────────────────────────"; }

# ── 1. Hash fix ──────────────────────────────────────────────

separator "1. Hash fix (Math.abs, no hyphens in session IDs)"

node --input-type=module <<'EOF'
// Reproduce the exact logic from index.js onChatChanged()
function sessionHash(rawChatId) {
    return Math.abs(
        Array.from(rawChatId).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
    ).toString(36);
}

const inputs = [
    'Seraphina - 2025-01-14 @20:41:27',
    'chat-2024-12-01 12:00:00',
    'a',
    'x'.repeat(100),
    '!@#$%^&*()',
    'Aria - 2025-04-13 @09:15:00',
    'default - 2025-01-01 @00:00:00',
    '',
    // These specific strings are known to produce negative djb2 values
    'abcdefghijklmnopqrstuvwxyz0123456789',
    'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
];

let ok = true;
for (const s of inputs) {
    const hash = sessionHash(s);
    if (hash.includes('-')) {
        console.error('  FAIL: hash contains hyphen for', JSON.stringify(s), '->', hash);
        ok = false;
    }
    if (!/^[a-z0-9]+$/.test(hash)) {
        console.error('  FAIL: hash is not alphanumeric for', JSON.stringify(s), '->', hash);
        ok = false;
    }
}
// Determinism check
const h1 = sessionHash('Seraphina - 2025-01-14 @20:41:27');
const h2 = sessionHash('Seraphina - 2025-01-14 @20:41:27');
if (h1 !== h2) { console.error('  FAIL: hash is not deterministic'); ok = false; }

process.exit(ok ? 0 : 1);
EOF
[[ $? -eq 0 ]] && ok "hash is always non-negative alphanumeric" || fail "hash contains hyphens or non-alphanumeric chars"

# ── 2. sanitizeId ────────────────────────────────────────────

separator "2. sanitizeId edge cases"

node --input-type=module <<'EOF'
function sanitizeId(str) {
    const cleaned = str.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return cleaned || 'unnamed';
}

const cases = [
    ['',            'unnamed'],
    ['!!!',         'unnamed'],
    ['   ',         'unnamed'],
    ['hello world', 'hello_world'],
    ['  leading',   'leading'],
    ['trailing  ',  'trailing'],
    ['hello-world', 'hello-world'],
    ['eri',         'eri'],
    ['__foo__',     'foo'],
    ['a!b@c#d',     'a_b_c_d'],
    ['a___b',       'a_b'],
];

let ok = true;
for (const [input, expected] of cases) {
    const result = sanitizeId(input);
    if (result !== expected) {
        console.error(`  FAIL: sanitizeId(${JSON.stringify(input)}) = ${JSON.stringify(result)}, want ${JSON.stringify(expected)}`);
        ok = false;
    }
}
process.exit(ok ? 0 : 1);
EOF
[[ $? -eq 0 ]] && ok "sanitizeId handles all edge cases" || fail "sanitizeId produced wrong output"

# ── 3. Plugin config seeding (first run) ─────────────────────

separator "3. Plugin config seeding — first run (no existing config)"

TMPDIR_CONFIG=$(mktemp -d)
HOME="$TMPDIR_CONFIG" node --input-type=module <<'EOF'
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.honcho', 'config.json');

function loadGlobalConfig() {
    try { return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')); } catch { return null; }
}
function saveGlobalConfig(cfg) {
    const dir = path.dirname(GLOBAL_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// Reproduce plugin/index.js init() logic
let globalConfig = loadGlobalConfig();
if (!globalConfig) {
    globalConfig = { hosts: { sillytavern: {} } };
    saveGlobalConfig(globalConfig);
}

// Verify
if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
    console.error('  FAIL: config file was not created');
    process.exit(1);
}
const written = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
if (!written.hosts?.sillytavern) {
    console.error('  FAIL: hosts.sillytavern not present in seeded config');
    process.exit(1);
}
process.exit(0);
EOF
[[ $? -eq 0 ]] && ok "config file created with hosts.sillytavern on first run" || fail "config file not created or malformed"
rm -rf "$TMPDIR_CONFIG"

# ── 4. Plugin config seeding — existing config preserved ─────

separator "4. Plugin config seeding — existing config not overwritten"

TMPDIR_CONFIG=$(mktemp -d)
mkdir -p "$TMPDIR_CONFIG/.honcho"
cat > "$TMPDIR_CONFIG/.honcho/config.json" <<'JSON'
{
  "apiKey": "test-key-123",
  "workspace": "my-workspace",
  "hosts": { "sillytavern": { "peerName": "eri" } }
}
JSON

HOME="$TMPDIR_CONFIG" node --input-type=module <<'EOF'
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.honcho', 'config.json');

function loadGlobalConfig() {
    try { return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8')); } catch { return null; }
}
function saveGlobalConfig(cfg) {
    const dir = path.dirname(GLOBAL_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// Reproduce plugin/index.js init() logic
let globalConfig = loadGlobalConfig();
if (!globalConfig) {
    globalConfig = { hosts: { sillytavern: {} } };
    saveGlobalConfig(globalConfig);
}

// Existing config should be untouched
const existing = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
if (existing.apiKey !== 'test-key-123') {
    console.error('  FAIL: apiKey was clobbered, got', existing.apiKey);
    process.exit(1);
}
if (existing.hosts?.sillytavern?.peerName !== 'eri') {
    console.error('  FAIL: peerName was clobbered');
    process.exit(1);
}
process.exit(0);
EOF
[[ $? -eq 0 ]] && ok "existing config preserved, not overwritten" || fail "existing config was clobbered"
rm -rf "$TMPDIR_CONFIG"

# ── 5. install.sh validation logic ───────────────────────────

separator "5. install.sh validation (|| logic)"

check_st_dir() {
    local dir="$1"
    if [[ ! -f "$dir/server.js" ]] || [[ ! -f "$dir/package.json" ]]; then
        return 1
    fi
    return 0
}

# Case 1: empty dir — should reject
d=$(mktemp -d)
check_st_dir "$d" && fail "accepted empty dir (no files)" || ok "rejected empty dir"
rm -rf "$d"

# Case 2: only server.js — should reject (missing package.json)
d=$(mktemp -d)
touch "$d/server.js"
check_st_dir "$d" && fail "accepted dir with only server.js" || ok "rejected dir with only server.js"
rm -rf "$d"

# Case 3: only package.json — should reject (missing server.js)
d=$(mktemp -d)
touch "$d/package.json"
check_st_dir "$d" && fail "accepted dir with only package.json" || ok "rejected dir with only package.json"
rm -rf "$d"

# Case 4: both files — should accept
d=$(mktemp -d)
touch "$d/server.js" "$d/package.json"
check_st_dir "$d" && ok "accepted dir with both files" || fail "rejected valid SillyTavern dir"
rm -rf "$d"

# ── 6. pendingChatId queue-one behavior ──────────────────────

separator "6. pendingChatId — queue-one, last-chat-wins"

node --input-type=module <<'EOF'
// Simulate the sessionSetupInProgress + pendingChatId pattern from index.js onChatChanged()
let sessionSetupInProgress = false;
let pendingChatId = null;
const processed = [];

async function onChatChanged(rawChatId) {
    if (sessionSetupInProgress) {
        pendingChatId = rawChatId;
        return;
    }
    sessionSetupInProgress = true;
    try {
        await new Promise(r => setTimeout(r, 40)); // simulate async peer/session setup
        processed.push(rawChatId);
    } finally {
        sessionSetupInProgress = false;
        if (pendingChatId) {
            const next = pendingChatId;
            pendingChatId = null;
            await onChatChanged(next);
        }
    }
}

// Fire A, B, C in rapid succession
// A starts immediately, B queues, C overwrites B
onChatChanged('A');
onChatChanged('B'); // queued
onChatChanged('C'); // overwrites B — last-wins

await new Promise(r => setTimeout(r, 200));

// Expected: A processed, then C processed (B silently dropped — correct)
const expected = JSON.stringify(['A', 'C']);
const actual = JSON.stringify(processed);
if (actual !== expected) {
    console.error('  FAIL: expected', expected, 'got', actual);
    process.exit(1);
}

// Also verify: with no overlap, sequential calls all process
sessionSetupInProgress = false;
pendingChatId = null;
processed.length = 0;

await onChatChanged('X');
await onChatChanged('Y');
if (JSON.stringify(processed) !== JSON.stringify(['X', 'Y'])) {
    console.error('  FAIL: sequential calls not all processed:', processed);
    process.exit(1);
}
process.exit(0);
EOF
[[ $? -eq 0 ]] && ok "concurrent: A+C processed, B correctly dropped (last-wins)" || fail "pendingChatId queue behavior wrong"

# ── Summary ──────────────────────────────────────────────────

echo
echo "────────────────────────────────────────────"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "────────────────────────────────────────────"
echo
if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
