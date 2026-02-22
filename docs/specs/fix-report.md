# 修正報告：Unexpected token '<' 與 Gateway 連線失敗

> 版本：2026-02-20（含 WS/RPC 架構遷移）
> 修正人員：Claude Code (AI)
> 修正範圍：apps/web、apps/api（路由層 + gateway adapter）

---

## 第一部分：前次 Commit 修正（REST 模式下的問題）

### 問題 1：登入時出現 `SyntaxError: Unexpected token '<'`

**位置**：`apps/web/src/api/client.ts:30`（`apiFetch` 函式）

**根因**：
`apiFetch` 在接收 HTTP 回應後，不檢查 `Content-Type` 就直接呼叫 `resp.json()`：

```typescript
// 修正前（有問題的程式碼）
const resp = await fetch(path, { ...init, headers })
const data = await resp.json()   // ← 無 Content-Type 檢查
```

當 AP server 未啟動時，Vite dev proxy 回傳 HTML 格式的 502/504 錯誤頁面，`resp.json()` 嘗試解析 HTML 就拋出：

```
SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
```

**修正方式**：在 `resp.json()` 前加入 `Content-Type` 檢查，非 JSON 時回傳 `API_NOT_AVAILABLE` 錯誤碼。

---

### 問題 2：Gateway 連線失敗時 sessions / messages 路由的錯誤碼不精確

**位置**：`apps/api/src/routes/sessions.ts`、`apps/api/src/routes/messages.ts`

**根因**：`GATEWAY_ENTRYPOINT_ERROR`（HTML 回應）分支只在 `auth.ts` 有處理，sessions/messages 遺漏。

**修正方式**：在所有路由 catch 區塊加入 `NON_JSON_RESPONSE` → `GATEWAY_ENTRYPOINT_ERROR` 分支。

---

## 第二部分：WS/RPC 架構遷移（本次變更）

> 規格變更（2026-02-20）：AP 與 Gateway 串接方式由「REST HTTP」改為「WebSocket/RPC」。

### 變更動機

1. 舊版 `gateway.ts` 使用 `fetch()` 呼叫 `GATEWAY_BASE_URL/api/v1/*`，依賴 Gateway 提供 REST API
2. 新規格中 Gateway 以 WebSocket 為主要通訊協定，不再假設有 REST JSON API
3. 舊方式容易因 API 入口設定錯誤而回傳 HTML（導致 `NON_JSON_RESPONSE`、`GATEWAY_ENTRYPOINT_ERROR` 等錯誤）

---

### 變更檔案一覽

| 檔案 | 變更類型 | 說明 |
|---|---|---|
| `apps/api/package.json` | 更新 | 新增依賴 `ws`、`@types/ws` |
| `apps/api/src/config.ts` | 更新 | 新增 `gatewayWsUrl`、`gatewayConnectTimeoutMs`、`gatewayRequestTimeoutMs`；舊 REST 設定標示 deprecated |
| `apps/api/src/gateway-rpc.ts` | **新增** | Gateway WebSocket/RPC 客戶端（連線池、逾時管理、錯誤映射） |
| `apps/api/src/gateway.ts` | **重寫** | 改用 `gatewayRpc.request()` 取代 REST `fetch()` |
| `apps/api/src/routes/auth.ts` | 更新 | 改用 `GatewayError` instanceof 判斷，使用新錯誤碼 |
| `apps/api/src/routes/sessions.ts` | 更新 | 同上 |
| `apps/api/src/routes/messages.ts` | 更新 | 同上；圖片 Uint8Array 轉 base64 由 gateway.ts 處理 |
| `apps/api/src/index.ts` | 更新 | 啟動日誌改顯示 `gatewayWsUrl` |
| `.env.example` | 更新 | 新增 `GATEWAY_WS_URL`、逾時設定；舊 REST 設定標示廢棄 |
| `docs/specs/implementation-report.md` | 更新 | 完整 WS/RPC 架構說明 |

---

### 新架構詳解

#### gateway-rpc.ts（核心新增）

```typescript
// 連線建立
const wsUrl = `${config.gatewayWsUrl}?token=${encodeURIComponent(token)}`
const ws = new WebSocket(wsUrl, { handshakeTimeout, rejectUnauthorized })

// RPC 請求格式
{ id: "req_<uuid>", method: "sessions.list", params?: { ... } }

// RPC 回應格式
{ id: "req_<uuid>", result: { ... } }          // 成功
{ id: "req_<uuid>", error: { code, message } } // 失敗
```

