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
import { user_avatar } from '../../../personas.js';
import { SECRET_KEYS, secret_state } from '../../../secrets.js';
import { selected_group } from '../../../group-chats.js';

const MODULE_NAME = 'honcho';
const PLUGIN_BASE = '/api/plugins/honcho-proxy';

const defaultSettings = {
    enabled: false,
    workspaceId: '',
    peerMode: 'single',
    contextMode: 'tool_call',
    prefetchQueries: ['Based on this message: "{{message}}", what do you know about the user that might be relevant?'],
    injectionPosition: extension_prompt_types.IN_PROMPT,
    injectionDepth: 4,
    promptTemplate: '[Honcho Memory]\n{{text}}',
    contextTokens: 2000,
    contextSummary: true,
};

let sessionSetupInProgress = false;
let lastGenerationChatIndex = -1;

/** Cache for late-arriving query results. Key = cache key, Value = result string. */
const lateResultCache = new Map();
/** In-flight background promises that outlived their timeout. Key = cache key. */
const pendingBackgroundQueries = new Map();

// ─── Helpers ──────────────────────────────────────────────

/** Sanitize a string to only contain letters, numbers, underscores, and hyphens. */
function sanitizeId(str) {
    return str.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
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
            // Append persona name for per-persona mode
            const personaName = context.name1 || 'default';
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
 * @returns {Promise<object|null>}
 */
async function honchoFetchRaw(endpoint, body) {
    try {
        const response = await fetch(`${PLUGIN_BASE}${endpoint}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                workspaceId: settings().workspaceId,
                ...body,
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            console.warn(`[Honcho] ${endpoint} failed (${response.status}):`, err.error || response.statusText);
            return null;
        }

        return await response.json();
    } catch (err) {
        console.warn(`[Honcho] ${endpoint} error:`, err.message);
        return null;
    }
}

/**
 * Make a request with a soft timeout. If the timeout expires:
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
        console.log(`[Honcho] Using cached late result for ${cacheKey}`);
        return cached;
    }

    const fetchPromise = honchoFetchRaw(endpoint, body);

    if (!cacheKey) {
        // No caching, just use a hard timeout
        try {
            const result = await Promise.race([
                fetchPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
            ]);
            return result;
        } catch {
            return null;
        }
    }

    // Soft timeout with background caching
    try {
        const result = await Promise.race([
            fetchPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
        ]);
        // Completed in time — clean up any pending background query
        pendingBackgroundQueries.delete(cacheKey);
        return result;
    } catch {
        // Timed out — let it run in the background and cache the result
        console.log(`[Honcho] ${endpoint} timed out after ${timeoutMs}ms, continuing in background (key: ${cacheKey})`);
        if (!pendingBackgroundQueries.has(cacheKey)) {
            const bgPromise = fetchPromise.then(result => {
                if (result) {
                    lateResultCache.set(cacheKey, result);
                    console.log(`[Honcho] Late result cached for ${cacheKey}`);
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
    if (!isReady()) {
        console.log('[Honcho] onChatChanged: not ready, skipping');
        return;
    }

    const rawChatId = getCurrentChatId();
    if (!rawChatId) {
        console.log('[Honcho] onChatChanged: no chat ID');
        return;
    }

    // Build a readable session ID: "charName-YYYY-MM-DD-hash"
    // Use a short hash of the raw ID for uniqueness while keeping it human-readable
    const charName = (this_chid !== undefined && characters[this_chid])
        ? characters[this_chid].name
        : 'chat';
    const dateMatch = rawChatId.match(/(\d{4}-\d{2}-\d{2})/);
    const dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
    const shortHash = Array.from(rawChatId)
        .reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)
        .toString(36).replace('-', '');
    const chatId = sanitizeId(`${charName}-${dateStr}-${shortHash}`);
    console.log(`[Honcho] onChatChanged: raw="${rawChatId}" sessionId="${chatId}"`);

    // Prevent race if CHAT_CHANGED fires multiple times
    if (sessionSetupInProgress) {
        console.log('[Honcho] onChatChanged: setup already in progress, skipping');
        return;
    }
    sessionSetupInProgress = true;

    try {
        const userPeerId = getUserPeerId();
        const charPeerId = getCharPeerId();
        console.log(`[Honcho] Setting up session: user="${userPeerId}" char="${charPeerId}"`);

        // Ensure peers exist
        const userPeer = await honchoFetch('/peer', { peerId: userPeerId, observeMe: true });
        console.log('[Honcho] User peer result:', userPeer);
        const charPeer = await honchoFetch('/peer', { peerId: charPeerId, observeMe: false });
        console.log('[Honcho] Char peer result:', charPeer);

        // Ensure session exists with peers
        const result = await honchoFetch('/session', {
            sessionId: chatId,
            userPeerId,
            charPeerId,
        });
        console.log('[Honcho] Session result:', result);

        if (result) {
            updateChatMetadata({
                honcho: {
                    sessionId: chatId,
                    userPeerId,
                    charPeerId,
                },
            });
            saveMetadataDebounced();
            console.log(`[Honcho] Session ready for chat: ${chatId}`);

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
            console.warn('[Honcho] Session setup failed — result was null');
        }
    } catch (err) {
        console.error('[Honcho] onChatChanged error:', err);
    } finally {
        sessionSetupInProgress = false;
    }
}

/**
 * GENERATION_AFTER_COMMANDS — Inject context before generation.
 */
async function onGeneration() {
    if (!isReady()) return;

    const mode = settings().contextMode;

    // Tool call mode: no pre-injection needed
    if (mode === 'tool_call') return;

    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId) return;

    // Dedup guard: prevent double-firing for the same chat index
    const currentIndex = chat.length - 1;
    if (currentIndex >= 0 && currentIndex === lastGenerationChatIndex) {
        console.log(`[Honcho] onGeneration: skipping duplicate for index ${currentIndex}`);
        return;
    }
    lastGenerationChatIndex = currentIndex;

    // Get the last user message for contextual queries
    let lastUserMessage = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user && chat[i]?.mes) {
            lastUserMessage = chat[i].mes;
            break;
        }
    }

    let contextText = '';

    try {
        if (mode === 'prefetch') {
            const queries = settings().prefetchQueries || [];
            const results = [];

            for (const query of queries) {
                let trimmed = query.trim();
                if (!trimmed) continue;

                // Replace {{message}} with the user's last message
                trimmed = trimmed.replace(/\{\{message\}\}/gi, lastUserMessage);

                const cacheKey = `prefetch:${honchoMeta.sessionId}:${trimmed.slice(0, 40)}`;
                const result = await honchoFetch('/chat', {
                    peerId: honchoMeta.userPeerId,
                    query: trimmed,
                    sessionId: honchoMeta.sessionId,
                }, 15000, cacheKey);

                if (result?.response) {
                    results.push(result.response);
                }
            }

            contextText = results.join('\n\n');
        } else if (mode === 'context') {
            const result = await honchoFetch('/context', {
                sessionId: honchoMeta.sessionId,
                userPeerId: honchoMeta.userPeerId,
                tokens: settings().contextTokens,
                summary: settings().contextSummary,
            });

            if (result?.context) {
                contextText = result.context;
            }
        }
    } catch (err) {
        console.warn('[Honcho] Context injection error:', err.message);
    }

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
    if (!isReady()) {
        console.log('[Honcho] onMessageSent: not ready, skipping');
        return;
    }

    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId) {
        console.log('[Honcho] onMessageSent: no session in metadata, skipping');
        return;
    }

    const message = chat[messageIndex];
    if (!message || !message.is_user) return;

    console.log(`[Honcho] Storing user message (index ${messageIndex})`);
    const result = await honchoFetch('/session/messages', {
        sessionId: honchoMeta.sessionId,
        messages: [{ peerId: honchoMeta.userPeerId, content: message.mes }],
    });
    console.log('[Honcho] User message store result:', result);
}

/**
 * CHARACTER_MESSAGE_RENDERED — Store AI response in Honcho.
 */
async function onCharResponse(messageIndex) {
    if (!isReady()) {
        console.log('[Honcho] onCharResponse: not ready, skipping');
        return;
    }

    const honchoMeta = chat_metadata?.honcho;
    if (!honchoMeta?.sessionId) {
        console.log('[Honcho] onCharResponse: no session in metadata, skipping');
        return;
    }

    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) return;

    // Skip swiped-away messages (only store if this is the latest message)
    if (messageIndex !== chat.length - 1) return;

    console.log(`[Honcho] Storing char message (index ${messageIndex})`);
    const result = await honchoFetch('/session/messages', {
        sessionId: honchoMeta.sessionId,
        messages: [{ peerId: honchoMeta.charPeerId, content: message.mes }],
    });
    console.log('[Honcho] Char message store result:', result);
}

// ─── Tool Registration ────────────────────────────────────

function registerHonchoTools() {
    const context = getContext();
    const shouldRegister = () => isReady() && settings().contextMode === 'tool_call';

    // Query memory — dialectic reasoning about the user
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
        stealth: true,
    });

    // Save observation — write a conclusion about the user to persistent memory
    context.registerFunctionTool({
        name: 'honcho_save_observation',
        displayName: 'Honcho: Save Observation',
        description: 'Save an important observation, insight, or fact about the user to persistent memory. Use this when you learn something worth remembering: preferences, biographical details, emotional states, recurring topics, or relationship dynamics.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: 'The observation to save, e.g. "The user prefers riddles over trivia" or "User\'s name is Erosika"',
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

            return result ? `Observation saved: ${args.content}` : 'Failed to save observation.';
        },
        formatMessage: () => 'Saving observation to memory...',
        shouldRegister,
        stealth: true,
    });

    // Search conversation history — semantic search across messages
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
        stealth: true,
    });
}

// ─── Settings UI ──────────────────────────────────────────

function updateStatusIndicator() {
    const $status = $('#honcho_status');
    if (isReady()) {
        $status.text('Ready').removeClass('not-ready').addClass('ready');
    } else {
        const reasons = [];
        if (!settings()?.enabled) reasons.push('disabled');
        if (!settings()?.workspaceId) reasons.push('no workspace ID');
        if (!secret_state[SECRET_KEYS.HONCHO] && !globalConfigCache?.hasApiKey) reasons.push('no API key');
        $status.text(`Not ready: ${reasons.join(', ')}`).removeClass('ready').addClass('not-ready');
    }
}

function updateConditionalSections() {
    const mode = settings()?.contextMode;
    $('#honcho_prefetch_section').toggle(mode === 'prefetch');
    $('#honcho_context_section').toggle(mode === 'context');

    const position = Number(settings()?.injectionPosition);
    $('#honcho_depth_section').toggle(position === extension_prompt_types.IN_CHAT);
}

function loadSettingsUI() {
    const s = settings();
    $('#honcho_enabled').prop('checked', s.enabled);
    $('#honcho_workspace_id').val(s.workspaceId);
    $(`input[name="honcho_peer_mode"][value="${s.peerMode}"]`).prop('checked', true);
    $(`input[name="honcho_context_mode"][value="${s.contextMode}"]`).prop('checked', true);
    $('#honcho_prefetch_queries').val((s.prefetchQueries || []).join('\n'));
    $(`input[name="honcho_injection_position"][value="${s.injectionPosition}"]`).prop('checked', true);
    $('#honcho_injection_depth').val(s.injectionDepth);
    $('#honcho_prompt_template').val(s.promptTemplate);
    $('#honcho_context_tokens').val(s.contextTokens);
    $('#honcho_context_summary').prop('checked', s.contextSummary);

    // Show global config source info
    if (globalConfigCache?.found) {
        const source = [];
        if (globalConfigCache.hasApiKey && !secret_state[SECRET_KEYS.HONCHO]) {
            source.push('API key');
        }
        if (globalConfigCache.workspace && s.workspaceId === globalConfigCache.workspace) {
            source.push('workspace');
        }
        if (globalConfigCache.peerName) {
            source.push(`peer: ${globalConfigCache.peerName}`);
        }
        if (source.length > 0) {
            $('#honcho_config_source').text(`~/.honcho/config.json (${source.join(', ')})`).show();
        }
    } else {
        $('#honcho_config_source').hide();
    }

    updateConditionalSections();
    updateStatusIndicator();
}

function bindSettingsListeners() {
    $('#honcho_enabled').on('change', function () {
        settings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
        updateStatusIndicator();
    });

    $('#honcho_workspace_id').on('input', function () {
        settings().workspaceId = $(this).val().trim();
        saveSettingsDebounced();
        updateStatusIndicator();
    });

    $('input[name="honcho_peer_mode"]').on('change', function () {
        settings().peerMode = $(this).val();
        saveSettingsDebounced();
    });

    $('input[name="honcho_context_mode"]').on('change', function () {
        settings().contextMode = $(this).val();
        saveSettingsDebounced();
        updateConditionalSections();
    });

    $('#honcho_prefetch_queries').on('input', function () {
        settings().prefetchQueries = $(this).val().split('\n').filter(q => q.trim());
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
    try {
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
    } catch (err) {
        console.log('[Honcho] Could not fetch global config:', err.message);
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
