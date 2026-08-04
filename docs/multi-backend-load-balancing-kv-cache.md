# 多機部署下的 KV Cache 命中問題

> 情境：兩台機器各跑一份 backend，前面接一個 load balancer 分流。前端跟同一個
> conversation 進行多輪對話時，有可能先後被導到不同機器，導致 `LlamaChatSession`
> 的 KV cache 無法命中——本質上跟「單機重啟」是同一類問題（KV cache 只活在特定 process
> 的記憶體裡），只是換成了「另一台機器」而不是「同一台機器重啟後」。

## 業界兩種做法

### 做法一：Session Affinity（黏著路由）—— 最常見、最實務

Load balancer 依照某個穩定的 key（session id / conversation id / cookie）做一致性路由，
讓同一個對話盡量固定打同一台後端：

- 常見實作：nginx `ip_hash` / `hash $cookie_xxx consistent`、HAProxy `balance source` /
  `stick-table`、AWS ALB sticky sessions（cookie-based）、Kubernetes Ingress
  `session-affinity: ClientIP` 或自訂 header hashing。
- 更聰明的變體是 **cache-aware routing**：router 不只是 hash session id，而是知道
  「哪個 replica 目前的 KV cache 裡有跟這個新請求最長共同前綴」，再把請求導過去
  （SGLang 的 router、vLLM 一些 prefix-cache-aware 路由提案走的就是這條路）。

**限制**：只能降低 cache miss 機率，不能完全消除——LB 重新配置、節點擴縮容、健康檢查
剔除、hash 分佈不均，都還是會讓同一對話偶爾換機器。**因此黏著路由必須永遠搭配一個
「cache miss 時的優雅退化路徑」**：不管是「同機重啟」還是「換了一台機器」，對後端來說
都是「這個 sequence 什麼都不知道，只能重新 decode」，處理方式一致。這正是本專案已經
實作的方案 A（`setChatHistory()` 對話重播，見 commit `7ba98c6`）——它不依賴任何共享狀態、
隨時能從前端保存的歷史重建，是黏著路由失效時唯一的安全網。

### 做法二：把 KV cache 外部化 / 跨機器共享 —— 治本但成本高

理論上可以把 KV cache 狀態存到所有節點都能存取的共享儲存（類比把 HTTP session 從記憶體
換成 Redis），但 KV cache 資料量本身很大——前面實測過這顆模型每 token 約 57KB，
`CONTEXT_SIZE=8192` 上限下單一對話理論上可達 ~450MB（見
[`docs/per-conversation-kv-cache-design.md`](./per-conversation-kv-cache-design.md)）。
把這種量級的資料每輪搬過網路，很多時候比「乾脆重新 decode」還貴，除非：

- 節點間有非常快的互聯（同機架、RDMA、100Gbps+），且
- 「換機導致 cache miss」發生得夠頻繁、prompt 又夠長，省下的 prefill 成本才划算過網路傳輸成本。

真正做這件事的都是重量級分散式基礎設施：

- **Mooncake**（Moonshot AI / Kimi 背後架構）：把 prefill 跟 decode 拆開跑在不同 GPU 池，
  中間用基於 RDMA 的分散式 KV cache pool，讓任何節點都能撈到匹配前綴的 KV blocks，
  把「誰算過這段」跟「誰現在服務這個請求」徹底解耦。
- **LMCache**、**vLLM 的 KV cache transfer/連接器**、**SGLang 的 HiCache**：概念類似，
  把 KV cache 當成可以跨 worker 分享、遷移的快取資源。

這些系統的共同前提是大規模 GPU 叢集 + 極快互聯 + prefill 成本高到值得為此建一整套基礎設施。
對「兩台機器 + llama.cpp」這種規模，這個投入通常不划算。

## 對本專案這種規模的實務建議

1. **LB 層做 session affinity**：用 conversation id 或既有的 `sessionId` 做一致性
   hash / sticky routing，讓同一對話盡量固定打同一台機器——成本最低、效益最高的第一步。
2. **前端在收到 session 失效時自動重連**：現有 `POST /api/sessions/:sessionId/messages`
   找不到 session 會回 404（`backend/src/server.js:81-83`），前端只要把「404」跟「重啟後
   sessionId 失效」視為同一種情況，走 `ensureSession` 重新建立 + 方案 A 的歷史重播即可——
   這段邏輯完全不需要因為多機而改，跟處理單機重啟是同一套機制。
3. **不需要為此實作跨機器的 KV state 同步**（做法二）——除非量體大到 prefill 成本主宰了
   延遲預算，且機器間有夠快的網路，否則「黏著路由 + 優雅重播」已經是性價比最高的解法。
