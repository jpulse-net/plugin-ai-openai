# jPulse Docs / Installed Plugins / OpenAI AI Provider Plugin v1.0.0

The OpenAI plugin is a GPT backend for the site AI agent. It does not add a panel of its own. Enable it, save an API key, then set **Site Configuration → AI** to OpenAI (default provider / model, or the allowed list).

This page is at `/jpulse-docs/installed-plugins/ai-openai/README`. A trailing slash is rewritten to `index.shtml` before markdown routing and 404s.

## Features

- **OpenAI completions** — streams the Responses API into the `ai-core` turn loop (text, parallel tool use, usage, done).
- **Four-way token accounting** — input, output, cache write, and cache read, in USD per million tokens.
- **Password API key** — bulk config reads return a mask; completions use the stored secret on the server.
- **Verify** — GET `/v1/models` with the key in the form field. The button never receives the stored-only value.

## Setup

1. Install: `npx jpulse plugin install @jpulse-net/plugin-ai-openai` (pulls `ai-core` if needed).
2. Enable **ai-openai** under **Admin → Plugins** if it is not already enabled, and restart.
3. Open **Plugins → ai-openai → Configure**.
4. Paste the API key on the **Provider** tab.
5. Click **Verify API key** — it uses the value in the field, so you do not need to Save first. Then **Save Changes**.
6. On **Site Configuration → AI**, set the default provider / model or the allowed list.

Start a thread and a turn over HTTP, or use the chat panel:

```
POST /api/1/ai/thread          { "scopeType": "doc", "scopeId": "<id>" }
POST /api/1/ai/thread/:id/turn { "text": "Summarize this." }
```

The second call is Server-Sent Events.

## Provider tab

| Field | Default | Notes |
|-------|---------|-------|
| API key | empty | `sk-…` or `sk-proj-…`. Masked in GET config. Reveal on this form is audited. |
| Verify API key | — | Calls GET `{endpoint}/v1/models` with the key in the field (unsaved is fine). Never returns the key. |
| Default model | GPT-6 Sol | Used when Site Configuration → AI does not pick a model. |
| API endpoint | `https://api.openai.com` | No trailing path. Completions POST `{endpoint}/v1/responses`. |
| Request timeout (ms) | 60000 | Abort one HTTP request after this many milliseconds. |
| Max output tokens | 8192 | Cap on a single completion. |

Models in the list: GPT-6 Sol, GPT-6 Luna, GPT-6 Astra.

## Pricing tab

Leave the override empty to use the built-in prices (USD per million tokens, short-context Standard, verified 2026-09-26 from OpenAI). Cache write is the 1.25× input rate. An unknown model stores cost `null` — it must not cost $0.

To override, paste a JSON object. Keys are model ids. Each value needs four numbers — `input`, `output`, `cacheWrite`, `cacheRead` — in $/MTok:

```json
{ "gpt-6-sol": { "input": 2, "output": 10, "cacheWrite": 2.5, "cacheRead": 0.2 } }
```

Invalid JSON is ignored and the built-in table stays in effect.

## Security

- The key is `type: "password"`. Completions read it with `PluginModel.getSecret`.
- Verify and error messages never include the key.
- The Verify button posts only the form field (mask or newly typed). It does not read the stored secret in the browser.

## Technical details

- **JavaScript**: `webapp/controller/aiOpenai.js` — `onAiProviderRegister` / `onAiComplete`; `webapp/view/jpulse-common.js` — Verify button (`jPulse.plugins.aiOpenai.verifyApiKey`).
- **Hooks**: `onAiProviderRegister` (continue) and `onAiComplete` (abort), defined by `ai-core`. This plugin only handles them. It does not import from `plugins/ai-core/`.
- **Depends on**: `ai-core` (`@jpulse-net/plugin-ai-core` >= 1.0.0). jPulse >= 2.0.2.

## Plugin releases

- **1.0.0**, 2026-09-29: First release: published `ai-core` contract (array `tool_use`, four-way usage, $/MTok price table), Responses API stream, password key, unsaved Verify, Pricing tab override.
