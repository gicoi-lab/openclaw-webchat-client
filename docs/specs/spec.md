# OpenClaw Web Chat Client 規格書（spec.md）
<!-- v2 更新：2026-02-20 — WS Push / SSE 串流 / Token 過期 / 心跳保活 -->

## 1. 目標
建立一個可讓使用者透過瀏覽器存取 OpenClaw Gateway 的 Web Chat Client，分為：
- WEB UI 端（Vite + Vue 3 + Bootstrap 5 + SCSS）
- AP 端（Node.js + TypeScript + Hono + @hono/node-server）

> 規格變更（2026-02-20 v1）：
> AP 與 Gateway 的串接方式由「REST 假設（`/api/v1/*`）」改為「Gateway WebSocket / RPC」。

> 規格擴充（2026-02-20 v2）：
> - 新增 WS Server Push（SSE 串流）：AP 透過 SSE 向前端推播 AI 回覆，前端可即時看到新訊息
> - 新增連線池心跳保活（ping/pong）：防止防火牆斷線，並可偵測連線存活
> - 新增 Token 過期自動偵測與重新登入流程
> - 保留 long polling 作為 SSE 不可用時的 fallback

## 2. 範圍（MVP）
### 2.1 必要功能
1. 使用 OpenClaw Token 登入
2. 登入後可查詢既有對話 Session
3. 可建立新對話 Session
4. 可進入 Session 對話
5. 對話支援多行文字輸入
6. 對話支援圖片上傳（拖曳 + 檔案選取，且可一次多張）

### 2.3 延伸功能（Close / Archive Session）
7. 可封存（Archive）對話 Session：封存後預設不顯示，可透過切換顯示/隱藏封存項目
8. 可關閉（Close）對話 Session：永久刪除，操作前需確認

### 2.5 延伸功能（Session 標題編輯）
12. 可在側邊欄直接重新命名 Session 標題（內聯編輯），透過 Gateway `sessions.patch` RPC 持久化

### 2.4 延伸功能（WS Push / Streaming）v2
9. AI 串流回覆：前端發送訊息後即時接收 AI 回應（SSE 串流），不必等整次完成
10. 串流失敗自動降級：SSE 不可用時自動切換 long polling，不卡 UI
11. Token 過期自動偵測：任何 API 回傳 UNAUTHORIZED(401) 時，自動清除登入並導回登入頁

> 目前基線實作狀態（2026-02-21）：
> - 已完成：持久 SSE 推播通道（push 模式）+ per-request SSE fallback + REST polling 保底（2 秒間隔）+ Token 過期自動登出
> - push 模式為主路徑，Gateway 原生事件透過 EventForwarder 即時轉發至前端

### 2.2 非目標（本版不做）
- User ACL（延後）
- 複雜權限矩陣
- 過度抽象化與過度設計
- 大規模重構既有功能

## 3. 系統需求與限制
- AP 端以 `.env` 載入 Gateway WS 位址與連線設定
- 預設 Gateway（本機）：`ws://127.0.0.1:18789`
- 可配置內網 HTTPS 入口，但 AP 不再假設有 REST JSON API
- 專案目錄：`~/codejobs/openclaw-webchat-client`
- 文件與註解：繁體中文
- 效能優先、程式碼風格一致

## 4. 架構與授權流程（v2 更新後）
1. 使用者於 Web 輸入 OpenClaw Token
2. AP 端以 Token 建立 Gateway WS 連線，送出 `connect` 握手驗證
3. 驗證成功後，AP 建立短期登入狀態（前端暫存 token，後續可升級 HttpOnly session）
4. 所有 Session / Message 操作皆由 AP 透過 Gateway RPC 轉發

