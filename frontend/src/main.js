import "./style.css";

// Self-hosted fonts (replaces the Google Fonts <link> tag) - Vite bundles the
// woff2 files locally so the app works fully offline.
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";

import { marked } from "marked";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.min.css";
import { createIcons, icons } from "lucide";

import {
    getHealth,
    getSystemPrompt,
    setSystemPrompt,
    createSession,
    deleteSession,
    sendMessage,
} from "./api.js";

const renderIcons = () => createIcons({ icons });

const STORAGE_KEY = "llm_chat_conversations";
const USE_CACHE_STORAGE_KEY = "llm_chat_use_kv_cache";

// --- State ---
let conversations = [];
let activeConversationId = null;
let isGenerating = false;
let abortController = null;
let modelInfo = null;
let useKvCache = true;

// --- DOM Elements ---
const chatListEl = document.getElementById("chat-list");
const newChatBtn = document.getElementById("new-chat-btn");
const modelNameDisplayEl = document.getElementById("model-name-display");
const contextSizeDisplayEl = document.getElementById("context-size-display");
const tempSliderEl = document.getElementById("temp-slider");
const tempValEl = document.getElementById("temp-val");
const cacheBadgeEl = document.getElementById("cache-status-badge");
const systemPromptStatusTextEl = document.getElementById("system-prompt-status-text");
const setSystemPromptBtn = document.getElementById("set-system-prompt-btn");
const useCacheToggleEl = document.getElementById("use-cache-toggle");
const chatTitleEl = document.getElementById("current-chat-title");
const activeModelBadgeEl = document.getElementById("active-model-badge");
const sessionCacheBadgeEl = document.getElementById("session-cache-badge");
const messagesContainerEl = document.getElementById("messages-container");
const welcomeScreenEl = document.getElementById("welcome-screen");
const chatFormEl = document.getElementById("chat-form");
const userInputEl = document.getElementById("user-input");
const sendBtnEl = document.getElementById("send-btn");
const serverStatusDot = document.getElementById("server-status-dot");
const serverStatusText = document.getElementById("server-status-text");

// Metrics elements
const mPromptTokens = document.getElementById("metric-prompt-tokens");
const mEvalTime = document.getElementById("metric-eval-time");
const mEvalSpeed = document.getElementById("metric-eval-speed");
const mGenSpeed = document.getElementById("metric-gen-speed");
const mCacheStatus = document.getElementById("metric-cache-hit");

// System Prompt modal elements
const systemPromptModalEl = document.getElementById("system-prompt-modal");
const systemPromptInputEl = document.getElementById("system-prompt-input");
const systemPromptSaveBtn = document.getElementById("system-prompt-save-btn");
const systemPromptCancelBtn = document.getElementById("system-prompt-cancel-btn");
const systemPromptModalStatusEl = document.getElementById("system-prompt-modal-status");

// --- Initialization ---
async function init() {
    loadConversationsFromStorage();

    const storedUseCache = localStorage.getItem(USE_CACHE_STORAGE_KEY);
    useKvCache = storedUseCache === null ? true : storedUseCache === "true";
    useCacheToggleEl.checked = useKvCache;
    useCacheToggleEl.addEventListener("change", () => {
        useKvCache = useCacheToggleEl.checked;
        localStorage.setItem(USE_CACHE_STORAGE_KEY, String(useKvCache));
    });

    newChatBtn.addEventListener("click", handleNewChat);
    tempSliderEl.addEventListener("input", (e) => {
        tempValEl.textContent = e.target.value;
        updateActiveConversationConfig();
    });

    setSystemPromptBtn.addEventListener("click", openSystemPromptModal);
    systemPromptCancelBtn.addEventListener("click", closeSystemPromptModal);
    systemPromptSaveBtn.addEventListener("click", handleSaveSystemPrompt);

    chatFormEl.addEventListener("submit", handleSendMessage);
    userInputEl.addEventListener("keydown", handleUserInputKeydown);
    userInputEl.addEventListener("input", () => {
        userInputEl.style.height = "auto";
        userInputEl.style.height = `${userInputEl.scrollHeight}px`;
    });

    await refreshBackendStatus();

    if (conversations.length === 0) {
        handleNewChat();
    } else {
        selectConversation(conversations[0].id);
    }

    renderIcons();
}

