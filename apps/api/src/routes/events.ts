/**
 * GET /api/events — 持久 SSE 端點
 *
 * 前端建立持久 SSE 連線，接收 Gateway 推播的即時事件：
 * - chunk（逐 token 串流文字）
 * - agent-start / agent-end（回覆生命週期）
 * - message-final（完成訊息）
 * - keepalive（每 30 秒，防止瀏覽器/proxy 斷線）
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { requireToken, extractToken } from '../middleware/auth.js'
import { eventForwarder } from '../event-forwarder.js'
import type { PushEvent, SseWriter } from '../event-forwarder.js'

const KEEPALIVE_INTERVAL_MS = 30_000

const events = new Hono()

events.get('/', requireToken, async (c) => {
  const token = extractToken(c) as string

  return streamSSE(c, async (stream) => {
    let closed = false

    // ── 建立 SseWriter 橋接器 ─────────────────────────────────────────────
    const writer: SseWriter = {
      write(event: PushEvent) {
        if (closed) return
        try {
          stream.writeSSE({ data: JSON.stringify(event) })
        } catch {
          // 寫入失敗代表連線已斷，忽略
        }
      },
    }

    // 註冊至事件轉發器
    await eventForwarder.subscribe(token, writer)
    console.log(`[events] SSE 客戶端已連線`)

    // ── Keepalive 定時器 ──────────────────────────────────────────────────
    const keepaliveTimer = setInterval(() => {
      if (closed) return
      try {
        stream.writeSSE({
          data: JSON.stringify({ type: 'keepalive', ts: Date.now() } satisfies PushEvent),
        })
      } catch {
        // 忽略
      }
    }, KEEPALIVE_INTERVAL_MS)

    // ── 等待連線關閉 ─────────────────────────────────────────────────────
    // Hono streamSSE 在 callback 結束後才會關閉回應，
    // 因此用 Promise 阻塞直到客戶端斷線
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true
        clearInterval(keepaliveTimer)
        eventForwarder.unsubscribe(token, writer)
        console.log(`[events] SSE 客戶端已斷線`)
        resolve()
      })
    })
  })
})

export default events
