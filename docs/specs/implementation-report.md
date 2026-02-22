# OpenClaw Web Chat Client — 實作報告（implementation-report.md）

> 最後更新：2026-02-21（Session 標題內聯編輯 + Gateway `sessions.patch` RPC）

---

## 一、Build 結果

| 套件 | 指令 | 結果 |
|---|---|---|
| `apps/api` | `tsc` | ✅ 成功，0 錯誤 |
| `apps/web` | `vue-tsc && vite build` | ✅ 成功，0 錯誤 |
| 全站 | `npm run build`（根目錄） | ✅ 成功 |

### apps/web 產物大小（v2）
```
dist/index.html                   0.47 kB │ gzip:  0.31 kB
dist/assets/index-*.css         238.15 kB │ gzip: 33.52 kB
dist/assets/index-*.js          109.32 kB │ gzip: 42.23 kB
✓ 38 modules transformed.
✓ built in 1.55s
```

---

## 二、架構說明

### 2.1 整體架構（v2，含 SSE 串流）

```
瀏覽器 (Vue 3 + Vite)
  │  HTTP（fetch + multipart）
  │  SSE（text/event-stream，AI 串流回覆）
  ▼
AP 端 (Hono + Node.js, port 3000)
  ├─ rpc-client.ts    ← 低階 WS RPC（heartbeat ping/pong、subscribeEvent）
  ├─ gateway-rpc.ts   ← 連線池 + request + sendStream（async generator）
  ├─ session-manager.ts ← 業務邏輯層（send / sendStream / history / list）
  └─ routes/*
       ├─ POST /messages         ← REST 阻塞版（fallback）
       └─ POST /messages/stream  ← SSE 串流版（v2 新增）
             │
             │  WebSocket（JSON RPC）
             ▼
Gateway (ws://127.0.0.1:18789 or wss://...)
  → chat.send（deliver: true）
  → chat.stream / chat.chunk events（若 Gateway 支援串流）
```

### 2.2 WS/RPC 流程

1. **Token 驗證**：AP 以 `ws://<gateway>?token=<token>` 建立 WS 連線；握手成功 = Token 有效
2. **Session/Message 操作**：複用 WS 連線，以 `{ type:'req', id, method, params }` 格式發送 RPC，等待 `{ type:'res', id, result/error }` 回應
3. **連線池**：每個 Token 維護一條 WS 連線（TTL 5 分鐘），同一 Token 的並行請求共用同一連線
4. **心跳保活**：每 30 秒送出 WS `ping`，Gateway 回傳 `pong`，避免防火牆閒置斷線

### 2.3 RPC 方法對應（更新後）

| AP 操作 | RPC method | params |
|---|---|---|
| Token 驗證 | WS 握手（connect RPC） | `{ minProtocol, maxProtocol, client, role, auth.token }` |
| 取得 Session 清單 | `sessions.list` | — |
| 建立新 Session | `sessions.reset` | `{ key }` |
| 取得訊息清單 | `chat.history` | `{ sessionKey, limit }` |
| 發送訊息（阻塞） | `chat.send` | `{ sessionKey, message, deliver:true, idempotencyKey, attachments }` |
| 發送訊息（串流） | `chat.send` | 同上（Gateway 自動推播串流事件，無需額外 stream 參數） |
| 更新 Session 標題 | `sessions.patch` | `{ key, label }` |
| 刪除 Session | `sessions.delete` | `{ sessionKey }` |
| 批次刪除 | `sessions.deleteMany` | `{ sessionKeys }` |

圖片以 base64 字串傳遞（`{ type:'image', mimeType, content:base64, name }`）。

### 2.4 訊息串流架構（2026-02-21 更新）

目前採「**持久推播優先 + fallback**」架構：

```
【主路徑：push 模式】
前端 → POST /messages（REST）
AP → chat.send RPC
Gateway → 推播 chunk / agent-end / message-final 事件
AP EventForwarder → 持久 SSE 通道 GET /api/events → 前端即時顯示

【次要路徑：per-request SSE（持久 SSE 離線時）】
前端 → POST /messages/stream
AP → text/event-stream 回應
  1. writeSSE: {"type":"status","status":"sending"}
  2. for await (event of sessionManager.sendStream(...)) {
       若 event.type === 'chunk': writeSSE chunk
       若 event.type === 'done':  writeSSE done
     }

【保底：REST + polling】
前端 → POST /messages（REST）+ waitForAssistantReply()（polling 2s）
```

