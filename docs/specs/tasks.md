# OpenClaw Web Chat Client 任務拆解（tasks.md）
<!-- v3 更新：2026-02-21 — T8 已完成（原生推播）、新增 T9（Session 標題內聯編輯） -->

## T0 規格變更（已完成）
- [x] 更新 `spec.md`
- [x] 更新 `plan.md`
- [x] 更新 `data-model.md`
- [x] 更新 `tasks.md`

## T1 AP 端：Gateway WS/RPC Adapter（已完成）
- [x] 建立 `rpc-client.ts`（connect/request/disconnect/heartbeat）
- [x] 建立 `gateway-rpc.ts`（連線池管理器）
- [x] 支援 token 驗證握手流程
- [x] 支援 request timeout 與錯誤映射
- [x] 將舊 REST 假設邏輯移除或標示 deprecated

## T2 AP 端路由調整（已完成）
- [x] `POST /api/auth/verify` 改走 WS/RPC 驗證
- [x] `GET /api/sessions` 改走 RPC
- [x] `POST /api/sessions` 改走 RPC
- [x] `GET /api/sessions/:sessionKey/messages` 改走 RPC
- [x] `POST /api/sessions/:sessionKey/messages` 改走 RPC

## T3 WEB 端相容調整（已完成）
- [x] 保持現有登入流程與 UI 行為
- [x] 錯誤訊息更新為 RPC 失敗語意
- [x] 確認多行輸入與多圖上傳不受影響

## T4 驗證（已完成）
- [x] `npm run build` 全部通過
- [x] 本機啟動 API/Web 成功
- [x] 手動驗收：登入、Session、新對話、多行、多圖上傳
- [x] 驗證不再出現 `Unexpected token '<'` 與 HTML→JSON 解析錯誤

## T5 文件（已完成）
- [x] 更新 `implementation-report.md` 增加 WS/RPC 架構說明
- [x] 新增本次變更摘要（併入 `fix-report.md`）

## T6 Close / Archive Session（已完成，2026-02-20）

### T6.1 規劃文件
- [x] 更新 `spec.md` — 新增延伸功能 2.3 與驗收條件 9~13
- [x] 更新 `plan.md` — 新增階段 4
- [x] 更新 `data-model.md` — 新增 `archived` 欄位與兩個端點
- [x] 更新 `tasks.md` — 新增 T6

### T6.2 AP 端
- [x] `session-manager.ts`：新增 in-memory archive 集合、`archive()`、`unarchive()`、`close()` 方法；修改 `list()` 加入 `archived` 欄位
- [x] `gateway.ts`：新增 `closeSession()` 與 `archiveSession()` 包裝函式
- [x] `routes/sessions.ts`：新增 `PATCH /:sessionKey`（封存）、`DELETE /:sessionKey`（關閉）路由

### T6.3 Web 端
- [x] `types.ts`：`ChatSession` 新增 `archived?: boolean`
- [x] `api/client.ts`：新增 `archiveSession()`、`closeSession()`
- [x] `stores/sessions.ts`：新增 `showArchived`、`archivingSessionKey`、`closingSessionKey` 狀態；新增 `archiveSession()`、`closeSession()`、`toggleShowArchived()` action；新增 `visibleSessions` getter
- [x] `views/ChatView.vue`：Session 列表每列新增「封存」「關閉」按鈕（hover 顯示，含 confirm）；新增顯示/隱藏封存切換

### T6.4 驗收
- [x] `npm run build` 全部通過（TypeScript 0 錯誤，38 modules）
- [x] 封存操作：成功→清單即時更新，封存項目預設隱藏
- [x] 取消封存：顯示封存後可點擊取消封存，即時恢復顯示
- [x] 關閉操作：confirm 確認→成功→從清單移除
- [x] 當前選中 Session 被封存/關閉時，右側內容區正確重置

### T6.5 文件
- [x] `implementation-report.md` 新增 Close/Archive 功能說明（第七節）
- [x] `fix-report.md` 追加本次修改摘要（第七部分）

## T7 WS Server Push / SSE 串流 / Token 過期 / 心跳保活（2026-02-20 v2）

