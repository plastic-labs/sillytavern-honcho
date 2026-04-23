import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    getRequestHeaders,
    getCurrentChatId,
    chat_metadata,
    updateChatMetadata,
    characters,
    this_chid,
    chat,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
} from '../../../extensions.js';
import { SECRET_KEYS, secret_state } from '../../../secrets.js';
import { selected_group } from '../../../group-chats.js';
import { oai_settings } from '../../../openai.js';

const MODULE_NAME = 'honcho';
const PLUGIN_BASE = '/api/plugins/honcho-proxy';

const defaultSettings = {
    enabled: false,
    workspaceId: '',
    peerMode: 'single',
    sessionNaming: 'auto',
    customSessionName: '',
    contextMode: 'reasoning',
    prefetchQueries: ['What do you know about the user?'],
    prefetchInterval: 8,
    injectionPosition: extension_prompt_types.IN_PROMPT,
    injectionDepth: 4,
    promptTemplate: '[Honcho Memory]\n{{text}}',
    contextTokens: 2000,
    contextInterval: 1,
    contextSummary: true,
    ignoreGlobalConfig: false,
};

let sessionSetupInProgress = false;
let pendingChatId = null;
let lastGenerationChatIndex = -1;
let turnsSinceLastReasoning = Infinity; // Infinity ensures first turn always fires

/** Stale-while-revalidate caches. */
let cachedContextText = null;
let contextRefreshInFlight = false;
let turnsSinceLastContextRefresh = Infinity;

let cachedReasoningText = null;
let reasoningRefreshInFlight = false;

/** Cache for late-arriving query results (tool_call mode). Key = cache key, Value = result string. */
const MAX_LATE_CACHE = 50;
const lateResultCache = new Map();
/** In-flight background promises that outlived their timeout. Key = cache key. */
const pendingBackgroundQueries = new Map();
/** In-flight AbortControllers for honchoFetch calls. Walked on extension disable so
 *  pending requests don't keep running after the user toggled off. */
const activeAbortControllers = new Set();

function abortAllInFlight() {
    for (const controller of activeAbortControllers) {
        controller.abort();
    }
    activeAbortControllers.clear();
}

// ─── Helpers ──────────────────────────────────────────────

/** Sanitize a string to only contain letters, numbers, underscores, and hyphens. */
function sanitizeId(str) {
    const cleaned = str.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return cleaned || 'unnamed';
}

/** Clear all SWR caches and refresh guards. Call on chat change or whenever
 *  a setting changes that makes the cached response stale (workspace, peer
 *  mode, context mode). Without this, edits to those settings are masked by
 *  the cache until the refresh interval ticks. */
function resetCaches() {
    lastGenerationChatIndex = -1;
    turnsSinceLastReasoning = Infinity;
    turnsSinceLastContextRefresh = Infinity;
    cachedContextText = null;
    contextRefreshInFlight = false;
    cachedReasoningText = null;
    reasoningRefreshInFlight = false;
    lateResultCache.clear();
    pendingBackgroundQueries.clear();
}

function isReady() {
    const hasApiKey = secret_state[SECRET_KEYS.HONCHO] || globalConfigCache?.hasApiKey;
    return (
        extension_settings.honcho?.enabled &&
        extension_settings.honcho?.workspaceId &&
        hasApiKey
    );
}

function settings() {
    return extension_settings.honcho;
}

/** Global config values fetched from ~/.honcho/config.json via the plugin */
let globalConfigCache = null;

/**
 * Resolve the user peer ID based on current peer mode.
 * Priority: globalConfig.peerName > persona name > display name
 */
function getUserPeerId() {
    const context = getContext();

    // Use global config peerName if available (e.g. "eri")
    if (globalConfigCache?.peerName) {
        if (settings().peerMode === 'per_persona') {
            const personaName = context.name1 || 'default';
            // Don't duplicate if persona name matches peerName
            if (sanitizeId(personaName) === sanitizeId(globalConfigCache.peerName)) {
                return sanitizeId(globalConfigCache.peerName);
            }
            return sanitizeId(`${globalConfigCache.peerName}-${personaName}`);
        }
        return sanitizeId(globalConfigCache.peerName);
    }

    // Fallback: use ST display name
    if (settings().peerMode === 'per_persona') {
        return sanitizeId(context.name1 || 'default-user');
    }
    return sanitizeId(context.name1 || 'user');
}

