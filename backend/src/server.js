import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { initEngine, getSystemPrompt, getCacheStats, getModelInfo, updateSystemPrompt, getContext } from "./engine.js";
import {
    createSession,
    getSession,
    deleteSession,
    disposeAllSessions,
    sessionStats,
} from "./sessionManager.js";

const app = express();
app.use(
    cors({
        origin(origin, callback) {
            // No Origin header (curl, server-to-server) - allow.
            if (!origin) return callback(null, true);
            if (origin === config.corsOrigin) return callback(null, true);
            // This is a local single-user app: allow any localhost/127.0.0.1 port so the
            // frontend still works if its dev server picks a different port than configured.
            if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
            callback(new Error("Not allowed by CORS"));
        },
    })
);
app.use(express.json());

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", model: getModelInfo(), ...sessionStats() });
});

app.get("/api/system-prompt", (req, res) => {
    res.json({ systemPrompt: getSystemPrompt(), cache: getCacheStats() });
});

app.post("/api/system-prompt", async (req, res) => {
    const { systemPrompt } = req.body || {};
    if (!systemPrompt || typeof systemPrompt !== "string" || !systemPrompt.trim()) {
        return res.status(400).json({ error: "Missing 'systemPrompt' string in body" });
    }

    try {
        // Drop every live session first: they're bound to the soon-to-be-stale cache,
        // and regenerating the cache needs a free sequence slot anyway.
        disposeAllSessions();
        const cache = await updateSystemPrompt(systemPrompt.trim());
        res.json({ ok: true, cache });
    } catch (err) {
        console.error("[POST /api/system-prompt]", err);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/sessions", async (req, res) => {
    try {
        const useCache = req.body?.useCache !== false; // default true
        const thinking = req.body?.thinkingMode !== false; // default true
        const history = Array.isArray(req.body?.history) ? req.body.history : undefined;
        const { sessionId, usedCache, thinking: thinkingMode } = await createSession(useCache, history, thinking);
        res.json({ sessionId, usedCache, thinkingMode });
    } catch (err) {
        console.error("[POST /api/sessions]", err);
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

app.delete("/api/sessions/:sessionId", (req, res) => {
    const ok = deleteSession(req.params.sessionId);
    if (!ok) return res.status(404).json({ error: "Session not found" });
    res.json({ ok: true });
});

app.post("/api/sessions/:sessionId/messages", async (req, res) => {
    const { sessionId } = req.params;
    const { message, temperature, topK, topP, minP, mirostat, mirostatTau, mirostatEta } = req.body || {};

    if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Missing 'message' string in body" });
    }

    const entry = getSession(sessionId);
    if (!entry) {
        return res.status(404).json({ error: "Session not found. Create one via POST /api/sessions first." });
    }
    if (entry.busy) {
        return res.status(409).json({ error: "This session is already generating a response" });
    }

    const sequence = entry.session.sequence;
    const newMessageTokens = entry.session.model.tokenize(message).length;
    // What's left in this sequence's context after what's already resident (system prompt +
    // prior turns), minus a slack for the chat template's own per-turn control tokens and a
    // reserve so the model actually has room to generate a reply. Without this check, a message
    // that doesn't fit gets silently mangled by node-llama-cpp's default context-shift strategy
    // instead of erroring: on a session's first turn there's no earlier model response yet for
    // it to trim, so it ends up truncating - potentially down to nothing - the new message itself.
    const availableTokens =
        getContext().contextSize - sequence.nextTokenIndex - config.chatTemplateSlackTokens - config.minResponseReserveTokens;
    if (newMessageTokens > availableTokens) {
        return res.status(400).json({
            error:
                `Message too long: needs ${newMessageTokens} tokens but only ${Math.max(0, availableTokens)} ` +
                "remain in this session's context. Start a new conversation or shorten the message.",
        });
    }

    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    entry.busy = true;
    const abortController = new AbortController();
    let responseFinished = false;
    // res (not req) 'close' fires only when the underlying connection actually drops;
    // req 'close' fires as soon as the request body is fully read, which is too early.
    res.on("close", () => {
        if (!responseFinished) abortController.abort();
    });

    const tokensBefore = sequence.nextTokenIndex;
    const t0 = Date.now();
    let firstTokenAt = null;
    let genTokenCount = 0;

    try {
        // Reusing the same session/sequence across turns means only the new user
        // message (and the model's new response) get evaluated here - the system
        // prompt and prior turns are already resident in this sequence's KV cache.
        await entry.session.prompt(message, {
            signal: abortController.signal,
            stopOnAbortSignal: true,
            temperature: typeof temperature === "number" ? temperature : undefined,
            topK: typeof topK === "number" ? topK : undefined,
            topP: typeof topP === "number" ? topP : undefined,
            minP: typeof minP === "number" ? minP : undefined,
            mirostat: typeof mirostat === "number" ? mirostat : undefined,
            mirostatTau: typeof mirostatTau === "number" ? mirostatTau : undefined,
            mirostatEta: typeof mirostatEta === "number" ? mirostatEta : undefined,
            repeatPenalty: { penalty: config.repeatPenalty },
            // onResponseChunk (rather than onTextChunk/onToken) also surfaces "thought"
            // segments - Gemma 4's thinking-mode output - which the frontend streams
            // into a collapsible box. It's still the single source of truth for token
            // counts: onToken excludes thought tokens entirely, which previously made
            // promptTokens overcount by the size of any hidden thinking when reasoning
            // was on (thought tokens were generated but never subtracted out below).
            onResponseChunk: (chunk) => {
                if (chunk.tokens.length > 0 && firstTokenAt === null) firstTokenAt = Date.now();
                genTokenCount += chunk.tokens.length;

                if (chunk.type === "segment" && chunk.segmentType === "thought") {
                    if (chunk.text) res.write(JSON.stringify({ thinkingChunk: chunk.text, done: false }) + "\n");
                } else if (chunk.type === undefined) {
                    if (chunk.text) res.write(JSON.stringify({ chunk: chunk.text, done: false }) + "\n");
                }
            },
        });

        const t2 = Date.now();
        const promptEvalDurationMs = (firstTokenAt ?? t2) - t0;
        const genDurationMs = t2 - (firstTokenAt ?? t2);
        const promptTokens = Math.max(0, sequence.nextTokenIndex - tokensBefore - genTokenCount);
        const prefillSpeed = promptEvalDurationMs > 0 ? promptTokens / (promptEvalDurationMs / 1000) : 0;
        const genSpeed = genDurationMs > 0 ? genTokenCount / (genDurationMs / 1000) : 0;
        // A real hit only evaluates this turn's own content: the user's message plus a
        // handful of chat-template control tokens (turn markers, response-start marker).
        // A real miss re-evaluates the whole system prompt on top of that, so promptTokens
        // for a miss is thousands of tokens larger than the message itself - comparing
        // against the message's own tokenized length (rather than a fraction of the system
        // prompt's size) stays correct even for a long pasted message on a genuine hit.
        const cacheHit = promptTokens <= newMessageTokens + config.chatTemplateSlackTokens;

        res.write(
            JSON.stringify({
                done: true,
                stats: {
                    promptTokens,
                    promptEvalDurationMs,
                    genTokenCount,
                    genDurationMs,
                    prefillSpeed,
                    genSpeed,
                    cacheHit,
                },
            }) + "\n"
        );
    } catch (err) {
        console.error(`[POST /api/sessions/${sessionId}/messages]`, err);
        res.write(JSON.stringify({ error: err.message, done: true }) + "\n");
    } finally {
        entry.busy = false;
        entry.lastUsed = Date.now();
        responseFinished = true;
        res.end();
    }
});

async function main() {
    await initEngine();
    app.listen(config.port, () => {
        console.log(`[Server] Listening on http://localhost:${config.port}`);
    });
}

main().catch((err) => {
    console.error("[Fatal] Failed to start server:", err);
    process.exit(1);
});