### 2.5 傳輸模式優先順序（2026-02-21 更新）

| 優先順序 | 模式 | badge 顏色 | 說明 |
|---|---|---|---|
| 1（主路徑） | **push** | 藍色 | 持久 SSE 在線時，僅 REST 發送，chunk 由持久 SSE 推播通道自動推入 |
| 2（次要路徑） | **stream** | 綠色 | 持久 SSE 離線時，per-request SSE 串流 fallback |
| 3（保底） | **fallback** | 橘色 | SSE 皆不可用時，REST + polling（間隔 2s，最長 30s） |

```
前端 sendMessage()
  ① 持久 SSE 在線？ → push 模式
     └─ POST /messages（REST），chunk/done 由持久 SSE 推播
     └─ 30 秒逾時保底：若 message-final 未到達，fallback 重載
  ② 持久 SSE 離線 → 嘗試 per-request SSE
     ├─ 成功（done 事件）：完成，重載訊息
     ├─ error.code === UNAUTHORIZED：登出，不 fallback
     └─ 其他 error：降級 →
  ③ REST + polling 保底
     ├─ 成功：waitForAssistantReply()（polling 2s，最長 30s）
     └─ 失敗：回傳 false，顯示錯誤
```

### 2.6 目前穩定基線（2026-02-21）

- **push 模式可用**：持久 SSE 通道正常建立，chunk 即時推播至前端
- **done 後補輪詢可成功補抓回覆**：message-final 事件到達後自動重載訊息
- **fallback 正常**：持久 SSE 離線時自動降級，REST + polling 2s 間隔可正確補抓
- **已知限制**：Gateway 串流事件格式仍為推測值，需依 Gateway 實際規格微調

### 2.6 Token 過期處理流程（v2 新增）

```
1. apiFetch() 收到 401 UNAUTHORIZED
   → unauthorizedState.triggered = true

2. ChatView watch(unauthorizedState.triggered)
   → authStore.logout()
   → sessionsStore.reset()
   → router.push({ name: 'login', query: { reason: 'session_expired' } })

3. LoginView 偵測 route.query.reason === 'session_expired'
   → 顯示「登入已過期，請重新輸入 Token 登入。」
```

---

## 三、變更檔案清單（v2 累計）

### 根目錄
| 檔案 | 說明 |
|---|---|
| `package.json` | Monorepo 根設定（npm workspaces） |
| `.env.example` | 環境變數範例（新增 GATEWAY_WS_URL、STREAMING_ENABLED 等） |

### apps/api（Hono + Node.js + TypeScript）
| 檔案 | 說明 | v2 更新 |
|---|---|---|
| `apps/api/src/rpc-client.ts` | 低階 WS RPC 客戶端 | 新增 `subscribeEvent()`、`_dispatchEvent()`、pong handler |
| `apps/api/src/gateway-rpc.ts` | 連線池管理器 | 新增 `sendStream()` async generator |
| `apps/api/src/session-manager.ts` | Session 業務邏輯 | 新增 `sendStream()` async generator |
| `apps/api/src/routes/messages.ts` | 訊息路由 | 新增 `POST /stream` SSE 端點；import 改至 session-manager |
| `apps/api/src/config.ts` | 設定 | 新增 `streamingEnabled`（`STREAMING_ENABLED` env） |
| `apps/api/src/index.ts` | AP 入口 | CORS allowMethods 補上 PATCH；啟動日誌顯示 SSE 狀態 |
| `apps/api/src/gateway.ts` | 相容層 | 新增 `renameSession()` facade |