**連線池機制**：
- 每個 Token 維護一條 WS 連線（TTL 5 分鐘）
- 連線中（CONNECTING）的並行請求等待同一 `openPromise`，不重複建立
- 連線中斷時自動清除池條目，下次請求重建

**Token 驗證**（`verifyToken`）：
- 使用一次性 WS 連線（不加入連線池）
- HTTP 101 握手成功 → Token 有效
- HTTP 401/403 或 close code 4001/4003 → Token 無效（回傳 `false`）
- 其他連線錯誤 → 拋出 `GATEWAY_CONNECT_FAILED`

#### gateway.ts（重寫）

```typescript
// 舊版（REST）
await fetch(gatewayUrl('/sessions'), fetchOptions(token, { method: 'GET' }))

// 新版（WS/RPC）
await gatewayRpc.request(token, 'sessions.list')
```

圖片改以 base64 傳送（`messages.send` RPC 的 `images` 陣列），不使用 multipart HTTP。

---

### 錯誤碼更新對照

| 場景 | 舊錯誤碼 | 新錯誤碼 |
|---|---|---|
| Gateway 無法連線 | `GATEWAY_ERROR` | `GATEWAY_CONNECT_FAILED` |
| Gateway API 入口設錯（回傳 HTML） | `GATEWAY_ENTRYPOINT_ERROR` | 已消除（WS 不回傳 HTML） |
| RPC 操作失敗 | `GATEWAY_ERROR` | `GATEWAY_RPC_ERROR` |
| Token 在 RPC 中被拒 | `GATEWAY_ERROR` | `UNAUTHORIZED` |

---

### Build 結果

```
$ npm run build

> openclaw-webchat-client@0.1.0 build
> npm -w apps/api run build && npm -w apps/web run build

> @openclaw/api@0.1.0 build
> tsc
（無錯誤，TypeScript 編譯通過）

> @openclaw/web@0.1.0 build
> vue-tsc && vite build

vite v5.4.21 building for production...
✓ 36 modules transformed.
dist/index.html                   0.47 kB │ gzip:  0.30 kB
dist/assets/index-Doy0Favz.css  236.27 kB │ gzip: 33.02 kB
dist/assets/index-CWFuAr2S.js   102.05 kB │ gzip: 39.84 kB
✓ built in 1.33s
```

**結論**：TypeScript 型別檢查與 Vite 生產建置均無錯誤。

---

## 三、完整錯誤碼對照（WS/RPC 版）

| 場景 | 來源 | 錯誤碼 | HTTP 狀態 |
|---|---|---|---|
| AP server 未啟動，proxy 回傳 HTML | 前端 apiFetch | `API_NOT_AVAILABLE` | — |
| 完全無法連線（ECONNREFUSED） | 前端 apiFetch | `NETWORK_ERROR` | — |
| Token 格式錯誤（無 Header） | AP middleware | `UNAUTHORIZED` | 401 |
| Token 無效或過期（WS 握手被拒） | AP auth route | `INVALID_TOKEN` | 401 |
| Gateway 無法連線（WS 逾時/被拒） | AP 所有路由 | `GATEWAY_CONNECT_FAILED` | 502 |
| RPC 操作失敗（Gateway 回傳 error） | AP 所有路由 | `GATEWAY_RPC_ERROR` | 502 |
| Token 在 RPC 中被拒（UNAUTHORIZED） | AP 所有路由 | `UNAUTHORIZED` | 401 |
| Session 不存在（RPC NOT_FOUND） | AP messages route | `NOT_FOUND` | 404 |
| 請求格式錯誤 | AP routes | `BAD_REQUEST` | 400 |

---

---

## 第三部分：Gateway WebSocket 協議格式修正（2026-02-20）

### 問題：GET /api/sessions 時 Gateway 關閉連線 code=1008 reason=invalid request frame

**根因**：
`gateway-rpc.ts` 發送的 RPC 請求幀缺少 `type` 欄位。Gateway 協議要求請求幀必須包含 `type: "req"`，舊版格式為：

```json
{ "id": "req_xxx", "method": "sessions.list" }
```

