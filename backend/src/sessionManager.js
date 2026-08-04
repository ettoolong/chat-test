import crypto from "node:crypto";
import { LlamaChatSession } from "node-llama-cpp";
import { config } from "./config.js";
import { getContext, getSystemPrompt, getCacheFilePath } from "./engine.js";

/** @type {Map<string, {session: LlamaChatSession, lastUsed: number, busy: boolean}>} */
const sessions = new Map();

function oldestIdleSessionId() {
    let oldestId = null;
    let oldestTime = Infinity;
    for (const [id, entry] of sessions) {
        if (!entry.busy && entry.lastUsed < oldestTime) {
            oldestTime = entry.lastUsed;
            oldestId = id;
        }
    }
    return oldestId;
}

function disposeEntry(entry) {
    // autoDisposeSequence was set on creation, so this also frees the KV-cache sequence slot.
    entry.session.dispose();
}

/**
 * Creates a new chat session. When useCache is true (the default), the fresh
 * sequence loads the pre-baked system-prompt KV state instead of re-evaluating
 * it. When false, the sequence is left empty and the system prompt gets
 * evaluated from scratch on the first message - useful for A/B-comparing
 * cached vs. cold-start performance from the UI toggle.
 */
export async function createSession(useCache = true) {
    const context = getContext();

    if (context.sequencesLeft === 0) {
        const evictId = oldestIdleSessionId();
        if (evictId !== null) {
            disposeEntry(sessions.get(evictId));
            sessions.delete(evictId);
            console.log(`[Session] Reclaimed sequence slot from idle session ${evictId}`);
        } else {
            throw Object.assign(new Error("Server is at maximum concurrent sessions"), { statusCode: 503 });
        }
    }

    const sequence = context.getSequence();

    if (useCache) {
        await sequence.loadStateFromFile(getCacheFilePath(), { acceptRisk: true });
    }

    const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: getSystemPrompt(),
        autoDisposeSequence: true,
    });

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { session, lastUsed: Date.now(), busy: false, usedCache: useCache });
    console.log(
        `[Session] Created ${sessionId} (${useCache ? "cache loaded" : "cold start, no cache"}) ` +
        `(${sessions.size}/${config.maxSessions} sequences in use)`
    );
    return { sessionId, usedCache: useCache };
}

export function getSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    entry.lastUsed = Date.now();
    return entry;
}

export function deleteSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    disposeEntry(entry);
    sessions.delete(sessionId);
    console.log(`[Session] Deleted ${sessionId}`);
    return true;
}

/**
 * Disposes every live session. Used when the system prompt changes: existing
 * sessions are bound to the now-stale KV cache, and regenerating the cache
 * needs every sequence slot free anyway.
 */
export function disposeAllSessions() {
    for (const [id, entry] of sessions) {
        disposeEntry(entry);
        sessions.delete(id);
    }
    console.log("[Session] Disposed all sessions (system prompt changed)");
}

export function sessionStats() {
    const context = getContext();
    return {
        activeSessions: sessions.size,
        maxSessions: config.maxSessions,
        sequencesLeft: context.sequencesLeft,
    };
}

// Periodically reclaim sessions that have been idle too long.
setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
        if (!entry.busy && now - entry.lastUsed > config.sessionIdleTimeoutMs) {
            disposeEntry(entry);
            sessions.delete(id);
            console.log(`[Session] Reclaimed idle session ${id}`);
        }
    }
}, 60_000).unref();
