# OpenClaw Web Chat Client 資料模型（data-model.md）
<!-- v2 更新：2026-02-20 — 新增 SSE 事件型別、串流狀態、Token 過期機制 -->

## 1. AuthTokenSession（前端本地狀態）
```ts
interface AuthTokenSession {
  token: string
  verifiedAt: string // ISO datetime
}
```

## 2. GatewayConnectionConfig（AP 端）
```ts
interface GatewayConnectionConfig {
  gatewayWsUrl: string            // 例：ws://127.0.0.1:18789
  connectTimeoutMs: number        // WS 握手逾時
  requestTimeoutMs: number        // RPC 請求逾時
  heartbeatIntervalMs: number     // ping 間隔（0 = 停用）
  reconnectMaxRetries: number     // 最大重連次數
  reconnectDelayMs: number        // 重連基礎等待時間
  origin?: string                 // WS Origin header
  tlsVerify: boolean              // TLS 憑證驗證
  streamingEnabled: boolean       // 是否啟用 SSE 串流端點
}
```

## 3. ChatSession
```ts
interface ChatSession {
  sessionKey: string
  title?: string
  createdAt?: string
  updatedAt?: string
  lastMessagePreview?: string
  /** 封存狀態（AP 端 in-memory，重啟後重置） */
  archived?: boolean
}
```

## 4. ChatMessage
```ts
interface ChatMessage {
  id: string
  sessionKey: string
  role: 'user' | 'assistant' | 'system'
  text?: string
  images?: MessageImage[]
  createdAt: string
}
```

## 5. MessageImage
```ts
interface MessageImage {
  id?: string
  name: string
  mimeType: string
  size: number
  url?: string
  /** 前端暫時預覽用 URL（ObjectURL） */
  previewObjectUrl?: string
}
```

## 6. API 回應包裝
```ts
interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
}
```

## 7. SSE 事件格式（AP → Web，v2 新增）

AP 端串流端點 `POST /api/sessions/:sessionKey/messages/stream` 以 `text/event-stream` 回應，
每個 SSE 幀格式為 `data: {JSON}\n\n`。

```ts
/** AP 向前端推播的 SSE 事件型別 */
type SseEvent =
  | { type: 'status'; status: 'sending' }              // 開始處理
  | { type: 'chunk'; text: string }                    // AI 串流片段（Gateway 支援時）
  | { type: 'done'; accepted: true }                   // 處理完成
  | { type: 'error'; code: string; message: string }   // 處理失敗
```

## 8. Gateway 串流事件（WS RpcEvent，v2 新增）

Gateway 可能推播的 WebSocket 事件（type=event 幀）：

```ts
interface GatewayStreamChunk {
  type: 'event'
  name: 'chat.stream' | 'chat.chunk'  // 兩種備援名稱
  data: {
    sessionKey?: string
    chunk?: string      // AI 回覆片段文字
    text?: string       // 同上（備援欄位名稱）
    [key: string]: unknown
  }
}
```

## 9. 前端串流狀態（sessionsStore，v2 新增）
```ts
interface StreamingState {
  /** 串流進行中的目標 sessionKey */
  streamingSessionKey: string | null
  /** 累積的串流文字（chunk 持續追加） */
  streamingText: string
}
```

## 10. 全域 UNAUTHORIZED 通知（v2 新增）
```ts
/** reactive 物件，apiFetch 偵測到 401 時設定 triggered=true */
const unauthorizedState = reactive({ triggered: false })
```

前端各元件可 `watch(unauthorizedState.triggered, ...)` 來監聽 token 過期事件。

## 11. 錯誤碼（更新）
| 碼 | 觸發條件 | 前端行為 |
|----|----------|----------|
| `UNAUTHORIZED` | Token 無效或已過期 | 自動登出，導至登入頁 |
| `INVALID_TOKEN` | Token 格式錯誤 | 顯示錯誤訊息 |
| `GATEWAY_CONNECT_FAILED` | 無法連線至 Gateway | 顯示連線失敗提示 |
| `GATEWAY_RPC_ERROR` | RPC 操作失敗 | 顯示操作失敗提示 |
| `BAD_REQUEST` | 請求格式錯誤 | 顯示格式錯誤提示 |
| `NOT_FOUND` | Session 不存在 | 顯示 404 提示 |
| `API_NOT_AVAILABLE` | AP 服務未回應 | 顯示服務不可用提示 |
| `NETWORK_ERROR` | 網路連線失敗 | 顯示網路錯誤提示 |

## 12. 主要端點（含 v2 新增串流端點）
- `POST /api/auth/verify`
  - req: `{ token: string }`
  - res: `ApiResponse<{ verified: true }>`
  - 後端行為：以 Gateway WS/RPC 驗證 token

- `GET /api/sessions`
  - res: `ApiResponse<ChatSession[]>`

- `POST /api/sessions`
  - req: `{ title?: string }`
  - res: `ApiResponse<ChatSession>`

- `GET /api/sessions/:sessionKey/messages`
  - res: `ApiResponse<ChatMessage[]>`

- `POST /api/sessions/:sessionKey/messages`
  - content-type: `multipart/form-data`
  - fields: `text`, `images[]` (0..10)
  - res: `ApiResponse<{ accepted: true }>`（阻塞至 AI 回覆完成）

- **`POST /api/sessions/:sessionKey/messages/stream`（v2 新增）**
  - content-type: `multipart/form-data`
  - fields: `text`, `images[]` (0..10)
  - res: `text/event-stream`（SSE 串流）
  - 前端 fallback：若此端點失敗，自動切換至上方 REST endpoint + polling

- `PATCH /api/sessions/:sessionKey`
  - req: `{ archived?: boolean; title?: string }`（兩欄位可獨立或同時傳送）
  - res: `ApiResponse<{ sessionKey: string; archived?: boolean; title?: string }>`
  - 後端行為：
    - `title`：呼叫 Gateway `sessions.patch` RPC（params: `{ key, label }`），持久化標題
    - `archived`：AP 端 in-memory 狀態更新（Gateway 無原生 archive RPC，此為 fallback）

- `DELETE /api/sessions/:sessionKey`
  - res: `ApiResponse<{ closed: boolean; sessionKey: string }>`
  - 後端行為：呼叫 Gateway `sessions.delete` RPC，永久刪除
