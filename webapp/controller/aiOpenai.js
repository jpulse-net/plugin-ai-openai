/**
 * @name            jPulse Framework / Plugins / AI OpenAI / WebApp / Controller
 * @tagline         OpenAI onAiComplete provider with Responses SSE
 * @description     Streams Responses API events into the published ai-core
 *                  contract: array tool_use, four-way usage, $/MTok prices
 * @file            plugins/ai-openai/webapp/controller/aiOpenai.js
 * @version         1.0.0
 * @release         2026-09-29
 * @repository      https://github.com/jpulse-net/plugin-ai-openai
 * @author          Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @copyright       2026 Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @license         BSL 1.1 -- see LICENSE file; for commercial use: team@jpulse.net
 * @genai           80%, Cursor 3.20, Grok 4.6
 */

const PLUGIN_ID = 'ai-openai';
const DEFAULT_ENDPOINT = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-6-sol';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOKENS = 8192;
const SENSITIVE_MASK = '********';

/** USD per million tokens. Short-context Standard. Verified 2026-09-26 from OpenAI pricing. */
export const PRICE_TABLE = {
    'gpt-6-sol': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    'gpt-6-luna': { input: 0.10, output: 0.50, cacheWrite: 0.125, cacheRead: 0.01 },
    'gpt-6-astra': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }
};

export const DEFAULT_MODELS = [
    { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' }
];

function isMask(value) {
    if (global.PluginModel && typeof global.PluginModel.isSensitiveMask === 'function') {
        return global.PluginModel.isSensitiveMask(value);
    }
    return value === SENSITIVE_MASK;
}

function isUsableKey(value) {
    return typeof value === 'string' && value !== '' && !isMask(value);
}

function isValidPriceRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return false;
    }
    return ['input', 'output', 'cacheWrite', 'cacheRead'].every((k) => {
        return typeof row[k] === 'number' && Number.isFinite(row[k]);
    });
}

function clonePriceTable(table) {
    const out = {};
    Object.keys(table).forEach((id) => {
        out[id] = { ...table[id] };
    });
    return out;
}

export function mergePriceTable(overrideJson) {
    const merged = clonePriceTable(PRICE_TABLE);
    if (typeof overrideJson === 'string' && overrideJson.trim()) {
        try {
            const parsed = JSON.parse(overrideJson);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                Object.keys(parsed).forEach((id) => {
                    if (!parsed[id] || typeof parsed[id] !== 'object' || Array.isArray(parsed[id])) {
                        return;
                    }
                    const candidate = { ...(merged[id] || {}), ...parsed[id] };
                    if (isValidPriceRow(candidate)) {
                        merged[id] = candidate;
                    }
                });
            }
        } catch (_err) { /* keep built-in table */ }
    }
    return merged;
}

export function ratesForModel(model, overrideJson) {
    const table = mergePriceTable(overrideJson);
    const row = table[model];
    if (!row || typeof row !== 'object') {
        return null;
    }
    const out = {};
    let known = false;
    ['input', 'output', 'cacheWrite', 'cacheRead'].forEach((k) => {
        if (typeof row[k] === 'number' && Number.isFinite(row[k])) {
            out[k] = row[k];
            known = true;
        }
    });
    return known ? out : null;
}

export function toOpenaiTools(tools) {
    const list = Array.isArray(tools) ? tools : [];
    return list.map((t) => {
        const schema = t.schema && typeof t.schema === 'object'
            ? t.schema
            : { type: 'object', properties: {} };
        return {
            type: 'function',
            name: t.name,
            description: t.description || t.name,
            parameters: schema
        };
    });
}

export function toOpenaiInput(messages) {
    const out = [];
    (messages || []).forEach((m) => {
        if (!m || !m.role) return;
        if (m.role === 'system') return;
        if (m.role === 'tool') {
            out.push({
                type: 'function_call_output',
                call_id: m.toolCallId || m.id || '',
                output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
            });
            return;
        }
        if (m.role === 'assistant') {
            if (m.content) {
                out.push({ role: 'assistant', content: String(m.content) });
            }
            (m.toolCalls || []).forEach((tc) => {
                const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
                out.push({
                    type: 'function_call',
                    call_id: tc.id || '',
                    name: tc.name || '',
                    arguments: JSON.stringify(args)
                });
            });
            return;
        }
        if (m.role === 'user') {
            if (Array.isArray(m.content)) {
                const content = [];
                m.content.forEach((part) => {
                    if (!part || typeof part !== 'object') return;
                    if (part.type === 'image') {
                        const mime = part.mimeType || 'image/jpeg';
                        content.push({
                            type: 'input_image',
                            image_url: 'data:' + mime + ';base64,' + String(part.data || '')
                        });
                        return;
                    }
                    if (part.type === 'text') {
                        content.push({
                            type: 'input_text',
                            text: String(part.text || '')
                        });
                    }
                });
                if (content.length) {
                    out.push({ role: 'user', content });
                }
                return;
            }
            out.push({ role: 'user', content: String(m.content || '') });
        }
    });
    return out;
}