// --- Backend Connection ---
async function refreshBackendStatus() {
    try {
        const health = await getHealth();
        modelInfo = health.model;
        modelNameDisplayEl.textContent = modelInfo?.filename || "unknown";
        contextSizeDisplayEl.textContent = modelInfo?.contextSize
            ? modelInfo.contextSize.toLocaleString()
            : "-";
        activeModelBadgeEl.textContent = modelInfo?.filename || "-";

        serverStatusDot.className = "status-indicator online";
        serverStatusText.textContent = "Backend Connected";

        const sp = await getSystemPrompt();
        updateCacheStatus(sp.cache);
    } catch (err) {
        console.error("Failed to connect to backend:", err);
        serverStatusDot.className = "status-indicator offline";
        serverStatusText.textContent = "Connection Error";
        modelNameDisplayEl.textContent = "無法連線";
        cacheBadgeEl.className = "badge badge-warning";
        cacheBadgeEl.textContent = "Unknown";
        systemPromptStatusTextEl.textContent = "無法連線到後端，請確認後端伺服器已啟動。";
    }
}

function updateCacheStatus(cache) {
    if (!cache) {
        cacheBadgeEl.className = "badge badge-inactive";
        cacheBadgeEl.textContent = "Uncached";
        systemPromptStatusTextEl.textContent = "尚未產生 system prompt 的 KV cache。";
        return;
    }
    cacheBadgeEl.className = "badge badge-active";
    cacheBadgeEl.textContent = "Cached (KV)";
    const sizeMb = (cache.cacheSizeBytes / (1024 * 1024)).toFixed(2);
    const when = cache.generatedAt ? new Date(cache.generatedAt).toLocaleTimeString() : "-";
    systemPromptStatusTextEl.textContent =
        `已快取 ${cache.promptTokens.toLocaleString()} tokens（${sizeMb} MB），` +
        `於 ${when} 產生。開啟新對話時會直接套用這份 cache。`;
}

// --- Conversation Management ---
function loadConversationsFromStorage() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    try {
        conversations = JSON.parse(stored);
        // sessionId is only valid for the backend process that issued it - drop any
        // stale ids from a previous page load so they get lazily recreated.
        conversations.forEach((c) => {
            c.sessionId = null;
            c.usedCache = undefined;
        });
    } catch (e) {
        console.error("Failed to parse stored conversations", e);
        conversations = [];
    }
}

function saveConversationsToStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
}

function handleNewChat() {
    const id = `chat_${Date.now()}`;
    const newConv = {
        id,
        title: "New Conversation",
        sessionId: null,
        temperature: 0.7,
        messages: [],
        created: Date.now(),
    };

    conversations.unshift(newConv);
    saveConversationsToStorage();
    renderChatList();
    selectConversation(id);
}

function renderChatList() {
    chatListEl.innerHTML = "";
    conversations.forEach((conv) => {
        const chatItem = document.createElement("div");
        chatItem.className = `chat-item ${conv.id === activeConversationId ? "active" : ""}`;
        chatItem.onclick = () => selectConversation(conv.id);

        const title = document.createElement("span");
        title.className = "chat-item-title";
        title.textContent = conv.title;

        const actions = document.createElement("div");
        actions.className = "chat-item-actions";

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "chat-item-btn";
        deleteBtn.innerHTML = '<i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteConversation(conv.id);
        };

        actions.appendChild(deleteBtn);
        chatItem.appendChild(title);
        chatItem.appendChild(actions);
        chatListEl.appendChild(chatItem);
    });
    renderIcons();
}

