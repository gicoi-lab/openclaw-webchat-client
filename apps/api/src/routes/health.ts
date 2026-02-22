import { Hono } from 'hono'
import { config } from '../config.js'
import { ok } from '../types.js'

const health = new Hono()

/** 健康檢查端點 */
health.get('/', (c) => {
  return c.json(
    ok({
      status: 'ok',
      service: 'openclaw-webchat-api',
      gateway: config.gatewayWsUrl,
      timestamp: new Date().toISOString(),
    }),
  )
})

export default health
