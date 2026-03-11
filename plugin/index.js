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
        console.log(`[honcho-proxy] No global config at ${configPath}`);
        return null;
    }
}

/** Path to the global config file */
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.honcho', 'config.json');

/**
 * Get config values for SillyTavern from the global config.
 * Checks hosts.sillytavern first, then falls back to top-level defaults.
 */
function getGlobalConfigForST() {
    if (!globalConfig) return null;

    const stHost = globalConfig.hosts?.sillytavern;
    return {
        apiKey: globalConfig.apiKey || null,
        workspace: stHost?.workspace || globalConfig.workspace || null,
        peerName: stHost?.peerName || globalConfig.peerName || null,
        aiPeer: stHost?.aiPeer || null,
        enabled: globalConfig.enabled ?? false,
    };
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
        console.log(`[honcho-proxy] Saved global config to ${GLOBAL_CONFIG_PATH}`);
        return true;
    } catch (err) {
        console.error(`[honcho-proxy] Failed to save global config: ${err.message}`);
        return false;
    }
}

/**
 * Update the hosts.sillytavern entry in the global config.
 */
function updateSTHost(updates) {
    if (!globalConfig) return;

    if (!globalConfig.hosts) globalConfig.hosts = {};
    if (!globalConfig.hosts.sillytavern) globalConfig.hosts.sillytavern = {};

    Object.assign(globalConfig.hosts.sillytavern, updates);
    saveGlobalConfig();
}

/**
 * Register or update a session mapping in the global config.
 */
