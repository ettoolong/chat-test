# 地端 LLM 聊天網站

一個簡單的本地 LLM 聊天網站：前端是靜態網頁（Vite + vanilla JS），後端是 Node.js，
透過 [`node-llama-cpp`](https://node-llama-cpp.withcat.ai/)（llama.cpp 的 Node 綁定）
在本機載入 GGUF 模型並提供對話 API。

## 專案結構

```
backend/    Node.js 後端（Express + node-llama-cpp），負責載入模型、KV Cache、對話 API
frontend/   前端（Vite + vanilla JS），聊天介面
models/     放置 GGUF 模型檔（預設 gemma-4-E4B-it-Q4_K_M.gguf）
```

後端使用 Node.js 直接開發，不需要 Docker。

## KV Cache 加速設計

1. **啟動時**：後端會把 `backend/system-prompt.txt` 的內容透過 llama.cpp prefill
   一次，並把結果的 KV cache 狀態存成檔案（`backend/cache/system-prompt.cache`）。
   下次啟動時若 system prompt 沒變，會直接重用這份 cache，不用重新計算。
2. **每次開新對話（session）**：後端會拿一個新的 context sequence，
   把上面存好的 system-prompt KV cache 讀進去，這樣這個 session 一開始就已經
   「記得」system prompt，只需要運算使用者輸入的部分。
3. **同一輪對話中**：同一個 session 會重複使用同一個 sequence，
   `LlamaChatSession` 內部只會對新增的訊息做運算（等同 llama.cpp server 的
   `cache_prompt: true`），之前的對話歷史都留在 KV cache 裡不會重算。

詳細實作在 `backend/src/engine.js`（cache 產生/驗證）與
`backend/src/sessionManager.js`（每個 session 的 sequence 管理）。

## KV Cache 的限制

KV cache 重用有幾個層面的限制，不是萬用的加速手段：

1. **模型必須完全一致（包含量化精度）**
   Cache 裡存的是每一層注意力機制算出來的實際 K/V 數值，這些數值由模型權重直接算出。
   換成不同模型、或同一模型不同量化版本（例如 Q4_K_M 換成 Q8_0），KV 數值都不同，
   不能共用同一份 cache；硬套用甚至可能讓 `node-llama-cpp` crash（這也是為什麼
   `loadStateFromFile` 需要明確傳入 `{ acceptRisk: true }`）。

   `engine.js` 的 `computeCacheKey()` 會把模型檔的 size + mtime 一併 hash 進去
   （而不是只 hash 檔名），這樣即使有人用同檔名換了一份內容不同的模型檔，也會被
   偵測為 cache 失效並自動重新產生。沒有直接對整個模型檔做內容雜湊（例如
   SHA-256），因為對一份數 GB 的模型檔做全內容雜湊在每次啟動時都要讀完整個檔案：
   實測對這份約 4.6GB 的 `.gguf` 做 SHA-256，即使檔案已經在 OS page cache
   裡（warm）也要 3-4 秒，冷啟動（檔案不在頁面快取）會更久。size + mtime
   只需要一次 `stat()` 系統呼叫，幾乎零成本，卻已經能涵蓋「用同檔名換了不同模型檔」
   這個實際會發生的情境。

2. **Context 設定也要相容**
   存檔時的 context size 必須 ≥ 讀取時 sequence 的 context size，否則載入會直接丟錯；
   若之後改用量化 KV cache（`experimentalKvCacheKeyType`/`ValueType`），存/取兩邊的
   KV tensor 型別也要一致。

3. **Cache 是「精確 token 前綴」比對，不是語意快取**
   System prompt 只要改一個字，tokenize 結果就不同，整份 cache 對新 prompt 就會失效
   （這正是 `updateSystemPrompt` 要重新 prefill 的原因）。同理，若未來
   `node-llama-cpp` 升級、聊天模板（chat template）邏輯有變動，同樣的文字也可能被
   tokenize 成不同序列，需要重新產生 cache。

4. **不保證跨版本相容**
   `saveStateToFile`/`loadStateFromFile` 的檔案格式跟著 `llama.cpp`/`node-llama-cpp`
   版本走，沒有像 GGUF 那樣的正式格式保證；升級套件版本後，舊的 `.cache` 檔可能需要
   重新產生。目前的 `isCacheValid()` 不會偵測「套件版本已變更」，只會在模型檔或
   system prompt 改變時判定失效。

5. **記憶體是線性疊加，不是真正共享**
   每個新 session 呼叫 `loadStateFromFile` 時，是把整份 cache **複製**進該 session
   自己的 KV 記憶體區域，不是多個 session 共用同一份記憶體。System prompt 越長、
   cache 檔案越大，每個並發 session 就要多吃這麼多記憶體 —— 這也是為什麼
   `MAX_SESSIONS` 預設只開放 3 個並發 session。

6. **超長對話仍會逐漸失效**
   單一 session 的對話超過 `contextSize` 後，`LlamaChatSession` 會觸發 context
   shift（預設策略是抹掉最早的回覆、保留最前面的 system prompt），被抹掉的部分下次
   要重新計算，快取加速的效果會隨對話變長而遞減。

   這個預設策略是設計來刪「已經存在的舊回覆」的，在 session 的**第一輪**對話裡
   還沒有任何舊回覆可刪——如果系統 prompt 已經吃掉大半個 `contextSize`（例如很長的
   角色設定/世界觀文件），這時使用者傳一則夠長的訊息進來，會讓策略誤把「這則正要
   處理的新訊息本身」當成可以刪減的舊內容，一路截短甚至整段砍光，且不會報錯——
   模型只會憑系統 prompt 生出一句文不對題的回覆。`backend/src/server.js` 已經加了
   明確的長度檢查（在真的呼叫 `session.prompt()` 之前，用
   `entry.session.model.tokenize()` 算出這則訊息的 token 數，跟這個 session
   剩餘的 context 空間比較），放不下就直接回傳 `400`，不會讓訊息被默默吃掉。

**不算限制的部分**：temperature / top-p / top-k / min-p / mirostat / repeat penalty
等取樣參數**不影響** KV cache——它們只影響「算完 K/V 之後怎麼挑下一個 token」，不影響
K/V 本身的計算結果，可以每次請求自由調整而不會讓 cache 失效（這也是前端 Sampling
區塊的滑桿可以隨意調整、完全不用重新 prefill 的原因）。

## 前端功能

- **Conversations**：左側可切換/刪除多個對話，各自對應一個後端 session。
- **Model Configuration**：顯示目前載入的本機模型與 context size。
- **Sampling**：調整生成時的取樣參數，設定值存在瀏覽器 localStorage，每個對話
  （conversation）各自獨立記憶：
  - **Temperature**（預設 `1.0`）：滑桿下限鎖定在 `0.1`，避免設成 `0` 導致模型
    每次都輸出同一個 token。
  - **Top-k**（預設 `0` = 停用，取完整詞彙表）
  - **Top-p**（預設 `1.0` = 停用）
  - **Min-P**（預設 `0.05`）
  - **啟用 Mirostat** 開關：切換是否改用 Mirostat 2.0 動態調整取樣（取代
    Top-k/Top-p/Min-p，但 Temperature 仍會先套用）。啟用後 Top-k/Top-p/Min-p
    會停用，Temperature 保持可調（因為取樣時仍會先用它調整 logits，再交給
    Mirostat 處理），改用下面兩個：
    - **Mirostat Target**（`mirostat_tau`，預設 `5.0`）：目標困惑度（entropy）。
    - **Mirostat Learning Rate**（`mirostat_eta`，預設 `0.1`）：演算法根據生成結果
      調整取樣的反應速度。
  - Repeat Penalty 固定為 `1.1`（見 `backend/src/config.js` 的 `repeatPenalty`），
    套用到每次生成，沒有對應的 UI 控制項。

  Mirostat 取樣（llama.cpp 的 `--mirostat`）沒有被公開發布的 `node-llama-cpp` npm
  套件開放對應的 JS 參數，因此這個功能仰賴 `backend/node-llama-cpp-src` 這份自行
  patch 過的版本（見 `backend/node-llama-cpp-patches/mirostat-sampling.patch`），
  不是單純呼叫上游套件就能取得。
- **Set System Prompt**：取代原本內嵌的 system prompt 編輯區，改為一個按鈕開啟彈窗，
  輸入新的 system prompt 後會呼叫 `POST /api/system-prompt` 儲存並重新產生 KV cache
  （所有既有對話的 session 也會一併被釋放，下次發言時會套用新 cache 重新開始）。
- **即時分析面板**：每則回覆都會顯示 Prompt Tokens、Prompt Eval Time、Prefill Speed、
  Generation Speed，以及是否命中 KV Cache。

前端可完全離線執行：字型（Inter、JetBrains Mono）、Markdown 渲染（marked）、
語法高亮（highlight.js）、圖示（lucide）都是透過 npm 安裝並由 Vite 打包進本地
bundle，`index.html` 沒有任何指向 CDN 的 `<link>`/`<script>`。後端本來就只依賴
本機的 GGUF 模型檔，不需要網路。

## 執行方式

### 1. 後端

```bash
cd backend
npm install
npm run dev   # 或 npm start
```

預設會讀取 `../models/gemma-4-E4B-it-Q4_K_M.gguf`，監聽 `http://localhost:3001`。
可透過複製 `.env.example` 為 `.env` 調整模型路徑、context 大小、最大同時對話數等。

### 2. 前端

```bash
cd frontend
npm install
npm run dev
```

預設監聽 `http://localhost:5173`（若被占用會自動換埠），
可透過複製 `.env.example` 為 `.env` 調整後端 API 位址（`VITE_API_BASE_URL`）。

## 目前狀態

已可完整運作並通過端對端測試（含 KV cache 命中、Set System Prompt 重建 cache 等流程）。
