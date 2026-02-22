/**
 * 持久 SSE 消費模組
 *
 * 使用 fetch + ReadableStream 連線至 GET /api/events，
 * 持續接收 Gateway 推播事件（chunk、message-final、keepalive 等）。
 *
 * 特性：
 * - 因 EventSource 不支援自訂 Authorization header，改用 fetch
 * - 斷線時自動重連（指數退避，最長 30 秒）
 * - 回傳 disconnect 函式供登出時呼叫
 */

import { unauthorizedState } from './client'

// ── 推播事件型別（與 AP 端 PushEvent 對應） ──────────────────────────────────

export type PushEvent =
  | { type: 'agent-start'; sessionKey: string; runId?: string }
  | { type: 'chunk'; sessionKey: string; text: string }
  | { type: 'agent-end'; sessionKey: string; runId?: string }
  | { type: 'message-final'; sessionKey: string; message: unknown }
  | { type: 'keepalive'; ts: number }

// ── 重連參數 ─────────────────────────────────────────────────────────────────

const INITIAL_RETRY_MS = 1000
const MAX_RETRY_MS = 30_000
const RETRY_MULTIPLIER = 2

/** 從 localStorage 取得 Token */
function getToken(): string | null {
  try {
    const raw = localStorage.getItem('auth')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.token ?? null
  } catch {
    return null
  }
}

/**
 * 建立持久 SSE 連線並消費事件。
 *
 * @param onEvent 收到事件時的回調
 * @param onConnected 連線狀態變化回調
 * @returns disconnect 函式（登出時呼叫）
 */
export function connectEventStream(
  onEvent: (event: PushEvent) => void,
  onConnected?: (connected: boolean) => void,
): () => void {
  let aborted = false
  let retryMs = INITIAL_RETRY_MS
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null

  async function connect() {
    if (aborted) return

    const token = getToken()
    if (!token) {
      console.warn('[event-source] 無 token，不建立 SSE 連線')
      onConnected?.(false)
      return
    }

    try {
      const resp = await fetch('/api/events', {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!resp.ok) {
        if (resp.status === 401) {
          console.warn('[event-source] Token 無效（401），觸發登出')
          unauthorizedState.triggered = true
          onConnected?.(false)
          return // 不重連
        }
        throw new Error(`SSE 端點回傳 HTTP ${resp.status}`)
      }

      if (!resp.body) {
        throw new Error('SSE 回應無 body')
      }

      // 連線成功：重置退避
      retryMs = INITIAL_RETRY_MS
      onConnected?.(true)
      console.log('[event-source] 持久 SSE 已連線')

      // ── 讀取串流 ──────────────────────────────────────────────────────
      const reader = resp.body.getReader()
      currentReader = reader
      const decoder = new TextDecoder()
      let buffer = ''

      while (!aborted) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const normalized = buffer.replace(/\r\n/g, '\n')

        // SSE 事件以空行分隔
        const blocks = normalized.split('\n\n')
        buffer = blocks.pop() ?? ''

        for (const block of blocks) {
          parseSseBlock(block, onEvent)
        }
      }

      // flush 殘留
      if (buffer.trim()) {
        parseSseBlock(buffer.replace(/\r\n/g, '\n'), onEvent)
      }
    } catch (err) {
      if (aborted) return
      console.warn('[event-source] 連線錯誤，將重連:', err)
    }

    // 斷線：通知狀態並安排重連
    currentReader = null
    if (!aborted) {
      onConnected?.(false)
      scheduleRetry()
    }
  }

  function scheduleRetry() {
    if (aborted) return
    console.log(`[event-source] ${retryMs}ms 後重連…`)
    retryTimer = setTimeout(() => {
      retryMs = Math.min(retryMs * RETRY_MULTIPLIER, MAX_RETRY_MS)
      connect()
    }, retryMs)
  }

  function parseSseBlock(block: string, cb: (event: PushEvent) => void) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trimEnd()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const event = JSON.parse(payload) as PushEvent
        // 檢查 UNAUTHORIZED
        if ((event as any).code === 'UNAUTHORIZED') {
          unauthorizedState.triggered = true
          return
        }
        cb(event)
      } catch {
        // 忽略非 JSON payload
      }
    }
  }

  // 啟動連線
  connect()

  // 回傳 disconnect 函式
  return () => {
    aborted = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (currentReader) {
      currentReader.cancel().catch(() => {})
      currentReader = null
    }
    onConnected?.(false)
    console.log('[event-source] 持久 SSE 已手動斷開')
  }
}
