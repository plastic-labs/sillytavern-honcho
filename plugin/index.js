import path from 'node:path';
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
 * Middleware to read Honcho API key from secrets and validate request body.
 */
function honchoMiddleware(req, res, next) {
    try {
        const manager = new SecretManager(req.user.directories);
        const apiKey = manager.readSecret(SECRET_KEYS.HONCHO);

        if (!apiKey) {
            return res.status(403).json({ error: 'Honcho API key not configured. Set it in SillyTavern API Connections.' });
        }

        const { workspaceId } = req.body;
        if (!workspaceId) {
            return res.status(400).json({ error: 'workspaceId is required' });
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
    // Verify SDK is importable at startup
    try {
        await import('@honcho-ai/sdk');
        console.log('[honcho-proxy] Honcho SDK loaded successfully');
    } catch {
        console.error('[honcho-proxy] @honcho-ai/sdk not found. Run: cd plugins/honcho-proxy && npm install');
        return;
    }

    router.use(honchoMiddleware);

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
            console.error('[honcho-proxy] POST /peer error:', err.message);
            return res.status(500).json({ error: err.message });
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
            console.error('[honcho-proxy] POST /session error:', err.message);
            return res.status(500).json({ error: err.message });
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
            console.error('[honcho-proxy] POST /session/messages error:', err.message);
            return res.status(500).json({ error: err.message });
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
            console.error('[honcho-proxy] POST /chat error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    // POST /context — Get session context for LLM prompt injection
    router.post('/context', async (req, res) => {
        try {
            const { sessionId, userPeerId, tokens, summary } = req.body;
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
            // Return the raw context string representation
            return res.json({ context: String(context) });
        } catch (err) {
            console.error('[honcho-proxy] POST /context error:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    console.log('[honcho-proxy] Plugin initialized with 5 routes');
}

export async function exit() {
    clientCache.clear();
    console.log('[honcho-proxy] Plugin cleaned up');
}
