# Backend

Node.js + Express + [node-llama-cpp](https://node-llama-cpp.withcat.ai/). No Docker needed.

## Setup

```bash
npm install
cp .env.example .env   # optional, defaults work out of the box
npm run dev
```

On startup the server loads the model, creates a multi-sequence context, and
either reuses or (re)generates the system-prompt KV-cache file in `cache/`
(see `src/engine.js`). Editing `system-prompt.txt` automatically invalidates
the cache on next start.

## API

| Method | Path                          | Body                       | Description |
|--------|-------------------------------|-----------------------------|--------------|
| GET    | `/api/health`                 | -                           | Server + session-pool status, plus `model: { filename, contextSize }` |
| GET    | `/api/system-prompt`          | -                           | Current system prompt + its cache stats (`{ systemPrompt, cache }`) |
| POST   | `/api/system-prompt`          | `{ systemPrompt: string }`  | Persists a new system prompt, disposes all live sessions, and rebuilds the KV cache from it. Returns `{ ok, cache }` |
| POST   | `/api/sessions`                | -                           | Create a chat session (loads the cached system-prompt KV state onto a fresh sequence). Returns `{ sessionId }` |
| POST   | `/api/sessions/:id/messages`   | `{ message: string, temperature?: number }` | Streams the reply as newline-delimited JSON (`{chunk, done}` lines, `application/x-ndjson`); the final line is `{done: true, stats: {promptTokens, promptEvalDurationMs, genTokenCount, genDurationMs, prefillSpeed, genSpeed, cacheHit}}` |
| DELETE | `/api/sessions/:id`            | -                           | Frees the session's sequence slot |

Concurrent sessions are capped by `MAX_SESSIONS` (default 3) since each one
holds its own KV-cache sequence; idle sessions are reclaimed automatically
(`SESSION_IDLE_TIMEOUT_MS`), and the oldest idle session is evicted if a new
one is requested while at capacity.

`stats.cacheHit` is a heuristic: a per-message prefill speed above
`CACHE_HIT_PREFILL_THRESHOLD` (default 300 tokens/sec) is reported as a hit.
Updating the system prompt via `POST /api/system-prompt` disposes every live
session (they're bound to the now-stale cache), so any open frontend
conversations will lazily start a fresh session on their next message.
