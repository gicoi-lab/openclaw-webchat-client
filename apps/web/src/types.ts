// OpenClaw Web Chat Client - 前端共用型別

/** 前端本地登入狀態（儲存於 localStorage） */
export interface AuthTokenSession {
  token: string
  verifiedAt: string // ISO datetime
}

/** 對話 Session */
export interface ChatSession {
  sessionKey: string
  title?: string
  createdAt?: string
  updatedAt?: string
  lastMessagePreview?: string
  /** 封存狀態（AP 端 in-memory，AP 重啟後重置） */
  archived?: boolean
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
  /** 前端暫時預覽用 URL（ObjectURL） */
  previewObjectUrl?: string
}

/** API 回應包裝 */
export interface ApiResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
}

/** 上傳前的預覽圖片（前端暫存） */
export interface PendingImage {
  file: File
  previewUrl: string
  name: string
  size: number
  mimeType: string
}