### apps/web（Vite + Vue3 + SCSS + Bootstrap5）
| 檔案 | 說明 | v2 更新 |
|---|---|---|
| `apps/web/src/api/client.ts` | API 客戶端 | 新增 `streamMessage()` SSE 客戶端；新增 `unauthorizedState` reactive；`apiFetch` 偵測 401 |
| `apps/web/src/stores/sessions.ts` | Session 狀態 Store | 新增串流狀態；`sendMessage()` 改為 SSE 優先 + polling fallback；UNAUTHORIZED 偵測 |
| `apps/web/src/views/ChatView.vue` | 主介面 | 新增串流訊息泡泡（typing cursor）；watch `unauthorizedState` 自動登出重導 |
| `apps/web/src/views/LoginView.vue` | 登入頁 | 新增 `session_expired` 提示 |

### docs/specs
| 檔案 | 更新內容 |
|---|---|
| `spec.md` | 新增 2.4 延伸功能、4.1~4.4 架構、驗收條件 14~17 |
| `plan.md` | 新增階段 5（WS Push 完整計畫） |
| `data-model.md` | 新增 SSE 事件型別、串流狀態、UNAUTHORIZED 機制 |
| `tasks.md` | 新增 T7（完整任務拆解） |
| `implementation-report.md` | 本次更新 |
| `fix-report.md` | v2 修正摘要 |

---

## 四、啟動方式

### 先決條件
1. Node.js >= 20
2. 複製 `.env.example` 為 `.env` 並填寫 `GATEWAY_WS_URL`

```bash
cp .env.example .env
# 修改 GATEWAY_WS_URL（預設 ws://127.0.0.1:18789）
```

### 安裝依賴
```bash
npm install
```

### 開發模式
```bash
# 終端 1：啟動 AP
npm run dev:api

# 終端 2：啟動 Web（Dev Server，含 proxy）
npm run dev:web

# 瀏覽器開啟 http://localhost:5173
```

### 正式 Build
```bash
npm run build
# 產物：apps/api/dist/（Node.js）、apps/web/dist/（靜態檔）
```

---

## 五、功能驗收狀態（v2 完整）

| 功能 | 規格對應 | 實作狀態 |
|---|---|---|
| Token 登入驗證（WS 握手） | 必要功能 1 | ✅ 完成 |
| 前端登入狀態持久化 | 驗收條件 1 | ✅ 完成（localStorage） |
| Session 清單查詢（RPC） | 必要功能 2 | ✅ 完成 |
| 建立新 Session（RPC） | 必要功能 3 | ✅ 完成 |
| Session 切換 | 必要功能 4 | ✅ 完成 |
| 多行文字輸入 | 必要功能 5 | ✅ 完成 |
| 圖片拖曳/多選上傳 | 必要功能 6 | ✅ 完成 |
| WS 連線失敗提示 | 驗收條件 7 | ✅ 完成 |
| Token 無效明確提示 | 驗收條件 7 | ✅ 完成 |
| RPC 錯誤明確提示 | 驗收條件 7 | ✅ 完成 |
| 不再出現 HTML 當 JSON 解析錯誤 | 驗收條件 8 | ✅ 完成 |
| 封存 Session（含 confirm） | 驗收條件 9 | ✅ 完成（AP in-memory fallback） |
| 關閉 Session（含 confirm） | 驗收條件 10 | ✅ 完成 |
| 顯示/隱藏封存切換 + 取消封存 | 驗收條件 11 | ✅ 完成 |
| 封存/關閉後即時更新清單 | 驗收條件 12 | ✅ 完成 |
| API 回應統一格式 | 驗收條件 13 | ✅ 完成 |
| Session 標題內聯編輯 | 驗收條件 19 | ✅ 完成（Gateway `sessions.patch` 持久化） |
| 發送後立即顯示傳送中提示 | 驗收條件 14 | ✅ 完成（SSE status 事件） |
| AI 串流 chunk 即時顯示 | 驗收條件 15 | ✅ 完成（Gateway 支援時） |
| SSE 失敗自動降級為 polling | 驗收條件 16 | ✅ 完成 |
| Token 過期自動登出重導 | 驗收條件 17 | ✅ 完成 |

---

## 六、錯誤碼完整對照（v2 更新）

