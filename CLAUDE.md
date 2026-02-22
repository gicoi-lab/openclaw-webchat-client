# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenClaw Webchat Client — a monorepo web chat application that connects to an **OpenClaw Gateway** via WebSocket RPC. Users authenticate with a Gateway token, then create/manage chat sessions and exchange messages with an AI assistant.

## Commands

```bash
# Install dependencies (npm workspaces)
npm install

# Development (run in separate terminals)
npm run dev:api    # API server at http://localhost:3000 (tsx watch)
npm run dev:web    # Vue dev server at http://localhost:5174 (Vite)

# Build
npm run build          # Build both apps
npm run build:api      # API only (tsc)
npm run build:web      # Web only (vue-tsc && vite build)

# Start production API
npm run start:api      # node dist/index.js
```

No test framework is configured. No linter is configured.

## Architecture

### Monorepo Structure (npm workspaces)

- **`apps/api`** — Node.js backend (Hono + @hono/node-server). Acts as a **BFF (Backend for Frontend)** layer between the Vue frontend and the OpenClaw Gateway.
- **`apps/web`** — Vue 3 + Bootstrap 5 + Vite frontend. Communicates exclusively with the API server (Vite proxy forwards `/api` and `/health` to `localhost:3000` in dev).

### API Server (`apps/api`) — Key Modules

The API server maintains a **persistent WebSocket connection pool** to the Gateway per token:

- **`rpc-client.ts`** — Low-level WebSocket RPC client. Manages a single WS connection: JSON-RPC req/res, heartbeat (ping/pong), auto-reconnect, `subscribeEvent()` for streaming events.
- **`gateway-rpc.ts`** — Connection pool manager (`GatewayRpcClientManager`). Keyed by token, TTL 5min. Provides `request()`, `sendStream()` (AsyncGenerator yielding chunks), `verifyToken()`. Exported as singleton `gatewayRpc`.
- **`session-manager.ts`** — Business logic layer (`SessionManager`). Wraps Gateway RPC calls for session CRUD + message operations. Maintains in-memory session cache and archive state (archive is AP-side only, not persisted in Gateway). Exported as singleton `sessionManager`.
- **`gateway.ts`** — Backward-compatible facade re-exporting `sessionManager` functions. Used by `routes/auth.ts` and `routes/sessions.ts`.
- **`config.ts`** — All config from env vars (reads `.env` from CWD, parent, and grandparent dirs).

**Routes:** `/health`, `/api/auth/verify`, `/api/sessions` (CRUD + PATCH archive + DELETE close), `/api/sessions/:sessionKey/messages` (GET history, POST send, POST stream SSE).

### Web Frontend (`apps/web`) — Key Modules

- **`api/client.ts`** — API client wrapping `fetch()` with auth header injection and global UNAUTHORIZED detection (`unauthorizedState`). Includes `streamMessage()` AsyncGenerator for SSE consumption.
- **`stores/sessions.ts`** — Reactive state store (plain `reactive()`, no Pinia). Manages sessions list, messages, streaming state. Message sending strategy: **SSE stream first → REST + polling fallback** if stream unavailable.
- **`views/ChatView.vue`** — Main chat UI: sidebar (session list with archive/close), message area with streaming bubble, MessageInput component.
- **`views/LoginView.vue`** — Token-based login (no username/password, just Gateway token).

### Communication Flow

```
Browser ←→ Vite Proxy ←→ Hono API (BFF) ←→ [WS RPC] ←→ OpenClaw Gateway
```

Message sending supports two modes:
1. **SSE streaming** — `POST /messages/stream` → API subscribes to Gateway `chat.stream`/`chat.chunk` events → forwards as SSE → frontend renders chunks in real-time
2. **REST + polling fallback** — `POST /messages` (blocking) → frontend polls `GET /messages` until assistant reply appears

### Key Patterns

