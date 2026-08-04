const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

export async function getHealth() {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return res.json();
}

export async function getSystemPrompt() {
    const res = await fetch(`${API_BASE}/api/system-prompt`);
    if (!res.ok) throw new Error(`Failed to fetch system prompt: ${res.status}`);
    return res.json();
}

/** Saves a new system prompt and rebuilds its KV cache. Returns { ok, cache }. */
export async function setSystemPrompt(systemPrompt) {
    const res = await fetch(`${API_BASE}/api/system-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Failed to save system prompt: ${res.status}`);
    return body;
}

/**
 * Creates a session. `history` (optional) replays prior turns into the new
 * session - used when reconnecting to a conversation whose backend session
 * was lost (e.g. after a server restart). `thinkingMode` picks which of the
 * two pre-baked system-prompt caches to load and must match whatever mode
 * this conversation was started with. Returns { sessionId, usedCache, thinkingMode }.
 */
export async function createSession(useCache = true, history = undefined, thinkingMode = true) {
    const res = await fetch(`${API_BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useCache, history, thinkingMode }),
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to create session: ${res.status}`);
    }
    return res.json();
}

export async function deleteSession(sessionId) {
    await fetch(`${API_BASE}/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
}

/**
 * Streams the assistant's reply for a user message.
 * Calls onChunk(text) for every piece of generated text, and resolves with the
 * final { promptTokens, promptEvalDurationMs, prefillSpeed, genSpeed, cacheHit } stats.
 */
export async function sendMessage(
    sessionId,
    message,
    { temperature, topK, topP, minP, mirostat, mirostatTau, mirostatEta, onChunk, onThinkingChunk, signal } = {}
) {
    const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, temperature, topK, topP, minP, mirostat, mirostatTau, mirostatEta }),
        signal,
    });

    if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stats = null;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) continue;

            const parsed = JSON.parse(line);
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.chunk) onChunk?.(parsed.chunk);
            if (parsed.thinkingChunk) onThinkingChunk?.(parsed.thinkingChunk);
            if (parsed.stats) stats = parsed.stats;
        }
    }

    return stats;
}
