import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// Dynamic import from SillyTavern's source (resolves from process.cwd(), not symlink target)
const secretsPath = pathToFileURL(path.join(process.cwd(), 'src', 'endpoints', 'secrets.js')).href;
const { SecretManager, SECRET_KEYS } = await import(secretsPath);

export const info = {
    id: 'honcho-proxy',
    name: 'Honcho Memory Proxy',
    description: 'Proxies requests to the Honcho AI memory service',
};

/** @type {Map<string, import('@honcho-ai/sdk').Honcho>} */
const clientCache = new Map();

/** Global Honcho config loaded from ~/.honcho/config.json */
let globalConfig = null;

/**
 * Load the global Honcho config from ~/.honcho/config.json.
 * Returns the parsed config or null if not found/invalid.
 */
function loadGlobalConfig() {
    const configPath = path.join(os.homedir(), '.honcho', 'config.json');
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        console.log(`[honcho-proxy] Loaded global config from ${configPath}`);
        return config;
    } catch {
        return null;
    }
}

/** Path to the global config file */
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.honcho', 'config.json');

/**
 * Get config values for SillyTavern from the global config.
 * Reads: hosts.sillytavern first, falls back to root-level globals.
 * Writes: always scoped to hosts.sillytavern (never mutate root).
 */
function getGlobalConfigForST() {
    if (!globalConfig) return null;

    const stHost = globalConfig.hosts?.sillytavern;
    return {
        apiKey: globalConfig.apiKey || null,
        peerName: stHost?.peerName || globalConfig.peerName || null,
        enabled: globalConfig.enabled ?? false,
        workspace: stHost?.workspace || globalConfig.workspace || null,
        aiPeer: stHost?.aiPeer || null,
    };
}

/**
 * Re-read the global config from disk to avoid overwriting changes
 * made by other tools (claude-code, cursor, hermes, etc.).
 */
function refreshGlobalConfig() {
    const fresh = loadGlobalConfig();
    if (fresh) {
        globalConfig = fresh;
    }
}

/**
 * Write the current globalConfig back to ~/.honcho/config.json.
 * Creates the directory if needed.
 */
function saveGlobalConfig() {
    if (!globalConfig) return false;
    try {
        const dir = path.dirname(GLOBAL_CONFIG_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(globalConfig, null, 2) + '\n');
        return true;
    } catch (err) {
        console.error(`[honcho-proxy] Failed to save global config: ${err.message}`);
        return false;
    }
}

/**
 * Update the hosts.sillytavern entry in the global config.
 * Re-reads from disk first to avoid clobbering other tools' writes.
 */
function updateSTHost(updates) {
    refreshGlobalConfig();
    if (!globalConfig) return;

    if (!globalConfig.hosts) globalConfig.hosts = {};
    if (!globalConfig.hosts.sillytavern) globalConfig.hosts.sillytavern = {};

    Object.assign(globalConfig.hosts.sillytavern, updates);
    saveGlobalConfig();
}

/**
 * Register or update a session mapping in the global config.
 * Re-reads from disk first to avoid clobbering other tools' writes.
 */
function registerSession(sessionId) {
    refreshGlobalConfig();
    if (!globalConfig) return;

    if (!globalConfig.sessions) globalConfig.sessions = {};

    // Use SillyTavern's data directory as the key
    const stDir = process.cwd();
    const existing = globalConfig.sessions[stDir];

    // Only write if the session changed
    if (existing !== sessionId) {
        globalConfig.sessions[stDir] = sessionId;
        saveGlobalConfig();
    }
}

/**
 * @param {string} apiKey
 * @param {string} workspaceId
 * @returns {Promise<import('@honcho-ai/sdk').Honcho>}
 */
async function getClient(apiKey, workspaceId) {
    const cacheKey = `${workspaceId}:${apiKey.slice(-8)}`;
    if (clientCache.has(cacheKey)) {
        return clientCache.get(cacheKey);
    }

    const { Honcho } = await import('@honcho-ai/sdk');
    const client = new Honcho({ apiKey, workspaceId });
    clientCache.set(cacheKey, client);
    return client;
}

/**
 * Map an SDK/HTTP error to an HTTP status. SDK surfaces err.status when the
 * underlying call is HTTP-originating (401/403/404/429/etc). Timeout and
 * connection errors set err.status = 0 (no HTTP response received) — those
 * must NOT be passed to res.status() or Express throws RangeError.
 */
function statusFromSdkError(err) {
    if (!err) return 500;
    if (err.name === 'TimeoutError') return 504;
    if (typeof err.status === 'number' && err.status >= 400) return err.status;
    if (typeof err.status === 'number' && err.status <= 0) return 502;
    return 500;
}

/**
 * Extract Retry-After from an SDK error, if present. Returns a string
 * suitable for the Retry-After response header (per RFC 9110 §10.2.3 —
 * seconds-integer or HTTP-date).
 */
