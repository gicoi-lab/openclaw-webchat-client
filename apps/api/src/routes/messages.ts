import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireToken, extractToken } from '../middleware/auth.js'
import { sessionManager, GatewayError } from '../session-manager.js'
import { ok, fail } from '../types.js'
import { config } from '../config.js'

const messages = new Hono()

/** 將 GatewayError 轉換為 HTTP 回應（messages 路由共用邏輯） */
function handleGatewayError(err: unknown, label: string, fallbackMsg: string) {
  console.error(`[${label}] Gateway 錯誤:`, err)
  if (err instanceof GatewayError) {
    if (err.code === 'UNAUTHORIZED') {
      return { status: 401 as const, body: fail('UNAUTHORIZED', 'Token 已失效，請重新登入') }
    }
    if (err.code === 'GATEWAY_CONNECT_FAILED') {
      return { status: 502 as const, body: fail('GATEWAY_CONNECT_FAILED', `無法連線至 Gateway：${err.message}`) }
    }
    // GATEWAY_RPC_ERROR（含 NOT_FOUND 等 Gateway 業務錯誤）
    const details = err.details as { code?: string } | undefined
    if (details?.code === 'NOT_FOUND') {
      return { status: 404 as const, body: fail('NOT_FOUND', '找不到指定的 Session') }
    }
    return { status: 502 as const, body: fail('GATEWAY_RPC_ERROR', err.message) }
  }
  return { status: 502 as const, body: fail('GATEWAY_RPC_ERROR', fallbackMsg) }
}

/**
 * 解析 multipart/form-data 並轉換圖片為 Uint8Array。
 * 回傳 { text, images } 或 { error } 供呼叫者處理。
 */
async function parseMessageFormData(c: any): Promise<
  | { text: string; images: Array<{ name: string; data: Uint8Array; mimeType: string }> }
  | { error: Response }
> {
  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return { error: c.json(fail('BAD_REQUEST', '請求格式錯誤，需為 multipart/form-data'), 400) }
  }

  const text = (formData.get('text') as string | null) ?? ''
  const imageFiles = formData.getAll('images[]') as File[]

  if (imageFiles.length > 10) {
    return { error: c.json(fail('BAD_REQUEST', '圖片數量超過上限（最多 10 張）'), 400) }
  }

  const MAX_SIZE = 10 * 1024 * 1024
  for (const file of imageFiles) {
    if (file.size > MAX_SIZE) {
      return {
        error: c.json(
          fail('BAD_REQUEST', `圖片「${file.name}」超過單張大小限制（10MB）`),
          400,
        ),
      }
    }
  }

  const images = await Promise.all(
    imageFiles.map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      data: new Uint8Array(await file.arrayBuffer()),
    })),
  )

  return { text, images }
}

/**
 * GET /api/sessions/:sessionKey/messages
 * 取得指定 Session 的訊息清單
 */
messages.get('/', requireToken, async (c) => {
  const token = extractToken(c) as string
  const sessionKey = c.req.param('sessionKey')
  try {
    const data = await sessionManager.history(token, sessionKey)
    return c.json(ok(data))
  } catch (err: unknown) {
    const { status, body } = handleGatewayError(err, 'messages/list', '訊息清單取得失敗')
    return c.json(body, status)
  }
})

/**
 * POST /api/sessions/:sessionKey/messages
 * 發送文字與圖片訊息（multipart/form-data，阻塞版）
 * - 欄位 text：文字內容（可多行）
 * - 欄位 images[]：0~10 張圖片（各最大 10MB）
 * - 此 endpoint 阻塞直到 AI 回覆完成，前端收到 { accepted: true } 後再重新載入訊息
 * - 若前端支援 SSE，建議改用 POST /messages/stream 串流版
 */
messages.post('/', requireToken, async (c) => {
  const token = extractToken(c) as string
  const sessionKey = c.req.param('sessionKey')

  const parsed = await parseMessageFormData(c)
  if ('error' in parsed) return parsed.error

  const { text, images } = parsed

  try {
    await sessionManager.send(token, sessionKey, text, images)
    return c.json(ok({ accepted: true }), 201)
  } catch (err: unknown) {
    const { status, body } = handleGatewayError(err, 'messages/send', '訊息發送失敗')
    return c.json(body, status)
  }
})

/**
 * POST /api/sessions/:sessionKey/messages/stream
 * 發送文字與圖片訊息（SSE 串流版）
 *
 * 回應為 text/event-stream，依序推播以下 SSE 事件：
 *   data: {"type":"status","status":"sending"}
 *   data: {"type":"chunk","text":"..."}   ← 若 Gateway 支援串流
 *   data: {"type":"done","accepted":true}
 *   data: {"type":"error","code":"...","message":"..."}  ← 失敗時
 *
 * 若設定 STREAMING_ENABLED=false，回傳 503，前端應降級至非串流版。
 */
messages.post('/stream', requireToken, async (c) => {
  // 若串流功能被停用，回傳 503 讓前端降級
  if (!config.streamingEnabled) {
    return c.json(fail('STREAMING_DISABLED', '串流功能已停用，請使用標準訊息端點'), 503)
  }

  const token = extractToken(c) as string
  const sessionKey = c.req.param('sessionKey')

  const parsed = await parseMessageFormData(c)
  if ('error' in parsed) return parsed.error

  const { text, images } = parsed

  // ── SSE 串流回應 ──────────────────────────────────────────────────────────
  return streamSSE(c, async (stream) => {
    // 立即通知前端訊息已開始處理
    await stream.writeSSE({ data: JSON.stringify({ type: 'status', status: 'sending' }) })

    try {
      // 逐一 yield Gateway 串流事件（chunk / done）
      for await (const event of sessionManager.sendStream(token, sessionKey, text, images)) {
        if (event.type === 'chunk') {
          await stream.writeSSE({ data: JSON.stringify({ type: 'chunk', text: event.text }) })
        } else if (event.type === 'done') {
          // 通知前端完成，前端應重新載入訊息清單
          await stream.writeSSE({ data: JSON.stringify({ type: 'done', accepted: true }) })
        }
      }
    } catch (err: unknown) {
      console.error('[messages/stream] 串流錯誤:', err)
      const { body } = handleGatewayError(err, 'messages/stream', '訊息串流失敗')
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'error',
          code: body.error?.code ?? 'GATEWAY_RPC_ERROR',
          message: body.error?.message ?? '訊息串流失敗',
        }),
      })
    }
  })
})

export default messages
