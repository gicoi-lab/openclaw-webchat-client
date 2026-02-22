import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { config } from './config.js'
import health from './routes/health.js'
import auth from './routes/auth.js'
import sessions from './routes/sessions.js'
import messages from './routes/messages.js'
import events from './routes/events.js'

const app = new Hono()

// 記錄請求日誌
app.use('*', logger())

// CORS 設定（允許前端 dev server 存取）
app.use(
  '*',
  cors({
    origin: config.corsOrigins,
    allowHeaders: ['Authorization', 'Content-Type'],
    // PATCH 補上（封存端點需要）
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
)

// 路由掛載
app.route('/health', health)
app.route('/api/auth', auth)
app.route('/api/sessions', sessions)
app.route('/api/sessions/:sessionKey/messages', messages)
app.route('/api/events', events)

// 404 處理
app.notFound((c) => {
  return c.json({ ok: false, error: { code: 'NOT_FOUND', message: '找不到指定路由' } }, 404)
})

// 全域錯誤處理
app.onError((err, c) => {
  console.error('[未預期錯誤]', err)
  return c.json(
    { ok: false, error: { code: 'INTERNAL_ERROR', message: '伺服器內部錯誤' } },
    500,
  )
})

// 啟動服務
serve(
  { fetch: app.fetch, port: config.port },
  (info) => {
    console.log(`✓ OpenClaw API 已啟動 http://localhost:${info.port}`)
    console.log(`  Gateway WS: ${config.gatewayWsUrl}`)
    console.log(`  TLS 驗證: ${config.tlsVerify ? '開啟' : '關閉（開發模式）'}`)
    console.log(`  連線逾時: ${config.gatewayConnectTimeoutMs}ms / RPC 逾時: ${config.gatewayRequestTimeoutMs}ms`)
    console.log(`  SSE 串流: ${config.streamingEnabled ? '啟用' : '停用（polling fallback）'}`)
  },
)

export default app