- **Gateway protocol**: WS connect handshake requires `minProtocol/maxProtocol: 3`, role `operator`, specific scopes, and `auth.token`. Client identifies as `openclaw-control-ui`.
- **Error handling**: All Gateway errors are typed as `GatewayError` with codes `GATEWAY_CONNECT_FAILED`, `GATEWAY_RPC_ERROR`, `UNAUTHORIZED`. Routes map these to HTTP 401/502.
- **API response format**: `{ ok: boolean, data?: T, error?: { code, message } }` — helper functions `ok()` and `fail()` in `types.ts`.
- **Auth**: Token stored in `localStorage` under key `auth`. Passed as `Bearer` header. Middleware `requireToken` checks header presence only (no Gateway call per request).
- **TypeScript**: API uses `NodeNext` module resolution (`.js` extensions in imports). Web uses Vite/Vue defaults.

## Environment Variables

See `.env.example`. Key vars: `GATEWAY_WS_URL`, `API_PORT` (default 3000), `TLS_VERIFY` (false for self-signed certs), `CORS_ORIGINS`, `STREAMING_ENABLED`.

## Project Documentation (`docs/`)

Design specs, task tracking, and reports live in `docs/specs/`:

- **`spec.md`** — Product specification (MVP scope, acceptance criteria, architecture flows for SSE/fallback/token expiry/heartbeat)
- **`plan.md`** — Phased development plan (stages 0–7)
- **`tasks.md`** — Task breakdown with checkbox status (T0–T9; T0–T9 all completed)
- **`data-model.md`** — TypeScript interface definitions, SSE event formats, API endpoint contracts
- **`implementation-report.md`** — Detailed implementation notes per feature phase
- **`fix-report.md`** — Chronological bug fix log (9 parts covering WS protocol iterations + sessions.patch discovery)
- **`uat-checklist.md`** — Manual UAT test template

**When making significant changes**, update the relevant docs (especially `tasks.md` for progress tracking, and `implementation-report.md` / `fix-report.md` for technical details).

### Current Project Status

- **Completed (T0–T9):** WS/RPC adapter, all routes, Vue frontend, session CRUD, archive/close, SSE streaming with polling fallback, token expiry auto-logout, heartbeat, Gateway native WS push, session title inline editing (via `sessions.patch` RPC)

### Known Limitations

- **Archive 狀態不持久**: 封存狀態存於 AP in-memory，AP 重啟後重置（Gateway 無原生 archive RPC）
- **Gateway 串流事件格式為推測值**: `chat.stream` / `chat.chunk` 事件名稱與 data 結構需依 Gateway 實際規格調整
- **圖片以 base64 傳送**: 若 Gateway 期待二進位 WS frame，需調整 `rpc-client.ts`
- **SSE 串流前端無法中途取消**: 連線建立後需等 done 或 error 才結束

## Language

This project's UI, comments, and documentation are in **Traditional Chinese (繁體中文)**.

## Development Guidelines

### Code Comments and Documentation

**註解及說明請使用『繁體中文』**

All code comments, documentation strings, and inline explanations should be written in Traditional Chinese (繁體中文). This ensures consistency across the codebase and makes it easier for the development team to maintain and understand the code.

### Work Documentation

After completing significant development work, always update the Claude AI work log in `docs/CLAUDE.LOG/YYYYMM.md` with:
- Project overview and objectives
- Technical implementation details
- Files created/modified
- Problems solved and solutions applied
- Integration points and system impacts
- User experience improvements

**撰寫原則：**
- 日誌應以摘要方式敘述，著重於「設計邏輯」與「變更原因」
- 避免逐行描述程式碼細節，讀者可自行查閱原始碼
- 記錄「為什麼這樣做」比「做了什麼」更重要

This ensures proper documentation of system evolution and helps maintain development history for future reference.

### Screenshot Management

Screenshots should be stored in the designated directory with standardized naming:
- **Default Path:** `docs/screenshot/`
- **Naming Convention:** `Screenshot from YYYY-MM-DD HH-MM-SS.png`
- **Example:** `Screenshot from 2025-08-28 00-59-21.png`

Screenshots are valuable for documenting UI changes, debugging issues, and providing visual context in work logs.
