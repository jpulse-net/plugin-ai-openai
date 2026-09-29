/**
 * @name            jPulse Framework / Plugins / AI OpenAI / Tests / Unit / Complete
 * @tagline         Fake-fetch completions against the published event contract
 * @file            plugins/ai-openai/webapp/tests/unit/complete-openai.test.js
 * @version         1.0.0
 * @release         2026-09-29
 * @repository      https://github.com/jpulse-net/plugin-ai-openai
 * @author          Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @copyright       2026 Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @license         BSL 1.1 -- see LICENSE file; for commercial use: team@jpulse.net
 * @genai           80%, Cursor 3.20, Grok 4.6
 */

import { describe, expect, test } from '@jest/globals';
import { completeOpenai } from '../../controller/aiOpenai.js';

function sse(...events) {
    return events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join('');
}

function okFetch(body) {
    return async function fetchFn() {
        return {
            ok: true,
            status: 200,
            body
        };
    };
}

function collect(context, deps) {
    const events = [];
    context.emit = (event) => events.push(event);
    return completeOpenai(context, deps).then(() => events);
}

function fetchFailed(code) {
    return async function fetchFn() {
        const err = new TypeError('fetch failed');
        if (code) {
            err.cause = { code };
        }
        throw err;
    };
}

const storedKey = async () => 'sk-testkey';
const emptyConfig = async () => ({});

