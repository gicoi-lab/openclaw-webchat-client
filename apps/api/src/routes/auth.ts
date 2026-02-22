import { Hono } from 'hono'
import { verifyToken, GatewayError } from '../gateway.js'
import { ok, fail } from '../types.js'

const auth = new Hono()

/**
 * POST /api/auth/verify
 * 驗證使用者提供的 OpenClaw Token 是否有效（透過 Gateway WS 握手）
 *
 * 請求體：{ token: string }
 * 成功：ApiResponse<{ verified: true }>
 */
auth.post('/verify', async (c) => {
  let body: { token?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json(fail('BAD_REQUEST', '請求格式錯誤，需提供 JSON 格式的 token'), 400)
  }

  const { token } = body
  if (!token || typeof token !== 'string') {
    return c.json(fail('BAD_REQUEST', '缺少 token 欄位'), 400)
  }

  try {
    const valid = await verifyToken(token)
    if (!valid) {
      return c.json(fail('INVALID_TOKEN', 'Token 無效或已過期'), 401)
    }
    return c.json(ok({ verified: true }))
  } catch (err: unknown) {
    console.error('[auth/verify] Gateway 操作失敗:', err)

    if (err instanceof GatewayError) {
      if (err.code === 'UNAUTHORIZED') {
        return c.json(fail('UNAUTHORIZED', 'Token 無效或已過期'), 401)
      }
      if (err.code === 'GATEWAY_CONNECT_FAILED') {
        return c.json(
          fail('GATEWAY_CONNECT_FAILED', `無法連線至 Gateway：${err.message}`),
          502,
        )
      }
      // GATEWAY_RPC_ERROR
      return c.json(fail('GATEWAY_RPC_ERROR', err.message), 502)
    }

    return c.json(
      fail('GATEWAY_CONNECT_FAILED', '無法連線至 OpenClaw Gateway，請確認 GATEWAY_WS_URL 與網路設定'),
      502,
    )
  }
})

export default auth
