# OpenClaw Web Chat Client 開發計畫（plan.md）
<!-- v3 更新：2026-02-21 — 階段 6 已完成（原生推播）、新增階段 7（標題編輯） -->

## 階段 0：初始化（已完成）
- monorepo 結構與規劃文件建立

## 階段 1：AP 端 Gateway Adapter（規格變更後重點，已完成）
1. 建立 Gateway WS client（connect/request/disconnect）
2. 建立 Token 驗證流程（以 WS/RPC 驗證，不依賴 REST `/api/v1`）
3. 建立 Session API（轉 RPC）
   - `GET /api/sessions`
   - `POST /api/sessions`
4. 建立 Message API（轉 RPC）
   - `GET /api/sessions/:id/messages`
   - `POST /api/sessions/:id/messages`（文字 + 圖片）
5. 統一錯誤碼映射（RPC 錯誤 → API 錯誤）

## 階段 2：WEB 端（已完成）
1. 登入頁（Token）
2. 主介面（左側 Session 清單 + 右側聊天）
3. 新增 Session
4. 多行文字 + 拖曳多圖上傳
5. 訊息渲染（文字 + 圖片）

## 階段 3：整合與驗證（已完成）
- 串接 AP 與 WEB
- build 檢查
- 手動驗收（登入、查詢、建立、對話、多圖）
- 驗證不再出現 HTML 當 JSON 解析錯誤

## 階段 4：Close / Archive Session（已完成，2026-02-20）
1. AP 端新增端點：
   - `PATCH /api/sessions/:sessionKey`（封存/取消封存，`{ archived: boolean }`）
   - `DELETE /api/sessions/:sessionKey`（關閉，呼叫 Gateway `sessions.delete` RPC）
2. `session-manager.ts` 新增 `archive()`、`unarchive()`、`close()` 方法
   - archive/unarchive：AP 端 in-memory 狀態追蹤（Gateway 未提供 archive RPC，此為 fallback）
   - close：轉發 `sessions.delete` RPC
3. `list()` 回應中加入 `archived` 欄位（讀取 in-memory 狀態）
4. Web 端擴充 `sessionsStore`：
   - 新增 `showArchived` 旗標、`archivingSessionKey`、`closingSessionKey` 載入狀態
   - 新增 `archiveSession()`、`closeSession()`、`toggleShowArchived()` action
   - 新增 `visibleSessions` getter（依 showArchived 過濾）
5. `ChatView.vue` Session 列表每列加入「封存」「關閉」按鈕（含 confirm）

## 階段 5：WS Server Push / SSE 串流 / Token 過期 / 心跳保活（2026-02-20 v2）

### 5.1 AP 端
1. **rpc-client.ts**：
   - 新增 `subscribeEvent(name, callback): unsubscribe` 方法（per-name 事件訂閱）
   - 新增 `_dispatchEvent()` 私有方法（dispatch 至訂閱者）
   - 新增 pong handler（記錄最後 pong 時間，加強心跳監控）
2. **gateway-rpc.ts**：
   - 新增 `sendStream()` async generator 方法
   - 訂閱 Gateway 串流事件（chat.stream / chat.chunk）
   - 呼叫 `chat.send` RPC 並 yield 事件 / 最終完成
3. **session-manager.ts**：
   - 新增 `sendStream()` async generator 方法（包裝 gateway-rpc.sendStream）
4. **routes/messages.ts**：
   - 新增 `POST /api/sessions/:sessionKey/messages/stream` SSE 端點
   - 訂閱串流事件並以 `text/event-stream` 轉發至前端
   - 保留既有 REST endpoint 作為 fallback
5. **config.ts**：
   - 新增 `streamingEnabled` 設定（`STREAMING_ENABLED`，預設 `true`）
6. **index.ts**：
   - CORS `allowMethods` 補上 `PATCH`（修正 archive 端點跨域預檢缺失）

