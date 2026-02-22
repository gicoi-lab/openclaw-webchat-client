/**
 * 持久事件轉發器（Event Forwarder）
 *
 * 職責：
 * - 管理 token → SSE 客戶端集合 的映射
 * - 當第一個 SSE 客戶端連上某 token 時，自動在該 token 的 WS 連線上
 *   註冊常駐 subscribeEvent('*', handler)，監聽 Gateway 推播
 * - 過濾出 agent（stream=assistant）與 chat（state=final）事件，
 *   轉換為標準 PushEvent 格式，廣播至該 token 的所有 SSE 客戶端
 * - 最後一個 SSE 客戶端斷開時，取消 WS 事件訂閱
 */

import { gatewayRpc } from './gateway-rpc.js'
import type { RpcClient, RpcEvent } from './rpc-client.js'

// ── 推播事件型別（AP → 前端 SSE） ────────────────────────────────────────────

export type PushEvent =
  | { type: 'agent-start'; sessionKey: string; runId?: string }
  | { type: 'chunk'; sessionKey: string; text: string }
  | { type: 'agent-end'; sessionKey: string; runId?: string }
  | { type: 'message-final'; sessionKey: string; message: unknown }
  | { type: 'keepalive'; ts: number }

/** SSE 客戶端寫入介面（由路由端傳入） */
export interface SseWriter {
  /** 寫入一筆 SSE data 行 */
  write(event: PushEvent): void
}

// ── 單一 token 的訂閱狀態 ────────────────────────────────────────────────────

interface TokenSubscription {
  /** 該 token 下所有 SSE 客戶端 */
  clients: Set<SseWriter>
  /** 取消 WS 事件訂閱的函式（null = 尚未建立） */
  unsubscribe: (() => void) | null
  /** 目前訂閱的 RpcClient 實例（用於偵測連線替換或斷線） */
  client: RpcClient | null
  /** 週期性健康檢查計時器 */
  healthCheckTimer: ReturnType<typeof setInterval> | null
}

// ── EventForwarder ───────────────────────────────────────────────────────────

/** 健康檢查間隔（毫秒）：偵測 WS 連線斷線並自動重新訂閱 */
const HEALTH_CHECK_INTERVAL_MS = 5_000

class EventForwarder {
  private subscriptions = new Map<string, TokenSubscription>()

  /**
   * 註冊一個 SSE 客戶端。
   * 若為該 token 的第一個客戶端，自動建立 WS 事件監聽。
   */
  async subscribe(token: string, writer: SseWriter): Promise<void> {
    let sub = this.subscriptions.get(token)
    if (!sub) {
      sub = { clients: new Set(), unsubscribe: null, client: null, healthCheckTimer: null }
      this.subscriptions.set(token, sub)
    }
    sub.clients.add(writer)

    // 確保該 token 的常駐 WS 事件監聯已建立（含斷線後重建）
    if (!sub.unsubscribe || (sub.client && !sub.client.isConnected)) {
      this._clearSubscription(sub)
      await this._ensureListener(token, sub)
    }
  }

  /**
   * 移除一個 SSE 客戶端。
   * 若為該 token 的最後一個客戶端，取消 WS 事件訂閱。
   */
  unsubscribe(token: string, writer: SseWriter): void {
    const sub = this.subscriptions.get(token)
    if (!sub) return
    sub.clients.delete(writer)

    if (sub.clients.size === 0) {
      // 最後一個客戶端斷開：清除訂閱與健康檢查
      this._clearSubscription(sub)
      this.subscriptions.delete(token)
      console.log(`[event-forwarder] token 最後一個 SSE 客戶端斷開，已取消 WS 訂閱`)
    }
  }

  /**
   * 清除訂閱狀態（取消 WS 事件監聽、停止健康檢查）。
   * 不移除 clients 集合，僅重置連線相關狀態。
   */
  private _clearSubscription(sub: TokenSubscription): void {
    sub.unsubscribe?.()
    sub.unsubscribe = null
    sub.client = null
    if (sub.healthCheckTimer) {
      clearInterval(sub.healthCheckTimer)
      sub.healthCheckTimer = null
    }
  }

