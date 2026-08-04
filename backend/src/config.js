import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(backendRoot, "..");

const dotEnvPath = path.join(backendRoot, ".env");
if (fs.existsSync(dotEnvPath)) {
    process.loadEnvFile(dotEnvPath);
}

function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

function envFloat(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
}

export const config = {
    port: envInt("PORT", 3001),
    corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",

    modelPath: process.env.MODEL_PATH
        ? path.resolve(process.env.MODEL_PATH)
        : path.join(projectRoot, "models", "gemma-4-E4B-it-Q4_K_M.gguf"),

    // Total tokens visible to the model per conversation sequence.
    contextSize: envInt("CONTEXT_SIZE", 8192),

    // Number of parallel KV-cache sequences (= max concurrent chat sessions).
    // Each one holds its own copy of the cached system-prompt state, so keep this modest.
    maxSessions: envInt("MAX_SESSIONS", 3),

    // Idle sessions get their sequence reclaimed after this long without a message.
    sessionIdleTimeoutMs: envInt("SESSION_IDLE_TIMEOUT_MS", 30 * 60 * 1000),

    // A per-message prefill speed (tokens/sec) above this is reported as a KV-cache hit
    // in the chat metrics. Heuristic - tune to taste for your hardware.
    cacheHitPrefillThreshold: envInt("CACHE_HIT_PREFILL_THRESHOLD", 300),

    // Not exposed in the UI - applied to every generation regardless of the other
    // sampling settings the user picks.
    repeatPenalty: 1.1,

    // Gemma 4 MTP (multi-token prediction) self-speculative decoding. Off by default -
    // opt in per deployment/benchmark run. Mirostat sampling has no effect on sessions
    // created while this is on (the underlying tokenPredictor evaluation path doesn't
    // carry mirostat options through - a pre-existing node-llama-cpp limitation that
    // applies to every token predictor, not something specific to this feature).
    mtpEnabled: process.env.MTP_DRAFT_ENABLED === "true",

    mtpModelPath: process.env.MTP_MODEL_PATH
        ? path.resolve(process.env.MTP_MODEL_PATH)
        : path.join(projectRoot, "models", "gemma-4-E4B-it-assistant-F16.gguf"),

    // Max speculative tokens proposed per round, and the confidence cutoff (drafter's own
    // top-pick probability) below which drafting stops early for that round.
    mtpMaxDraftTokens: envInt("MTP_MAX_DRAFT_TOKENS", 3),
    mtpMinConfidence: envFloat("MTP_MIN_CONFIDENCE", 0),

    systemPromptFile: process.env.SYSTEM_PROMPT_FILE
        ? path.resolve(process.env.SYSTEM_PROMPT_FILE)
        : path.join(backendRoot, "system-prompt.txt"),

    cacheDir: path.join(backendRoot, "cache"),
    // Thinking mode changes the token sequence at the very front of the system
    // prompt (see Gemma4ChatWrapper's `<|think|>` prefix), so each mode needs its
    // own cache file - one can never be a prefix-match substitute for the other.
    systemPromptCacheFile(thinking) {
        return path.join(this.cacheDir, thinking ? "system-prompt-thinking.cache" : "system-prompt-no-thinking.cache");
    },
};

export { backendRoot, projectRoot };
