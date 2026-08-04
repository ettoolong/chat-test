import crypto from "node:crypto";
import { LlamaChatSession, Gemma4ChatWrapper, Gemma4MtpTokenPredictor } from "node-llama-cpp";
import { config } from "./config.js";
import { getContext, getMtpContext, getSystemPrompt, getCachedState } from "./engine.js";

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
 *
 * `history` (optional [{role, content}]) replays prior turns from a conversation
 * whose backend session was lost, e.g. after a server restart. Setting it only
 * updates this session's own tracked chat history - none of those turns are
 * decoded yet, so the next prompt() call decodes the whole backlog (plus the
 * new message) in one shot before generating. The system-prompt cache still
 * applies on top of that, since it covers the sequence's KV state independently.
 *
 * `thinking` picks which of the two pre-baked system-prompt caches to load
 * (Gemma 4's `<|think|>` prefix changes the token sequence right at the front
 * of the system prompt, so the two modes can never share a cache). This must
 * match whatever mode was used for any replayed `history`, since that's the
 * mode those earlier turns were actually generated under.
 */
export async function createSession(useCache = true, history = undefined, thinking = true) {
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

    // MTP-enabled sessions get a dedicated draft sequence on the MTP context, paired 1:1 with
    // this session's target sequence. Mirostat sampling silently has no effect on these sessions
    // (see config.js) - a pre-existing node-llama-cpp limitation for any tokenPredictor, not
    // something specific to this feature.
    const mtpContext = getMtpContext();
    const sequence = mtpContext
        ? context.getSequence({
            tokenPredictor: new Gemma4MtpTokenPredictor(mtpContext.getSequence(), {
                maxDraftTokens: config.mtpMaxDraftTokens,
                minConfidence: config.mtpMinConfidence,
            }),
        })
        : context.getSequence();

    if (useCache) {
        const { buffer, tokens } = getCachedState(thinking);
        await sequence.loadStateFromBuffer(buffer, tokens, { acceptRisk: true });
    }

    const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: getSystemPrompt(),
        chatWrapper: new Gemma4ChatWrapper({ reasoning: thinking }),
        autoDisposeSequence: true,
    });

    if (history && history.length > 0) {
        const replayedItems = history.map((m) =>
            m.role === "assistant"
                ? { type: "model", response: [m.content] }
                : { type: "user", text: m.content }
        );
        // Keep the system-prompt entry the constructor already generated, append the replay after it.
        session.setChatHistory([...session.getChatHistory(), ...replayedItems]);
    }

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { session, lastUsed: Date.now(), busy: false, usedCache: useCache });
    console.log(
        `[Session] Created ${sessionId} (${useCache ? "cache loaded" : "cold start, no cache"}, ` +
        `thinking=${thinking}) (${sessions.size}/${config.maxSessions} sequences in use)`
    );
    return { sessionId, usedCache: useCache, thinking };
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
