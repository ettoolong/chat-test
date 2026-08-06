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

    // Slack added on top of the current message's own tokenized length when deciding
    // whether a message's promptTokens count reflects a KV-cache hit - covers the chat
    // template's per-turn control tokens (turn markers, response-start marker) that get
    // evaluated alongside the message itself even on a genuine hit.
    chatTemplateSlackTokens: envInt("CHAT_TEMPLATE_SLACK_TOKENS", 32),

    // Tokens reserved for the model's reply when checking whether an incoming message fits
    // in what's left of the session's context. Without this, a message could be accepted
    // because it just barely fits alongside what's already resident, leaving the model no
    // room to actually generate a response.
    minResponseReserveTokens: envInt("MIN_RESPONSE_RESERVE_TOKENS", 256),

    // Not exposed in the UI - applied to every generation regardless of the other
    // sampling settings the user picks.
    repeatPenalty: 1.1,

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