Gateway 收到不符格式的幀後，依 RFC 6455 以 close code **1008 (Policy Violation)** 關閉連線。

---

### 修正內容（`apps/api/src/gateway-rpc.ts`）

#### 1. 請求幀格式加入 `type: "req"`

```typescript
// 修正前
{ id: "req_xxx", method: "sessions.list" }

// 修正後
{ type: "req", id: "req_xxx", method: "sessions.list" }
```

- `RpcRequest` 介面新增必填欄位 `type: 'req'`
- `request()` 方法建構 `reqMsg` 時一律帶入 `type: 'req'`

#### 2. 回應幀解析加入 `type` 篩選

```typescript
// 修正前：無 type 檢查，任何含 id 的幀均嘗試配對
if (!msg.id) return

// 修正後：只處理 type=res；type=event 或其他推播幀略過
if (msg.type !== undefined && msg.type !== 'res') return
if (!msg.id) return
```

- `RpcResponse` 介面新增選填欄位 `type?: string`
- `type=event` 的推播幀不再嘗試配對 pending request，避免誤觸或雜訊

#### 3. 不需異動項目

| 項目 | 說明 |
|---|---|
| `verifyToken` | 僅檢查 WS 握手（HTTP 101）結果，不發送 RPC 幀，無需異動 |
| 錯誤映射 | `UNAUTHORIZED` / `GATEWAY_CONNECT_FAILED` / `GATEWAY_RPC_ERROR` 三碼保持不變 |
| close code 1008 處理 | 修正後不再觸發，現有 fallback 映射至 `GATEWAY_CONNECT_FAILED` 仍正確 |
| `gateway.ts` / 路由層 | 無需異動，格式修正完全封裝在 `gateway-rpc.ts` 內 |

---

### Build 結果

```
$ npm run build

> @openclaw/api@0.1.0 build
> tsc
（無錯誤）

> @openclaw/web@0.1.0 build
> vue-tsc && vite build
✓ 36 modules transformed.
✓ built in 1.35s
```

---

---

## 第四部分：Gateway connect 握手強制排序修正（2026-02-20）

### 問題：Gateway 回覆 `invalid handshake: first request must be connect`

**根因**：
`gateway-rpc.ts` 的 `openPromise` 在 WS `open` 事件觸發時立即 resolve，導致後續 RPC（如 `sessions.list`）在 `connect` 握手之前就被送出。Gateway 協議要求 WS 建立後的**第一個請求必須是 `method: 'connect'`**，否則關閉連線。

---

### 修正內容（`apps/api/src/gateway-rpc.ts`）

#### 1. `openPromise` 延後至 connect 握手成功才 resolve

```typescript
// 修正前：WS open 即視為就緒
ws.on('open', () => {
  openResolved = true
  resolveOpen()
})

// 修正後：WS open 後先送 connect，等回應成功才 resolve
ws.on('open', () => {
  connectId = `req_${crypto.randomUUID()}`
  ws.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: {} }))
})

// message handler 中處理 connect 回應
if (msg.id === connectId) {
  if (msg.error) {
    rejectOpen(isAuthErrorCode ? UNAUTHORIZED : GATEWAY_CONNECT_FAILED)
  } else {
    connectResolved = true
    resolveOpen()   // ← 此時才標記連線可用
  }
  return
}
```

#### 2. 狀態旗標從 `openResolved` 改為 `connectResolved`

| 舊旗標 | 新旗標 | 語意 |
|---|---|---|
| `openResolved` | `connectResolved` | 連線真正可用（connect 握手已成功） |

`error` / `close` / `unexpected-response` 事件中改用 `!connectResolved` 決定是否需 `rejectOpen()`，確保：
- WS open 後、connect 回應前若連線中斷 → `openPromise` 正確 reject
- connect 成功後中斷 → `openPromise` 已 resolve，不重複 reject

#### 3. connect 失敗錯誤映射

| connect 回應錯誤碼 | 映射至 GatewayError |
|---|---|
| `UNAUTHORIZED` / `401` / `403` / `FORBIDDEN` | `UNAUTHORIZED` |
| 其他 | `GATEWAY_CONNECT_FAILED` |

#### 4. `verifyToken` 同步採用 connect 握手流程

