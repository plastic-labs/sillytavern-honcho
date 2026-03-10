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
    contextMode: 'prefetch',
    prefetchQueries: ['What do you know about the user?'],
    injectionPosition: extension_prompt_types.IN_PROMPT,
    injectionDepth: 4,
    promptTemplate: '[Honcho Memory]\n{{text}}',
    contextTokens: 2000,
    contextSummary: true,
};

let sessionSetupInProgress = false;

// ─── Helpers ──────────────────────────────────────────────

function isReady() {
    return (
        extension_settings.honcho?.enabled &&
        extension_settings.honcho?.workspaceId &&
        secret_state[SECRET_KEYS.HONCHO]
    );
}

function settings() {
    return extension_settings.honcho;
}

/**
 * Resolve the user peer ID based on current peer mode.
 */
function getUserPeerId() {
    const context = getContext();
    if (settings().peerMode === 'per_persona') {
        return user_avatar || context.name1 || 'default-user';
    }
    // Single mode: stable across persona switches
    return `st-user-${context.name1 || 'default'}`;
}

/**
 * Resolve the character peer ID.
 */
function getCharPeerId() {
    if (selected_group) {
        return `group-${selected_group}`;
    }
    if (this_chid !== undefined && characters[this_chid]) {
        return characters[this_chid].avatar || `char-${this_chid}`;
    }
    return 'unknown-char';
}

/**
 * Make a request to the Honcho plugin proxy.
 * @param {string} endpoint
 * @param {object} body
 * @returns {Promise<object|null>}
 */
async function honchoFetch(endpoint, body) {
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

// ─── Event Handlers ───────────────────────────────────────

/**
 * CHAT_CHANGED — Ensure a Honcho session exists for this chat.
 */
async function onChatChanged() {
    if (!isReady()) return;

    const chatId = getCurrentChatId();
    if (!chatId) return;

    // Prevent race if CHAT_CHANGED fires multiple times
    if (sessionSetupInProgress) return;
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
            console.log(`[Honcho] Session ready for chat: ${chatId}`);
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

    let contextText = '';

    try {
        if (mode === 'prefetch') {
            const queries = settings().prefetchQueries || [];
            const results = [];

            for (const query of queries) {
                const trimmed = query.trim();
                if (!trimmed) continue;

                const result = await honchoFetch('/chat', {
                    peerId: honchoMeta.userPeerId,
                    query: trimmed,
                    sessionId: honchoMeta.sessionId,
                });

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

function registerHonchoTool() {
    const context = getContext();

    context.registerFunctionTool({
        name: 'honcho_query_memory',
        displayName: 'Honcho Memory',
        description: 'Query the user\'s memory and personal context from Honcho. Use this to recall what you know about the user.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The question to ask about the user, e.g. "What are the user\'s preferences?"',
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

            const result = await honchoFetch('/chat', {
                peerId: honchoMeta.userPeerId,
                query: args.query,
                sessionId: honchoMeta.sessionId,
            });

            return result?.response || 'No information available.';
        },
        formatMessage: () => 'Querying Honcho memory...',
        shouldRegister: () => {
            return isReady() && settings().contextMode === 'tool_call';
        },
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
        if (!secret_state[SECRET_KEYS.HONCHO]) reasons.push('no API key');
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

    // Render settings panel
    const settingsHtml = await renderExtensionTemplateAsync('third-party/sillytavern-honcho', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    loadSettingsUI();
    bindSettingsListeners();

    // Register function tool for tool_call mode
    registerHonchoTool();

    // Subscribe to events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGeneration);
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onCharResponse);

    console.log('[Honcho] Extension loaded');
});
