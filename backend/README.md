# Backend

Node.js + Express + [node-llama-cpp](https://node-llama-cpp.withcat.ai/). No Docker needed.

## Setup

This project uses a patched build of `node-llama-cpp` (see below), so on a fresh
clone build it first, then install the rest of the dependencies:

```bash
npm run setup:node-llama-cpp   # clones+patches+builds node-llama-cpp-src/ (needs git, cmake, a C++ toolchain)
npm install
cp .env.example .env   # optional, defaults work out of the box
npm run dev
```

### Patched node-llama-cpp

`node-llama-cpp` only supports saving/loading a context sequence's KV-cache
state to/from a file (`saveStateToFile`/`loadStateFromFile`), which means every
`createSession()` call re-reads the system-prompt cache from disk. To let the
server keep that cache in RAM instead and apply it to a fresh sequence without
touching the filesystem, `node-llama-cpp-patches/kv-cache-in-memory-buffer.patch`
adds `saveStateToBuffer`/`loadStateFromBuffer` (JS wrapper + a small native addon
binding calling llama.cpp's existing `llama_state_seq_get_data`/`llama_state_seq_set_data`).

`node-llama-cpp-src/` (the vendored, patched checkout) isn't committed - it's
~750MB of upstream source, `node_modules`, and build output, all reproducible
from the patch. Run `npm run setup:node-llama-cpp` to (re)generate it; see
`scripts/setup-node-llama-cpp.mjs` for exactly what it does.

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
