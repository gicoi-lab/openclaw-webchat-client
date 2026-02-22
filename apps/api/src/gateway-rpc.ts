/**
 * Gateway WebSocket/RPC 連線池管理器
 *
 * 職責：
 * 1. 以 Token 為 key 維護 RpcClient 連線池（TTL 5 分鐘）
 * 2. 並發安全：多個並行請求共享同一條 WS 連線，等待 connect 握手完成
 * 3. 連線失效時自動從池中移除，下次請求重建
 * 4. 提供 request / sendStream / verifyToken / closeToken / closeAll 公開 API
 *
 * 低階 WS/RPC 邏輯（heartbeat、reconnect、hooks、Origin）封裝於 rpc-client.ts。
 */

import { RpcClient, GatewayError } from './rpc-client.js'
import type { RpcEvent } from './rpc-client.js'
import { config } from './config.js'

// 重新匯出 GatewayError，讓上層模組可直接 import
export { GatewayError }

// ── Gateway 協議版本與客戶端識別 ─────────────────────────────────────────────

/** connect 握手固定 params（minProtocol/maxProtocol/client 為 Gateway 協議要求） */
const CONNECT_BASE_PARAMS = {
  minProtocol: 3,
  maxProtocol: 3,
  client: {
    id: config.clientId,
    version: config.clientVersion,
    platform: 'web',
    mode: 'webchat',
    instanceId: config.clientInstanceId,
  },
}

function buildConnectParams(token: string) {
  return {
    ...CONNECT_BASE_PARAMS,
    role: 'operator',
    scopes: ['operator.read', 'operator.admin', 'operator.approvals', 'operator.pairing'],
    auth: { token },
  }
}

/** 連線池項目最大存活時間（毫秒）；超過後下次請求重建連線 */
const CONNECTION_TTL_MS = 5 * 60 * 1000

// ── 連線池型別 ────────────────────────────────────────────────────────────────

interface PoolEntry {
  client: RpcClient
  /** 建立時間（用於 TTL 判斷） */
  createdAt: number
  /**
   * 初始連線 Promise（connect 握手成功後 resolve）。
   * 並發請求等待此 Promise，不重複建立連線。
   */
  connectPromise: Promise<void>
}

// ── Gateway 串流事件型別 ──────────────────────────────────────────────────────

/** sendStream() yield 的事件型別 */
export type GatewayStreamEvent =
  | { type: 'chunk'; text: string; raw?: unknown }  // AI 串流片段
  | { type: 'done'; data: unknown }                  // RPC 完成（含完整回應）

// ── Gateway RPC 連線池管理器 ──────────────────────────────────────────────────

class GatewayRpcClientManager {
  /** 連線池，key = token（記憶體中，不持久化） */
  private pool = new Map<string, PoolEntry>()

  /** 建立 WS URL（token 置於 query param） */
  private _makeWsUrl(token: string): string {
    return `${config.gatewayWsUrl}?token=${encodeURIComponent(token)}`
  }

  /** 建立 RpcClient 實例（連線池用，不自動重連） */
  private _makeClient(wsUrl: string, token: string): RpcClient {
    return new RpcClient(
      wsUrl,
      {
        connectTimeoutMs: config.gatewayConnectTimeoutMs,
        requestTimeoutMs: config.gatewayRequestTimeoutMs,
        heartbeatIntervalMs: config.gatewayHeartbeatIntervalMs,
        // 連線池本身管理重連（TTL 到期或斷線後下次請求重建），此處不啟用自動重連
        reconnectMaxRetries: 0,
        reconnectDelayMs: 0,
        origin: config.gatewayWsOrigin || undefined,
        tlsVerify: config.tlsVerify,
        connectParams: buildConnectParams(token),
      },
      {
        onError: (err) => console.error('[gateway-rpc] WS 錯誤:', err.message),
        onDisconnect: (code, reason) =>
          console.log(
            `[gateway-rpc] 連線關閉 code=${code}${reason ? ` reason=${reason}` : ''}`,
          ),
      },
    )
  }

  /**
   * 取得可用連線；若無有效連線則新建。
   * 並發請求等待同一 connectPromise，不重複建立連線。
   */
  async getConnection(token: string): Promise<RpcClient> {
    const entry = this.pool.get(token)
    const now = Date.now()

    if (entry) {
      const stale = now - entry.createdAt >= CONNECTION_TTL_MS
      if (!stale) {
        // 等待初始連線完成（可能仍在 connect 握手中）
        await entry.connectPromise
        // 連線就緒後若仍在線，直接返回
        if (entry.client.isConnected) return entry.client
        // 連線已斷（TTL 內斷線）：清除並重建
      }
      entry.client.close()
      this.pool.delete(token)
    }

    // 建立新連線，立即加入池（防止並發重複建立）
    const wsUrl = this._makeWsUrl(token)
    const client = this._makeClient(wsUrl, token)
    const connectPromise = client.connect()

    // connect 失敗時清除池條目（讓下次請求重試）
    connectPromise.catch(() => {
      this.pool.delete(token)
    })

    this.pool.set(token, { client, createdAt: Date.now(), connectPromise })

    // 等待 connect 握手（失敗會 throw GatewayError）
    await connectPromise
    return client
  }

  // ── 公開 API ──────────────────────────────────────────────────────────────

  /**
   * 發送 RPC 請求並等待回應。
   * 內部會等待 connect 握手完成才送出請求。
   * @throws {GatewayError}
   */
  async request<T = unknown>(token: string, method: string, params?: unknown): Promise<T> {
    const client = await this.getConnection(token)
    return client.request<T>(method, params)
  }

