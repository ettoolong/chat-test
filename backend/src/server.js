import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { initEngine, getSystemPrompt, getCacheStats, getModelInfo, updateSystemPrompt } from "./engine.js";
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
        const { sessionId, usedCache } = await createSession(useCache);
        res.json({ sessionId, usedCache });
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
    const { message, temperature } = req.body || {};

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

    const sequence = entry.session.sequence;
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
            onToken: (tokens) => {
                if (firstTokenAt === null) firstTokenAt = Date.now();
                genTokenCount += tokens.length;
            },
            onTextChunk: (text) => {
                res.write(JSON.stringify({ chunk: text, done: false }) + "\n");
            },
        });

        const t2 = Date.now();
        const promptEvalDurationMs = (firstTokenAt ?? t2) - t0;
        const genDurationMs = t2 - (firstTokenAt ?? t2);
        const promptTokens = Math.max(0, sequence.nextTokenIndex - tokensBefore - genTokenCount);
        const prefillSpeed = promptEvalDurationMs > 0 ? promptTokens / (promptEvalDurationMs / 1000) : 0;
        const genSpeed = genDurationMs > 0 ? genTokenCount / (genDurationMs / 1000) : 0;
        const cacheHit = promptTokens === 0 || prefillSpeed > config.cacheHitPrefillThreshold;

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