| 場景 | 來源 | 錯誤碼 | HTTP 狀態 |
|---|---|---|---|
| AP server 未啟動，proxy 回傳 HTML | 前端 apiFetch | `API_NOT_AVAILABLE` | — |
| 完全無法連線（ECONNREFUSED） | 前端 apiFetch | `NETWORK_ERROR` | — |
| Token 格式錯誤（無 Header） | AP middleware | `UNAUTHORIZED` | 401 |
| Token 無效或過期（Gateway 拒絕 WS 握手） | AP auth route | `INVALID_TOKEN` | 401 |
| Gateway 無法連線（WS 握手逾時/被拒） | AP 所有路由 | `GATEWAY_CONNECT_FAILED` | 502 |
| RPC 操作失敗（Gateway 回傳 error） | AP 所有路由 | `GATEWAY_RPC_ERROR` | 502 |
| Token 在 RPC 中被拒絕（UNAUTHORIZED） | AP 所有路由 | `UNAUTHORIZED` | 401 |
| Session 不存在（RPC NOT_FOUND） | AP messages route | `NOT_FOUND` | 404 |
| 請求格式錯誤 | AP routes | `BAD_REQUEST` | 400 |
| SSE 串流功能被停用 | AP stream route | `STREAMING_DISABLED` | 503 |
| SSE 端點不可用（前端偵測） | 前端 streamMessage | `STREAMING_UNAVAILABLE` | — |
| SSE 讀取中斷 | 前端 streamMessage | `STREAM_READ_ERROR` | — |

---

## 七、Close / Archive Session 功能（2026-02-20 v1）

### 7.1 功能說明

| 功能 | 實作方式 | 備註 |
|---|---|---|
| 封存 Session | AP 端 in-memory Set 追蹤 | Gateway 無 archive RPC，此為 fallback |
| 取消封存 | 從 in-memory Set 移除 | 同上 |
| 關閉 Session | 呼叫 Gateway `sessions.delete` RPC | 永久刪除 |
| 封存狀態隨 list 回傳 | `sessions.list` 回應加入 `archived` 欄位 | 由 AP 端附加 |
| 封存項目預設隱藏 | `visibleSessions` computed 過濾 | 前端 store |

### 7.2 Archive Fallback 行為邊界

- **封存狀態存於 AP 記憶體，AP 重啟後封存狀態重置**（所有 Session 恢復「未封存」）
- Gateway 側 Session 仍存在，封存僅影響 AP 端清單顯示
- 若日後 Gateway 提供 archive RPC，只需修改 `SessionManager.archive()` 即可

---

## 八、WS Push / SSE 串流功能（2026-02-20 v2）

### 8.1 subscribeEvent 機制

`RpcClient.subscribeEvent(name, callback)` 允許在 RPC 請求期間，同時監聽 Gateway 推播的事件（type=event 幀）。

```
client.subscribeEvent('*', handler)
  ↓
_dispatchEvent(event)
  ├─ 精確名稱訂閱者（event.name 完全相符）
  └─ 萬用訂閱者（'*'）
```

### 8.2 sendStream async generator 設計

```typescript
async *gatewayRpc.sendStream(token, sessionKey, message, attachments, idempotencyKey)
  // 1. 訂閱事件
  unsubscribe = client.subscribeEvent('*', handler)
  // 2. 發送 RPC（background Promise）
  client.request('chat.send', {...}).then(...).catch(...)
  // 3. yield chunk / done
  while (!done || buffer.length > 0) {
    yield buffer.shift()  // or await notification
  }
  // 4. 清理
  unsubscribe()
```

### 8.3 pong handler

`ws.on('pong', ...)` 記錄 `_lastPongAt = Date.now()`，確保心跳機制的 liveness 可被查詢（供未來監控使用）。

### 8.4 前端 SSE 降級策略總覽

| 條件 | 前端行為 |
|---|---|
| `STREAMING_ENABLED=false`（AP 停用） | `streamMessage()` 收到 503，降級至 polling |
| 網路錯誤（fetch throw） | 降級至 polling |
| HTTP 非 200（非 401） | 降級至 polling |
| `Content-Type` 非 `text/event-stream` | 降級至 polling |
| SSE 讀取中斷 | 降級至 polling |
| `type:'error'` 且 code !== UNAUTHORIZED | 降級至 polling |
| `type:'error'` 且 code === UNAUTHORIZED | 觸發登出，不 fallback |

