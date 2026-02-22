/**
 * SessionManager — Session 業務邏輯層
 *
 * 職責：
 * 1. 封裝 Gateway RPC 的 session / message 操作
 * 2. 維護本地 Session 快取（token → sessionKey → LocalSession）
 *    - getLocalSession：不發網路請求，直接讀快取
 *    - touch：更新最後活躍時間
 *    - gcIdle：清除閒置超過指定時間的快取項目
 * 3. 提供 create / send / sendStream / history / list / delete / deleteMany
 * 4. Archive/Unarchive 使用 AP in-memory fallback（Gateway 無原生 archive RPC）
 *
 * 路由層直接 import 此模組，不再依賴 gateway.ts 的舊式函式。
 */

import crypto from 'node:crypto'
import { gatewayRpc, GatewayError } from './gateway-rpc.js'
import type { GatewayStreamEvent } from './gateway-rpc.js'

// 重新匯出，讓路由層可直接 import
export { GatewayError }
export type { GatewayStreamEvent }

// ── 本地快取型別 ──────────────────────────────────────────────────────────────

/** 本地快取中的 Session 摘要 */
export interface LocalSession {
  sessionKey: string
  title?: string
  createdAt?: string
  /** 最後活躍時間（Date.now()），用於 gcIdle */
  lastActiveAt: number
}

// ── SessionManager ────────────────────────────────────────────────────────────

