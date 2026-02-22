/**
 * Gateway 操作封裝層（向後相容介面）
 *
 * 此模組保持既有函式簽章，供 auth 路由等直接使用。
 * Session / Message 操作已遷移至 session-manager.ts，
 * 路由層建議直接 import session-manager。
 */

import { sessionManager, GatewayError } from './session-manager.js'
import { gatewayRpc } from './gateway-rpc.js'

// 重新匯出 GatewayError，讓路由層可直接 import
export { GatewayError }

// ── 驗證 ─────────────────────────────────────────────────────────────────────

/**
 * 驗證 Token 有效性（透過 Gateway WS connect 握手）。
 * @returns true = 有效；false = 無效或已過期
 * @throws {GatewayError} Gateway 無法連線時拋出（code: GATEWAY_CONNECT_FAILED）
 */
export async function verifyToken(token: string): Promise<boolean> {
  return gatewayRpc.verifyToken(token)
}

// ── Session 操作（委派至 SessionManager） ─────────────────────────────────────

/** @see SessionManager.list */
export async function getSessions(token: string): Promise<unknown> {
  return sessionManager.list(token)
}

/** @see SessionManager.create */
export async function createSession(token: string, title?: string): Promise<unknown> {
  return sessionManager.create(token, title)
}

/** @see SessionManager.archive */
export function archiveSession(
  token: string,
  sessionKey: string,
  archived: boolean,
): { archived: boolean; sessionKey: string } {
  return archived
    ? sessionManager.archive(token, sessionKey)
    : sessionManager.unarchive(token, sessionKey)
}

/** @see SessionManager.close */
export async function closeSession(
  token: string,
  sessionKey: string,
): Promise<{ closed: boolean; sessionKey: string }> {
  return sessionManager.close(token, sessionKey)
}

/** @see SessionManager.rename */
export async function renameSession(
  token: string,
  sessionKey: string,
  title: string,
): Promise<{ sessionKey: string; title: string }> {
  return sessionManager.rename(token, sessionKey, title)
}

// ── 訊息操作（委派至 SessionManager） ─────────────────────────────────────────

/** @see SessionManager.history */
export async function getMessages(token: string, sessionKey: string): Promise<unknown> {
  return sessionManager.history(token, sessionKey)
}

/** @see SessionManager.send */
export async function sendMessage(
  token: string,
  sessionKey: string,
  text: string,
  images: Array<{ name: string; data: Uint8Array; mimeType: string }>,
): Promise<unknown> {
  return sessionManager.send(token, sessionKey, text, images)
}