`verifyToken` 不再以 WS `open` 視為 Token 有效，改為：
1. WS open → 送出 connect 請求
2. connect 回應成功 → `settle(true)`（Token 有效）
3. connect 回應為認證錯誤 → `settle(false)`（Token 無效）
4. connect 回應為其他錯誤 → `reject(GATEWAY_CONNECT_FAILED)`

#### 5. 連線池並發安全

`getConnection()` 呼叫 `await entry.openPromise`，由於 `openPromise` 現在在 connect 握手完成後才 resolve，所有並發的 `sessions.list` 等呼叫都會等待握手完成，不可能在 connect 之前送出。

---

### 不需異動項目

| 項目 | 說明 |
|---|---|
| `gateway.ts` / 路由層 | 無需異動，完全封裝於 `gateway-rpc.ts` |
| `GatewayError` 錯誤碼 | `UNAUTHORIZED` / `GATEWAY_CONNECT_FAILED` / `GATEWAY_RPC_ERROR` 三碼不變 |
| RPC 請求幀格式 | `{ type: 'req', id, method, params }` 格式已正確，無需修改 |

---

### Build 結果

```
$ npm run build

> @openclaw/api@0.1.0 build
> tsc
（無錯誤）

> @openclaw/web@0.1.0 build
> vue-tsc && vite build
✓ 36 modules transformed.
✓ built in 1.40s
```

---

---

## 第五部分：Gateway connect 握手 params 補齊（2026-02-20）

### 問題：Gateway 拒絕 connect，回覆 `connect params must include minProtocol, maxProtocol, client`

**根因**：
`gateway-rpc.ts` 發送的 connect 握手 params 為空物件 `{}`，Gateway 協議要求 connect params 必須包含：

```json
{
  "minProtocol": 1,
  "maxProtocol": 1,
  "client": {
    "id": "openclaw-webchat-client",
    "version": "0.1.0",
    "mode": "webchat"
  }
}
```

---

### 修正內容（`apps/api/src/gateway-rpc.ts`）

#### 1. 新增 `CONNECT_PARAMS` 常數

在 RPC 訊息格式區塊後新增，統一定義 connect 握手所需 params：

```typescript
const CONNECT_PARAMS = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: 'openclaw-webchat-client',
    version: '0.1.0',
    mode: 'webchat',
  },
} as const
```

- `minProtocol` / `maxProtocol`：指定支援的協議版本範圍（目前固定 1）
- `client.id`：本客戶端識別碼
- `client.version`：本客戶端版本號
- `client.mode`：操作模式（`webchat`）
- Auth Token 已由 WS URL query param（`?token=...`）傳遞，無需在 params 重複

#### 2. `_createConnection` connect 握手更新

```typescript
// 修正前
params: {}

// 修正後
params: CONNECT_PARAMS
```

#### 3. `verifyToken` connect 握手更新

```typescript
// 修正前
params: {}

// 修正後
params: CONNECT_PARAMS
```

`verifyToken` 使用一次性連線進行 Token 驗證，同樣必須以正確 params 完成 connect 握手，否則 Gateway 拒絕並關閉連線。

---

### 不需異動項目

| 項目 | 說明 |
|---|---|
| `gateway.ts` / 路由層 | 無需異動，完全封裝於 `gateway-rpc.ts` |
| `GatewayError` 錯誤碼 | 三碼不變 |
| 連線排序邏輯 | `openPromise` 仍在 connect 回應成功後才 resolve |
| 錯誤映射 | connect 回應中 auth 錯誤仍映射至 `UNAUTHORIZED`，其他至 `GATEWAY_CONNECT_FAILED` |

---

### Build 結果

```
$ npm run build

> @openclaw/api@0.1.0 build
> tsc
（無錯誤）

> @openclaw/web@0.1.0 build
> vue-tsc && vite build
✓ 36 modules transformed.
✓ built in 1.38s
```

---

---

## 第六部分：Gateway connect params 修正為 OpenClaw Control UI 相容格式（2026-02-20）

### 問題：Gateway 拒絕 connect，回覆 invalid connect params

**錯誤訊息**：
```
connect payload: invalid connect params:
  at /client: must have required property 'platform';
  at /client/id: must be equal to constant;
  at /client/id: must match schema anyOf
```

**根因**：
`gateway-rpc.ts` 的 `CONNECT_PARAMS` 使用的 `client.id` 為 `'openclaw-webchat-client'`，且缺少 `platform` 欄位。Gateway 驗證 schema 要求：
- `client.id` 必須等於常數 `'openclaw-control-ui'`（anyOf 之一）
- `client` 物件必須包含 `platform` 欄位

