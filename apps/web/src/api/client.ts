import type { ApiResponse, ChatSession, ChatMessage, PendingImage } from '../types'
import { reactive } from 'vue'

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
 * 全域 UNAUTHORIZED 通知狀態。
 * 當任何 API 請求收到 401 UNAUTHORIZED 時，triggered 設為 true。
 * ChatView 透過 watch 監聽此狀態，自動執行登出與重導。
 */
export const unauthorizedState = reactive({ triggered: false })

/** 基礎 fetch 包裝（自動帶入 Token，並偵測 UNAUTHORIZED） */
async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (!(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  try {
    const resp = await fetch(path, { ...init, headers })

    // 確認回應確實是 JSON；若非 JSON（例如 Vite proxy 回傳 HTML 502 頁面），
    // 直接以可讀錯誤碼返回，避免 resp.json() 丟出 SyntaxError: Unexpected token '<'
    const ct = resp.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) {
      console.warn('[apiFetch] 非 JSON 回應 (Content-Type:', ct, ') status:', resp.status, 'path:', path)
      return {
        ok: false,
        error: {
          code: 'API_NOT_AVAILABLE',
          message: 'API 服務未回應（收到非 JSON 格式），請確認後端服務是否正常運行',
        },
      }
    }

    const data = await resp.json()
    const result = data as ApiResponse<T>

    // ── UNAUTHORIZED 偵測 ──────────────────────────────────────────────
    // 任何 API 回傳 401 UNAUTHORIZED 時，觸發全域通知（Token 過期）
    if (!result.ok && result.error?.code === 'UNAUTHORIZED') {
      console.warn('[apiFetch] Token 過期或無效，觸發自動登出')
      unauthorizedState.triggered = true
    }

    return result
  } catch (err) {
    // fetch 本身拋出表示網路完全不通（ECONNREFUSED 等）
    console.error('[apiFetch] 請求失敗:', err)
    return {
      ok: false,
      error: { code: 'NETWORK_ERROR', message: '網路連線失敗，請稍後再試' },
    }
  }
}