function registerSession(sessionId) {
    if (!globalConfig) return;

    if (!globalConfig.sessions) globalConfig.sessions = {};

    // Use SillyTavern's data directory as the key
    const stDir = process.cwd();
    const existing = globalConfig.sessions[stDir];

    // Only write if the session changed
    if (existing !== sessionId) {
        globalConfig.sessions[stDir] = sessionId;
        saveGlobalConfig();
        console.log(`[honcho-proxy] Registered session "${sessionId}" for ${stDir}`);
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
            console.log('[honcho-proxy] Using API key from global ~/.honcho/config.json');
        }

        if (!apiKey) {
            return res.status(403).json({ error: 'Honcho API key not configured. Set it in SillyTavern API Connections or ~/.honcho/config.json.' });
        }

        // workspaceId from request body, or fall back to global config
        let workspaceId = req.body?.workspaceId;
        if (!workspaceId) {
            const stConfig = getGlobalConfigForST();
            workspaceId = stConfig?.workspace;
            if (workspaceId) {
                console.log(`[honcho-proxy] Using workspace "${workspaceId}" from global config`);
            }
        }

        if (!workspaceId) {
            return res.status(400).json({ error: 'workspaceId is required (set in extension settings or ~/.honcho/config.json)' });
        }

        req.honchoApiKey = apiKey;
        req.honchoWorkspaceId = workspaceId;
        next();
    } catch (err) {
        console.error('[honcho-proxy] Middleware error:', err.message);
        return res.status(500).json({ error: 'Failed to read Honcho API key' });
    }
}

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    // Load global config
    globalConfig = loadGlobalConfig();

    // Register SillyTavern as a host on startup
    if (globalConfig) {
        const stHost = globalConfig.hosts?.sillytavern;
        if (!stHost) {
            updateSTHost({
                workspace: globalConfig.workspace || 'sillytavern',
            });
            console.log('[honcho-proxy] Registered hosts.sillytavern in global config');
        }
    }

    // Verify SDK is importable at startup
    try {
        await import('@honcho-ai/sdk');
        console.log('[honcho-proxy] Honcho SDK loaded successfully');
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
            console.log(`[honcho-proxy] POST /peer peerId="${peerId}" observeMe=${observeMe}`);
            if (!peerId) {
                return res.status(400).json({ error: 'peerId is required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const opts = {};
            if (typeof observeMe === 'boolean') {
                opts.configuration = { observeMe };
            }
            const peer = await client.peer(peerId, opts);
            console.log(`[honcho-proxy] POST /peer OK id="${peer.id}"`);
            return res.json({ id: peer.id, workspaceId: peer.workspaceId });
        } catch (err) {
            console.error('[honcho-proxy] POST /peer error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // POST /session — Create or get a session and add peers
    router.post('/session', async (req, res) => {
        try {
            const { sessionId, userPeerId, charPeerId } = req.body;
            console.log(`[honcho-proxy] POST /session sessionId="${sessionId}" userPeerId="${userPeerId}" charPeerId="${charPeerId}"`);
            if (!sessionId) {
                return res.status(400).json({ error: 'sessionId is required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const session = await client.session(sessionId);
            console.log(`[honcho-proxy] Session created/fetched id="${session.id}"`);

            const peersToAdd = [];
            if (userPeerId) {
                peersToAdd.push([userPeerId, { observeMe: true }]);
            }
            if (charPeerId) {
                peersToAdd.push([charPeerId, { observeMe: false }]);
            }

            if (peersToAdd.length > 0) {
                console.log(`[honcho-proxy] Adding ${peersToAdd.length} peers to session`);
                await session.addPeers(peersToAdd);
                console.log(`[honcho-proxy] Peers added OK`);
            }

            return res.json({ id: session.id, workspaceId: session.workspaceId });
        } catch (err) {
            console.error('[honcho-proxy] POST /session error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // POST /session/messages — Store messages in a session
    router.post('/session/messages', async (req, res) => {
        try {
            const { sessionId, messages } = req.body;
            console.log(`[honcho-proxy] POST /session/messages sessionId="${sessionId}" count=${messages?.length}`);
            if (!sessionId || !Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ error: 'sessionId and messages[] are required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const session = await client.session(sessionId);

            // Build MessageInput objects via peer.message()
            const messageInputs = [];
            for (const msg of messages) {
                if (!msg.peerId || !msg.content) continue;
                console.log(`[honcho-proxy] Building message: peerId="${msg.peerId}" content="${msg.content.slice(0, 80)}..."`);
                const peer = await client.peer(msg.peerId);
                messageInputs.push(peer.message(msg.content));
            }

            if (messageInputs.length === 0) {
                return res.status(400).json({ error: 'No valid messages provided' });
            }

            const stored = await session.addMessages(messageInputs);
            console.log(`[honcho-proxy] Messages stored OK count=${stored.length}`);
            return res.json({ count: stored.length });
        } catch (err) {
            console.error('[honcho-proxy] POST /session/messages error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // POST /chat — Dialectic chat query against a peer's representation
    router.post('/chat', async (req, res) => {
        try {
            const { peerId, query, sessionId } = req.body;
            console.log(`[honcho-proxy] POST /chat peerId="${peerId}" query="${query.slice(0, 80)}" sessionId="${sessionId}"`);
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
            console.log(`[honcho-proxy] POST /chat response="${String(response).slice(0, 120)}..."`);
            return res.json({ response: response || '' });
        } catch (err) {
            console.error('[honcho-proxy] POST /chat error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // POST /context — Get session context for LLM prompt injection
    router.post('/context', async (req, res) => {
        try {
            const { sessionId, userPeerId, tokens, summary } = req.body;
            console.log(`[honcho-proxy] POST /context sessionId="${sessionId}" userPeerId="${userPeerId}" tokens=${tokens} summary=${summary}`);
            if (!sessionId || !userPeerId) {
                return res.status(400).json({ error: 'sessionId and userPeerId are required' });
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
            opts.peerPerspective = userPeerId;

            const context = await session.context(opts);
            console.log(`[honcho-proxy] POST /context response="${String(context).slice(0, 120)}..."`);
            // Return the raw context string representation
            return res.json({ context: String(context) });
        } catch (err) {
            console.error('[honcho-proxy] POST /context error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // POST /conclusion — Create a conclusion (persistent observation) about a peer
    router.post('/conclusion', async (req, res) => {
        try {
            const { peerId, content } = req.body;
            console.log(`[honcho-proxy] POST /conclusion peerId="${peerId}" content="${content?.slice(0, 80)}..."`);
            if (!peerId || !content) {
                return res.status(400).json({ error: 'peerId and content are required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const peer = await client.peer(peerId);
            const conclusion = await peer.createConclusion(content);
            console.log(`[honcho-proxy] Conclusion created id="${conclusion.id}"`);
            return res.json({ id: conclusion.id, content: conclusion.content });
        } catch (err) {
            console.error('[honcho-proxy] POST /conclusion error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // POST /search — Semantic search across session messages
    router.post('/search', async (req, res) => {
        try {
            const { sessionId, query, limit } = req.body;
            console.log(`[honcho-proxy] POST /search sessionId="${sessionId}" query="${query?.slice(0, 80)}" limit=${limit}`);
            if (!sessionId || !query) {
                return res.status(400).json({ error: 'sessionId and query are required' });
            }

            const client = await getClient(req.honchoApiKey, req.honchoWorkspaceId);
            const session = await client.session(sessionId);
            const results = await session.search(query, { limit: limit || 10 });
            console.log(`[honcho-proxy] Search returned ${results.length} results`);
            return res.json({ results });
        } catch (err) {
            console.error('[honcho-proxy] POST /search error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    console.log('[honcho-proxy] Plugin initialized with 7 routes');
}

export async function exit() {
    clientCache.clear();
    console.log('[honcho-proxy] Plugin cleaned up');
}
