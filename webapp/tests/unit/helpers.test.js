/**
 * @name            jPulse Framework / Plugins / AI OpenAI / Tests / Unit / Helpers
 * @tagline         SSE parser, usage map, stop reason, sanitize, verify, prices
 * @file            plugins/ai-openai/webapp/tests/unit/helpers.test.js
 * @version         1.0.0
 * @release         2026-09-29
 * @repository      https://github.com/jpulse-net/plugin-ai-openai
 * @author          Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @copyright       2026 Peter Thoeny, https://twiki.org & https://github.com/peterthoeny/
 * @license         BSL 1.1 -- see LICENSE file; for commercial use: team@jpulse.net
 * @genai           80%, Cursor 3.20, Grok 4.6
 */

import { describe, expect, test } from '@jest/globals';
import {
    consumeSse,
    mapStopReason,
    mapUsage,
    mergePriceTable,
    pingModels,
    PRICE_TABLE,
    ratesForModel,
    resolveVerifyApiKey,
    sanitizeError,
    toOpenaiInput,
    toOpenaiMessages,
    toOpenaiTools
} from '../../controller/aiOpenai.js';

describe('consumeSse', () => {
    test('split chunk leaves the incomplete event in the buffer', () => {
        const first = 'data: {"type":"a"}\n\ndata: {"type":';
        const parsed = consumeSse(first);
        expect(parsed.events).toEqual([{ type: 'a' }]);
        expect(parsed.rest).toBe('data: {"type":');
        const second = consumeSse(parsed.rest + '"b"}\n\n');
        expect(second.events).toEqual([{ type: 'b' }]);
        expect(second.rest).toBe('');
    });

    test('malformed data: line is skipped; rest stays in the buffer', () => {
        const parsed = consumeSse('data: {bad\n\ndata: {"type":"ok"}\n\ndata: {"type":');
        expect(parsed.events).toEqual([{ type: 'ok' }]);
        expect(parsed.rest).toBe('data: {"type":');
    });
});

describe('mapUsage', () => {
    test('maps four-way Responses usage fields', () => {
        expect(mapUsage({
            input_tokens: 10,
            output_tokens: 4,
            input_tokens_details: {
                cached_tokens: 8,
                cache_write_tokens: 2
            }
        })).toEqual({
            tokensIn: 10,
            tokensOut: 4,
            cacheWrite: 2,
            cacheRead: 8
        });
    });

    test('missing fields are zero', () => {
        expect(mapUsage({})).toEqual({
            tokensIn: 0,
            tokensOut: 0,
            cacheWrite: 0,
            cacheRead: 0
        });
    });
});

describe('mapStopReason', () => {
    test('normalizes the published trio', () => {
        expect(mapStopReason('function_call')).toBe('tool');
        expect(mapStopReason('tool_calls')).toBe('tool');
        expect(mapStopReason('max_output_tokens')).toBe('length');
        expect(mapStopReason('max_tokens')).toBe('length');
        expect(mapStopReason('completed')).toBe('end');
        expect(mapStopReason('')).toBe('end');
    });
});

describe('sanitizeError', () => {
    test('redacts sk- / sk-proj- / sk-svcacct- keys', () => {
        const out = sanitizeError(
            'invalid key sk-abc123XYZ and sk-proj-abc123XYZ and sk-svcacct-abc123XYZ'
        );
        expect(out).toContain('sk-…');
        expect(out).toContain('sk-proj-…');
        expect(out).toContain('sk-svcacct-…');
        expect(out).not.toContain('sk-abc123XYZ');
        expect(out).not.toContain('sk-proj-abc123XYZ');
        expect(out).not.toContain('sk-svcacct-abc123XYZ');
    });

    test('never echoes a key from an HTTP error body', () => {
        const body = 'Authentication failed for sk-proj-secretKEY99';
        const out = sanitizeError(body);
        expect(out).not.toMatch(/sk-proj-secretKEY99/);
        expect(out).toContain('sk-proj-…');
    });
});

describe('price table', () => {
    test('built-in table is $/MTok, not per-token', () => {
        expect(PRICE_TABLE['gpt-6-sol']).toEqual({
            input: 2,
            output: 10,
            cacheWrite: 2.5,
            cacheRead: 0.2
        });
        expect(PRICE_TABLE['gpt-6-sol'].input).toBeGreaterThan(0.01);
        expect(PRICE_TABLE['gpt-6-astra']).toEqual({
            input: 10,
            output: 50,
            cacheWrite: 12.5,
            cacheRead: 1
        });
        expect(PRICE_TABLE['gpt-6-luna']).toEqual({
            input: 0.10,
            output: 0.50,
            cacheWrite: 0.125,
            cacheRead: 0.01
        });
        expect(PRICE_TABLE['gpt-4o']).toBeUndefined();
    });

    test('override JSON merges on top', () => {
        const merged = mergePriceTable(JSON.stringify({
            'gpt-6-sol': { input: 9 }
        }));
        expect(merged['gpt-6-sol'].input).toBe(9);
        expect(merged['gpt-6-sol'].output).toBe(10);
        expect(merged['gpt-6-luna'].input).toBe(0.10);
    });

    test('invalid JSON keeps the built-in table', () => {
        expect(mergePriceTable('{')).toEqual(PRICE_TABLE);
        expect(mergePriceTable('not-json')).toEqual(PRICE_TABLE);
    });

    test('unknown model returns null rates', () => {
        expect(ratesForModel('gpt-unknown')).toBeNull();
        expect(ratesForModel('')).toBeNull();
    });

    test('partial row for a new model is ignored', () => {
        const merged = mergePriceTable(JSON.stringify({
            'gpt-next': { input: 5 }
        }));
        expect(merged['gpt-next']).toBeUndefined();
        expect(ratesForModel('gpt-next', JSON.stringify({
            'gpt-next': { input: 5 }
        }))).toBeNull();
    });

    test('a complete new-model row merges', () => {
        const row = { input: 5, output: 15, cacheWrite: 6.25, cacheRead: 0.5 };
        const merged = mergePriceTable(JSON.stringify({ 'gpt-next': row }));
        expect(merged['gpt-next']).toEqual(row);
    });

    test('non-numeric override of a built-in row is ignored', () => {
        const merged = mergePriceTable(JSON.stringify({
            'gpt-6-sol': { input: 'nope' }
        }));
        expect(merged['gpt-6-sol']).toEqual(PRICE_TABLE['gpt-6-sol']);
    });
});