---

### 修正內容（`apps/api/src/gateway-rpc.ts`）

#### `CONNECT_PARAMS` 更新

```typescript
// 修正前
const CONNECT_PARAMS = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: 'openclaw-webchat-client',
    version: '0.1.0',
    mode: 'webchat',
  },
} as const

// 修正後
const CONNECT_PARAMS = {
  minProtocol: 3,
  maxProtocol: 3,
  client: {
    id: 'openclaw-control-ui',
    version: 'dev',
    platform: 'web',
    mode: 'webchat',
    instanceId: 'openclaw-webchat-client',
  },
} as const
```

| 欄位 | 舊值 | 新值 | 說明 |
|---|---|---|---|
| `minProtocol` | `1` | `3` | Gateway 目前要求協議版本 3 |
| `maxProtocol` | `1` | `3` | 同上 |
| `client.id` | `'openclaw-webchat-client'` | `'openclaw-control-ui'` | Gateway schema anyOf 常數要求 |
| `client.version` | `'0.1.0'` | `'dev'` | 開發版本標識 |
| `client.platform` | （無） | `'web'` | Gateway schema 必填欄位 |
| `client.mode` | `'webchat'` | `'webchat'` | 不變 |
| `client.instanceId` | （無） | `'openclaw-webchat-client'` | 本客戶端識別碼（移至此欄位） |

---

### 不需異動項目

| 項目 | 說明 |
|---|---|
| 連線順序邏輯 | `openPromise` 仍在 connect 回應成功後才 resolve |
| `verifyToken` | 同樣使用 `CONNECT_PARAMS`，自動套用修正後格式 |
| `GatewayError` 錯誤碼 | `UNAUTHORIZED` / `GATEWAY_CONNECT_FAILED` / `GATEWAY_RPC_ERROR` 三碼不變 |
| `gateway.ts` / 路由層 | 無需異動，完全封裝於 `gateway-rpc.ts` |

---

### Build 結果

```
$ npm run build

> @openclaw/api@0.1.0 build
> tsc
（無錯誤）

> @openclaw/web@0.1.0 build
> vue-tsc && vite build
✓ 36 modules transformed.
✓ built in 1.41s
```

---

## 七、後續建議

1. **依 Gateway 實際規格調整 RPC 方法名稱**：`session-manager.ts` 中的 `sessions.list`、`chat.send` 等為預設值，需依 OpenClaw Gateway 實際文件確認。

2. **WS 心跳（ping/pong）**：已實作（`rpc-client.ts` 每 30 秒發送 ping，pong handler 記錄存活時間）。

3. **連線池監控**：可在 `GET /health` 回應中加入 WS 連線池狀態（連線數、存活時間）。

4. **生產環境 TLS**：`GATEWAY_WS_URL` 改用 `wss://` 並設 `TLS_VERIFY=true`，移除 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

---

## 第七部分：Close / Archive Session 功能新增（2026-02-20）

### 功能需求
使用者可在 Session 列表對每個 Session 執行「封存」或「關閉（永久刪除）」操作。

### 修改摘要

#### 規劃文件
| 檔案 | 變更內容 |
|---|---|
| `docs/specs/spec.md` | 新增延伸功能 2.3（Close/Archive）與驗收條件 9~13 |
| `docs/specs/plan.md` | 新增階段 4（Close/Archive 實作計畫） |
| `docs/specs/data-model.md` | `ChatSession` 新增 `archived?` 欄位；新增兩個端點說明 |
| `docs/specs/tasks.md` | 新增 T6 任務清單 |

#### AP 端變更
| 檔案 | 變更內容 |
|---|---|
| `apps/api/src/session-manager.ts` | 新增 `archiveSet` in-memory 封存狀態；新增 `archive()` / `unarchive()` / `close()` 方法；修改 `list()` 附加 `archived` 欄位 |
| `apps/api/src/gateway.ts` | 新增 `archiveSession()` / `closeSession()` 包裝函式 |
| `apps/api/src/routes/sessions.ts` | 新增 `PATCH /:sessionKey`（封存）、`DELETE /:sessionKey`（關閉）路由 |