### 4.1 WS Server Push（SSE 串流）流程
```
前端 → POST /api/sessions/:key/messages/stream（multipart/form-data）
         ↓
AP（回應 text/event-stream）
  1. 立即送出 {"type":"status","status":"sending"}
  2. 呼叫 Gateway chat.send RPC，並訂閱 chat.stream 事件
     - 若 Gateway 推播 chat.stream/chat.chunk 事件：
       以 {"type":"chunk","text":"..."} 轉發至前端（串流打字效果）
  3. chat.send RPC 完成後，送出 {"type":"done","accepted":true}
  4. 關閉 SSE 連線

前端
  - 收到 status 事件：顯示「傳送中」狀態
  - 收到 chunk 事件：即時追加文字到串流訊息泡泡
  - 收到 done 事件：完成串流，重新載入訊息清單
  - 收到 error 事件：顯示錯誤，觸發 fallback polling
```

### 4.2 傳輸模式優先順序
```
① 持久 SSE 在線 → push 模式（主路徑）
   前端 POST /messages（REST），chunk 由持久 SSE 推播通道自動推入
② 持久 SSE 離線 → per-request SSE（次要路徑）
   前端 POST /messages/stream，AP 以 text/event-stream 回應
③ SSE 皆不可用 → REST + polling（保底）
   前端 POST /messages + waitForAssistantReply()（polling 2s，最長 30s）
```
> 可透過 `STREAMING_ENABLED=false` 環境變數在 AP 側完全停用 per-request SSE 端點

### 4.3 Token 過期流程
```
前端發出任何 API 請求
  → AP 回傳 401 UNAUTHORIZED
  → apiFetch 觸發全域 onUnauthorized 回呼（reactive flag）
  → ChatView watch：
      1. 呼叫 authStore.logout()
      2. 呼叫 sessionsStore.reset()
      3. router.push({ name: 'login', query: { reason: 'session_expired' } })
  → LoginView 偵測 route query reason=session_expired：
      顯示「登入已過期，請重新登入」提示
```

### 4.4 連線池心跳保活
- AP 端 RpcClient 每 `GATEWAY_HEARTBEAT_INTERVAL_MS`（預設 30000ms）傳送一次 WS `ping`
- Gateway 回傳 `pong`，RpcClient 記錄最後 pong 時間
- 若連線中斷（close 事件），連線池自動移除並於下次請求重建
- 此機制防止防火牆閒置超時斷線

## 5. Gateway RPC 方法映射

| 操作 | RPC 方法 | 主要 params | 備註 |
|------|----------|-------------|------|
| 取得 Session 清單 | `sessions.list` | — | 回傳含 sessionKey/title/createdAt/updatedAt |
| 建立新 Session | `sessions.reset` | `{ key }` | Gateway 無原生 create，以 reset 建立 |
| 取得訊息歷史 | `chat.history` | `{ sessionKey, limit }` | 回傳 messages 陣列或含 messages 物件 |
| 發送訊息 | `chat.send` | `{ sessionKey, message, deliver, idempotencyKey, attachments }` | Gateway 自動推播串流事件，無需額外 stream 參數 |
| 刪除 Session | `sessions.delete` | `{ sessionKey }` | — |
| 批次刪除 | `sessions.deleteMany` | `{ sessionKeys }` | — |
| 更新 Session 標題 | `sessions.patch` | `{ key, label }` | 持久化於 Gateway |
| 封存 Session | (AP in-memory) | — | Gateway 無原生 archive RPC，AP 端 fallback |

### 5.1 Gateway 串流事件（若 Gateway 支援）
| 事件名稱 | data 結構（推測） | 說明 |
|----------|------------------|------|
| `chat.stream` | `{ sessionKey, chunk, text }` | AI 回覆片段 |
| `chat.chunk` | `{ sessionKey, chunk, text }` | 同上（備援名稱） |

> 若 Gateway 不推播以上事件，chat.send RPC 完成後直接發送 done 事件，前端仍可正常運作。

## 6. SSE 訊息格式（AP → Web）
```
data: {"type":"status","status":"sending"}\n\n
data: {"type":"chunk","text":"..."}\n\n      ← 若 Gateway 支援串流
data: {"type":"done","accepted":true}\n\n
data: {"type":"error","code":"...","message":"..."}\n\n  ← 失敗時
```