export const toOpenaiMessages = toOpenaiInput;

export function mapUsage(raw) {
    const u = raw && typeof raw === 'object' ? raw : {};
    const details = u.input_tokens_details && typeof u.input_tokens_details === 'object'
        ? u.input_tokens_details
        : {};
    return {
        tokensIn: u.input_tokens || 0,
        tokensOut: u.output_tokens || 0,
        cacheWrite: details.cache_write_tokens || u.cache_write_tokens || 0,
        cacheRead: details.cached_tokens || u.cached_tokens || 0
    };
}

export function mapStopReason(reason) {
    if (reason === 'function_call' || reason === 'tool_calls' || reason === 'tool_use') {
        return 'tool';
    }
    if (reason === 'max_output_tokens' || reason === 'max_tokens' || reason === 'length') {
        return 'length';
    }
    return 'end';
}

export function sanitizeError(text) {
    return String(text || 'OpenAI request failed').replace(
        /sk-(proj-|svcacct-)?[A-Za-z0-9_-]+/g,
        (_m, kind) => 'sk-' + (kind || '') + '…'
    );
}

const RETRYABLE_CAUSE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT'
]);

function causeCode(error) {
    const cause = error && error.cause;
    if (!cause || typeof cause !== 'object') {
        return '';
    }
    return typeof cause.code === 'string' ? cause.code : '';
}

export function consumeSse(buffer) {
    const normalized = String(buffer || '').replace(/\r\n/g, '\n');
    const parts = normalized.split('\n\n');
    const rest = parts.pop() || '';
    const events = [];
    parts.forEach((block) => {
        let data = '';
        String(block).split('\n').forEach((line) => {
            if (line.indexOf('data:') === 0) {
                const chunk = line.slice(5).trim();
                data = data ? data + '\n' + chunk : chunk;
            }
        });
        if (!data || data === '[DONE]') return;
        try {
            events.push(JSON.parse(data));
        } catch (_err) { /* skip malformed */ }
    });
    return { events, rest };
}

async function loadPluginModel() {
    if (global.PluginModel) return global.PluginModel;
    const mod = await import('../../../../webapp/model/plugin.js');
    return mod.default;
}

async function defaultGetSecret() {
    const PluginModel = await loadPluginModel();
    if (!PluginModel || typeof PluginModel.getSecret !== 'function') return '';
    const value = await PluginModel.getSecret(PLUGIN_ID, 'apiKey');
    return typeof value === 'string' ? value : '';
}

async function defaultGetConfig() {
    const PluginModel = await loadPluginModel();
    if (!PluginModel || typeof PluginModel.getByName !== 'function') return {};
    const doc = await PluginModel.getByName(PLUGIN_ID);
    return (doc && doc.config) || {};
}

function headerMap(apiKey) {
    return {
        'Authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json'
    };
}

function endpointOf(config) {
    const raw = (config && config.endpoint) || DEFAULT_ENDPOINT;
    return String(raw).replace(/\/+$/, '');
}

/**
 * Same rule as EmailController._resolveTestSmtpPass: a newly typed (non-empty,
 * non-mask) field value is used as-is so Verify works before Save. Mask or
 * empty falls back to the stored secret.
 * @param {*} submitted - apiKey from the request body
 * @param {*} stored - PluginModel.getSecret value
 * @returns {string}
 */
export function resolveVerifyApiKey(submitted, stored) {
    if (isUsableKey(submitted)) {
        return submitted;
    }
    if (isUsableKey(stored)) {
        return stored;
    }
    return '';
}