#### Web 端變更
| 檔案 | 變更內容 |
|---|---|
| `apps/web/src/types.ts` | `ChatSession` 新增 `archived?: boolean` |
| `apps/web/src/api/client.ts` | 新增 `archiveSession()` / `closeSession()` API 呼叫 |
| `apps/web/src/stores/sessions.ts` | 新增 `showArchived`、`archivingSessionKey`、`closingSessionKey`、`archiveError`、`closeError` 狀態；新增 `archiveSession()`、`closeSession()`、`toggleShowArchived()` action；新增 `visibleSessions` computed |
| `apps/web/src/views/ChatView.vue` | 每列加入「封存」「關閉」按鈕（hover 顯示，含 window.confirm）；新增「顯示/隱藏封存」切換；封存項目加上標籤與 opacity 區分 |

### Archive Fallback 說明
Gateway 無原生 archive RPC，AP 端以 in-memory Set 實作：
- **限制**：AP 重啟後封存狀態重置
- **關閉操作**：仍正確呼叫 Gateway `sessions.delete` RPC，永久刪除 Session
- **升級路徑**：若 Gateway 日後支援 archive，只需修改 `SessionManager.archive()` 方法

### Build 結果
```
$ npm run build
> @openclaw/api@0.1.0 build > tsc  （無錯誤）
> @openclaw/web@0.1.0 build > vue-tsc && vite build
✓ 38 modules transformed.
dist/assets/index-*.css  237.85 kB │ gzip: 33.43 kB
dist/assets/index-*.js   105.77 kB │ gzip: 41.08 kB
✓ built in 1.40s
```

---

---

## 第八部分：WS Push / SSE 串流 / Token 過期 / 心跳保活（2026-02-20 v2）

### 功能背景

前一版本（第七部分）完成 Close/Archive Session 功能後，訊息仍以「送出 → 等待 → polling」模式運作：前端每隔 2 秒輪詢一次直到 AI 回覆出現（最長等待 30 秒）。本次（v2）新增以下能力：

1. **WS Server Push / SSE 串流**：Gateway 透過 WebSocket event 主動推播 AI 回覆 chunk，AP 以 SSE 即時轉發至瀏覽器，使用者可看到文字逐字出現
2. **Token 過期自動偵測與重新登入**：任何 API 回傳 `UNAUTHORIZED` 時，前端自動清除登入狀態並導向登入頁，顯示「登入已過期」提示
3. **心跳保活（pong handler）**：`rpc-client.ts` 已有 30 秒 ping，本次補齊 pong handler 記錄最後存活時間
4. **SSE → polling 降級**：當 SSE 端點不可用或中途失敗時，自動降級至原有 REST + polling 流程，確保功能不中斷

---

### 修改摘要

#### 規劃文件

| 檔案 | 變更內容 |
|---|---|
| `docs/specs/spec.md` | 新增 §2.4（WS Push 串流）、§4.1~§4.4（SSE 流程 / 降級 / Token 過期 / 心跳）；新增驗收條件 14~17 |
| `docs/specs/plan.md` | 新增階段 5（WS Server Push / SSE / Token 過期 / 心跳）及詳細子任務清單 |
| `docs/specs/data-model.md` | `GatewayConnectionConfig` 新增 `streamingEnabled`；新增 §7 SSE 事件型別、§8 Gateway 串流事件、§9 前端串流狀態、§10 `unauthorizedState` |
| `docs/specs/tasks.md` | 新增 T7 任務群組（T7.1 文件、T7.2 AP、T7.3 Web、T7.4 驗收、T7.5 報告） |

#### AP 端變更

| 檔案 | 變更內容 |
|---|---|
| `apps/api/src/rpc-client.ts` | 新增 `subscribeEvent(name, callback)` 方法（per-name 事件訂閱）；新增 `_dispatchEvent()` 內部分發；新增 `_lastPongAt` 欄位與 `lastPongAt` getter；補齊 `ws.on('pong', ...)` handler |
| `apps/api/src/gateway-rpc.ts` | 新增 `GatewayStreamEvent` 型別；新增 `async *sendStream()` async generator（訂閱 `chat.stream` 事件，逐 chunk yield，completion 時 yield `done`） |
| `apps/api/src/session-manager.ts` | 新增 `async *sendStream()` 委派至 `gatewayRpc.sendStream()`；re-export `GatewayStreamEvent` |
| `apps/api/src/routes/messages.ts` | 新增 `POST /stream` SSE 端點（使用 `hono/streaming` 的 `streamSSE`）；提取 `parseMessageFormData()` 共用函式；更新 import 至 `session-manager` |
| `apps/api/src/config.ts` | 新增 `streamingEnabled`（預設 `true`，可由 `STREAMING_ENABLED=false` 停用） |
| `apps/api/src/index.ts` | CORS `allowMethods` 補齊 `PATCH`（之前遺漏，封存 endpoint 需要）；啟動日誌顯示串流啟用狀態 |