function selectConversation(id) {
    activeConversationId = id;
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;

    tempSliderEl.value = conv.temperature ?? 0.7;
    tempValEl.textContent = conv.temperature ?? 0.7;

    chatTitleEl.textContent = conv.title;
    updateSessionCacheBadge(conv);

    renderChatList();
    renderMessages();
    resetMetricsPanel();
}

function deleteConversation(id) {
    const index = conversations.findIndex((c) => c.id === id);
    if (index === -1) return;

    const [removed] = conversations.splice(index, 1);
    if (removed.sessionId) deleteSession(removed.sessionId);
    saveConversationsToStorage();

    if (activeConversationId === id) {
        if (conversations.length > 0) {
            selectConversation(conversations[0].id);
        } else {
            handleNewChat();
        }
    } else {
        renderChatList();
    }
}

function updateActiveConversationConfig() {
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (!conv) return;
    conv.temperature = parseFloat(tempSliderEl.value);
    saveConversationsToStorage();
}

/** Returns a live backend sessionId for this conversation, creating one if needed. */
async function ensureSession(conv) {
    if (conv.sessionId) return conv.sessionId;
    const { sessionId, usedCache } = await createSession(useKvCache);
    conv.sessionId = sessionId;
    conv.usedCache = usedCache;
    saveConversationsToStorage();
    updateSessionCacheBadge(conv);
    return conv.sessionId;
}

/** Shows whether the active conversation's live session used the pre-baked KV cache. */
function updateSessionCacheBadge(conv) {
    if (!conv || conv.id !== activeConversationId || conv.usedCache === undefined) {
        sessionCacheBadgeEl.style.display = "none";
        return;
    }
    sessionCacheBadgeEl.style.display = "";
    sessionCacheBadgeEl.className = `model-badge cache-indicator ${conv.usedCache ? "cache-on" : "cache-off"}`;
    sessionCacheBadgeEl.textContent = conv.usedCache ? "Cache: ON" : "Cache: OFF (cold start)";
}

// --- Messages Rendering ---
function renderMessages() {
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (!conv || conv.messages.length === 0) {
        messagesContainerEl.innerHTML = "";
        messagesContainerEl.appendChild(welcomeScreenEl);
        welcomeScreenEl.style.display = "flex";
        renderIcons();
        return;
    }

    welcomeScreenEl.style.display = "none";
    messagesContainerEl.innerHTML = "";

    conv.messages.forEach((msg) => {
        messagesContainerEl.appendChild(createMessageBubble(msg));
    });

    renderIcons();
    scrollToBottom();
}