export async function buildProviderDescriptor(deps) {
    deps = deps || {};
    const getSecret = deps.getSecret || defaultGetSecret;
    const getConfig = deps.getConfig || defaultGetConfig;
    let maxTokens = DEFAULT_MAX_TOKENS;
    let overrideJson = '';
    try {
        const config = await getConfig();
        const n = parseInt(config.maxTokens, 10);
        if (Number.isFinite(n) && n > 0) maxTokens = n;
        if (typeof config.priceTableOverride === 'string') {
            overrideJson = config.priceTableOverride;
        }
    } catch (_err) { /* tests and first boot have no plugin doc */ }
    let apiKey = '';
    try {
        apiKey = await getSecret();
    } catch (_err) { /* same: no plugin doc yet */ }
    return {
        plugin: PLUGIN_ID,
        label: 'OpenAI',
        models: DEFAULT_MODELS.slice(),
        capabilities: { vision: true },
        priceTable: mergePriceTable(overrideJson),
        maxTokens,
        configured: isUsableKey(apiKey)
    };
}

export async function pingModels(deps) {
    const getSecret = deps.getSecret || defaultGetSecret;
    const getConfig = deps.getConfig || defaultGetConfig;
    const fetchFn = deps.fetch || global.fetch;
    const stored = await getSecret();
    const apiKey = resolveVerifyApiKey(deps.apiKey, stored);
    if (!apiKey) {
        return { configured: false, valid: false, message: 'OpenAI API key is not configured.' };
    }
    const config = await getConfig();
    const endpoint = (typeof deps.endpoint === 'string' && deps.endpoint.trim())
        ? String(deps.endpoint).replace(/\/+$/, '')
        : endpointOf(config);
    const url = endpoint + '/v1/models';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
        const res = await fetchFn(url, {
            method: 'GET',
            headers: headerMap(apiKey),
            signal: ctrl.signal
        });
        if (res.ok) {
            return { configured: true, valid: true, message: 'OpenAI API key is valid.' };
        }
        if (res.status === 401 || res.status === 403) {
            return { configured: true, valid: false, message: 'OpenAI rejected the API key.' };
        }
        return {
            configured: true,
            valid: false,
            message: sanitizeError('OpenAI verify failed (' + res.status + ').')
        };
    } catch (error) {
        if (error && error.name === 'AbortError') {
            return { configured: true, valid: false, message: 'OpenAI verify timed out.' };
        }
        return { configured: true, valid: false, message: sanitizeError(error && error.message) };
    } finally {
        clearTimeout(t);
    }
}

async function readSse(body, onEvent, signal) {
    if (!body || typeof body.getReader !== 'function') {
        const text = typeof body === 'string' ? body
            : (body && typeof body.text === 'function' ? await body.text() : '');
        const parsed = consumeSse(text + '\n\n');
        parsed.events.forEach(onEvent);
        return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
        if (signal && signal.aborted) {
            try { await reader.cancel(); } catch (_err) { /* ignore */ }
            return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = consumeSse(buf);
        buf = parsed.rest;
        parsed.events.forEach(onEvent);
    }
    if (buf.trim()) {
        consumeSse(buf + '\n\n').events.forEach(onEvent);
    }
}

function parseToolArgs(tb) {
    if (!tb.stopped) {
        return { ok: false };
    }
    if (!tb.json) {
        return { ok: true, args: {} };
    }
    try {
        const parsed = JSON.parse(tb.json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, args: parsed };
        }
        return { ok: true, args: {} };
    } catch (_err) {
        return { ok: false };
    }
}

function toolKeys(ev) {
    const keys = [];
    if (typeof ev.output_index === 'number') {
        keys.push('i:' + ev.output_index);
    }
    if (ev.item_id) {
        keys.push('id:' + ev.item_id);
    }
    if (ev.item && ev.item.id) {
        keys.push('id:' + ev.item.id);
    }
    return keys;
}

function rememberTool(toolBlocks, ev, fields) {
    const keys = toolKeys(ev);
    let tb = null;
    keys.forEach((k) => {
        if (toolBlocks[k]) tb = toolBlocks[k];
    });
    if (!tb) {
        tb = { id: '', name: '', json: '', stopped: false };
    }
    if (fields.id) tb.id = fields.id;
    if (fields.name) tb.name = fields.name;
    if (typeof fields.jsonChunk === 'string') tb.json += fields.jsonChunk;
    if (typeof fields.json === 'string') tb.json = fields.json;
    if (fields.stopped) tb.stopped = true;
    keys.forEach((k) => {
        toolBlocks[k] = tb;
    });
    return tb;
}