## 7. 錯誤碼一覽
| 碼 | HTTP | 說明 |
|----|------|------|
| `UNAUTHORIZED` | 401 | Token 無效或已過期，前端自動登出 |
| `INVALID_TOKEN` | 401 | Token 格式錯誤 |
| `GATEWAY_CONNECT_FAILED` | 502 | 無法連線至 Gateway |
| `GATEWAY_RPC_ERROR` | 502 | RPC 操作失敗 |
| `BAD_REQUEST` | 400 | 請求格式錯誤 |
| `NOT_FOUND` | 404 | Session 不存在 |
| `API_NOT_AVAILABLE` | — | AP 服務未回應（前端偵測） |
| `NETWORK_ERROR` | — | 網路連線失敗（前端偵測） |

## 8. 驗收條件（Acceptance Criteria）v2
1. 可使用有效 Token 成功登入並維持登入狀態（前端暫存）
2. Session 清單可成功顯示（至少含 sessionKey 與最近活動時間）
3. 可建立新 Session 並立即出現在清單
4. 對話可送出多行文字，不截斷換行
5. 可一次上傳多張圖片，且每張皆可成功送出
6. UI 版型風格與 OpenClaw Dashboard 接近（左側清單 + 右側對話）
7. 失敗情境（Token 無效、Gateway 連線失敗、RPC 連線失敗）有清楚錯誤提示
8. 不再出現「把 HTML 當 JSON 解析」類型錯誤
9. Session 清單每列可執行「封存」操作（含確認提示），封存後預設不顯示
10. Session 清單每列可執行「關閉」操作（含確認提示），關閉後從清單移除
11. 提供「顯示/隱藏封存」切換，封存項目可還原（取消封存）
12. 封存/關閉操作成功後，清單與當前選中狀態即時更新
13. API 回應格式維持 `ApiResponse<T>` 統一包裝
14. 發送訊息後，前端立即顯示「傳送中」提示，不需等待 AI 完整回覆
15. AI 串流 chunk 可即時顯示在畫面（若 Gateway 支援串流）
16. SSE 失敗時自動降級為 polling，UI 不卡死
17. Token 過期時前端自動登出並導回登入頁，提示「登入已過期」
18. 在目前 Gateway 串流事件不穩定或不支援時，仍可透過 polling 成功補抓助手回覆
19. 側邊欄可內聯編輯 Session 標題（✎ 按鈕），Enter 確認、Escape 取消
20. 標題修改透過 Gateway `sessions.patch` RPC 持久化，重新整理後仍保持

## 10. 待實作項目（下一階段）
1. **推播事件 schema 穩定化**
   - 確認 Gateway 實際串流事件名稱與 payload 格式（`chat.stream` / `chat.chunk` 為推測值）
   - 固化 event name / payload 定義（sessionKey、messageId、role、delta、done）
2. **觀測性（Observability）**
   - `/health` 端點暴露 WS 連線池狀態、持久 SSE 客戶端數量
   - push/stream/fallback 模式使用比例統計
3. **SSE 串流前端中途取消**
   - 目前連線建立後需等 done 或 error 才結束，考慮加入取消機制

## 9. 風險與對策
- WS 握手失敗：AP 封裝重試與清楚錯誤碼（`GATEWAY_CONNECT_FAILED`）
- Token 驗證成功但後續失效：每次 RPC 回 401/403 時統一轉換 `UNAUTHORIZED`，前端自動登出
- 大圖多張上傳耗時：前端預覽與大小限制，AP 控制檔案上限
- Gateway RPC 事件/格式差異：集中於 AP adapter mapping，不讓 Web 直接耦合
- SSE 連線被防火牆截斷：前端 fallback 自動切換 polling，不卡 UI
- Gateway 不支援串流事件：chat.send RPC 完成後直接以 done 事件結束，前端正常顯示