/** 驗證 Token */
export async function verifyToken(token: string): Promise<ApiResponse<{ verified: true }>> {
  return apiFetch('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ token }),
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 取得 Session 清單 */
export async function fetchSessions(): Promise<ApiResponse<ChatSession[]>> {
  return apiFetch<ChatSession[]>('/api/sessions')
}

/** 建立新 Session */
export async function createSession(title?: string): Promise<ApiResponse<ChatSession>> {
  return apiFetch<ChatSession>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

/** 取得指定 Session 的訊息清單 */
export async function fetchMessages(sessionKey: string): Promise<ApiResponse<ChatMessage[]>> {
  return apiFetch<ChatMessage[]>(`/api/sessions/${encodeURIComponent(sessionKey)}/messages`)
}

/** 封存或取消封存 Session */
export async function archiveSession(
  sessionKey: string,
  archived: boolean,
): Promise<ApiResponse<{ archived: boolean; sessionKey: string }>> {
  return apiFetch(`/api/sessions/${encodeURIComponent(sessionKey)}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  })
}

/** 重新命名 Session 標題 */
export async function renameSession(
  sessionKey: string,
  title: string,
): Promise<ApiResponse<{ sessionKey: string; title: string }>> {
  return apiFetch(`/api/sessions/${encodeURIComponent(sessionKey)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

/** 關閉（刪除）Session */
export async function closeSession(
  sessionKey: string,
): Promise<ApiResponse<{ closed: boolean; sessionKey: string }>> {
  return apiFetch(`/api/sessions/${encodeURIComponent(sessionKey)}`, {
    method: 'DELETE',
  })
}

/** 發送文字 + 圖片訊息（REST 阻塞版，fallback 用） */
export async function sendMessage(
  sessionKey: string,
  text: string,
  images: PendingImage[],
): Promise<ApiResponse<{ accepted: true }>> {
  const form = new FormData()
  form.append('text', text)
  for (const img of images) {
    form.append('images[]', img.file, img.name)
  }
  return apiFetch<{ accepted: true }>(
    `/api/sessions/${encodeURIComponent(sessionKey)}/messages`,
    { method: 'POST', body: form },
  )
}

// ── SSE 串流事件型別 ──────────────────────────────────────────────────────────

/** AP 推播的 SSE 事件 */
export type SseEvent =
  | { type: 'status'; status: string }
  | { type: 'chunk'; text: string }
  | { type: 'done'; accepted: boolean }
  | { type: 'error'; code: string; message: string }

/**
 * 以 SSE 串流方式發送訊息，逐步 yield 事件。
 *
 * 使用 fetch + ReadableStream 讀取 text/event-stream 回應。
 * 若端點不可用（503 / 網路錯誤），呼叫端應降級至 sendMessage()。
 *
 * @throws 不拋出例外；錯誤以 { type: 'error', ... } 事件 yield
 */
export async function* streamMessage(
  sessionKey: string,
  text: string,
  images: PendingImage[],
): AsyncGenerator<SseEvent> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const form = new FormData()
  form.append('text', text)
  for (const img of images) {
    form.append('images[]', img.file, img.name)
  }

  let resp: Response
  try {
    resp = await fetch(
      `/api/sessions/${encodeURIComponent(sessionKey)}/messages/stream`,
      { method: 'POST', body: form, headers },
    )
  } catch (err) {
    // 網路錯誤（ECONNREFUSED 等）
    console.warn('[streamMessage] 網路錯誤，將 fallback:', err)
    yield { type: 'error', code: 'NETWORK_ERROR', message: '網路連線失敗' }
    return
  }

  // 非成功回應 → 觸發 fallback
  if (!resp.ok) {
    console.warn('[streamMessage] 串流端點回傳', resp.status, '，將 fallback')

    // 偵測 UNAUTHORIZED（即使是串流端點也需要處理）
    if (resp.status === 401) {
      unauthorizedState.triggered = true
      yield { type: 'error', code: 'UNAUTHORIZED', message: 'Token 已失效，請重新登入' }
      return
    }

    yield {
      type: 'error',
      code: 'STREAMING_UNAVAILABLE',
      message: `串流端點不可用（HTTP ${resp.status}）`,
    }
    return
  }

  const contentType = resp.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    console.warn('[streamMessage] 回應非 text/event-stream:', contentType, '，將 fallback')
    yield { type: 'error', code: 'STREAMING_UNAVAILABLE', message: '回應格式不符（非 SSE）' }
    return
  }

  if (!resp.body) {
    yield { type: 'error', code: 'STREAMING_UNAVAILABLE', message: '回應無 body' }
    return
  }

  // 串流通道已建立（即使後續沒有 chunk，也不應立即重送 REST）
  yield { type: 'status', status: 'stream-open' }

  // ── 讀取 SSE 串流 ─────────────────────────────────────────────────────────
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const parseBlock = (block: string): SseEvent[] => {
    const events: SseEvent[] = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trimEnd()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const event = JSON.parse(payload) as SseEvent
        if (event.type === 'error' && event.code === 'UNAUTHORIZED') {
          unauthorizedState.triggered = true
        }
        events.push(event)
      } catch {
        // ignore non-json payloads
      }
    }
    return events
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      // 相容 CRLF / LF
      const normalized = buffer.replace(/\r\n/g, '\n')

      // SSE 事件以空行分隔
      const blocks = normalized.split('\n\n')
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        for (const event of parseBlock(block)) {
          yield event
        }
      }
    }

    // flush 最後殘留 block（有些 server 結尾不一定補空行）
    if (buffer.trim()) {
      for (const event of parseBlock(buffer.replace(/\r\n/g, '\n'))) {
        yield event
      }
    }
  } catch (err) {
    console.warn('[streamMessage] 讀取串流失敗:', err)
    yield { type: 'error', code: 'STREAM_READ_ERROR', message: '串流讀取中斷' }
  } finally {
    reader.cancel().catch(() => {})
  }
}