#### Web 端變更

| 檔案 | 變更內容 |
|---|---|
| `apps/web/src/api/client.ts` | 新增 `unauthorizedState` reactive 物件；`apiFetch` 在解析 JSON 後偵測 `UNAUTHORIZED` 並設旗標；新增 `SseEvent` 型別；新增 `async *streamMessage()` async generator（fetch + ReadableStream SSE 解析） |
| `apps/web/src/stores/sessions.ts` | 新增串流狀態（`streamingSessionKey`、`streamingText`、`streamingError`）；`sendMessage()` 改為 SSE 優先 + polling 降級；`selectSession()` / `reset()` 清除串流狀態；re-export `unauthorizedState` |
| `apps/web/src/views/ChatView.vue` | 新增串流氣泡（`v-if="isStreaming"`，含閃爍游標 CSS animation）；新增 `watch(unauthorizedState.triggered)` 觸發自動登出 + 導向；新增 `watch(streamingText)` 自動捲動 |
| `apps/web/src/views/LoginView.vue` | 新增 `sessionExpired` computed；新增「登入已過期」警示橫幅（`reason=session_expired` query 時顯示） |

---

### 核心設計說明

#### 1. Gateway 串流事件訂閱（AP 端）

`rpc-client.ts` 的 `subscribeEvent(name, callback)` 提供 per-name 事件訂閱，支援萬用字元 `'*'`：

```typescript
// 訂閱所有 chat.stream / chat.chunk 事件
const unsubscribe = client.subscribeEvent('*', (event) => {
  if (event.name !== 'chat.stream' && event.name !== 'chat.chunk') return
  // 過濾 sessionKey，只處理當前 session 的 chunk
  buffer.push({ type: 'chunk', text: event.data.chunk ?? event.data.text })
  notify() // 喚醒 async generator
})
```

`gateway-rpc.ts` 的 `sendStream()` 以 producer-consumer 模式實作：
- **Producer**：事件 callback 將 chunk 推入 buffer，呼叫 `notify()` 喚醒 generator
- **Consumer**：async generator 逐一 yield buffer 中的事件，無事件時等待 Promise
- **Completion**：`request()` resolve 時 push `done` 事件，generator 結束後 `unsubscribe()`

#### 2. SSE 端點（AP → Web）

`POST /api/sessions/:sessionKey/messages/stream` 以 `text/event-stream` 推播：

```
data: {"type":"status","status":"sending"}
data: {"type":"chunk","text":"你好"}
data: {"type":"chunk","text":"，有什麼"}
data: {"type":"chunk","text":"可以幫你？"}
data: {"type":"done","accepted":true}
```

失敗時推播：

```
data: {"type":"error","code":"GATEWAY_RPC_ERROR","message":"..."}
```

#### 3. 前端 SSE 解析（fetch + ReadableStream）

`EventSource` 不支援 POST，因此 `streamMessage()` 改用 `fetch()` 搭配 `ReadableStream`：

```typescript
const resp = await fetch(`${BASE}/sessions/${key}/messages/stream`, {
  method: 'POST', body: formData, headers: { Authorization: `Bearer ${token}` },
})
const reader = resp.body.getReader()
// 逐 chunk 讀取，以 \n\n 切割 SSE 事件，解析 data: {...} 行
```

UNAUTHORIZED 偵測：HTTP 401 回應或 stream 中 `type=error, code=UNAUTHORIZED` 均觸發 `unauthorizedState.triggered = true`。

#### 4. SSE → Polling 降級策略

| 情況 | 行為 |
|---|---|
| SSE 成功（收到 `done`） | 直接 reload 訊息，不 polling |
| SSE 失敗（網路錯誤、503 等） | 靜默降級至 REST `sendMessage()` + polling |
| SSE 中途收到 `UNAUTHORIZED` | **不降級**，直接觸發登出流程 |
| `STREAMING_ENABLED=false` | AP 回傳 503，前端降級 |

