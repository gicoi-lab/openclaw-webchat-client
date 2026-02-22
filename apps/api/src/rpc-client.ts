/**
 * OpenClaw Gateway WebSocket RPC 客戶端（可重用低階層）
 *
 * 職責：
 * - 管理單一 WebSocket 連線的完整生命週期
 * - 實作 JSON-RPC 2.0 格式的請求/回應機制（type=req/res/event）
 * - 支援 pending map、per-request timeout、heartbeat（ping/pong）、自動重連、hooks
 * - 支援 subscribeEvent()：per-name 事件訂閱（供串流回覆使用）
 * - 可配置 Origin header（修正 origin not allowed 錯誤）
 * - 自訂錯誤類別 GatewayError
 */

import WebSocket from 'ws'
import crypto from 'node:crypto'

// ── 自訂錯誤類別 ─────────────────────────────────────────────────────────────

/** Gateway 操作的統一錯誤型別 */
export class GatewayError extends Error {
  constructor(
    /** 錯誤碼（對應 API 回應的 code 欄位） */
    public readonly code: 'GATEWAY_CONNECT_FAILED' | 'GATEWAY_RPC_ERROR' | 'UNAUTHORIZED',
    message: string,
    /** 原始 Gateway 回應（診斷用） */
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

// ── RPC 訊息格式 ─────────────────────────────────────────────────────────────

interface RpcRequest {
  type: 'req'
  id: string
  method: string
  params?: unknown
}

interface RpcResponse {
  type?: string
  id?: string
  // 標準 JSON-RPC
  result?: unknown
  // OpenClaw Gateway 風格
  ok?: boolean
  payload?: unknown
  error?: {
    code: string | number
    message: string
    data?: unknown
  }
}

/** Gateway 推播事件幀（type=event） */
export interface RpcEvent {
  type: 'event'
  /** 舊版欄位名稱（相容用） */
  name?: string
  data?: unknown
  /** Gateway 實際使用的事件名稱欄位（如 'agent', 'chat', 'health', 'tick'） */
  event?: string
  /** Gateway 實際使用的 payload 欄位 */
  payload?: Record<string, unknown>
  /** 全域序號 */
  seq?: number
  [key: string]: unknown
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** RpcClient 生命週期 hooks */
export interface RpcClientHooks {
  /** connect 握手成功後呼叫 */
  onConnect?: () => void
  /** 連線關閉後呼叫（含 close code 與 reason） */
  onDisconnect?: (code: number, reason: string) => void
  /** WS 錯誤時呼叫 */
  onError?: (err: Error) => void
  /** 收到 type=event 推播幀時呼叫（全域，早於 subscribeEvent） */
  onEvent?: (event: RpcEvent) => void
}

// ── 選項 ─────────────────────────────────────────────────────────────────────

/** RpcClient 建構選項 */
export interface RpcClientOptions {
  /** WS 握手逾時（ms） */
  connectTimeoutMs: number
  /** 單次 RPC 請求逾時（ms） */
  requestTimeoutMs: number
  /** Heartbeat 間隔（ms）；0 = 停用 */
  heartbeatIntervalMs: number
  /** 最大自動重連次數；0 = 不重連 */
  reconnectMaxRetries: number
  /** 重連基礎等待時間（ms，依次數線性增長） */
  reconnectDelayMs: number
  /**
   * 自訂 Origin header（修正 origin not allowed）。
   * undefined / 空字串 = 不設定，使用 ws 預設行為。
   */
  origin?: string
  /** TLS 驗證；false = 接受自簽憑證 */
  tlsVerify?: boolean
  /** connect 握手 params（Gateway 協議要求） */
  connectParams: object
}

// ── 等待中的 RPC 請求 ─────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: GatewayError) => void
  timeoutId: ReturnType<typeof setTimeout>
}

// ── 輔助 ─────────────────────────────────────────────────────────────────────

function isAuthErrorCode(code: string | number): boolean {
  const s = String(code)
  return s === 'UNAUTHORIZED' || s === '401' || s === '403' || s === 'FORBIDDEN'
}

// ── RpcClient ─────────────────────────────────────────────────────────────────

/**
 * 單一 WebSocket RPC 連線（可重用）。
 *
 * 使用範例：
 * ```ts
 * const client = new RpcClient(wsUrl, options, hooks)
 * await client.connect()                            // 建立連線並完成 connect 握手
 * const result = await client.request('sessions.list')
 * client.close()
 * ```
 */
export class RpcClient {
  private ws: WebSocket | null = null
  /** 等待回應中的 RPC 請求（key = request id） */
  private readonly pending = new Map<string, PendingRequest>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempts = 0
  private _isConnected = false
  /** close() 呼叫後設 true，停止自動重連 */
  private _closed = false
  /** 最後收到 pong 的時間（ms），0 表示尚未收到 */
  private _lastPongAt = 0

  /**
   * per-name 事件訂閱器（供串流回覆使用）。
   * key = 事件名稱（'*' 為萬用，訂閱所有 event 幀）
   */
  private readonly eventListeners = new Map<string, Set<(e: RpcEvent) => void>>()

  constructor(
    private readonly wsUrl: string,
    private readonly options: RpcClientOptions,
    private readonly hooks: RpcClientHooks = {},
  ) {}

  /** 是否已連線（connect 握手成功且連線仍開啟） */
  get isConnected(): boolean {
    return this._isConnected
  }

  /** 最後收到 pong 的時間（Date.now() ms），0 表示尚未收到 */
  get lastPongAt(): number {
    return this._lastPongAt
  }

  /**
   * 建立 WebSocket 連線並完成 connect 握手。
   * 若已連線則立即 resolve。
   */
  async connect(): Promise<void> {
    if (this._isConnected) return
    if (this._closed) {
      // 允許在 close() 後重新呼叫 connect()
      this._closed = false
      this.reconnectAttempts = 0
    }
    return this._doConnect()
  }

  /** 內部：建立 WS 並執行 connect 握手 */
  private _doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsOptions: WebSocket.ClientOptions = {
        handshakeTimeout: this.options.connectTimeoutMs,
        rejectUnauthorized: this.options.tlsVerify !== false,
      }

      // ── 修正 origin not allowed ──────────────────────────────────────────
      if (this.options.origin) {
        // ws client 原生支援 origin 欄位，交由 library 正確產生握手 header
        wsOptions.origin = this.options.origin
        // 保險起見同時帶入自訂 header（部分環境會讀 headers）
        wsOptions.headers = { Origin: this.options.origin }
      }

      const ws = new WebSocket(this.wsUrl, wsOptions)
      this.ws = ws

      let settled = false
      let connectId: string | null = null

      const doFail = (err: GatewayError) => {
        if (settled) return
        settled = true
        reject(err)
      }

      const doSucceed = () => {
        if (settled) return
        settled = true
        this._isConnected = true
        this.reconnectAttempts = 0
        this._startHeartbeat()
        this.hooks.onConnect?.()
        resolve()
      }

      ws.on('open', () => {
        // WS TCP 已開啟：送出 connect 握手（Gateway 要求第一個 req 必須是 connect）
        connectId = `req_${crypto.randomUUID()}`
        try {
          ws.send(
            JSON.stringify({
              type: 'req',
              id: connectId,
              method: 'connect',
              params: this.options.connectParams,
            }),
          )
        } catch (err) {
          doFail(
            new GatewayError('GATEWAY_CONNECT_FAILED', `connect 握手發送失敗：${String(err)}`),
          )
        }
      })

      ws.on('message', (raw: WebSocket.RawData) => {
        let msg: RpcResponse
        try {
          msg = JSON.parse(raw.toString()) as RpcResponse
        } catch {
          console.warn('[rpc-client] 無法解析 WS 訊息:', raw.toString().slice(0, 200))
          return
        }

        // type=event 推播幀：轉發至 hook 與事件訂閱者
        if (msg.type === 'event') {
          const event = msg as unknown as RpcEvent
          this.hooks.onEvent?.(event)
          this._dispatchEvent(event)
          return
        }

        // 只處理 type=res 回應幀；其他推播幀略過
        if (msg.type !== undefined && msg.type !== 'res') return
        if (!msg.id) return

        // ── connect 握手回應 ─────────────────────────────────────────────
        if (connectId && msg.id === connectId) {
          connectId = null
          const hasError = !!msg.error || msg.ok === false
          if (hasError) {
            const errorObj =
              msg.error ??
              ({ code: 'CONNECT_FAILED', message: 'connect 握手失敗', data: msg } as const)
            const err = isAuthErrorCode(errorObj.code)
              ? new GatewayError(
                  'UNAUTHORIZED',
                  errorObj.message || 'connect 握手：Token 無效',
                  errorObj,
                )
              : new GatewayError(
                  'GATEWAY_CONNECT_FAILED',
                  errorObj.message || 'connect 握手失敗',
                  errorObj,
                )
            doFail(err)
            this._rejectAllPending(err)
          } else {
            doSucceed()
          }
          return
        }

        // ── 一般 RPC 回應 ────────────────────────────────────────────────
        const req = this.pending.get(msg.id)
        if (!req) return
        clearTimeout(req.timeoutId)
        this.pending.delete(msg.id)

        const hasError = !!msg.error || msg.ok === false
        if (hasError) {
          const errorObj =
            msg.error ??
            ({ code: 'RPC_ERROR', message: 'RPC 操作失敗', data: msg } as const)
          const err = isAuthErrorCode(errorObj.code)
            ? new GatewayError('UNAUTHORIZED', errorObj.message || 'Token 無效', errorObj)
            : new GatewayError('GATEWAY_RPC_ERROR', errorObj.message || 'RPC 操作失敗', errorObj)
          req.reject(err)
        } else {
          // 相容兩種回應格式：JSON-RPC(result) 與 OpenClaw(payload)
          req.resolve(msg.result !== undefined ? msg.result : msg.payload)
        }
      })

      ws.on('unexpected-response', (_req, resp) => {
        // Gateway 以 HTTP 4xx/5xx 拒絕 WS 升級（含 origin not allowed → 403）
        const status = resp.statusCode ?? 0
        const err =
          status === 401 || status === 403
            ? new GatewayError('UNAUTHORIZED', `Token 無效（Gateway HTTP ${status}）`)
            : new GatewayError('GATEWAY_CONNECT_FAILED', `WS 升級失敗（HTTP ${status}）`)
        doFail(err)
        this._rejectAllPending(err)
      })

      ws.on('error', (err: Error) => {
        this.hooks.onError?.(err)
        const gwErr = new GatewayError('GATEWAY_CONNECT_FAILED', `WS 錯誤：${err.message}`)
        doFail(gwErr)
        // close 事件會接著觸發，pending 由那裡清除
      })

      // ── pong 處理：記錄最後存活時間 ──────────────────────────────────────
      ws.on('pong', () => {
        this._lastPongAt = Date.now()
        // pong 收到代表連線健康，無需額外動作
      })

      ws.on('close', (code: number, reasonBuf: Buffer) => {
        const reason = reasonBuf?.toString() || ''
        this._isConnected = false
        this._stopHeartbeat()
        this.ws = null

        // 4001 / 4003 為 Gateway 自訂認證拒絕碼
        const isAuth = code === 4001 || code === 4003
        const gwErr = isAuth
          ? new GatewayError('UNAUTHORIZED', `Token 無效（close code ${code}）`)
          : new GatewayError('GATEWAY_CONNECT_FAILED', `WS 連線中斷（code: ${code}）`)

        doFail(gwErr)
        this._rejectAllPending(gwErr)
        this.hooks.onDisconnect?.(code, reason)

        // ── 自動重連（認證錯誤不重連） ────────────────────────────────────
        if (
          !this._closed &&
          !isAuth &&
          this.reconnectAttempts < this.options.reconnectMaxRetries
        ) {
          this.reconnectAttempts++
          const delay = this.options.reconnectDelayMs * this.reconnectAttempts
          console.log(
            `[rpc-client] 將在 ${delay}ms 後重連（第 ${this.reconnectAttempts}/${this.options.reconnectMaxRetries} 次）`,
          )
          setTimeout(() => {
            if (!this._closed) {
              this._doConnect().catch((err) => {
                console.error(
                  '[rpc-client] 重連失敗:',
                  err instanceof Error ? err.message : String(err),
                )
              })
            }
          }, delay)
        }
      })
    })
  }

  /**
   * 發送 RPC 請求並等待回應。
   * @throws {GatewayError} 連線未就緒、逾時或 RPC 錯誤時拋出
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this._isConnected || !this.ws) {
      throw new GatewayError(
        'GATEWAY_CONNECT_FAILED',
        `連線未就緒，無法發送 RPC 請求（method: ${method}）`,
      )
    }

    return new Promise<T>((resolve, reject) => {
      const id = `req_${crypto.randomUUID()}`
      const reqMsg: RpcRequest =
        params !== undefined ? { type: 'req', id, method, params } : { type: 'req', id, method }

      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new GatewayError(
            'GATEWAY_RPC_ERROR',
            `RPC 請求逾時（${this.options.requestTimeoutMs}ms）：${method}`,
          ),
        )
      }, this.options.requestTimeoutMs)

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timeoutId,
      })

      try {
        this.ws!.send(JSON.stringify(reqMsg))
      } catch (err) {
        clearTimeout(timeoutId)
        this.pending.delete(id)
        reject(new GatewayError('GATEWAY_RPC_ERROR', `RPC 發送失敗：${String(err)}`))
      }
    })
  }

  /**
   * 訂閱 type=event 推播幀（依 name 過濾）。
   * 用於串流回覆：在發送 chat.send 前先訂閱，收到 chunk 事件時呼叫 callback。
   *
   * @param name 事件名稱（'*' = 訂閱所有 event 幀）
   * @param callback 事件處理函式
   * @returns unsubscribe 函式（呼叫後取消訂閱）
   */
  subscribeEvent(name: string, callback: (e: RpcEvent) => void): () => void {
    let listeners = this.eventListeners.get(name)
    if (!listeners) {
      listeners = new Set()
      this.eventListeners.set(name, listeners)
    }
    listeners.add(callback)
    return () => {
      const l = this.eventListeners.get(name)
      if (l) {
        l.delete(callback)
        if (l.size === 0) this.eventListeners.delete(name)
      }
    }
  }

  /**
   * 主動關閉連線，停止 heartbeat 與自動重連，拒絕所有等待中請求。
   */
  close(): void {
    this._closed = true
    this._stopHeartbeat()
    this._rejectAllPending(new GatewayError('GATEWAY_CONNECT_FAILED', '連線已主動關閉'))
    try {
      if (this.ws) {
        this.ws.close()
        this.ws = null
      }
    } catch {
      // 忽略關閉時的例外
    }
  }

  private _startHeartbeat(): void {
    if (this.options.heartbeatIntervalMs <= 0) return
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping()
      }
    }, this.options.heartbeatIntervalMs)
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 拒絕並清除所有等待中的 RPC 請求 */
  private _rejectAllPending(err: GatewayError): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timeoutId)
      req.reject(err)
    }
    this.pending.clear()
  }

  /**
   * 將收到的 event 幀分發至對應訂閱者。
   * - 精確名稱訂閱者（event.event 或 event.name 完全相符）
   * - 萬用訂閱者（'*'）
   */
  private _dispatchEvent(event: RpcEvent): void {
    // Gateway 實際使用 event 欄位，舊版使用 name 欄位，兩者皆嘗試
    const eventName = event.event ?? event.name ?? ''
    // 精確名稱訂閱者
    const specific = this.eventListeners.get(eventName)
    if (specific) {
      for (const cb of specific) cb(event)
    }
    // 萬用訂閱者（訂閱所有事件）
    const wildcard = this.eventListeners.get('*')
    if (wildcard) {
      for (const cb of wildcard) cb(event)
    }
  }
}
