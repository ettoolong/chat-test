import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getLlama, LlamaChatSession, Gemma4ChatWrapper } from "node-llama-cpp";
import { config } from "./config.js";

let llama = null;
let model = null;
let context = null;
let assistantModel = null; // Gemma 4 MTP drafter model, only loaded when config.mtpEnabled
let mtpContext = null; // ctxType: "mtp" context cross-attending `context`, only created when config.mtpEnabled
let systemPrompt = "";
let cacheStats = null; // { thinking: {promptTokens, prefillMs, cacheSizeBytes}, noThinking: {...}, generatedAt }
// { buffer, tokens } per thinking mode - held in RAM so createSession never re-reads it from disk
let cachedStates = { thinking: null, noThinking: null };

function modeKey(thinking) {
    return thinking ? "thinking" : "noThinking";
}

function readSystemPrompt() {
    if (!fs.existsSync(config.systemPromptFile)) {
        throw new Error(`System prompt file not found at: ${config.systemPromptFile}`);
    }
    return fs.readFileSync(config.systemPromptFile, "utf-8").trim();
}

function cacheMetaFile() {
    return path.join(config.cacheDir, "system-prompt.cache.meta.json");
}

function modelFileFingerprint() {
    // Hashing the full multi-GB model file on every startup would cost real
    // seconds (~3-4s for a ~4.6GB file even warm from page cache, worse cold).
    // Size + mtime is a single stat() call - effectively free - and still catches
    // the realistic failure mode of a different file being swapped in under the
    // same filename (a different quantization/model almost never matches both).
    const stat = fs.statSync(config.modelPath);
    return `${stat.size}:${stat.mtimeMs}`;
}

function computeCacheKey() {
    return crypto
        .createHash("sha256")
        .update(path.basename(config.modelPath))
        .update("\0")
        .update(modelFileFingerprint())
        .update("\0")
        .update(systemPrompt)
        .digest("hex");
}

function readCacheMeta() {
    try {
        return JSON.parse(fs.readFileSync(cacheMetaFile(), "utf-8"));
    } catch {
        return null;
    }
}

function isCacheValid() {
    if (!fs.existsSync(config.systemPromptCacheFile(true)) || !fs.existsSync(config.systemPromptCacheFile(false)))
        return false;
    const meta = readCacheMeta();
    return meta?.cacheKey === computeCacheKey();
}

/**
 * Prefills the (current) system prompt for one thinking mode on a scratch
 * sequence and persists the resulting KV-cache state to disk. Thinking mode
 * changes the token sequence at the very front of the system prompt (Gemma 4's
 * `<|think|>` prefix), so its cache can't be shared with the other mode's -
 * each needs its own prefill and its own file.
 */
async function generateSystemPromptCacheForMode(thinking) {
    const start = Date.now();

    const sequence = context.getSequence();
    const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt,
        chatWrapper: new Gemma4ChatWrapper({ reasoning: thinking }),
        autoDisposeSequence: true,
    });

    // Force evaluation of the system prompt without generating a real response.
    // maxTokens: 1 makes exactly one token get generated after the prefill.
    await session.prompt("", { maxTokens: 1 });
    const promptTokens = sequence.nextTokenIndex - 1;
    const prefillMs = Date.now() - start;

    fs.mkdirSync(config.cacheDir, { recursive: true });
    const { fileSize } = await sequence.saveStateToFile(config.systemPromptCacheFile(thinking));
    cachedStates[modeKey(thinking)] = await sequence.saveStateToBuffer();

    session.dispose();
    console.log(
        `[KV Cache] Prefilled ${promptTokens} tokens (thinking=${thinking}) in ${prefillMs}ms, ` +
        `saved state to ${config.systemPromptCacheFile(thinking)} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`
    );

    return { promptTokens, prefillMs, cacheSizeBytes: fileSize };
}

/**
 * Prefills and persists both thinking-mode variants of the system-prompt cache.
 *
 * Requires two free sequence slots' worth of sequential use - callers that may
 * have live sessions holding all slots must dispose them first (see
 * sessionManager.disposeAllSessions).
 */
async function generateSystemPromptCache() {
    console.log("[KV Cache] Prefilling system prompt (thinking on + off)...");
    const thinking = await generateSystemPromptCacheForMode(true);
    const noThinking = await generateSystemPromptCacheForMode(false);
    const generatedAt = Date.now();

    cacheStats = { thinking, noThinking, generatedAt };
    fs.writeFileSync(
        cacheMetaFile(),
        JSON.stringify({ cacheKey: computeCacheKey(), thinking, noThinking, generatedAt }, null, 2)
    );

    return cacheStats;
}