function retryAfterFromSdkError(err) {
    if (!err) return null;
    // Forward-defensive: Honcho SDK 2.0.1 doesn't attach .headers to errors,
    // but a future version may. Pass through raw header value if present.
    if (err.headers && typeof err.headers.get === 'function') {
        const v = err.headers.get('retry-after');
        if (v) return String(v);
    }
    // Honcho SDK's parseRetryAfter stores err.retryAfter as MILLISECONDS,
    // not seconds. RFC 9110 requires seconds-integer → divide and ceil.
    if (typeof err.retryAfter === 'number') {
        return String(Math.max(1, Math.ceil(err.retryAfter / 1000)));
    }
    return null;
}

/**
 * Send an SDK error as a structured HTTP response. Centralizes status mapping,
 * Retry-After surfacing, and error logging so every SDK-facing route catch
 * behaves identically. Middleware and non-SDK catches (saveGlobalConfig,
 * secret-read) intentionally don't route through this helper.
 * @param {import('express').Response} res
 * @param {unknown} err
 * @param {string} route - Route path for the log line (e.g. 'peer', 'session/messages')
 */
function sendError(res, err, route) {
    console.error(`[honcho-proxy] POST /${route} error:`, err.message);
    const status = statusFromSdkError(err);
    const retryAfter = retryAfterFromSdkError(err);
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    return res.status(status).json({
        error: err.message,
        ...(retryAfter ? { retryAfter } : {}),
    });
}

/**
 * Middleware to read Honcho API key from secrets (with global config fallback)
 * and validate request body.
 */