### T7.1 規劃文件
- [x] 更新 `spec.md` — 新增 2.4 延伸功能、4.1~4.4 架構說明、驗收條件 14~17
- [x] 更新 `plan.md` — 新增階段 5
- [x] 更新 `data-model.md` — 新增 SSE 事件型別、串流狀態、UNAUTHORIZED 機制
- [x] 更新 `tasks.md` — 新增 T7

### T7.2 AP 端
- [x] `rpc-client.ts`：新增 `subscribeEvent()` 方法、`_dispatchEvent()` 私有方法、pong handler
- [x] `gateway-rpc.ts`：新增 `sendStream()` async generator
- [x] `session-manager.ts`：新增 `sendStream()` async generator
- [x] `routes/messages.ts`：新增 `POST /:sessionKey/messages/stream` SSE 端點；更新 import 至 session-manager
- [x] `config.ts`：新增 `streamingEnabled` 設定
- [x] `index.ts`：CORS allowMethods 補上 PATCH

### T7.3 Web 端
- [x] `api/client.ts`：新增 `streamMessage()`、`unauthorizedState` reactive
- [x] `stores/sessions.ts`：新增串流狀態、SSE 優先 + polling fallback、UNAUTHORIZED 偵測
- [x] `views/ChatView.vue`：串流訊息泡泡、UNAUTHORIZED redirect
- [x] `views/LoginView.vue`：session_expired 提示

### T7.4 驗收（基線）
- [x] `npm run build` 全部通過（0 TypeScript 錯誤）
- [x] SSE 串流：發送訊息時前端立即顯示傳送中狀態
- [x] SSE fallback：模擬失敗時自動降級至 polling
- [x] Token 過期：模擬 401 時前端自動登出並導至登入頁
- [x] 既有功能不受影響：多行輸入、多圖上傳、封存/關閉
- [x] polling 間隔調整為 2 秒

### T7.5 文件
- [x] 更新 `implementation-report.md` — 加入 SSE/fallback/token 過期說明
- [x] 更新 `fix-report.md` — 追加 v2 修正摘要

## T8 Gateway 原生 WS 訂閱推播（已完成，2026-02-21）
- [x] 定義 Gateway 實際可用事件 schema（event name / payload）
- [x] AP 端改為長連線事件訂閱器（非依附單次 chat.send）
- [x] 前端訊息更新改為「推播優先」
- [x] fallback polling 保留為保底，避免重複請求
- [x] 驗收：連續多輪對話不漏訊息、不卡住、不重送

## T9 Session 標題內聯編輯（已完成，2026-02-21）

### T9.1 AP 端
- [x] `session-manager.ts`：新增 `rename()` 方法，呼叫 Gateway RPC `sessions.patch`（params: `{ key, label }`）
- [x] `gateway.ts`：新增 `renameSession()` facade 函式
- [x] `routes/sessions.ts`：擴充 `PATCH /:sessionKey` 支援 `{ title }` 欄位（與 `{ archived }` 獨立處理，可同時存在）

### T9.2 Web 端
- [x] `api/client.ts`：新增 `renameSession(sessionKey, title)` API 呼叫
- [x] `stores/sessions.ts`：新增 `renameSession()` action + `renamingSessionKey` / `renameError` 狀態
- [x] `views/ChatView.vue`：側邊欄新增 ✎ 編輯按鈕；點擊後標題切換為 `<input>` 內聯編輯；Enter 確認、Escape 取消、blur 自動確認

### T9.3 驗收
- [x] `npm run build` 全部通過（0 TypeScript 錯誤）
- [x] 點擊 ✎ → input 出現，自動聚焦並選取全文
- [x] 輸入新標題按 Enter → API 呼叫成功（`sessions.patch` RPC），標題即時更新
- [x] 按 Escape → 取消編輯，標題不變
- [x] 空白標題 → 不送出
- [x] 重新整理頁面 → 標題仍為新值（Gateway 持久化）

### T9.4 踩坑紀錄
- 初次嘗試 `sessions.update` → Gateway 回覆 `unknown method`
- 查閱 OpenClaw Control UI 文件發現正確方法為 `sessions.patch`
- AP in-memory fallback 方案曾短暫實作，確認 RPC 可用後移除