describe('toOpenaiTools', () => {
    test('maps function tools with parameters schema', () => {
        const tools = toOpenaiTools([
            { name: 'get_outline', description: 'Outline', schema: { type: 'object', properties: {} } },
            { name: 'get_title', schema: { type: 'object', properties: { q: { type: 'string' } } } }
        ]);
        expect(tools).toHaveLength(2);
        expect(tools[0]).toEqual({
            type: 'function',
            name: 'get_outline',
            description: 'Outline',
            parameters: { type: 'object', properties: {} }
        });
        expect(tools[0].cache_control).toBeUndefined();
        expect(tools[1].parameters.properties.q).toEqual({ type: 'string' });
    });
});

describe('toOpenaiInput', () => {
    test('skips system, maps tool results, and assistant toolCalls', () => {
        const out = toOpenaiInput([
            { role: 'system', content: 'ignore' },
            { role: 'user', content: 'hi' },
            {
                role: 'assistant',
                content: 'calling',
                toolCalls: [{ id: 'c1', name: 'get_outline', args: { q: 'a' } }]
            },
            { role: 'tool', toolCallId: 'c1', content: { ok: true } },
            { role: 'tool', id: 'c2', content: 'second' }
        ]);
        expect(out).toEqual([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'calling' },
            {
                type: 'function_call',
                call_id: 'c1',
                name: 'get_outline',
                arguments: JSON.stringify({ q: 'a' })
            },
            {
                type: 'function_call_output',
                call_id: 'c1',
                output: JSON.stringify({ ok: true })
            },
            {
                type: 'function_call_output',
                call_id: 'c2',
                output: 'second'
            }
        ]);
        expect(toOpenaiMessages).toBe(toOpenaiInput);
    });

    test('maps image parts to data URLs and drops unknown types', () => {
        const out = toOpenaiInput([{
            role: 'user',
            content: [
                { type: 'text', text: 'see' },
                { type: 'image', mimeType: 'image/png', data: 'abc' },
                { type: 'file', name: 'skip-me' }
            ]
        }]);
        expect(out[0].content).toEqual([
            { type: 'input_text', text: 'see' },
            { type: 'input_image', image_url: 'data:image/png;base64,abc' }
        ]);
    });
});

describe('pingModels', () => {
    test('unsaved non-mask key is sent; empty both is not configured', async () => {
        const missing = await pingModels({
            apiKey: '',
            getSecret: async () => '',
            getConfig: async () => ({}),
            fetch: async () => { throw new Error('should not fetch'); }
        });
        expect(missing).toEqual({
            configured: false,
            valid: false,
            message: 'OpenAI API key is not configured.'
        });

        let captured;
        const ok = await pingModels({
            apiKey: 'sk-unsaved',
            endpoint: 'https://api.example.com/',
            getSecret: async () => 'sk-stored',
            getConfig: async () => ({}),
            fetch: async (url, opts) => {
                captured = { url, opts };
                return { ok: true, status: 200 };
            }
        });
        expect(ok.valid).toBe(true);
        expect(captured.url).toBe('https://api.example.com/v1/models');
        expect(captured.opts.headers.Authorization).toBe('Bearer sk-unsaved');
    });

    test('401 is configured but invalid', async () => {
        const result = await pingModels({
            apiKey: 'sk-bad',
            getSecret: async () => '',
            getConfig: async () => ({}),
            fetch: async () => ({ ok: false, status: 401 })
        });
        expect(result).toEqual({
            configured: true,
            valid: false,
            message: 'OpenAI rejected the API key.'
        });
    });
});

describe('resolveVerifyApiKey', () => {
    test('unsaved non-mask wins', () => {
        expect(resolveVerifyApiKey('sk-new', 'sk-stored')).toBe('sk-new');
    });

    test('mask or empty falls back to getSecret', () => {
        expect(resolveVerifyApiKey('********', 'sk-stored')).toBe('sk-stored');
        expect(resolveVerifyApiKey('', 'sk-stored')).toBe('sk-stored');
    });

    test('empty both is not configured', () => {
        expect(resolveVerifyApiKey('', '')).toBe('');
        expect(resolveVerifyApiKey('********', '')).toBe('');
        expect(resolveVerifyApiKey('********', '********')).toBe('');
    });
});

// EOF plugins/ai-openai/webapp/tests/unit/helpers.test.js