class SessionManager {
  private normalizeSessions(raw: unknown): Array<Record<string, unknown>> {
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as any).sessions)
        ? (raw as any).sessions
        : []

    return list
      .map((s: any) => {
        const sessionKey = s.sessionKey ?? s.key
        if (!sessionKey || typeof sessionKey !== 'string') return null
        return {
          sessionKey,
          title: typeof s.title === 'string' ? s.title : typeof s.label === 'string' ? s.label : undefined,
          createdAt:
            typeof s.createdAt === 'string'
              ? s.createdAt
              : typeof s.updatedAt === 'string'
                ? s.updatedAt
                : new Date().toISOString(),
          updatedAt:
            typeof s.updatedAt === 'string'
              ? s.updatedAt
              : typeof s.createdAt === 'string'
                ? s.createdAt
                : new Date().toISOString(),
        }
      })
      .filter(Boolean) as Array<Record<string, unknown>>
  }

  private normalizeMessages(sessionKey: string, raw: unknown): Array<Record<string, unknown>> {
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as any).messages)
        ? (raw as any).messages
        : []

    return list.map((m: any, idx: number) => {
      const role = m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'assistant'
      let text: string | undefined = typeof m.text === 'string' ? m.text : undefined
      if (!text && Array.isArray(m.content)) {
        text = m.content
          .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n')
      }
      return {
        id: typeof m.id === 'string' ? m.id : `${sessionKey}-${idx}-${m.timestamp ?? Date.now()}`,
        sessionKey,
        role,
        text,
        createdAt:
          typeof m.createdAt === 'string'
            ? m.createdAt
            : typeof m.timestamp === 'number'
              ? new Date(m.timestamp).toISOString()
              : new Date().toISOString(),
      }
    })
  }

  /** 本地快取：token → (sessionKey → LocalSession) */
  private readonly cache = new Map<string, Map<string, LocalSession>>()

  /** 封存集合：token → Set<sessionKey>（AP in-memory，重啟後重置） */
  private readonly archiveSet = new Map<string, Set<string>>()

  private _tokenCache(token: string): Map<string, LocalSession> {
    let m = this.cache.get(token)
    if (!m) {
      m = new Map()
      this.cache.set(token, m)
    }
    return m
  }

  private _tokenArchive(token: string): Set<string> {
    let s = this.archiveSet.get(token)
    if (!s) {
      s = new Set()
      this.archiveSet.set(token, s)
    }
    return s
  }

  // ── 本地快取操作（無網路請求） ──────────────────────────────────────────────

  /** 取得本地快取的 Session（不發網路請求） */
  getLocalSession(token: string, sessionKey: string): LocalSession | null {
    return this.cache.get(token)?.get(sessionKey) ?? null
  }

  /** 更新本地快取中 Session 的最後活躍時間 */
  touch(token: string, sessionKey: string): void {
    const s = this.cache.get(token)?.get(sessionKey)
    if (s) s.lastActiveAt = Date.now()
  }

  /**
   * 清除閒置超過 maxIdleMs 的本地快取項目。
   * @param maxIdleMs 最大閒置時間（毫秒）
   */
  gcIdle(token: string, maxIdleMs: number): void {
    const m = this.cache.get(token)
    if (!m) return
    const threshold = Date.now() - maxIdleMs
    for (const [key, s] of m) {
      if (s.lastActiveAt < threshold) m.delete(key)
    }
  }

  // ── Session CRUD（透過 Gateway RPC） ────────────────────────────────────────

  /**
   * 取得 Session 清單，並附加 AP 端 in-memory 封存狀態。
   * @throws {GatewayError}
   */
  async list(token: string): Promise<unknown> {
    const raw = await gatewayRpc.request<unknown>(token, 'sessions.list')
    const sessions = this.normalizeSessions(raw)
    const archived = this._tokenArchive(token)
    return sessions.map((s) => ({
      ...s,
      archived: archived.has(s.sessionKey as string),
    }))
  }

  /**
   * 建立新 Session，並將結果加入本地快取。
   * @throws {GatewayError}
   */
  async create(token: string, title?: string): Promise<unknown> {
    // OpenClaw Gateway 無 sessions.create；以 sessions.reset 建立/重置新 key
    const sessionKey = `webchat-${Date.now()}`
    await gatewayRpc.request(token, 'sessions.reset', { key: sessionKey })

    const newSession = {
      sessionKey,
      title: title || '新對話',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const m = this._tokenCache(token)
    m.set(sessionKey, {
      sessionKey,
      title: newSession.title,
      createdAt: newSession.createdAt,
      lastActiveAt: Date.now(),
    })

    return newSession
  }

  /**
   * 取得指定 Session 的訊息歷史。
   * @throws {GatewayError}
   */
  async history(token: string, sessionKey: string): Promise<unknown> {
    this.touch(token, sessionKey)
    const raw = await gatewayRpc.request<unknown>(token, 'chat.history', { sessionKey, limit: 200 })
    return this.normalizeMessages(sessionKey, raw)
  }

  /**
   * 發送訊息（文字 + 圖片）至指定 Session（阻塞版，等待 AI 回覆完成）。
   * 圖片以 base64 編碼透過 RPC payload 傳遞。
   * @throws {GatewayError}
   */
  async send(
    token: string,
    sessionKey: string,
    text: string,
    images: Array<{ name: string; data: Uint8Array; mimeType: string }>,
  ): Promise<unknown> {
    this.touch(token, sessionKey)
    const attachments = images.map((img) => ({
      type: 'image',
      mimeType: img.mimeType,
      content: Buffer.from(img.data).toString('base64'),
      name: img.name,
    }))

    return gatewayRpc.request(token, 'chat.send', {
      sessionKey,
      message: text,
      // deliver=true：等待回覆完成後再返回，前端隨後 reload messages 可立即看到助手回應
      deliver: true,
      idempotencyKey: crypto.randomUUID(),
      attachments,
    })
  }

  /**
   * 以串流方式發送訊息，yield Gateway 串流事件與最終結果。
   *
   * - 若 Gateway 支援串流：yield { type:'chunk', text } + { type:'done', data }
   * - 若 Gateway 不支援串流：只 yield { type:'done', data }
   *
   * @throws {GatewayError} 連線失敗或 RPC 錯誤時拋出
   */
  async *sendStream(
    token: string,
    sessionKey: string,
    text: string,
    images: Array<{ name: string; data: Uint8Array; mimeType: string }>,
  ): AsyncGenerator<GatewayStreamEvent> {
    this.touch(token, sessionKey)
    const attachments = images.map((img) => ({
      type: 'image',
      mimeType: img.mimeType,
      content: Buffer.from(img.data).toString('base64'),
      name: img.name,
    }))

    yield* gatewayRpc.sendStream(
      token,
      sessionKey,
      text,
      attachments,
      crypto.randomUUID(),
    )
  }

  /**
   * 刪除單一 Session，並從本地快取移除。
   * @throws {GatewayError}
   */
  async delete(token: string, sessionKey: string): Promise<unknown> {
    const result = await gatewayRpc.request(token, 'sessions.delete', { key: sessionKey })
    this.cache.get(token)?.delete(sessionKey)
    return result
  }

  /**
   * 批次刪除 Session，並從本地快取移除。
   * @throws {GatewayError}
   */
  async deleteMany(token: string, sessionKeys: string[]): Promise<unknown> {
    const result = await gatewayRpc.request(token, 'sessions.deleteMany', { keys: sessionKeys })
    const m = this.cache.get(token)
    if (m) {
      for (const key of sessionKeys) m.delete(key)
    }
    return result
  }

  // ── Rename（透過 Gateway sessions.patch 更新 label） ────────────────────────

  /**
   * 重新命名 Session 標題，透過 Gateway RPC `sessions.patch` 持久化 label 欄位。
   * @throws {GatewayError}
   */
  async rename(token: string, sessionKey: string, title: string): Promise<{ sessionKey: string; title: string }> {
    await gatewayRpc.request(token, 'sessions.patch', { key: sessionKey, label: title })
    // 同步更新本地快取
    const local = this.cache.get(token)?.get(sessionKey)
    if (local) {
      local.title = title
    }
    return { sessionKey, title }
  }

  // ── Archive / Close（Gateway 無原生 archive RPC，採 AP in-memory fallback） ─

  /**
   * 封存 Session（AP 端 in-memory 狀態，AP 重啟後重置）。
   * Gateway 未提供 sessions.archive RPC，此為 fallback 實作。
   */
  archive(token: string, sessionKey: string): { archived: boolean; sessionKey: string } {
    this._tokenArchive(token).add(sessionKey)
    return { archived: true, sessionKey }
  }

  /**
   * 取消封存 Session（AP 端 in-memory 狀態）。
   */
  unarchive(token: string, sessionKey: string): { archived: boolean; sessionKey: string } {
    this._tokenArchive(token).delete(sessionKey)
    return { archived: false, sessionKey }
  }

  /**
   * 關閉（刪除）Session：呼叫 Gateway sessions.delete RPC 並清除本地狀態。
   * @throws {GatewayError}
   */
  async close(token: string, sessionKey: string): Promise<{ closed: boolean; sessionKey: string }> {
    await gatewayRpc.request(token, 'sessions.delete', { key: sessionKey })
    // 清除本地快取與封存狀態
    this.cache.get(token)?.delete(sessionKey)
    this._tokenArchive(token).delete(sessionKey)
    return { closed: true, sessionKey }
  }
}

/** 全域 SessionManager 單例 */
export const sessionManager = new SessionManager()