describe('completeOpenai', () => {
    test('text-only stream emits text, four-way usage, and done/end', async () => {
        const body = sse(
            { type: 'response.output_text.delta', delta: 'Hello' },
            { type: 'response.output_text.delta', delta: ' world' },
            {
                type: 'response.completed',
                response: {
                    usage: {
                        input_tokens: 12,
                        output_tokens: 7,
                        input_tokens_details: {
                            cached_tokens: 5,
                            cache_write_tokens: 3
                        }
                    }
                }
            }
        );
        const events = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: okFetch(body)
        });
        expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['Hello', ' world']);
        const usage = events.find((e) => e.type === 'usage');
        expect(usage).toEqual({
            type: 'usage',
            tokensIn: 12,
            tokensOut: 7,
            cacheWrite: 3,
            cacheRead: 5
        });
        expect(usage.cacheWriteTokens).toBeUndefined();
        expect(events.find((e) => e.type === 'done')).toEqual({ type: 'done', stopReason: 'end' });
    });

    test('two function calls emit one calls array', async () => {
        const body = sse(
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'function_call', call_id: 'c1', name: 'get_outline' }
            },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"a"}' },
            {
                type: 'response.function_call_arguments.done',
                output_index: 0,
                name: 'get_outline',
                arguments: '{"q":"a"}'
            },
            {
                type: 'response.output_item.added',
                output_index: 1,
                item: { type: 'function_call', call_id: 'c2', name: 'get_title' }
            },
            { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' },
            {
                type: 'response.function_call_arguments.done',
                output_index: 1,
                name: 'get_title',
                arguments: '{}'
            },
            {
                type: 'response.completed',
                response: { usage: { output_tokens: 4 } }
            }
        );
        const events = await collect({
            messages: [{ role: 'user', content: 'outline' }],
            tools: [{ name: 'get_outline' }, { name: 'get_title' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: okFetch(body)
        });
        const toolUse = events.filter((e) => e.type === 'tool_use');
        expect(toolUse).toHaveLength(1);
        expect(toolUse[0].id).toBeUndefined();
        expect(toolUse[0].calls).toEqual([
            { id: 'c1', name: 'get_outline', args: { q: 'a' } },
            { id: 'c2', name: 'get_title', args: {} }
        ]);
        expect(events.find((e) => e.type === 'done').stopReason).toBe('tool');
    });

    test('truncated tool JSON does not drop a valid sibling', async () => {
        const body = sse(
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'function_call', call_id: 'ok', name: 'get_outline' }
            },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"ok":true}' },
            {
                type: 'response.function_call_arguments.done',
                output_index: 0,
                name: 'get_outline',
                arguments: '{"ok":true}'
            },
            {
                type: 'response.output_item.added',
                output_index: 1,
                item: { type: 'function_call', call_id: 'bad', name: 'get_title' }
            },
            { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"q":' },
            { type: 'response.completed', response: {} }
        );
        const events = await collect({
            messages: [{ role: 'user', content: 'go' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: okFetch(body)
        });
        expect(events.find((e) => e.type === 'tool_use').calls).toEqual([
            { id: 'ok', name: 'get_outline', args: { ok: true } }
        ]);
        expect(events.filter((e) => e.type === 'tool_use_truncated')).toEqual([{
            type: 'tool_use_truncated',
            id: 'bad',
            name: 'get_title',
            jsonLen: 5
        }]);
    });

    test('fetch failed with ECONNRESET is retryable and names the code', async () => {
        const events = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFailed('ECONNRESET')
        });
        expect(events).toEqual([{
            type: 'error',
            code: 'AI_PROVIDER_ERROR',
            message: 'fetch failed (ECONNRESET)',
            retryable: true
        }]);
    });

    test('ENOTFOUND and a TLS failure stay retryable false', async () => {
        const notFound = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFailed('ENOTFOUND')
        });
        expect(notFound).toEqual([{
            type: 'error',
            code: 'AI_PROVIDER_ERROR',
            message: 'fetch failed (ENOTFOUND)',
            retryable: false
        }]);
        const tls = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
        });
        expect(tls).toEqual([{
            type: 'error',
            code: 'AI_PROVIDER_ERROR',
            message: 'fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
            retryable: false
        }]);
    });

    test('429 is retryable and the body key is redacted', async () => {
        const events = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: async () => ({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                json: async () => ({
                    error: { message: 'rate limited for sk-proj-leakedKEY' }
                })
            })
        });
        expect(events).toEqual([{
            type: 'error',
            code: 'AI_RATE_LIMIT',
            message: 'rate limited for sk-proj-…',
            retryable: true
        }]);
    });

    test('missing key emits AI_NO_API_KEY without fetch', async () => {
        let fetched = false;
        const events = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: async () => '',
            getConfig: emptyConfig,
            fetch: async () => {
                fetched = true;
                throw new Error('should not fetch');
            }
        });
        expect(fetched).toBe(false);
        expect(events).toEqual([{
            type: 'error',
            code: 'AI_NO_API_KEY',
            message: 'OpenAI API key is not configured.',
            retryable: false
        }]);
    });

    test('abortSignal cancels the in-flight request', async () => {
        const abort = new AbortController();
        let sawSignal = false;
        const fetchFn = (url, opts) => {
            sawSignal = !!(opts && opts.signal);
            return new Promise((resolve, reject) => {
                opts.signal.addEventListener('abort', () => {
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        };
        const events = [];
        const pending = completeOpenai({
            messages: [{ role: 'user', content: 'Hi' }],
            emit: (event) => events.push(event),
            abortSignal: abort.signal
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: fetchFn
        });
        await new Promise((resolve) => setImmediate(resolve));
        abort.abort();
        await pending;
        expect(sawSignal).toBe(true);
        expect(events).toEqual([]);
    });

    test('plugin timeout emits AI_TIMEOUT, not AI_CANCELED', async () => {
        const fetchFn = (url, opts) => new Promise((resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
            });
        });
        const events = await collect({
            messages: [{ role: 'user', content: 'Hi' }]
        }, {
            getSecret: storedKey,
            getConfig: async () => ({ timeoutMs: 20 }),
            fetch: fetchFn
        });
        expect(events).toEqual([{
            type: 'error',
            code: 'AI_TIMEOUT',
            message: 'Request timed out.',
            retryable: false
        }]);
    });

    test('a function call without arguments.done is truncated', async () => {
        const body = sse(
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'function_call', call_id: 'cut', name: 'get_outline' }
            },
            { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
            { type: 'response.completed', response: {} }
        );
        const events = await collect({
            messages: [{ role: 'user', content: 'go' }]
        }, {
            getSecret: storedKey,
            getConfig: emptyConfig,
            fetch: okFetch(body)
        });
        expect(events.find((e) => e.type === 'tool_use')).toBeUndefined();
        expect(events.filter((e) => e.type === 'tool_use_truncated')).toEqual([{
            type: 'tool_use_truncated',
            id: 'cut',
            name: 'get_outline',
            jsonLen: 2
        }]);
    });

    test('request uses Responses path, stream, bearer key, instructions, and config model', async () => {
        let captured;
        const events = await collect({
            system: 'You are helpful.',
            messages: [{ role: 'user', content: 'Hi' }],
            tools: [
                { name: 'get_outline', schema: { type: 'object', properties: {} } },
                { name: 'get_title', schema: { type: 'object', properties: {} } }
            ]
        }, {
            getSecret: storedKey,
            getConfig: async () => ({
                model: 'gpt-6-luna',
                endpoint: 'https://api.example.com/'
            }),
            fetch: async (url, opts) => {
                captured = { url, opts };
                return { ok: true, status: 200, body: sse(
                    { type: 'response.output_text.delta', delta: 'ok' },
                    { type: 'response.completed', response: {} }
                ) };
            }
        });
        expect(captured.url).toBe('https://api.example.com/v1/responses');
        expect(captured.opts.headers.Authorization).toBe('Bearer sk-testkey');
        expect(JSON.stringify(captured.opts.body)).not.toContain('sk-testkey');
        const body = JSON.parse(captured.opts.body);
        expect(body.stream).toBe(true);
        expect(body.model).toBe('gpt-6-luna');
        expect(body.instructions).toBe('You are helpful.');
        expect(body.max_output_tokens).toBe(8192);
        expect(body.tools[0]).toEqual({
            type: 'function',
            name: 'get_outline',
            description: 'get_outline',
            parameters: { type: 'object', properties: {} }
        });
        expect(body.tools[0].cache_control).toBeUndefined();
        expect(events.find((e) => e.type === 'text_delta').text).toBe('ok');
    });
});

// EOF plugins/ai-openai/webapp/tests/unit/complete-openai.test.js
