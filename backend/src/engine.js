import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { config } from "./config.js";

let llama = null;
let model = null;
let context = null;
let systemPrompt = "";
let cacheStats = null; // { promptTokens, prefillMs, cacheSizeBytes, generatedAt }

function readSystemPrompt() {
    if (!fs.existsSync(config.systemPromptFile)) {
        throw new Error(`System prompt file not found at: ${config.systemPromptFile}`);
    }
    return fs.readFileSync(config.systemPromptFile, "utf-8").trim();
}

function cacheMetaFile() {
    return `${config.systemPromptCacheFile}.meta.json`;
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
    if (!fs.existsSync(config.systemPromptCacheFile)) return false;
    const meta = readCacheMeta();
    return meta?.cacheKey === computeCacheKey();
}

/**
 * Prefills the (current) system prompt on a scratch sequence and persists the
 * resulting KV-cache state to disk, so future sessions can load it instead of
 * re-evaluating the system prompt from scratch.
 *
 * Requires a free sequence slot - callers that may have live sessions holding
 * all slots must dispose them first (see sessionManager.disposeAllSessions).
 */
async function generateSystemPromptCache() {
    console.log("[KV Cache] Prefilling system prompt...");
    const start = Date.now();

    const sequence = context.getSequence();
    const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt,
        autoDisposeSequence: true,
    });

    // Force evaluation of the system prompt without generating a real response.
    // maxTokens: 1 makes exactly one token get generated after the prefill.
    await session.prompt("", { maxTokens: 1 });
    const promptTokens = sequence.nextTokenIndex - 1;
    const prefillMs = Date.now() - start;

    fs.mkdirSync(config.cacheDir, { recursive: true });
    const { fileSize } = await sequence.saveStateToFile(config.systemPromptCacheFile);
    const generatedAt = Date.now();
    cacheStats = { promptTokens, prefillMs, cacheSizeBytes: fileSize, generatedAt };
    fs.writeFileSync(
        cacheMetaFile(),
        JSON.stringify({ cacheKey: computeCacheKey(), ...cacheStats }, null, 2)
    );

    session.dispose();
    console.log(
        `[KV Cache] Prefilled ${promptTokens} tokens in ${prefillMs}ms, ` +
        `saved state to ${config.systemPromptCacheFile} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`
    );

    return cacheStats;
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

    if (!isCacheValid()) {
        await generateSystemPromptCache();
    } else {
        console.log("[KV Cache] Existing cache is valid and will be reused for new sessions.");
        const meta = readCacheMeta();
        cacheStats = {
            promptTokens: meta.promptTokens,
            prefillMs: meta.prefillMs,
            cacheSizeBytes: meta.cacheSizeBytes,
            generatedAt: meta.generatedAt,
        };
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

export function getCacheFilePath() {
    return config.systemPromptCacheFile;
}

export function getModelInfo() {
    return {
        filename: path.basename(config.modelPath),
        contextSize: context?.contextSize ?? config.contextSize,
    };
}
