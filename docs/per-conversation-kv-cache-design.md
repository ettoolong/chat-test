# 方案 B：per-conversation KV cache 落地存檔（設計筆記）

> 背景：backend 重啟會清空所有 `LlamaChatSession` 的 KV cache（純記憶體、綁在 process 上）。
> 目前已實作的方案 A（見 `7ba98c6` — 對話重播）是重啟後把歷史訊息透過 `setChatHistory()`
> 灌回新 session，靠既有的 diff 機制在下一次 `.prompt()` 時一次 decode 完，換取「不用管理額外檔案」，
> 代價是重連後第一則訊息要付全額 prefill 成本。
>
> 方案 B 是另一條路：比照現有 `backend/src/engine.js` 對 system prompt 做的事（`saveStateToFile` /
> `loadStateFromFile`），把**每個 conversation** 的 sequence KV 狀態也存到磁碟，重啟後直接
> `loadStateFromFile` 復原，不需要重新 decode 任何歷史 token。本檔案記錄這個方案的設計思路，
> 以及實作前必須弄清楚的兩個磁碟相關限制。

## 設計思路

比照 `engine.js` 現有的 system-prompt cache 機制，但把顆粒度從「一份全域的 system prompt」
擴大到「每個 conversation 一份」：

1. **存檔時機**：每輪對話結束後（`entry.session.prompt()` 完成時），把該 session 的
   `sequence.saveStateToFile()` 寫到 `backend/cache/conversations/<conversationId>.cache`。
   - 每輪都存會有額外 I/O 開銷（存檔大小隨對話長度增加，見下方問題 1）；也可以改成「每 N 輪」或
     「idle 時」才存，用「重啟時要重播的輪數」換「平常運行時的 I/O 成本」。
2. **失效判斷**：比照 `engine.js` 的 `computeCacheKey()`（model 檔案 fingerprint + 內容 hash），
   每個 conversation 存檔也要記一份 sidecar meta（例如 model fingerprint + 最後一則訊息的 hash），
   重啟後先比對，不符就整份丟棄、退回全額 replay（或方案 A 的重播機制作為 fallback）。
   - **必須做**，因為 `loadStateFromFile` 本身完全不驗證 model 是否相符（見下方問題 2），
     用不同 model 的存檔去 load 有 crash 風險，這一層驗證只能靠上層自己做。
3. **磁碟清理**：需要一個 conversation 存檔的淘汰策略（比照 `sessionManager.js` 現有的
   idle-timeout 淘汰邏輯），例如：conversation 太久沒被開啟就刪除對應的 `.cache` 檔案，
   避免磁碟隨對話數量無限增長。
4. **並發/一致性**：存檔跟讀檔都要在同一把 sequence 的 lock 下進行（node-llama-cpp 內部已經用
   `acquireLock` 保護單一 sequence 的 evaluate/save/load 互斥，但「這一輪存的檔案 vs. 這一輪
   使用者又送了新訊息」的時序仍要在應用層自己序列化，不能让存檔動作跟下一輪生成重疊)。

**跟方案 A 的取捨**：方案 B 換來「重啟後幾乎無感接續」，但要多管理一整套「per-conversation 檔案
的建立、失效、淘汰」邏輯，複雜度明顯更高；而且如下方問題 1 所示，單一對話的存檔可能達到數百 MB
量級，磁碟成本不是免費的。

---

## 問題 1：存檔大小會不會隨對話變長而增加？有沒有上限？

**會，幾乎線性成長。**

`saveStateToFile()` 的實作（`backend/node-llama-cpp-src/dist/evaluator/LlamaContext/LlamaContext.js:1297-1307`）：

```js
async saveStateToFile(filePath) {
    ...
    const fileSize = await this._context._ctx.saveSequenceStateToFile(
        resolvedPath, this._sequenceId, Uint32Array.from(this.contextTokens)
    );
    return { fileSize };
}
```

它序列化的是「當下這個 sequence 實際持有的所有 token」對應的 KV cache cell（每一層、每個 KV
head 的 K/V），token 越多，檔案越大——不是固定大小。

