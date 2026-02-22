import type { Context, Next } from 'hono'
import { fail } from '../types.js'

/** 從請求 Header 取出 Bearer Token */
export function extractToken(c: Context): string | null {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7).trim() || null
}

/** 驗證 Token 是否存在的中介層（不呼叫 Gateway，僅確認 Header 存在） */
export async function requireToken(c: Context, next: Next) {
  const token = extractToken(c)
  if (!token) {
    return c.json(fail('UNAUTHORIZED', '未提供有效 Token，請先登入'), 401)
  }
  // 將 token 存入 context 供後續路由使用
  c.set('token', token)
  await next()
}