### 5.2 Web 端
1. **api/client.ts**：
   - 新增 `streamMessage()` 函式（fetch + ReadableStream SSE 解析）
   - 新增 `unauthorizedState` reactive 物件（全域 UNAUTHORIZED 通知）
   - `apiFetch` 偵測到 401 時設定 `unauthorizedState.triggered = true`
2. **stores/sessions.ts**：
   - 新增 `streamingText` / `streamingSessionKey` 狀態
   - `sendMessage()` 改為先嘗試 SSE 串流，失敗時 fallback polling
   - 監聽 `unauthorizedState`，觸發時清除狀態並導回登入頁
3. **views/ChatView.vue**：
   - 顯示串流訊息泡泡（實時追加 chunk）
   - watch `unauthorizedState`，觸發時呼叫 logout 並重導至 login
4. **views/LoginView.vue**：
   - 偵測 route query `reason=session_expired`，顯示「登入已過期」提示

### 5.3 驗收（目前基線完成）
- `npm run build` 全部通過（0 TypeScript 錯誤）
- SSE 串流：發送訊息時前端立即顯示傳送中狀態
- SSE fallback：手動停用或模擬失敗時自動降級至 polling，UI 正常運作
- Token 過期：模擬 401 回應時前端自動登出並導至登入頁，顯示提示訊息
- polling 間隔調整為 2 秒，並驗證可補抓助手回覆

## 階段 6：Gateway 原生 WS 訂閱推播（已完成，2026-02-21）
1. ✅ AP 端新增 `EventForwarder` 類別，以 token 為 key 管理持久 Gateway 事件訂閱
2. ✅ 新增 `GET /api/events` 持久 SSE 端點（含 30 秒 keepalive）
3. ✅ 前端新增 `event-source.ts` 持久 SSE 消費模組（fetch+ReadableStream，指數退避重連）
4. ✅ 前端 `sendMessage()` 推播優先：持久 SSE 在線時僅 REST 發送，chunk 由推播自動推入
5. ✅ fallback 完整保留：持久 SSE 離線 → per-request SSE → REST + polling（2s）

### 驗收結果
- push 模式正常運作，chunk 即時推播
- message-final 事件觸發訊息重載
- 持久 SSE 斷線自動重連（指數退避）
- fallback 正常降級

## 階段 7：Session 標題內聯編輯（已完成，2026-02-21）
1. AP 端 `session-manager.ts` 新增 `rename()` 方法，呼叫 Gateway `sessions.patch` RPC
2. `gateway.ts` 新增 `renameSession()` facade
3. `routes/sessions.ts` 擴充 `PATCH /:sessionKey`：同時支援 `{ title }` 和 `{ archived }` 欄位
4. Web 端 `api/client.ts` 新增 `renameSession()` 呼叫
5. `stores/sessions.ts` 新增 `renameSession()` action 與 loading / error 狀態
6. `ChatView.vue` 側邊欄新增 ✎ 編輯按鈕，點擊後切換為 `<input>` 內聯編輯
   - Enter / blur 確認、Escape 取消
   - 空白標題不送出、未變更不送出

## 階段 8：待辦（下一輪）
1. 推播事件 schema 穩定化：確認 Gateway 實際串流事件名稱與 payload 格式
2. 觀測性：`/health` 暴露 WS 連線池狀態、持久 SSE 客戶端數量
3. SSE 串流前端中途取消機制
4. 封存持久化（若 Gateway 日後提供 archive RPC）

## 效能策略
- AP 端對 Gateway 連線採輕量快取/重用（TTL 5 分鐘，並發安全）
- Heartbeat（ping/pong）30 秒間隔，防止防火牆閒置斷線
- Session 與訊息採增量載入
- 圖片上傳限制：單張 <= 10MB、一次 <= 10 張

## 程式品質策略
- Adapter 與 route 分層
- 明確錯誤碼（`UNAUTHORIZED` / `GATEWAY_CONNECT_FAILED` / `GATEWAY_RPC_ERROR`）
- loading/empty/error 三態完整
- 串流與非串流路徑分離，fallback 自動觸發