#### 5. Token 過期自動登出

```typescript
// stores/sessions.ts 對外暴露
export { unauthorizedState } from '../api/client'

// ChatView.vue 監聽
watch(() => store.unauthorizedState.triggered, (val) => {
  if (!val) return
  authStore.logout()
  store.reset()
  router.push({ name: 'login', query: { reason: 'session_expired' } })
})
```

#### 6. 心跳保活（pong handler）

```typescript
// rpc-client.ts
private _lastPongAt = 0
get lastPongAt(): number { return this._lastPongAt }

// WS open 後
ws.on('pong', () => { this._lastPongAt = Date.now() })
```

現有 30 秒 ping 定時器搭配此 pong handler，可在日後監控端點（`/health`）中暴露連線存活狀態。

---

### Build 結果

```
$ npm run build

> @openclaw/api@0.1.0 build
> tsc
（無錯誤）

> @openclaw/web@0.1.0 build
> vue-tsc && vite build
✓ 38 modules transformed.
dist/assets/index-*.js   109.32 kB │ gzip: 42.23 kB
✓ built in 1.55s
```

**結論**：TypeScript 型別檢查與 Vite 生產建置均無錯誤。

---

---

## 第九部分：Session 標題內聯編輯與 `sessions.patch` RPC 發現（2026-02-21）

### 問題：`sessions.update` RPC 不存在

**錯誤訊息**：
```
[sessions/patch] Gateway 錯誤: GatewayError: unknown method: sessions.update
```

**根因**：
初始實作假設 Gateway 提供 `sessions.update` RPC 方法來更新 session metadata（label），
但 Gateway 回覆 `unknown method`。查閱 OpenClaw Control UI（Dashboard）文件後發現，
Dashboard 使用的是 `sessions.patch`（非 `sessions.update`）來修改 session label。

---

### 修正歷程

#### 階段 1：嘗試 `sessions.update`（失敗）
```typescript
// session-manager.ts — 初始版本
await gatewayRpc.request(token, 'sessions.update', { key: sessionKey, label: title })
// → Gateway 回覆：unknown method: sessions.update
```

#### 階段 2：AP in-memory fallback（臨時方案）
Gateway RPC 失敗後，暫時改為 AP 端 in-memory 標題覆寫（與 archive 相同策略）。
此方案標題僅存於 AP 記憶體，AP 重啟後重置。

#### 階段 3：發現 `sessions.patch`（最終方案）
查閱 Control UI 文件，確認 Dashboard 使用 `sessions.patch` RPC：
```typescript
// session-manager.ts — 最終版本
await gatewayRpc.request(token, 'sessions.patch', { key: sessionKey, label: title })
// → 成功，200 OK，63ms
```

移除 in-memory fallback，標題現在持久化儲存於 Gateway。

---

### 變更檔案

| 檔案 | 變更內容 |
|---|---|
| `apps/api/src/session-manager.ts` | 新增 `rename()` 方法，呼叫 `sessions.patch` RPC |
| `apps/api/src/gateway.ts` | 新增 `renameSession()` facade |
| `apps/api/src/routes/sessions.ts` | 擴充 PATCH 路由支援 `{ title }` 欄位 |
| `apps/web/src/api/client.ts` | 新增 `renameSession()` |
| `apps/web/src/stores/sessions.ts` | 新增 `renameSession()` action |
| `apps/web/src/views/ChatView.vue` | 新增 ✎ 內聯編輯按鈕與 UI |

### RPC 方法完整清單（更新後）

| 操作 | RPC method | params |
|---|---|---|
| 取得清單 | `sessions.list` | — |
| 建立 Session | `sessions.reset` | `{ key }` |
| 更新 Session metadata | `sessions.patch` | `{ key, label }` |
| 刪除 Session | `sessions.delete` | `{ key }` |
| 批次刪除 | `sessions.deleteMany` | `{ keys }` |

### Build 結果
```
$ npm run build
> @openclaw/api@0.1.0 build > tsc  （無錯誤）
> @openclaw/web@0.1.0 build > vue-tsc && vite build
✓ 39 modules transformed.
✓ built in 4.34s
```