  /**
   * 建立該 token 的常駐 WS 事件監聽。
   * 在 WS 連線上訂閱所有事件，過濾後廣播至 SSE 客戶端。
   */
  private async _ensureListener(token: string, sub: TokenSubscription): Promise<void> {
    try {
      const client = await gatewayRpc.getConnection(token)

      const handler = (event: RpcEvent) => {
        const eventName = event.event ?? event.name ?? ''
        const payload = (event.payload ?? event.data ?? {}) as Record<string, unknown>
        const sessionKey = (payload.sessionKey ?? '') as string

        // ── agent 事件 ──────────────────────────────────────────────────
        if (eventName === 'agent') {
          const stream = payload.stream as string | undefined
          const data = (payload.data ?? {}) as Record<string, unknown>

          // 串流 chunk（逐 token delta）
          if (stream === 'assistant' && data.delta !== undefined) {
            const pushEvent: PushEvent = {
              type: 'chunk',
              sessionKey,
              text: String(data.delta),
            }
            this._broadcast(sub, pushEvent)
            return
          }

          // 生命週期：回覆開始
          if (stream === 'lifecycle') {
            const phase = data.phase as string | undefined
            if (phase === 'start') {
              this._broadcast(sub, {
                type: 'agent-start',
                sessionKey,
                runId: (data.runId ?? '') as string,
              })
            } else if (phase === 'end') {
              this._broadcast(sub, {
                type: 'agent-end',
                sessionKey,
                runId: (data.runId ?? '') as string,
              })
            }
          }
          return
        }

        // ── chat 事件：最終完成訊息 ─────────────────────────────────────
        if (eventName === 'chat') {
          const state = payload.state as string | undefined
          if (state === 'final') {
            this._broadcast(sub, {
              type: 'message-final',
              sessionKey,
              message: payload.message ?? payload,
            })
          }
          return
        }
      }

      sub.client = client
      sub.unsubscribe = client.subscribeEvent('*', handler)

      // ── 啟動週期性健康檢查：偵測 WS 斷線並自動重新訂閱 ──────────────
      sub.healthCheckTimer = setInterval(() => {
        if (!sub.client || !sub.client.isConnected) {
          console.log('[event-forwarder] 偵測到 WS 連線已斷開，嘗試重新訂閱...')
          this._clearSubscription(sub)
          this._ensureListener(token, sub).catch((err) => {
            console.error('[event-forwarder] 重新訂閱失敗:', err)
          })
        }
      }, HEALTH_CHECK_INTERVAL_MS)

      console.log(`[event-forwarder] 已為 token 建立常駐 WS 事件訂閱`)
    } catch (err) {
      console.error('[event-forwarder] 建立 WS 事件訂閱失敗:', err)
      // 訂閱失敗不阻止 SSE 連線建立，客戶端仍可接收 keepalive
      // 健康檢查會持續嘗試重建
      this._clearSubscription(sub)

      // 啟動重試計時器（若仍有客戶端連線中）
      if (sub.clients.size > 0) {
        sub.healthCheckTimer = setInterval(() => {
          if (!sub.unsubscribe && sub.clients.size > 0) {
            console.log('[event-forwarder] 重試建立 WS 事件訂閱...')
            this._ensureListener(token, sub).catch((retryErr) => {
              console.error('[event-forwarder] 重試訂閱失敗:', retryErr)
            })
          }
        }, HEALTH_CHECK_INTERVAL_MS)
      }
    }
  }

  /** 廣播事件至該 token 的所有 SSE 客戶端 */
  private _broadcast(sub: TokenSubscription, event: PushEvent): void {
    for (const writer of sub.clients) {
      try {
        writer.write(event)
      } catch {
        // 個別客戶端寫入失敗不影響其他客戶端
      }
    }
  }
}

/** 全域事件轉發器單例 */
export const eventForwarder = new EventForwarder()