/**
 * Resolve the character peer ID using the character's display name.
 */
function getCharPeerId() {
    if (selected_group) {
        return sanitizeId(`group-${selected_group}`);
    }
    if (this_chid !== undefined && characters[this_chid]) {
        // Use character name, not avatar filename
        return sanitizeId(characters[this_chid].name || `char-${this_chid}`);
    }
    return 'unknown-char';
}

/**
 * Make a request to the Honcho plugin proxy (no timeout, raw fetch).
 * @param {string} endpoint
 * @param {object} body
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<object|null>}
 */
async function honchoFetchRaw(endpoint, body, signal = null) {
    try {
        const response = await fetch(`${PLUGIN_BASE}${endpoint}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                workspaceId: settings().workspaceId,
                ...body,
            }),
            signal,
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.warn(`[Honcho] ${endpoint} failed (${response.status}):`, err.error || response.statusText);
            return null;
        }

        return await response.json();
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.warn(`[Honcho] ${endpoint} error:`, err.message);
        }
        return null;
    }
}

/** honchoFetchRaw with its AbortController tracked in activeAbortControllers
 *  so disable-flow cancels the fetch. */
async function honchoFetchRawTracked(endpoint, body) {
    // Re-check: disable may have fired after the caller's isReady() gate.
    if (!isReady()) return null;
    const controller = new AbortController();
    activeAbortControllers.add(controller);
    try {
        return await honchoFetchRaw(endpoint, body, controller.signal);
    } finally {
        activeAbortControllers.delete(controller);
    }
}

/**
 * Make a request with a soft timeout (used by tool_call mode).
 * If the timeout expires:
 * - Returns cached result from a previous late arrival (if available)
 * - Keeps the request running in the background and caches its result
 * - Next call with the same cacheKey will pick up the late result
 *
 * @param {string} endpoint
 * @param {object} body
 * @param {number} timeoutMs - Soft timeout in ms (default 30s)
 * @param {string} [cacheKey] - Optional key for late-result caching. If omitted, no caching.
 * @returns {Promise<object|null>}
 */
async function honchoFetch(endpoint, body, timeoutMs = 30000, cacheKey = null) {
    // Check if a previous late-arriving result is cached
    if (cacheKey && lateResultCache.has(cacheKey)) {
        const cached = lateResultCache.get(cacheKey);
        lateResultCache.delete(cacheKey);
        return cached;
    }

    if (!cacheKey) {
        // Hard abort for write endpoints — a cancelled request must not land stale state.
        const controller = new AbortController();
        activeAbortControllers.add(controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await honchoFetchRaw(endpoint, body, controller.signal);
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn(`[Honcho] ${endpoint} error:`, err.message);
            } else {
                console.warn(`[Honcho] ${endpoint} timed out after ${timeoutMs}ms`);
            }
            return null;
        } finally {
            clearTimeout(timer);
            activeAbortControllers.delete(controller);
        }
    }

    // Soft timeout with background caching (read endpoints).
    const readController = new AbortController();
    activeAbortControllers.add(readController);
    const fetchPromise = honchoFetchRaw(endpoint, body, readController.signal)
        .finally(() => activeAbortControllers.delete(readController));
    try {
        const result = await Promise.race([
            fetchPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ]);
        pendingBackgroundQueries.delete(cacheKey);
        return result;
    } catch {
        // Timed out — let it run in the background and cache the result
        console.warn(`[Honcho] ${endpoint} timed out after ${timeoutMs}ms (key: ${cacheKey})`);
        if (!pendingBackgroundQueries.has(cacheKey)) {
            const bgPromise = fetchPromise.then(result => {
                if (!isReady()) {
                    pendingBackgroundQueries.delete(cacheKey);
                    return;
                }
                if (result) {
                    // Evict oldest entry if cache is full
                    if (lateResultCache.size >= MAX_LATE_CACHE) {
                        const oldest = lateResultCache.keys().next().value;
                        lateResultCache.delete(oldest);
                    }
                    lateResultCache.set(cacheKey, result);
                }
                pendingBackgroundQueries.delete(cacheKey);
            }).catch(() => {
                pendingBackgroundQueries.delete(cacheKey);
            });
            pendingBackgroundQueries.set(cacheKey, bgPromise);
        }
        return null;
    }
}

// ─── Event Handlers ───────────────────────────────────────

/**
 * CHAT_CHANGED — Ensure a Honcho session exists for this chat.
 */
async function onChatChanged() {
    if (!isReady()) return;

    resetCaches();

    const rawChatId = getCurrentChatId();
    if (!rawChatId) return;

    // Build session ID based on naming mode
    const charName = (this_chid !== undefined && characters[this_chid])
        ? characters[this_chid].name
        : 'chat';
    let chatId;
    const namingMode = settings().sessionNaming || 'auto';

    if (namingMode === 'custom' && settings().customSessionName) {
        chatId = sanitizeId(settings().customSessionName);
    } else if (namingMode === 'character') {
        chatId = sanitizeId(charName);
    } else {
        // auto: "charName-YYYY-MM-DD-hash" (one session per ST chat)
        const dateMatch = rawChatId.match(/(\d{4}-\d{2}-\d{2})/);
        const dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
        const shortHash = Math.abs(
            Array.from(rawChatId).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
        ).toString(36);
        chatId = sanitizeId(`${charName}-${dateStr}-${shortHash}`);
    }

    // Prevent race if CHAT_CHANGED fires while a setup is already running.
    // Queue one rerun so the last chat switch always gets processed.
    if (sessionSetupInProgress) {
        pendingChatId = rawChatId;
        return;
    }
    sessionSetupInProgress = true;

    try {
        const userPeerId = getUserPeerId();
        const charPeerId = getCharPeerId();

        // Ensure peers exist
        await honchoFetch('/peer', { peerId: userPeerId, observeMe: true });
        await honchoFetch('/peer', { peerId: charPeerId, observeMe: false });

        // Ensure session exists with peers
        const result = await honchoFetch('/session', {
            sessionId: chatId,
            userPeerId,
            charPeerId,
        });

        if (result) {
            updateChatMetadata({
                honcho: {
                    sessionId: chatId,
                    userPeerId,
                    charPeerId,
                },
            });
            saveMetadataDebounced();
            updateActiveSessionDisplay();

            // Update global config with current aiPeer and session
            try {
                await fetch(`${PLUGIN_BASE}/config/update`, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        aiPeer: charPeerId,
                        sessionId: chatId,
                        workspace: settings().workspaceId,
                    }),
                });
            } catch { /* best-effort */ }
        } else {
            console.warn('[Honcho] Session setup failed');
        }
    } catch (err) {
        console.error('[Honcho] onChatChanged error:', err);
    } finally {
        sessionSetupInProgress = false;
        // If a chat change arrived while this setup was running, process it now
        if (pendingChatId) {
            pendingChatId = null;
            onChatChanged();
        }
    }
}

/**
 * Run dialectic peer.chat() queries and return combined result string.
 * Used by the reasoning layer (stale-while-revalidate).
 */
async function fetchReasoningQueries(honchoMeta, lastUserMessage) {
    const queries = settings().prefetchQueries || [];
    const results = [];

    for (const query of queries) {
        if (!isReady()) break;

        let trimmed = query.trim();
        if (!trimmed) continue;

        trimmed = trimmed.replace(/\{\{message\}\}/gi, lastUserMessage);

        const result = await honchoFetchRawTracked('/chat', {
            workspaceId: settings().workspaceId,
            peerId: honchoMeta.userPeerId,
            query: trimmed,
            sessionId: honchoMeta.sessionId,
        });

        if (result?.response) {
            results.push(result.response);
        }
    }

    return results.length > 0 ? results.join('\n\n') : null;
}

/**
 * GENERATION_AFTER_COMMANDS — Inject context before generation.
 */
async function onGeneration() {
    if (!isReady()) return;

    const mode = settings().contextMode;

    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId) return;

    // Dedup guard: prevent double-firing for the same chat index
    const currentIndex = chat.length - 1;
    if (currentIndex >= 0 && currentIndex === lastGenerationChatIndex) return;
    lastGenerationChatIndex = currentIndex;

    // Get the last user message for contextual queries
    let lastUserMessage = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user && chat[i]?.mes) {
            lastUserMessage = chat[i].mes;
            break;
        }
    }

    const parts = [];

    try {
        // Base layer: session.context() with stale-while-revalidate
        // First turn (no cache): blocking fetch. Subsequent turns: serve cache, background refresh on interval.
        const contextBody = {
            sessionId: honchoMeta.sessionId,
            userPeerId: honchoMeta.userPeerId,
            charPeerId: honchoMeta.charPeerId,
            tokens: settings().contextTokens,
            summary: settings().contextSummary,
        };
        const contextInterval = settings().contextInterval || 1;
        turnsSinceLastContextRefresh++;

        if (cachedContextText === null) {
            // First turn of session — blocking fetch, must wait
            const contextResult = await honchoFetch('/context', contextBody);
            if (!isReady()) return;
            if (contextResult?.context) {
                cachedContextText = contextResult.context;
            }
            turnsSinceLastContextRefresh = 0;
        } else if (turnsSinceLastContextRefresh >= contextInterval && !contextRefreshInFlight) {
            // Background refresh — serve stale, update for next turn
            turnsSinceLastContextRefresh = 0;
            contextRefreshInFlight = true;
            honchoFetchRawTracked('/context', { workspaceId: settings().workspaceId, ...contextBody })
                .then(result => {
                    if (!isReady()) return;
                    if (result?.context) {
                        cachedContextText = result.context;
                    }
                })
                .catch(() => {})
                .finally(() => { contextRefreshInFlight = false; });
        }

        if (cachedContextText) {
            parts.push(cachedContextText);
        }

        // Reasoning layer: dialectic peer.chat() with stale-while-revalidate
        if (mode === 'reasoning') {
            const reasoningInterval = settings().prefetchInterval || 8;
            turnsSinceLastReasoning++;

            if (cachedReasoningText === null) {
                // First turn of session — blocking fetch
                const results = await fetchReasoningQueries(honchoMeta, lastUserMessage);
                // fetchReasoningQueries can return partial results from iterations
                // that completed before a mid-loop abort; recheck before caching.
                if (!isReady()) return;
                if (results) {
                    cachedReasoningText = results;
                }
                turnsSinceLastReasoning = 0;
            } else if (turnsSinceLastReasoning >= reasoningInterval && !reasoningRefreshInFlight) {
                // Background refresh — serve stale, update for next turn
                turnsSinceLastReasoning = 0;
                reasoningRefreshInFlight = true;
                fetchReasoningQueries(honchoMeta, lastUserMessage)
                    .then(results => {
                        if (!isReady()) return;
                        if (results) {
                            cachedReasoningText = results;
                        }
                    })
                    .catch(() => {})
                    .finally(() => { reasoningRefreshInFlight = false; });
            }

            if (cachedReasoningText) {
                parts.push(cachedReasoningText);
            }
        }
    } catch (err) {
        console.warn('[Honcho] Context injection error:', err.message);
    }

    const contextText = parts.join('\n\n');

    if (!contextText) {
        setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, 0);
        return;
    }

    // Apply template
    const template = settings().promptTemplate || '{{text}}';
    const formatted = template.replace('{{text}}', contextText);

    const position = Number(settings().injectionPosition);
    const depth = position === extension_prompt_types.IN_CHAT
        ? Number(settings().injectionDepth)
        : 0;

    setExtensionPrompt(
        MODULE_NAME,
        formatted,
        position,
        depth,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

/**
 * MESSAGE_SENT — Store user message in Honcho.
 */
async function onMessageSent(messageIndex) {
    if (!isReady()) return;

    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId) return;

    const message = chat[messageIndex];
    if (!message || !message.is_user) return;

    await honchoFetch('/session/messages', {
        sessionId: honchoMeta.sessionId,
        messages: [{ peerId: honchoMeta.userPeerId, content: message.mes }],
    });
}

/**
 * CHARACTER_MESSAGE_RENDERED — Store AI response in Honcho.
 */
async function onCharResponse(messageIndex) {
    if (!isReady()) return;

    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId) return;

    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) return;

    // Skip swiped-away messages (only store if this is the latest message)
    if (messageIndex !== chat.length - 1) return;

    await honchoFetch('/session/messages', {
        sessionId: honchoMeta.sessionId,
        messages: [{ peerId: honchoMeta.charPeerId, content: message.mes }],
    });
}

// ─── Tool Registration ────────────────────────────────────

function registerHonchoTools() {
    const context = getContext();
    const shouldRegister = () => isReady() && settings().contextMode === 'tool_call';

    // Stealth convention: read tools are non-stealth (results must reach the
    // LLM for the follow-up generate); write tools are stealth (fire-and-forget).

    context.registerFunctionTool({
        name: 'honcho_query_memory',
        displayName: 'Honcho: Query Memory',
        description: 'Query what you know about the user using dialectic reasoning. Use this to recall preferences, history, personality traits, or anything relevant about them.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Natural language question about the user, e.g. "What are the user\'s interests?" or "What have we discussed before?"',
                },
            },
            required: ['query'],
        },
        action: async (args) => {
            if (!args?.query) return 'No query provided.';

            const honchoMeta = chat_metadata?.honcho;
            if (!honchoMeta?.sessionId || !honchoMeta?.userPeerId) {
                return 'Honcho session not initialized for this chat.';
            }

            const cacheKey = `tool:${honchoMeta.sessionId}:${args.query.slice(0, 40)}`;
            const result = await honchoFetch('/chat', {
                peerId: honchoMeta.userPeerId,
                query: args.query,
                sessionId: honchoMeta.sessionId,
            }, 30000, cacheKey);

            return result?.response || 'No information available.';
        },
        formatMessage: () => 'Querying Honcho memory...',
        shouldRegister,
        stealth: false,
    });

    context.registerFunctionTool({
        name: 'honcho_save_conclusion',
        displayName: 'Honcho: Save Conclusion',
        description: 'Save an important conclusion, insight, or fact about the user to persistent memory. Use this when you learn something worth remembering: preferences, biographical details, emotional states, recurring topics, or relationship dynamics.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: 'The conclusion to save, e.g. "The user prefers riddles over trivia" or "User\'s name is Erosika"',
                },
            },
            required: ['content'],
        },
        action: async (args) => {
            if (!args?.content) return 'No content provided.';

            const honchoMeta = chat_metadata?.honcho;
            if (!honchoMeta?.userPeerId) {
                return 'Honcho session not initialized for this chat.';
            }

            const result = await honchoFetch('/conclusion', {
                peerId: honchoMeta.userPeerId,
                content: args.content,
            });

            return result ? `Conclusion saved: ${args.content}` : 'Failed to save conclusion.';
        },
        formatMessage: () => 'Saving conclusion to memory...',
        shouldRegister,
        stealth: true,
    });

    context.registerFunctionTool({
        name: 'honcho_search_history',
        displayName: 'Honcho: Search History',
        description: 'Search through past conversation messages using semantic search. Use this to find specific things the user said or topics you discussed previously.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'What to search for in conversation history, e.g. "when they talked about their job" or "favorite music"',
                },
            },
            required: ['query'],
        },
        action: async (args) => {
            if (!args?.query) return 'No query provided.';

            const honchoMeta = chat_metadata?.honcho;
            if (!honchoMeta?.sessionId) {
                return 'Honcho session not initialized for this chat.';
            }

            const result = await honchoFetch('/search', {
                sessionId: honchoMeta.sessionId,
                query: args.query,
                limit: 5,
            });

            if (!result?.results?.length) return 'No matching messages found.';
            return result.results.map((r, i) => `${i + 1}. ${r.content || r}`).join('\n');
        },
        formatMessage: () => 'Searching conversation history...',
        shouldRegister,
        stealth: false,
    });
}

// ─── Settings UI ──────────────────────────────────────────

function updateStatusIndicator() {
    const $status = $('#honcho_status');
    const hasKey = !!(secret_state[SECRET_KEYS.HONCHO] || globalConfigCache?.hasApiKey);

    // BUG-6 fix: swap API-key placeholder so users get feedback on the input
    // itself after save, not only in the #honcho_status line below. The input
    // is SillyTavern's manage-api-keys pattern (maxlength=0, readonly), so we
    // can't set a value — but the placeholder IS the visible text.
    $('#honcho_api_key').attr('placeholder', hasKey ? 'Key set — click to change' : 'Click to set key');

    if (isReady()) {
        $status.text('Ready').removeClass('not-ready').addClass('ready');
    } else {
        const reasons = [];
        if (!settings()?.enabled) reasons.push('disabled');
        if (!settings()?.workspaceId) reasons.push('no workspace ID');
        if (!hasKey) reasons.push('no API key');
        $status.text(`Not ready: ${reasons.join(', ')}`).removeClass('ready').addClass('not-ready');
    }
}

function updateConditionalSections() {
    const mode = settings()?.contextMode;
    $('#honcho_prefetch_section').toggle(mode === 'reasoning');

    const position = Number(settings()?.injectionPosition);
    $('#honcho_depth_section').toggle(position === extension_prompt_types.IN_CHAT);

    const naming = settings()?.sessionNaming || 'auto';
    $('#honcho_custom_session_section').toggle(naming === 'custom');
}

/** Update the active session display in settings. */
function updateActiveSessionDisplay() {
    const meta = chat_metadata?.honcho;
    $('#honcho_active_session').val(meta?.sessionId || '');
}

/**
 * Sync SillyTavern's function_calling flag to match the current Tool Call
 * enrichment mode. Without this, ToolManager registers tools but ST's
 * chat-completion request omits the `tools` key entirely.
 *
 * Called from both the mode-change listener and at extension load so the flag
 * stays in lockstep with contextMode. NOTE: this mutates a global ST setting
 * — every tool-registering extension sees the change.
 */
function syncFunctionCallingFlag() {
    if (oai_settings && 'function_calling' in oai_settings) {
        oai_settings.function_calling = (settings().contextMode === 'tool_call');
    }
}

function loadSettingsUI() {
    const s = settings();
    // One-time migration for BUG-11: internal enum 'prefetch' → 'reasoning'
    // (value now matches UI label). Safe no-op after migration.
    if (s.contextMode === 'prefetch') {
        s.contextMode = 'reasoning';
        saveSettingsDebounced();
        console.log('[Honcho] Migrated contextMode: prefetch → reasoning');
    }
    $('#honcho_enabled').prop('checked', s.enabled);
    $('#honcho_ignore_global').prop('checked', !!s.ignoreGlobalConfig);
    $('#honcho_workspace_id').val(s.workspaceId);
    $('#honcho_peer_name').val(globalConfigCache?.peerName || '');
    $(`input[name="honcho_peer_mode"][value="${s.peerMode}"]`).prop('checked', true);
    $(`input[name="honcho_session_naming"][value="${s.sessionNaming || 'auto'}"]`).prop('checked', true);
    $('#honcho_custom_session').val(s.customSessionName || '');
    $(`input[name="honcho_context_mode"][value="${s.contextMode}"]`).prop('checked', true);
    syncFunctionCallingFlag();
    $('#honcho_prefetch_queries').val((s.prefetchQueries || []).join('\n'));
    $('#honcho_prefetch_interval').val(s.prefetchInterval || 8);
    $(`input[name="honcho_injection_position"][value="${s.injectionPosition}"]`).prop('checked', true);
    $('#honcho_injection_depth').val(s.injectionDepth);
    $('#honcho_prompt_template').val(s.promptTemplate);
    $('#honcho_context_tokens').val(s.contextTokens);
    $('#honcho_context_interval').val(s.contextInterval || 1);
    $('#honcho_context_summary').prop('checked', s.contextSummary);

    // Show global config source info (hidden when user has opted out)
    if (!s.ignoreGlobalConfig && globalConfigCache?.found) {
        const source = [];
        if (globalConfigCache.hasApiKey && !secret_state[SECRET_KEYS.HONCHO]) {
            source.push('API key');
        }
        if (globalConfigCache.workspace && s.workspaceId === globalConfigCache.workspace) {
            source.push('workspace');
        }
        if (source.length > 0) {
            $('#honcho_config_source').text(`~/.honcho/config.json (${source.join(', ')})`).show();
        } else {
            $('#honcho_config_source').hide();
        }
        $('#honcho_config_refresh').show();
        $('#honcho_peer_name_section').show();
    } else {
        $('#honcho_config_source').hide();
        $('#honcho_config_refresh').hide();
        $('#honcho_peer_name_section').toggle(!s.ignoreGlobalConfig);
    }

    updateConditionalSections();
    updateStatusIndicator();
    updateActiveSessionDisplay();
}

function bindSettingsListeners() {
    $('#honcho_enabled').on('change', function () {
        const wasEnabled = settings().enabled;
        const nowEnabled = $(this).prop('checked');
        settings().enabled = nowEnabled;
        saveSettingsDebounced();
        updateStatusIndicator();
        if (wasEnabled && !nowEnabled) {
            abortAllInFlight();
            resetCaches();
        } else if (!wasEnabled && nowEnabled) {
            // onChatChanged is self-guarded on isReady() + chat id.
            onChatChanged();
        }
    });

    $('#honcho_workspace_id').on('input', function () {
        settings().workspaceId = $(this).val().trim();
        resetCaches();
        saveSettingsDebounced();
        updateStatusIndicator();
    });

    // Peer name override: writes to hosts.sillytavern.peerName in ~/.honcho/config.json.
    // Empty value clears the override (resolution falls back to root peerName).
    // Debounced so typing doesn't thrash the file; fires on blur too for safety.
    const DEFAULT_PEER_HINT = 'Applies to new chats. Saved to ~/.honcho/config.json under hosts.sillytavern.';
    let peerNameSaveTimer = null;
    let peerNameHintTimer = null;
    const flashPeerHint = (msg, isError = false) => {
        clearTimeout(peerNameHintTimer);
        const $hint = $('#honcho_peer_name_hint');
        $hint.text(msg).css('opacity', isError ? '1' : '0.9').toggleClass('honcho_hint_error', isError);
        peerNameHintTimer = setTimeout(() => {
            $hint.text(DEFAULT_PEER_HINT).css('opacity', '0.6').removeClass('honcho_hint_error');
        }, 1800);
    };
    const savePeerName = async () => {
        const value = $('#honcho_peer_name').val().trim();
        try {
            const resp = await fetch(`${PLUGIN_BASE}/config/update`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ peerName: value }),
            });
            if (!resp.ok) {
                flashPeerHint(`Save failed (${resp.status})`, true);
                return;
            }
            // Refresh cache so getUserPeerId() reflects the new value immediately
            const fresh = await fetch(`${PLUGIN_BASE}/config`, {
                method: 'GET',
                headers: getRequestHeaders(),
            });
            if (fresh.ok) {
                globalConfigCache = await fresh.json();
            }
            resetCaches();
            flashPeerHint(value ? `Saved — peer: ${value}` : 'Override cleared. Using root peerName.');
        } catch (err) {
            flashPeerHint(`Save failed: ${err.message}`, true);
        }
    };
    $('#honcho_peer_name').on('input', function () {
        clearTimeout(peerNameSaveTimer);
        peerNameSaveTimer = setTimeout(savePeerName, 500);
    });
    $('#honcho_peer_name').on('change blur', function () {
        clearTimeout(peerNameSaveTimer);
        savePeerName();
    });

    // Ignore-global-config toggle: opts out of auto-detection from ~/.honcho/config.json.
    // When on, the extension skips the /config fetch on reload, hides the source line,
    // and hides the peer-name override field. Resolution falls back to ST persona name.
    $('#honcho_ignore_global').on('change', async function () {
        const ignore = $(this).prop('checked');
        settings().ignoreGlobalConfig = ignore;
        saveSettingsDebounced();
        if (ignore) {
            globalConfigCache = null;
        } else {
            // Re-enabling detection: pull fresh config so UI populates without a separate click
            try {
                const resp = await fetch(`${PLUGIN_BASE}/config`, {
                    method: 'GET',
                    headers: getRequestHeaders(),
                });
                if (resp.ok) {
                    globalConfigCache = await resp.json();
                }
            } catch { /* best-effort */ }
        }
        resetCaches();
        loadSettingsUI();
    });

    // Refresh from disk: re-read ~/.honcho/config.json and repopulate the UI.
    $('#honcho_config_refresh').on('click', async function () {
        const $btn = $(this);
        const original = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-rotate fa-spin"></i> Reading');
        try {
            const resp = await fetch(`${PLUGIN_BASE}/config`, {
                method: 'GET',
                headers: getRequestHeaders(),
            });
            if (resp.ok) {
                globalConfigCache = await resp.json();
                resetCaches();
                loadSettingsUI();
            }
        } catch { /* best-effort */ }
        $btn.prop('disabled', false).html(original);
    });

    $('input[name="honcho_peer_mode"]').on('change', function () {
        settings().peerMode = $(this).val();
        resetCaches();
        saveSettingsDebounced();
    });

    $('input[name="honcho_session_naming"]').on('change', function () {
        settings().sessionNaming = $(this).val();
        saveSettingsDebounced();
        updateConditionalSections();
    });

    $('#honcho_custom_session').on('input', function () {
        settings().customSessionName = $(this).val().trim();
        saveSettingsDebounced();
    });

    // Renaming the active session re-registers it with Honcho
    $('#honcho_active_session').on('change', async function () {
        const newName = sanitizeId($(this).val().trim());
        if (!newName) return;
        $(this).val(newName);

        const meta = chat_metadata?.honcho;
        if (!meta) return;

        meta.sessionId = newName;
        updateChatMetadata({ honcho: meta });
        saveMetadataDebounced();

        // Re-register session with new name
        try {
            await honchoFetch('/session', {
                sessionId: newName,
                userPeerId: meta.userPeerId,
                charPeerId: meta.charPeerId,
            });
            // Update global config
            await fetch(`${PLUGIN_BASE}/config/update`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ sessionId: newName }),
            });
        } catch (err) {
            console.error('[Honcho] Session rename error:', err);
        }
    });

    $('input[name="honcho_context_mode"]').on('change', function () {
        settings().contextMode = $(this).val();
        syncFunctionCallingFlag();
        resetCaches();
        saveSettingsDebounced();
        updateConditionalSections();
    });

    $('#honcho_prefetch_queries').on('input', function () {
        settings().prefetchQueries = $(this).val().split('\n').filter(q => q.trim());
        saveSettingsDebounced();
    });

    $('#honcho_prefetch_interval').on('input', function () {
        settings().prefetchInterval = Math.max(1, Number($(this).val()) || 8);
        saveSettingsDebounced();
    });

    $('input[name="honcho_injection_position"]').on('change', function () {
        settings().injectionPosition = Number($(this).val());
        saveSettingsDebounced();
        updateConditionalSections();
    });

    $('#honcho_injection_depth').on('input', function () {
        settings().injectionDepth = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#honcho_prompt_template').on('input', function () {
        settings().promptTemplate = $(this).val();
        saveSettingsDebounced();
    });

    $('#honcho_context_tokens').on('input', function () {
        settings().contextTokens = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#honcho_context_interval').on('input', function () {
        settings().contextInterval = Math.max(1, Number($(this).val()) || 1);
        saveSettingsDebounced();
    });

    $('#honcho_context_summary').on('change', function () {
        settings().contextSummary = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // React to API key changes
    eventSource.on(event_types.SECRET_WRITTEN, () => updateStatusIndicator());
    eventSource.on(event_types.SECRET_DELETED, () => updateStatusIndicator());
}

// ─── Init ─────────────────────────────────────────────────

jQuery(async () => {
    // Merge default settings
    if (!extension_settings.honcho) {
        extension_settings.honcho = {};
    }
    extension_settings.honcho = Object.assign({}, defaultSettings, extension_settings.honcho);

    // Try to auto-populate from global ~/.honcho/config.json
    // (skipped when user has opted out via Ignore checkbox)
    try {
        if (extension_settings.honcho?.ignoreGlobalConfig) {
            throw new Error('ignored');
        }
        const configResp = await fetch(`${PLUGIN_BASE}/config`, {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        if (configResp.ok) {
            const globalConfig = await configResp.json();
            if (globalConfig.found) {
                // Cache for peer ID resolution
                globalConfigCache = globalConfig;

                let changed = false;

                // Auto-populate workspace if not set
                if (!settings().workspaceId && globalConfig.workspace) {
                    settings().workspaceId = globalConfig.workspace;
                    changed = true;
                    console.log(`[Honcho] Auto-populated workspace from global config: ${globalConfig.workspace}`);
                }

                // Auto-enable if global config says enabled and not yet configured
                if (globalConfig.enabled && !settings().enabled && globalConfig.hasApiKey) {
                    settings().enabled = true;
                    changed = true;
                    console.log('[Honcho] Auto-enabled from global config');
                }

                if (changed) {
                    saveSettingsDebounced();
                }
            }
        }
    } catch {
        // Global config not available — not an error
    }

    // Render settings panel
    const settingsHtml = await renderExtensionTemplateAsync('third-party/sillytavern-honcho', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    loadSettingsUI();
    bindSettingsListeners();

    // Register function tools for tool_call mode
    registerHonchoTools();

    // Subscribe to events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGeneration);
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharResponse);

    console.log('[Honcho] Extension loaded');
});