function applyUsage(target, raw) {
    const u = mapUsage(raw);
    if (u.tokensIn) target.tokensIn += u.tokensIn;
    if (u.tokensOut) target.tokensOut += u.tokensOut;
    if (u.cacheWrite) target.cacheWrite += u.cacheWrite;
    if (u.cacheRead) target.cacheRead += u.cacheRead;
}

export async function completeOpenai(context, deps) {
    deps = deps || {};
    const getSecret = deps.getSecret || defaultGetSecret;
    const getConfig = deps.getConfig || defaultGetConfig;
    const fetchFn = deps.fetch || global.fetch;
    const emit = typeof context.emit === 'function' ? context.emit : function() {};

    const apiKey = await getSecret();
    if (!isUsableKey(apiKey)) {
        emit({
            type: 'error',
            code: 'AI_NO_API_KEY',
            message: 'OpenAI API key is not configured.',
            retryable: false
        });
        return context;
    }

    const config = await getConfig();
    const model = context.model || config.model || DEFAULT_MODEL;
    const timeoutMs = parseInt(config.timeoutMs, 10) || DEFAULT_TIMEOUT_MS;
    const maxTokens = parseInt(config.maxTokens, 10) || DEFAULT_MAX_TOKENS;

    const systemText = typeof context.system === 'string' ? context.system.trim() : '';
    const body = {
        model,
        max_output_tokens: maxTokens,
        stream: true,
        input: toOpenaiInput(context.messages)
    };
    if (systemText) {
        body.instructions = systemText;
    }
    const tools = toOpenaiTools(context.tools);
    if (tools.length) body.tools = tools;

    const ctrl = new AbortController();
    const onAbort = function() { ctrl.abort(); };
    if (context.abortSignal) {
        if (context.abortSignal.aborted) {
            return context;
        }
        context.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
        const res = await fetchFn(endpointOf(config) + '/v1/responses', {
            method: 'POST',
            headers: headerMap(apiKey),
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
        if (!res.ok) {
            let detail = res.statusText || '';
            try {
                const errBody = await res.json();
                if (errBody && errBody.error && errBody.error.message) detail = errBody.error.message;
            } catch (_err) { /* keep statusText */ }
            const retryable = res.status === 429;
            emit({
                type: 'error',
                code: retryable ? 'AI_RATE_LIMIT' : 'AI_PROVIDER_ERROR',
                message: sanitizeError(detail || ('HTTP ' + res.status)),
                retryable
            });
            return context;
        }

        const usage = { tokensIn: 0, tokensOut: 0, cacheWrite: 0, cacheRead: 0 };
        const toolBlocks = {};
        let stopReason = '';

        await readSse(res.body, function(ev) {
            if (!ev || !ev.type) return;
            if (ev.type === 'response.output_text.delta' && ev.delta) {
                emit({ type: 'text_delta', text: ev.delta });
            }
            if (ev.type === 'response.output_item.added' && ev.item && ev.item.type === 'function_call') {
                rememberTool(toolBlocks, ev, {
                    id: ev.item.call_id || '',
                    name: ev.item.name || '',
                    json: typeof ev.item.arguments === 'string' ? ev.item.arguments : ''
                });
            }
            if (ev.type === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
                rememberTool(toolBlocks, ev, { jsonChunk: ev.delta });
            }
            if (ev.type === 'response.function_call_arguments.done') {
                rememberTool(toolBlocks, ev, {
                    id: ev.call_id || (ev.item && ev.item.call_id) || '',
                    name: ev.name || (ev.item && ev.item.name) || '',
                    json: typeof ev.arguments === 'string'
                        ? ev.arguments
                        : (ev.item && typeof ev.item.arguments === 'string' ? ev.item.arguments : undefined),
                    stopped: true
                });
            }
            if (ev.type === 'response.output_item.done' && ev.item && ev.item.type === 'function_call') {
                rememberTool(toolBlocks, ev, {
                    id: ev.item.call_id || '',
                    name: ev.item.name || '',
                    json: typeof ev.item.arguments === 'string' ? ev.item.arguments : undefined,
                    stopped: true
                });
            }
            if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
                const resp = ev.response && typeof ev.response === 'object' ? ev.response : {};
                if (resp.usage) applyUsage(usage, resp.usage);
                if (ev.usage) applyUsage(usage, ev.usage);
                const incomplete = resp.incomplete_details && resp.incomplete_details.reason;
                if (incomplete) stopReason = incomplete;
                else if (resp.status === 'incomplete') stopReason = stopReason || 'max_output_tokens';
            }
            if (ev.usage && ev.type !== 'response.completed' && ev.type !== 'response.incomplete') {
                applyUsage(usage, ev.usage);
            }
        }, context.abortSignal);

        if (context.abortSignal && context.abortSignal.aborted) {
            return context;
        }

        const calls = [];
        const truncated = [];
        const seen = new Set();
        Object.keys(toolBlocks).forEach((key) => {
            const tb = toolBlocks[key];
            if (seen.has(tb)) return;
            seen.add(tb);
            const parsed = parseToolArgs(tb);
            if (parsed.ok) {
                calls.push({ id: tb.id, name: tb.name, args: parsed.args });
                return;
            }
            truncated.push({
                type: 'tool_use_truncated',
                id: tb.id,
                name: tb.name,
                jsonLen: (tb.json || '').length
            });
        });
        if (calls.length) {
            emit({ type: 'tool_use', calls });
            if (!stopReason) stopReason = 'function_call';
        }
        truncated.forEach((event) => emit(event));

        context.usage = usage;
        emit({ type: 'usage', ...usage });
        emit({ type: 'done', stopReason: mapStopReason(stopReason) });
        return context;
    } catch (error) {
        if (error && error.name === 'AbortError') {
            if (context.abortSignal && context.abortSignal.aborted) {
                return context;
            }
            emit({
                type: 'error',
                code: 'AI_TIMEOUT',
                message: 'Request timed out.',
                retryable: false
            });
            return context;
        }
        const code = causeCode(error);
        const message = sanitizeError(
            code ? ('fetch failed (' + code + ')') : (error && error.message)
        );
        emit({
            type: 'error',
            code: 'AI_PROVIDER_ERROR',
            message,
            retryable: RETRYABLE_CAUSE_CODES.has(code)
        });
        return context;
    } finally {
        clearTimeout(timer);
        if (context.abortSignal) {
            context.abortSignal.removeEventListener('abort', onAbort);
        }
    }
}

class AiOpenaiController {
    static hooks = {
        onAiProviderRegister: { handler: 'onAiProviderRegister' },
        onAiComplete: { handler: 'onAiComplete' }
    };

    static routes = [
        { method: 'POST', path: '/api/1/aiOpenai/verify-api-key', handler: 'apiVerifyApiKey', auth: 'admin' }
    ];

    static async onAiProviderRegister(context) {
        if (!Array.isArray(context.providers)) context.providers = [];
        context.providers.push(await buildProviderDescriptor());
        return context;
    }

    static async onAiComplete(context) {
        return completeOpenai(context);
    }

    static async apiVerifyApiKey(req, res) {
        const startTime = Date.now();
        const LogController = global.LogController;
        const CommonUtils = global.CommonUtils;
        const AuthController = global.AuthController;
        const sendError = (status, message, code, extra) => {
            if (CommonUtils?.sendError) {
                return CommonUtils.sendError(req, res, status, message, code, extra);
            }
            return res.status(status).json({ success: false, error: message, code });
        };
        try {
            LogController?.logRequest(req, 'aiOpenai.verifyApiKey', 'verify request');
            const Auth = AuthController || (await import('../../../../webapp/controller/auth.js')).default;
            if (!Auth || !Auth.isAdmin(req)) {
                LogController?.logError(req, 'aiOpenai.verifyApiKey', 'error: admin role required');
                return sendError(403, 'Administrator access required', 'FORBIDDEN');
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const result = await pingModels({
                apiKey: body.apiKey,
                endpoint: body.endpoint
            });
            const elapsed = Date.now() - startTime;
            LogController?.logInfo(req, 'aiOpenai.verifyApiKey',
                `success: configured=${result.configured} valid=${result.valid} completed in ${elapsed}ms`);
            res.json({
                success: true,
                data: { configured: result.configured, valid: result.valid },
                message: result.message,
                elapsed
            });
        } catch (error) {
            LogController?.logError(req, 'aiOpenai.verifyApiKey', 'error: ' + error.message);
            return sendError(500, 'Failed to verify OpenAI API key', 'INTERNAL_ERROR', error.message);
        }
    }
}

export default AiOpenaiController;

// EOF plugins/ai-openai/webapp/controller/aiOpenai.js
