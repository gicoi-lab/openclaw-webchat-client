import { Hono } from 'hono'
import { requireToken, extractToken } from '../middleware/auth.js'
import { getSessions, createSession, archiveSession, renameSession, closeSession, GatewayError } from '../gateway.js'
import { ok, fail } from '../types.js'

const sessions = new Hono()

/** 將 GatewayError 轉換為 HTTP 回應（sessions 路由共用邏輯） */
function handleGatewayError(err: unknown, label: string, fallbackMsg: string) {
  console.error(`[${label}] Gateway 錯誤:`, err)
  if (err instanceof GatewayError) {
    if (err.code === 'UNAUTHORIZED') {
      return { status: 401 as const, body: fail('UNAUTHORIZED', 'Token 已失效，請重新登入') }
    }
    if (err.code === 'GATEWAY_CONNECT_FAILED') {
      return { status: 502 as const, body: fail('GATEWAY_CONNECT_FAILED', `無法連線至 Gateway：${err.message}`) }
    }
    // GATEWAY_RPC_ERROR
    return { status: 502 as const, body: fail('GATEWAY_RPC_ERROR', err.message) }
  }
  return { status: 502 as const, body: fail('GATEWAY_RPC_ERROR', fallbackMsg) }
}

/**
 * GET /api/sessions
 * 取得目前使用者的 Session 清單
 */
sessions.get('/', requireToken, async (c) => {
  const token = extractToken(c) as string
  try {
    const data = await getSessions(token)
    return c.json(ok(data))
  } catch (err: unknown) {
    const { status, body } = handleGatewayError(err, 'sessions/list', 'Session 清單取得失敗')
    return c.json(body, status)
  }
})

/**
 * POST /api/sessions
 * 建立新的 Session
 */
sessions.post('/', requireToken, async (c) => {
  const token = extractToken(c) as string
  let body: { title?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    // body 可選，允許空 body
  }

  try {
    const data = await createSession(token, body.title)
    return c.json(ok(data), 201)
  } catch (err: unknown) {
    const { status, body: errBody } = handleGatewayError(err, 'sessions/create', '建立 Session 失敗')
    return c.json(errBody, status)
  }
})

/**
 * PATCH /api/sessions/:sessionKey
 * 支援欄位：
 *   - { archived: boolean } — 封存或取消封存（AP in-memory）
 *   - { title: string }     — 重新命名（Gateway 持久化）
 *   兩個欄位可同時存在，也可只傳其中一個。
 */
sessions.patch('/:sessionKey', requireToken, async (c) => {
  const token = extractToken(c) as string
  const sessionKey = c.req.param('sessionKey')

  let body: { archived?: boolean; title?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json(fail('BAD_REQUEST', '請求格式錯誤，需提供 JSON body'), 400)
  }

  const hasArchived = typeof body.archived === 'boolean'
  const hasTitle = typeof body.title === 'string'

  if (!hasArchived && !hasTitle) {
    return c.json(fail('BAD_REQUEST', '需提供 archived（boolean）或 title（string）欄位'), 400)
  }

  const result: Record<string, unknown> = {}

  try {
    // 處理重新命名
    if (hasTitle) {
      const renamed = await renameSession(token, sessionKey, body.title!)
      Object.assign(result, renamed)
    }

    // 處理封存狀態
    if (hasArchived) {
      const archived = archiveSession(token, sessionKey, body.archived!)
      Object.assign(result, archived)
    }

    return c.json(ok(result))
  } catch (err: unknown) {
    const { status, body: errBody } = handleGatewayError(err, 'sessions/patch', '更新 Session 失敗')
    return c.json(errBody, status)
  }
})

/**
 * DELETE /api/sessions/:sessionKey
 * 關閉（刪除）Session，呼叫 Gateway sessions.delete RPC
 */
sessions.delete('/:sessionKey', requireToken, async (c) => {
  const token = extractToken(c) as string
  const sessionKey = c.req.param('sessionKey')

  try {
    const data = await closeSession(token, sessionKey)
    return c.json(ok(data))
  } catch (err: unknown) {
    const { status, body: errBody } = handleGatewayError(err, 'sessions/close', '關閉 Session 失敗')
    return c.json(errBody, status)
  }
})

export default sessions