---

## 九、已知限制與後續建議（v2 更新）

### 已知限制
1. **Gateway 串流事件格式假設**：`chat.stream` / `chat.chunk` 事件名稱與 data 結構為推測值，需依 Gateway 實際規格調整 `gateway-rpc.ts` 中的事件過濾邏輯。
2. **Archive 狀態不持久**：封存狀態存於 AP in-memory，AP 重啟後重置。需持久化則需引入儲存機制（DB / 檔案）或 Gateway 原生支援。
3. **圖片傳輸格式**：圖片以 base64 傳送。若 Gateway 期待二進位 WebSocket frame，需調整 `rpc-client.ts`。
4. **無訊息即時更新（非串流模式）**：Polling 模式仍需間隔查詢。若 Gateway 主動推播新訊息事件，可在 `rpc-client.ts` 訂閱並即時更新前端。
5. **SSE 串流前端無法取消**：一旦 SSE 連線建立，前端無法中途取消（目前 `reader.cancel()` 在 done 後呼叫）。

### 後續建議
- 確認 Gateway 實際串流事件名稱（`chat.stream` / `chat.chunk` 的確切格式），更新 `gateway-rpc.ts` 事件過濾邏輯
- 若 Gateway 提供 WS 推播新訊息事件，在 `rpc-client.ts` 訂閱並即時更新前端 Session/訊息清單
- 生產環境改用 `wss://` 並啟用 `TLS_VERIFY=true`
- 若需封存持久化，可在 AP 端加入 JSON 檔或 SQLite 儲存
- 考慮加入 SSE 心跳（AP 端定期送 `: keep-alive` 或空事件），防止瀏覽器 SSE 連線超時

---

## 十、Session 標題內聯編輯（2026-02-21）

### 10.1 功能說明

使用者可在側邊欄直接重新命名 Session 標題，透過 Gateway `sessions.patch` RPC 持久化 label 欄位。

| 功能 | 實作方式 | 備註 |
|---|---|---|
| 重新命名 Session | Gateway `sessions.patch` RPC | 持久化（Gateway 端儲存） |
| 內聯編輯 UI | 側邊欄 ✎ 按鈕 → `<input>` 切換 | Enter/blur 確認、Escape 取消 |
| PATCH 路由擴充 | 同時支援 `{ title }` 和 `{ archived }` | 兩欄位獨立處理 |

### 10.2 Gateway RPC 發現過程

- 初次嘗試 `sessions.update` → Gateway 回覆 `unknown method: sessions.update`
- 查閱 OpenClaw Control UI（Dashboard）文件，發現 Dashboard 使用 `sessions.patch` 更新 label
- 確認 `sessions.patch` RPC params 為 `{ key: sessionKey, label: title }`

### 10.3 變更檔案

| 檔案 | 變更內容 |
|---|---|
| `apps/api/src/session-manager.ts` | 新增 `rename()` 方法，呼叫 `sessions.patch` RPC 並同步更新 local cache |
| `apps/api/src/gateway.ts` | 新增 `renameSession()` facade 函式 |
| `apps/api/src/routes/sessions.ts` | 擴充 `PATCH /:sessionKey`：支援 `{ title }` 欄位，移除 `archived` 為必填的限制 |
| `apps/web/src/api/client.ts` | 新增 `renameSession()` API 呼叫 |
| `apps/web/src/stores/sessions.ts` | 新增 `renameSession()` action + `renamingSessionKey` / `renameError` 狀態 |
| `apps/web/src/views/ChatView.vue` | 新增 ✎ 編輯按鈕與 `<input>` 內聯編輯模式；自動聚焦選取全文；Enter/Escape/blur 處理 |

### 10.4 UI 行為

1. 滑鼠 hover session 列表項目時，顯示 ✎ 按鈕（在封存按鈕前）
2. 點擊 ✎ → 標題文字替換為 `<input>`，自動聚焦並選取全文
3. `Enter` 或 `blur` → 確認送出（空白標題或未變更不送出）
4. `Escape` → 取消編輯，恢復原標題
5. 編輯中 `@click.stop` 防止觸發 session 切換
6. 聊天 header 標題透過 store 響應式自動同步更新