/**
 * Loads both on-disk system-prompt KV caches into RAM once, so createSession
 * can apply either to a fresh sequence without hitting disk on every session.
 */
async function warmInMemoryCache() {
    for (const thinking of [true, false]) {
        const sequence = context.getSequence();
        await sequence.loadStateFromFile(config.systemPromptCacheFile(thinking), { acceptRisk: true });
        cachedStates[modeKey(thinking)] = await sequence.saveStateToBuffer();
        sequence.dispose();
    }
}

/**
 * Loads the Gemma 4 MTP assistant/drafter model and creates its `ctxType: "mtp"` context,
 * cross-attending the already-initialized target `context` via `otherContext` (required by
 * the assistant's architecture - see Gemma4Assistant's `ctx_other` requirement). Also enables
 * NextN hidden-state extraction on the target context, since the drafter needs `h_nextn` for
 * every real token the target decodes from here on.
 *
 * Must run after `context` is fully created - `otherContext` captures the target's native
 * context pointer at MTP-context-construction time, so the target has to already be `.init()`-ed.
 */
async function initMtpDrafter() {
    if (!fs.existsSync(config.mtpModelPath)) {
        throw new Error(
            `MTP drafter model file not found at: ${config.mtpModelPath}\n` +
            `Place the converted Gemma 4 assistant GGUF there, set MTP_MODEL_PATH, or set MTP_DRAFT_ENABLED=false.`
        );
    }

    console.log(`[Engine] Loading MTP drafter model: ${config.mtpModelPath}`);
    assistantModel = await llama.loadModel({ modelPath: config.mtpModelPath });

    console.log(`[Engine] Creating MTP context (sequences=${config.maxSessions})`);
    mtpContext = await assistantModel.createContext({
        contextSize: config.contextSize,
        sequences: config.maxSessions,
        ctxType: "mtp",
        otherContext: context,
    });

    context._ctx.setEmbeddingsNextn(true, false);
}

export async function initEngine() {
    if (!fs.existsSync(config.modelPath)) {
        throw new Error(
            `Model file not found at: ${config.modelPath}\n` +
            `Place a GGUF model there or set the MODEL_PATH environment variable.`
        );
    }

    systemPrompt = readSystemPrompt();

    console.log("[Engine] Initializing llama.cpp...");
    llama = await getLlama();

    console.log(`[Engine] Loading model: ${config.modelPath}`);
    model = await llama.loadModel({ modelPath: config.modelPath });

    console.log(`[Engine] Creating context (contextSize=${config.contextSize}, sequences=${config.maxSessions})`);
    context = await model.createContext({
        contextSize: config.contextSize,
        sequences: config.maxSessions,
    });

    if (config.mtpEnabled) {
        await initMtpDrafter();
    }

    if (!isCacheValid()) {
        await generateSystemPromptCache();
    } else {
        console.log("[KV Cache] Existing cache is valid and will be reused for new sessions.");
        const meta = readCacheMeta();
        cacheStats = { thinking: meta.thinking, noThinking: meta.noThinking, generatedAt: meta.generatedAt };
        await warmInMemoryCache();
    }
}

/**
 * Updates the system prompt persisted on disk and regenerates the KV cache for it.
 * Callers must ensure no live sessions are holding sequences (see
 * sessionManager.disposeAllSessions) since this needs a free sequence slot and
 * any existing sessions are bound to the now-stale cache anyway.
 */
export async function updateSystemPrompt(newPrompt) {
    fs.writeFileSync(config.systemPromptFile, `${newPrompt}\n`);
    systemPrompt = newPrompt;
    return generateSystemPromptCache();
}

export function getSystemPrompt() {
    return systemPrompt;
}

export function getCacheStats() {
    return cacheStats;
}

export function getModel() {
    return model;
}

export function getContext() {
    return context;
}

export function getMtpContext() {
    return mtpContext;
}

export function getCachedState(thinking) {
    return cachedStates[modeKey(thinking)];
}

export function getModelInfo() {
    return {
        filename: path.basename(config.modelPath),
        contextSize: context?.contextSize ?? config.contextSize,
    };
}
