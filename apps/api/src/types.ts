// OpenClaw Web Chat Client - AP 端共用型別

/** 標準 API 回應包裝 */
export interface ApiResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
}

/** 對話 Session */
export interface ChatSession {
  sessionKey: string
  title?: string
  createdAt?: string
  updatedAt?: string
  lastMessagePreview?: string
}

/** 對話訊息 */
export interface ChatMessage {
  id: string
  sessionKey: string
  role: 'user' | 'assistant' | 'system'
  text?: string
  images?: MessageImage[]
  createdAt: string
}

/** 訊息圖片 */
export interface MessageImage {
  id?: string
  name: string
  mimeType: string
  size: number
  url?: string
}

/** 成功回應輔助函式 */
export function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data }
}

/** 錯誤回應輔助函式 */
export function fail(code: string, message: string, details?: unknown): ApiResponse<never> {
  return { ok: false, error: { code, message, details } }
}