function createMessageBubble(msg) {
    const container = document.createElement("div");
    container.className = `message ${msg.role}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.innerHTML = `<i data-lucide="${msg.role === "user" ? "user" : "bot"}" class="avatar-icon"></i>`;

    const content = document.createElement("div");
    content.className = "message-content";

    if (msg.role === "assistant") {
        content.innerHTML = marked.parse(msg.content || "");
        addCodeBlockCopyButtons(content);
        highlightCodeBlocks(content);
    } else {
        content.textContent = msg.content;
    }

    container.appendChild(avatar);
    container.appendChild(content);

    if (msg.role === "assistant" && msg.stats) {
        const statsEl = document.createElement("div");
        statsEl.className = "message-stats";
        const s = msg.stats;
        const cacheStr = s.cacheHit ? "Cache Hit ⚡" : "Cache Miss ❄️";
        statsEl.textContent =
            `${cacheStr} | Prefill: ${s.prefillSpeed.toFixed(0)} t/s | ` +
            `Gen: ${s.genSpeed.toFixed(1)} t/s | Prompt Eval: ${s.promptEvalDurationMs.toFixed(0)}ms`;
        content.appendChild(statsEl);
    }

    return container;
}

function addCodeBlockCopyButtons(container) {
    container.querySelectorAll("pre").forEach((pre) => {
        if (pre.querySelector(".code-header")) return;

        const code = pre.querySelector("code");
        const lang =
            [...(code?.className.split(" ") ?? [])]
                .find((c) => c.startsWith("language-"))
                ?.replace("language-", "") || "code";

        const header = document.createElement("div");
        header.className = "code-header";
        header.innerHTML = `
            <span>${lang}</span>
            <button class="copy-btn">
                <i data-lucide="copy" style="width: 11px; height: 11px;"></i> Copy
            </button>
        `;
        pre.insertBefore(header, pre.firstChild);

        const copyBtn = header.querySelector(".copy-btn");
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(code.innerText).then(() => {
                copyBtn.innerHTML = '<i data-lucide="check" style="width: 11px; height: 11px;"></i> Copied!';
                renderIcons();
                setTimeout(() => {
                    copyBtn.innerHTML = '<i data-lucide="copy" style="width: 11px; height: 11px;"></i> Copy';
                    renderIcons();
                }, 2000);
            });
        };
    });
}

function highlightCodeBlocks(container) {
    container.querySelectorAll("pre code").forEach((block) => hljs.highlightElement(block));
}

function scrollToBottom() {
    messagesContainerEl.scrollTop = messagesContainerEl.scrollHeight;
}

function handleUserInputKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatFormEl.requestSubmit();
    }
}

// --- Chat Streaming Action ---
async function handleSendMessage(e) {
    e.preventDefault();
    if (isGenerating || !userInputEl.value.trim()) return;

    const text = userInputEl.value.trim();
    userInputEl.value = "";
    userInputEl.style.height = "auto";

    const conv = conversations.find((c) => c.id === activeConversationId);
    if (!conv) return;

    if (conv.messages.length === 0) {
        conv.title = text.length > 25 ? `${text.substring(0, 25)}...` : text;
        chatTitleEl.textContent = conv.title;
    }

    const userMsg = { role: "user", content: text };
    conv.messages.push(userMsg);
    saveConversationsToStorage();

    welcomeScreenEl.style.display = "none";
    messagesContainerEl.appendChild(createMessageBubble(userMsg));
    scrollToBottom();

    const assistantBubble = document.createElement("div");
    assistantBubble.className = "message assistant";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.innerHTML = `<i data-lucide="bot" class="avatar-icon"></i>`;
    const content = document.createElement("div");
    content.className = "message-content";
    content.innerHTML = `
        <div class="typing-indicator">
            <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
        </div>
    `;
    assistantBubble.appendChild(avatar);
    assistantBubble.appendChild(content);
    messagesContainerEl.appendChild(assistantBubble);
    scrollToBottom();
    renderIcons();

    isGenerating = true;
    sendBtnEl.disabled = true;
    userInputEl.disabled = true;
    newChatBtn.disabled = true;
    setSystemPromptBtn.disabled = true;
    abortController = new AbortController();

    let assistantText = "";
    let isFirstChunk = true;

    try {
        const sessionId = await ensureSession(conv);

        const stats = await sendMessage(sessionId, text, {
            temperature: conv.temperature,
            signal: abortController.signal,
            onChunk: (chunk) => {
                if (isFirstChunk) {
                    content.innerHTML = "";
                    isFirstChunk = false;
                }
                assistantText += chunk;
                content.innerHTML = marked.parse(assistantText);
                addCodeBlockCopyButtons(content);
                scrollToBottom();
            },
        });

        const assistantMsg = { role: "assistant", content: assistantText, stats };
        conv.messages.push(assistantMsg);
        saveConversationsToStorage();

        if (stats) updateMetricsPanel(stats);
        renderMessages();
    } catch (error) {
        if (error.name === "AbortError") {
            console.log("Generation aborted");
        } else {
            console.error("Send message error:", error);
            if (isFirstChunk) content.innerHTML = "";
            content.innerHTML += `<div class="error-box">
                <strong>發生錯誤：</strong> ${error.message}<br>
                <small>請確認後端伺服器正在執行，且模型已成功載入。</small>
            </div>`;
            scrollToBottom();
        }
    } finally {
        isGenerating = false;
        abortController = null;
        sendBtnEl.disabled = false;
        userInputEl.disabled = false;
        newChatBtn.disabled = false;
        setSystemPromptBtn.disabled = false;
        userInputEl.focus();
        renderIcons();
        renderChatList();
    }
}

// --- Metrics Update Logic ---
function resetMetricsPanel() {
    mPromptTokens.textContent = "-";
    mEvalTime.textContent = "-";
    mEvalSpeed.textContent = "-";
    mGenSpeed.textContent = "-";
    mCacheStatus.className = "metric-status";
    mCacheStatus.querySelector(".status-val").textContent = "-";
    mCacheStatus.querySelector(".metric-icon").setAttribute("data-lucide", "circle-dashed");
    renderIcons();
}

function updateMetricsPanel(stats) {
    mPromptTokens.textContent = stats.promptTokens.toLocaleString();
    mEvalTime.textContent = `${stats.promptEvalDurationMs.toFixed(0)} ms`;
    mEvalSpeed.textContent = `${stats.prefillSpeed.toFixed(0)} tokens/s`;
    mGenSpeed.textContent = `${stats.genSpeed.toFixed(1)} tokens/s`;

    const icon = mCacheStatus.querySelector(".metric-icon");
    if (stats.cacheHit) {
        mCacheStatus.className = "metric-status cache-hit";
        mCacheStatus.querySelector(".status-val").textContent = "Hit ⚡";
        icon.setAttribute("data-lucide", "zap");
    } else {
        mCacheStatus.className = "metric-status cache-miss";
        mCacheStatus.querySelector(".status-val").textContent = "Miss ❄️";
        icon.setAttribute("data-lucide", "snowflake");
    }
    renderIcons();
}

// --- Set System Prompt Modal ---
async function openSystemPromptModal() {
    systemPromptModalStatusEl.textContent = "";
    systemPromptModalStatusEl.className = "modal-status";
    systemPromptInputEl.value = "讀取目前的 system prompt 中...";
    systemPromptModalEl.classList.remove("hidden");
    renderIcons();

    try {
        const { systemPrompt } = await getSystemPrompt();
        systemPromptInputEl.value = systemPrompt;
    } catch (err) {
        systemPromptInputEl.value = "";
        systemPromptModalStatusEl.textContent = `無法讀取目前的 system prompt：${err.message}`;
        systemPromptModalStatusEl.className = "modal-status error";
    }
}

function closeSystemPromptModal() {
    systemPromptModalEl.classList.add("hidden");
}

async function handleSaveSystemPrompt() {
    const text = systemPromptInputEl.value.trim();
    if (!text) {
        systemPromptModalStatusEl.textContent = "System prompt 不可為空白。";
        systemPromptModalStatusEl.className = "modal-status error";
        return;
    }

    systemPromptSaveBtn.disabled = true;
    systemPromptCancelBtn.disabled = true;
    systemPromptModalStatusEl.className = "modal-status";
    systemPromptModalStatusEl.textContent = "正在重新產生 KV cache，這可能需要一些時間...";

    try {
        const { cache } = await setSystemPrompt(text);

        // The backend just disposed every live session to rebuild the cache -
        // drop our local sessionIds too so the next message per conversation
        // lazily starts a fresh one against the new cache.
        conversations.forEach((c) => {
            c.sessionId = null;
            c.usedCache = undefined;
        });
        saveConversationsToStorage();
        updateSessionCacheBadge(conversations.find((c) => c.id === activeConversationId));

        updateCacheStatus(cache);
        systemPromptModalStatusEl.textContent =
            `已儲存！新的 system prompt 已快取（${cache.promptTokens.toLocaleString()} tokens，` +
            `花費 ${cache.prefillMs}ms）。`;
        systemPromptModalStatusEl.className = "modal-status success";

        setTimeout(closeSystemPromptModal, 1500);
    } catch (err) {
        systemPromptModalStatusEl.textContent = `儲存失敗：${err.message}`;
        systemPromptModalStatusEl.className = "modal-status error";
    } finally {
        systemPromptSaveBtn.disabled = false;
        systemPromptCancelBtn.disabled = false;
    }
}

window.addEventListener("DOMContentLoaded", init);