  /**
   * 發送 chat.send RPC，並以 AsyncGenerator yield 串流事件與最終結果。
   *
   * Gateway 實際推播格式（經 debug 確認 2026-02-21）：
   * - 串流 chunk：event="agent", payload.stream="assistant", payload.data.delta="..."
   * - 生命週期：event="agent", payload.stream="lifecycle", payload.data.phase="start"|"end"
   * - 完成訊息：event="chat", payload.state="final", payload.message={role,content}
   *
   * 流程：
   * 1. 取得連線並訂閱 Gateway 的 agent/chat 事件
   * 2. 發送 chat.send RPC（Gateway 在 RPC 完成前推播串流事件）
   * 3. 收到 agent(stream=assistant) 事件時 yield { type: 'chunk', text: delta }
   * 4. 收到 chat(state=final) 或 RPC 完成時 yield { type: 'done', data } 並結束
   *
   * @throws {GatewayError} 連線失敗或 RPC 錯誤時拋出
   */
  async *sendStream(
    token: string,
    sessionKey: string,
    message: string,
    attachments: Array<{ type: string; mimeType: string; content: string; name: string }>,
    idempotencyKey: string,
  ): AsyncGenerator<GatewayStreamEvent> {
    const client = await this.getConnection(token)

    // ── 串流 chunk 緩衝 ──────────────────────────────────────────────────
    const buffer: GatewayStreamEvent[] = []
    let resolver: (() => void) | null = null
    let done = false
    let error: GatewayError | null = null

    /** 喚醒等待中的 generator（若有） */
    function notify() {
      if (resolver) {
        const r = resolver
        resolver = null
        r()
      }
    }

    // ── 訂閱 Gateway 推播的串流事件 ──────────────────────────────────────
    // Gateway 實際使用 event/payload 欄位（非 name/data）
    const unsubscribe = client.subscribeEvent('*', (event: RpcEvent) => {
      const eventName = event.event ?? event.name ?? ''
      const payload = (event.payload ?? event.data ?? {}) as Record<string, unknown>

      // 過濾：只處理屬於本 session 的事件
      if (payload.sessionKey !== undefined && payload.sessionKey !== sessionKey) return

      // ── agent 事件：串流 chunk（stream=assistant）與生命週期 ──────────
      if (eventName === 'agent') {
        const stream = payload.stream as string | undefined
        const data = (payload.data ?? {}) as Record<string, unknown>

        if (stream === 'assistant' && data.delta !== undefined) {
          // 逐 token 增量文字
          const delta = String(data.delta)
          buffer.push({ type: 'chunk', text: delta, raw: event })
          notify()
          return
        }
        // lifecycle phase=end 可作為備援完成信號，但優先由 chat(final) 或 RPC 完成處理
        return
      }

      // ── chat 事件：最終完成訊息 ─────────────────────────────────────────
      if (eventName === 'chat') {
        const state = payload.state as string | undefined
        if (state === 'final') {
          // Gateway 推播完成訊息，不等 RPC 回應直接標記 done
          buffer.push({ type: 'done', data: payload.message ?? payload })
          done = true
          notify()
        }
        // state=delta 忽略（已由 agent stream=assistant 處理增量）
        return
      }
    })

    // ── 發送 RPC 請求（不阻塞，在 background 執行） ───────────────────────
    client
      .request<unknown>('chat.send', {
        sessionKey,
        message,
        deliver: true,
        idempotencyKey,
        attachments,
      })
      .then((result) => {
        // 若 chat(final) 事件已先到達，done 已為 true，此處不重複推送
        if (!done) {
          buffer.push({ type: 'done', data: result })
          done = true
          notify()
        }
      })
      .catch((err: unknown) => {
        error =
          err instanceof GatewayError
            ? err
            : new GatewayError('GATEWAY_RPC_ERROR', String(err))
        done = true
        notify()
      })

    // ── Yield 事件（串流 chunk + done） ──────────────────────────────────
    try {
      while (!done || buffer.length > 0) {
        if (buffer.length > 0) {
          yield buffer.shift()!
          continue
        }
        if (done) break
        // 等待下一個事件通知
        await new Promise<void>((r) => {
          resolver = r
        })
      }

      if (error) throw error
    } finally {
      unsubscribe()
    }
  }

  /**
   * 驗證 Token：以一次性連線完成 connect 握手，成功即代表 Token 有效。
   * @returns true = 有效；false = 無效（Gateway 明確拒絕）
   * @throws {GatewayError} 無法連線至 Gateway 時拋出（非 Token 問題）
   */
  async verifyToken(token: string): Promise<boolean> {
    const wsUrl = this._makeWsUrl(token)
    const client = new RpcClient(
      wsUrl,
      {
        connectTimeoutMs: config.gatewayConnectTimeoutMs,
        requestTimeoutMs: config.gatewayRequestTimeoutMs,
        heartbeatIntervalMs: 0, // 驗證用，不需心跳
        reconnectMaxRetries: 0,
        reconnectDelayMs: 0,
        origin: config.gatewayWsOrigin || undefined,
        tlsVerify: config.tlsVerify,
        connectParams: buildConnectParams(token),
      },
    )

    try {
      await client.connect()
      return true
    } catch (err) {
      if (err instanceof GatewayError && err.code === 'UNAUTHORIZED') return false
      throw err
    } finally {
      client.close()
    }
  }

  /**
   * 釋放特定 Token 的連線（可在登出時呼叫）
   */
  closeToken(token: string): void {
    const entry = this.pool.get(token)
    if (entry) {
      entry.client.close()
      this.pool.delete(token)
    }
  }

  /**
   * 釋放所有連線（伺服器關閉時呼叫）
   */
  closeAll(): void {
    for (const [, entry] of this.pool) {
      entry.client.close()
    }
    this.pool.clear()
  }
}

/** 全域 Gateway RPC 連線池管理器單例 */
export const gatewayRpc = new GatewayRpcClientManager()
