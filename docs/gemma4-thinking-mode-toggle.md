# Gemma 4 Thinking Mode 切換：對 system prompt KV cache 的影響

> 情境：想在前端加一個「思考模式（thinking mode）」開關。Gemma 4 是透過在 system prompt
> 前面加上 `<|think|>` 這個 special token 來觸發思考。這份筆記記錄：這個機制實際上怎麼運作、
> 開關切換會不會破壞現有的 system-prompt KV cache 機制、以及能不能在不重啟 server 的情況下
> 動態切換。

## `<|think|>` 的實際運作方式

原始碼位置：`backend/node-llama-cpp-src/dist/chatWrappers/Gemma4ChatWrapper.js:32-55`

```js
constructor(options = {}) {
    super();
    const { reasoning = true, keepOnlyLastThought = true } = options;
    this.reasoning = reasoning;
    ...
}
generateContextState({ chatHistory, ... }) {
    ...
    if (this.reasoning)
        systemMessage = LlamaText([
            new SpecialTokensText("<|think|>"),
            systemMessage
        ]);
    ...
}
```

`reasoning` 是 **ChatWrapper 建構時的參數**（`true`/`false`），不是每次請求可以單獨傳的
runtime flag。它在**每次重建整個 context 文字**時，把 `<|think|>` 直接接在 system message
內容**最前面**——也就是整個 sequence token 序列最開頭的幾個 token 之一。

## 會不會破壞 system prompt KV cache？會，而且是徹底破壞

`<|think|>` 插在 system 內容最前端，開/關這個開關等於**改變了整個 sequence 從第一個 token
開始的內容**。KV cache 命中靠的是「前綴完全相同」，最前面的 token 一旦不同，後面所有內容的
KV 全部作廢——不是部分失效，是整個 system prompt 那段快取完全不能用。

## 目前專案現況：thinking mode 其實已經悄悄開著

查了實際程式碼，這件事現在就已經在發生，只是被藏起來了：

- `backend/src/sessionManager.js` 建立 session 時完全沒傳 `chatWrapper`
  （`new LlamaChatSession({contextSequence, systemPrompt, autoDisposeSequence:true})`），
  也就是用 `"auto"`。
- `resolveChatWrapper.js:200-201` 靠檔名比對（`gemma-4-E4B-it-Q4_K_M.gguf` 命中
  `"gemma-4"`）自動選出 `Gemma4ChatWrapper`，而 `createSpecializedChatWrapper()`
  （`resolveChatWrapper.js:74-81`）呼叫時**沒有帶入任何 override**，所以等同
  `new Gemma4ChatWrapper({})` → `reasoning` 用預設值 **`true`**。
- `backend/src/engine.js:75-79` 產生 system-prompt 預烤 cache 時，同樣建的是「auto」
  session——也就是說**現有的 `system-prompt.cache` 檔案，本來就是用 `reasoning:true`
  （帶 `<|think|>` 前綴）烤出來的**。
- 輸出端，`backend/src/server.js:111,126` 用的是 `onTextChunk`（文件明講：「只包含主要
  回覆，不含 thought 這類 segment」），所以模型其實**已經在偷偷產生思考內容、多花 token 跟
  時間，只是被丟掉沒有串流給前端**。

換句話說：現在系統的行為是「思考模式一直開著、但看不到思考過程」，而不是「思考模式關閉」。

## 能不能不重啟 server 動態切換？

可以，但有兩個層次要分開看：

1. **建立新 session 時切換**：完全不需要重啟 process。`reasoning` 只是建立
   `Gemma4ChatWrapper` 實例時的參數，只要在 `createSession()` 裡改成明確傳入
   `chatWrapper: new Gemma4ChatWrapper({ reasoning })`（而不是丟給 `"auto"`），
   再讓前端把這個開關跟 `useCache` 一樣隨 `POST /api/sessions` 傳過去即可——純粹是
   per-session 設定，跟 process 生命週期無關。

2. **對話「進行中」切換**：不行原地切換。已經存在的 sequence 裡，`<|think|>`（或它的缺席）
   已經 decode 進 KV cache 裡了，沒辦法回頭改。這跟現有「改 system prompt 要
   `disposeAllSessions()`」是同一類問題——實務上要做的是：把目前這個 session 丟掉、用新的
   reasoning 設定建立新 session，再用既有的方案 A（`setChatHistory()` 對話重播，見
   commit `7ba98c6`）把歷史灌回去，讓對話內容不中斷。機制完全現成，只是觸發點從
   「backend 重啟」換成「使用者按了開關」。

3. **快取層的連帶影響**：如果想讓「切換到另一個模式」時 system prompt 那段仍然吃得到預烤
   cache 的加速，`engine.js` 的 `computeCacheKey()`/`cachedState` 邏輯就得從「只認
   system prompt 文字」擴充成「認 (system prompt 文字, reasoning 開關)」這個組合鍵，
   等於要維護**兩份** system-prompt cache（開/關各一份），否則切到比較少用的那個模式，
   每次都會是全額 cold prefill。

## 小結

- `<|think|>` 是 ChatWrapper 建構參數，不是 per-request flag，作用點在 system 內容最前面。
- 切換必然讓 system-prompt KV cache 失效（前綴改變），要嘛接受該次 cold prefill，要嘛維護
  兩份 cache（開/關各一份）。
- 動態切換不需要重啟 server，但需要「新建 session + 歷史重播」，跟現有改 system prompt /
  backend 重啟後接續對話走的是同一套機制。
- 目前專案預設就是 `reasoning: true`（thinking mode 已經開著），只是輸出被 `onTextChunk`
  過濾掉，UI 上完全看不到——如果要顯示思考過程，需要另外把 `onTextChunk` 換成
  `onResponseChunk` 並處理 `segmentType === "thought"` 的 chunk，這是跟「開關」本身
  獨立的加法功能。