function honchoMiddleware(req, res, next) {
    // Skip middleware for config endpoints
    if (req.path === '/config' || req.path === '/config/update') return next();

    try {
        const manager = new SecretManager(req.user.directories);
        let apiKey = manager.readSecret(SECRET_KEYS.HONCHO);

        // Fall back to global config API key
        if (!apiKey && globalConfig?.apiKey) {
            apiKey = globalConfig.apiKey;
        }

        if (!apiKey) {
            return res.status(403).json({ error: 'Honcho API key not configured. Set it in SillyTavern API Connections or ~/.honcho/config.json.' });
        }

        // workspaceId from request body, or fall back to global config
        let workspaceId = req.body?.workspaceId;
        if (!workspaceId) {
            const stConfig = getGlobalConfigForST();
            workspaceId = stConfig?.workspace;
        }

        if (!workspaceId) {
            return res.status(400).json({ error: 'workspaceId is required (set in extension settings or ~/.honcho/config.json)' });
        }

        req.honchoApiKey = apiKey;
        req.honchoWorkspaceId = workspaceId;
        next();
    } catch (err) {
        console.error('[honcho-proxy] Middleware error:', err.message);
        // Genuine 500 — local secret-read failure, not an SDK/upstream error.
        // Don't route through statusFromSdkError (no err.status to map).
        return res.status(500).json({ error: 'Failed to read Honcho API key' });
    }
}

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    // Load global config, seeding a minimal default if the file doesn't exist yet
    globalConfig = loadGlobalConfig();
    if (!globalConfig) {
        globalConfig = { hosts: { sillytavern: {} } };
        saveGlobalConfig();
        console.log(`[honcho-proxy] Created default global config at ${GLOBAL_CONFIG_PATH}`);
    } else {
        // Register SillyTavern as a host if not present
        const stHost = globalConfig.hosts?.sillytavern;
        if (!stHost) {
            updateSTHost({});
        }
    }

    // Verify SDK is importable at startup
    try {
        await import('@honcho-ai/sdk');
        console.log('[honcho-proxy] Honcho SDK loaded');
    } catch {
        console.error('[honcho-proxy] @honcho-ai/sdk not found. Run: cd plugins/honcho-proxy && npm install');
        return;
    }

    router.use(honchoMiddleware);

    // GET /config — Return global config values for client-side auto-population
    router.get('/config', (req, res) => {
        const stConfig = getGlobalConfigForST();
        if (!stConfig) {
            return res.json({ found: false });
        }

        // Check if ST secrets store has an API key
        let hasSecretKey = false;
        try {
            const manager = new SecretManager(req.user.directories);
            hasSecretKey = !!manager.readSecret(SECRET_KEYS.HONCHO);
        } catch { /* ignore */ }

        return res.json({
            found: true,
            hasApiKey: !!(stConfig.apiKey || hasSecretKey),
            workspace: stConfig.workspace,
            peerName: stConfig.peerName,
            aiPeer: stConfig.aiPeer,
            enabled: stConfig.enabled,
        });
    });

    // POST /config/update — Update hosts.sillytavern and session in global config
    router.post('/config/update', (req, res) => {
        if (!globalConfig) {
            return res.status(404).json({ error: 'No global config found at ~/.honcho/config.json' });
        }

        const { aiPeer, workspace, sessionId } = req.body;
        const updates = {};

        if (aiPeer) updates.aiPeer = aiPeer;
        if (workspace) updates.workspace = workspace;

        if (Object.keys(updates).length > 0) {
            updateSTHost(updates);
        }

        if (sessionId) {
            registerSession(sessionId);
        }

        return res.json({ ok: true, host: globalConfig.hosts?.sillytavern });
    });

    // POST /peer — Create or get a peer
    router.post('/peer', async (req, res) => {
        try {
            const { peerId, observeMe } = req.body;
            if (!peerId) {
                return res.status(400).json({ error: 'peerId is required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const opts = {};
            if (typeof observeMe === 'boolean') {
                opts.configuration = { observeMe };
            }
            const peer = await client.peer(peerId, opts);
            return res.json({ id: peer.id, workspaceId: peer.workspaceId });
        } catch (err) {
            return sendError(res, err, 'peer');
        }
    });

    // POST /session — Create or get a session and add peers
    router.post('/session', async (req, res) => {
        try {
            const { sessionId, userPeerId, charPeerId } = req.body;
            if (!sessionId) {
                return res.status(400).json({ error: 'sessionId is required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const session = await client.session(sessionId);

            const peersToAdd = [];
            if (userPeerId) {
                peersToAdd.push([userPeerId, { observeMe: true }]);
            }
            if (charPeerId) {
                peersToAdd.push([charPeerId, { observeMe: false }]);
            }

            if (peersToAdd.length > 0) {
                await session.addPeers(peersToAdd);
            }

            return res.json({ id: session.id, workspaceId: session.workspaceId });
        } catch (err) {
            return sendError(res, err, 'session');
        }
    });

    // POST /session/messages — Store messages in a session
    router.post('/session/messages', async (req, res) => {
        try {
            const { sessionId, messages } = req.body;
            if (!sessionId || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ error: 'sessionId and messages[] are required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const session = await client.session(sessionId);

            // Build MessageInput objects via peer.message()
            const messageInputs = [];
            for (const msg of messages) {
                if (!msg.peerId || !msg.content) continue;
                const peer = await client.peer(msg.peerId);
                messageInputs.push(peer.message(msg.content));
            }

            if (messageInputs.length === 0) {
                return res.status(400).json({ error: 'No valid messages provided' });
            }

            const stored = await session.addMessages(messageInputs);
            return res.json({ count: stored.length });
        } catch (err) {
            return sendError(res, err, 'session/messages');
        }
    });

    // POST /chat — Dialectic chat query against a peer's representation
    router.post('/chat', async (req, res) => {
        try {
            const { peerId, query, sessionId } = req.body;
            if (!peerId || !query) {
                return res.status(400).json({ error: 'peerId and query are required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const peer = await client.peer(peerId);

            const opts = {};
            if (sessionId) {
                opts.session = sessionId;
            }

            const response = await peer.chat(query, opts);
            return res.json({ response: response || '' });
        } catch (err) {
            return sendError(res, err, 'chat');
        }
    });

    // POST /context — Get session context for LLM prompt injection
    router.post('/context', async (req, res) => {
        try {
            const { sessionId, userPeerId, charPeerId, tokens, summary } = req.body;
            if (!sessionId || !userPeerId || !charPeerId) {
                return res.status(400).json({ error: 'sessionId, userPeerId, and charPeerId are required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const session = await client.session(sessionId);

            const opts = {};
            if (typeof tokens === 'number' && tokens > 0) {
                opts.tokens = tokens;
            }
            if (typeof summary === 'boolean') {
                opts.summary = summary;
            }
            // SDK requires the pair: peerPerspective (observer) + peerTarget (subject).
            // The SDK rejects client-side if either is missing when the other is provided.
            opts.peerPerspective = userPeerId;
            opts.peerTarget = charPeerId;

            const context = await session.context(opts);

            // SessionContext is a rich object — extract text content from it
            const parts = [];
            if (context.peerRepresentation) {
                parts.push(context.peerRepresentation);
            }
            if (context.summary?.content) {
                parts.push(context.summary.content);
            }
            const contextText = parts.join('\n\n') || null;
            return res.json({ context: contextText });
        } catch (err) {
            return sendError(res, err, 'context');
        }
    });

    // POST /conclusion — Create a conclusion (persistent observation) about a peer
    router.post('/conclusion', async (req, res) => {
        try {
            const { peerId, content } = req.body;
            if (!peerId || !content) {
                return res.status(400).json({ error: 'peerId and content are required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const peer = await client.peer(peerId);
            const results = await peer.conclusions.create({ content });
            const conclusion = Array.isArray(results) ? results[0] : results;
            return res.json({ id: conclusion.id, content: conclusion.content });
        } catch (err) {
            return sendError(res, err, 'conclusion');
        }
    });

    // POST /search — Semantic search across session messages
    router.post('/search', async (req, res) => {
        try {
            const { sessionId, query, limit } = req.body;
            if (!sessionId || !query) {
                return res.status(400).json({ error: 'sessionId and query are required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const session = await client.session(sessionId);
            const results = await session.search(query, { limit: limit || 10 });
            return res.json({ results });
        } catch (err) {
            return sendError(res, err, 'search');
        }
    });

    console.log('[honcho-proxy] Plugin initialized with 7 routes');
}

export async function exit() {
    clientCache.clear();
}