**實測數據**（本專案現有的 `backend/cache/system-prompt.cache`）：

| 項目 | 數值 |
|---|---|
| system prompt token 數（`system-prompt.cache.meta.json` 的 `promptTokens`） | 56 |
| 存檔大小（`cacheSizeBytes`） | 3,270,840 bytes（~3.2MB） |
| 換算 bytes/token | **~57KB/token**（gemma-4B, f16 KV cache） |

**上限**：node-llama-cpp 本身不設檔案大小上限，但一個 sequence 能持有的 token 數不會超過
建立 context 時的 `contextSize`（本專案 `backend/src/config.js:30` 預設 `CONTEXT_SIZE=8192`）。
一旦對話逼近這個上限，既有的 context-shift 機制（`contextShift.strategy`，預設
`"eraseBeginning"`）會清掉最舊的 token，所以 `contextTokens.length` 永遠 ≤ `contextSize`。

用上面實測的 bytes/token 推算，這顆模型 + `CONTEXT_SIZE=8192` 的組合下：

> 單一對話存檔的理論上限 ≈ 8192 × 57KB ≈ **~450MB**

這個數字會隨模型架構（layer 數、KV head 數、head_dim、KV cache 精度）和 `CONTEXT_SIZE` 設定不同
而變化，但足以說明：方案 B 如果不做淘汰策略，磁碟用量會隨對話數量、對話長度快速膨脹。

---

## 問題 2：讀回來時有載入大小限制嗎？

**有，而且是雙重檢查，失敗時會直接讓 sequence 報廢。**

`loadStateFromFile()`（`LlamaContext.js:1323-1352`）：

```js
const tokens = Array.from(
    await this._context._ctx.loadSequenceStateFromFile(resolvedPath, this._sequenceId, this.contextSize)
);
if (tokens.length > this.contextSize) {
    this._context._ctx.disposeSequence(this._sequenceId);
    throw new Error("The given state file is too large for the current context size");
}
```

- native 層呼叫時就把「**目前這個 sequence** 的 `contextSize`」當作上限傳進去。
- JS 層再檢查一次：存檔裡的 token 數若超過目前 sequence 的 `contextSize`，會直接把這個
  sequence `dispose` 掉並丟例外——不是「截斷後面、載入前面能載的部分」這種優雅降級。
- in-RAM 版本 `loadStateFromBuffer()` 邏輯相同，且檢查更早，在呼叫 native load
  之前就先擋掉了（`LlamaContext.js:1387-1388`）。

**對方案 B 設計的實際影響**：

1. 若之後調小 `.env` 的 `CONTEXT_SIZE`，或換到 context 更小的環境重啟，之前存的、token 數
   超過新 `contextSize` 的對話存檔會**整份載入失敗**，必須設計 fallback（例如退回方案 A 的
   全額重播，或直接丟棄該存檔重新開始對話）。
2. **model 是否相符完全不檢查**——官方文件明講「用不同 model 產生的存檔去 load 可能直接讓
   process crash」。node-llama-cpp 不提供這層保護，必須靠應用層自己做（比照現有
   `engine.js` 的 `computeCacheKey()` fingerprint 機制,擴充到每個 conversation 存檔）。

---

## 小結

| | 方案 A（已實作，對話重播） | 方案 B（本文件，per-conversation 存檔） |
|---|---|---|
| 重啟後第一則訊息延遲 | 全額 prefill 整段歷史 | 幾乎無感（直接 load 回 KV） |
| 額外磁碟用量 | 無 | 每個 conversation 最壞情況下數百 MB 量級 |
| 需要管理的狀態 | 無（前端本來就存著 `conv.messages`） | 存檔建立/失效/淘汰、model fingerprint 驗證、並發存取序列化 |
| Model / 設定變更的風險 | 無特殊風險（本來就是重新 decode） | 需要自己驗證 model 相符與 `contextSize` 相容，否則會載入失敗或 crash |

方案 A 目前已經足夠應付「重啟後接續對話」的核心需求；方案 B 適合在「對話經常很長、且重啟頻繁、
延遲非常敏感」的情境下再考慮導入，但需要額外投入前述的檔案生命週期管理。
