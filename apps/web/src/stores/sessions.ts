import { reactive, computed } from 'vue'
import type { ChatSession, ChatMessage } from '../types'
import {
  fetchSessions,
  createSession,
  fetchMessages,
  sendMessage,
  streamMessage,
  archiveSession as apiArchiveSession,
  renameSession as apiRenameSession,
  closeSession as apiCloseSession,
  unauthorizedState,
} from '../api/client'
import { connectEventStream } from '../api/event-source'
import type { PushEvent } from '../api/event-source'
import type { PendingImage } from '../types'

const ASSISTANT_POLL_INTERVAL_MS = 2000
const ASSISTANT_POLL_TIMEOUT_MS = 30000

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Session 清單狀態 */
const state = reactive({
  sessions: [] as ChatSession[],
  currentSessionKey: null as string | null,
  messages: [] as ChatMessage[],
  loadingSessions: false,
  loadingMessages: false,
  sendingMessage: false,
  sessionsError: null as string | null,
  messagesError: null as string | null,
  /** 是否顯示封存項目 */
  showArchived: false,
  /** 正在封存/取消封存的 sessionKey（用於 loading 狀態） */
  archivingSessionKey: null as string | null,
  archiveError: null as string | null,
  /** 正在重新命名的 sessionKey（用於 loading 狀態） */
  renamingSessionKey: null as string | null,
  renameError: null as string | null,
  /** 正在關閉的 sessionKey（用於 loading 狀態） */
  closingSessionKey: null as string | null,
  closeError: null as string | null,
  /** SSE 串流進行中：目標 sessionKey */
  streamingSessionKey: null as string | null,
  /** SSE 串流累積文字（chunk 持續追加，供畫面即時顯示） */
  streamingText: '',
  /** 串流錯誤訊息（SSE 失敗時顯示） */
  streamingError: null as string | null,
  /** debug：最近一次發送使用的傳輸模式 */
  transportMode: 'idle' as 'idle' | 'stream' | 'fallback' | 'push',
  /** 持久 SSE 推播連線是否在線 */
  eventStreamConnected: false,
})

/** 持久 SSE 斷線函式（由 initEventStream 設定） */
let disconnectEventStream: (() => void) | null = null

/** 依 showArchived 過濾後的可見 Session 清單 */
const visibleSessions = computed<ChatSession[]>(() => {
  if (state.showArchived) return state.sessions
  return state.sessions.filter((s) => !s.archived)
})

export const sessionsStore = {
  state,
  visibleSessions,

  /** 全域 UNAUTHORIZED 狀態（供 ChatView watch） */
  unauthorizedState,

  /** 載入 Session 清單 */
  async loadSessions() {
    state.loadingSessions = true
    state.sessionsError = null
    const resp = await fetchSessions()
    state.loadingSessions = false
    if (!resp.ok || !resp.data) {
      state.sessionsError = resp.error?.message ?? 'Session 清單載入失敗'
      return
    }
    // 相容 Gateway 回傳格式：直接陣列或包裝物件
    if (Array.isArray(resp.data)) {
      state.sessions = resp.data
    } else if (Array.isArray((resp.data as any).sessions)) {
      state.sessions = (resp.data as any).sessions
    } else {
      state.sessions = []
    }
  },

  /** 建立新 Session */
  async createSession(title?: string): Promise<ChatSession | null> {
    const resp = await createSession(title)
    if (!resp.ok || !resp.data) {
      return null
    }
    // 加入清單頂端
    const newSession = resp.data as ChatSession
    state.sessions.unshift(newSession)
    return newSession
  },

  /** 切換目前 Session 並載入訊息 */
  async selectSession(sessionKey: string) {
    if (state.currentSessionKey === sessionKey) return
    state.currentSessionKey = sessionKey
    state.messages = []
    state.messagesError = null
    // 清除串流狀態（避免顯示舊 session 的串流）
    state.streamingText = ''
    state.streamingSessionKey = null
    state.streamingError = null
    await sessionsStore.loadMessages()
  },

  /** 重新載入目前 Session 的訊息 */
  async loadMessages() {
    const key = state.currentSessionKey
    if (!key) return
    state.loadingMessages = true
    state.messagesError = null
    const resp = await fetchMessages(key)
    state.loadingMessages = false
    if (!resp.ok || !resp.data) {
      state.messagesError = resp.error?.message ?? '訊息載入失敗'
      return
    }
    if (Array.isArray(resp.data)) {
      state.messages = resp.data
    } else if (Array.isArray((resp.data as any).messages)) {
      state.messages = (resp.data as any).messages
    } else {
      state.messages = []
    }
  },

  async waitForAssistantReply(previousAssistantTs: number | null) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < ASSISTANT_POLL_TIMEOUT_MS) {
      await sessionsStore.loadMessages()

      const assistantMessages = state.messages.filter((m) => m.role === 'assistant')
      const newestAssistantTs = assistantMessages.reduce((max, m) => {
        const ts = new Date(m.createdAt).getTime()
        return Number.isFinite(ts) ? Math.max(max, ts) : max
      }, 0)

      // 首次等待：只要出現 assistant 訊息就視為成功
      if (previousAssistantTs === null && assistantMessages.length > 0) {
        return
      }

      // 非首次：需出現比發送前更新的 assistant 訊息
      if (previousAssistantTs !== null && newestAssistantTs > previousAssistantTs) {
        return
      }

      await sleep(ASSISTANT_POLL_INTERVAL_MS)
    }
  },

  // ── 持久 SSE 推播 ──────────────────────────────────────────────────────────

  /**
   * 初始化持久 SSE 事件流。
   * 在 loadSessions() 成功後呼叫，建立長連線持續接收 Gateway 推播。
   */
  initEventStream() {
    // 避免重複建立
    if (disconnectEventStream) {
      disconnectEventStream()
      disconnectEventStream = null
    }

    disconnectEventStream = connectEventStream(
      // onEvent：處理推播事件
      (event: PushEvent) => {
        switch (event.type) {
          case 'chunk': {
            // 僅當正在串流且 sessionKey 匹配當前 session 時追加文字
            if (
              state.streamingSessionKey === event.sessionKey &&
              state.currentSessionKey === event.sessionKey
            ) {
              state.streamingText += event.text
              state.transportMode = 'push'
            }
            break
          }
          case 'agent-start': {
            // 若目前 session 收到 agent-start，設定串流狀態
            if (state.currentSessionKey === event.sessionKey && state.sendingMessage) {
              state.streamingSessionKey = event.sessionKey
              state.streamingText = ''
              state.transportMode = 'push'
            }
            break
          }
          case 'agent-end': {
            // agent 回覆結束，但等 message-final 才真正完成
            break
          }
          case 'message-final': {
            // 完成訊息到達：清除串流狀態、重載訊息
            if (state.streamingSessionKey === event.sessionKey) {
              state.streamingText = ''
              state.streamingSessionKey = null
              state.sendingMessage = false
            }
            // 無論是否為當前 session，都重載訊息（當前 session）
            if (state.currentSessionKey === event.sessionKey) {
              sessionsStore.loadMessages()
            }
            break
          }
          case 'keepalive': {
            // keepalive 不需特殊處理
            break
          }
        }
      },
      // onConnected：連線狀態回調
      (connected: boolean) => {
        state.eventStreamConnected = connected
      },
    )
  },

  /**
   * 發送訊息（文字 + 圖片）。
   *
   * 推播優先策略（T8）：
   * 1. 若持久 SSE 在線 → 僅 POST /messages（REST），chunk 由持久 SSE 自動推入
   * 2. 若持久 SSE 離線 → 回退至原有 SSE stream + polling fallback 流程
   */
  async sendMessage(text: string, images: PendingImage[]): Promise<boolean> {
    const key = state.currentSessionKey
    if (!key) return false

    // 記錄發送前最新 assistant 訊息時間（供 polling fallback 判斷）
    const previousAssistantTs = state.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => new Date(m.createdAt).getTime())
      .filter((ts) => Number.isFinite(ts))
      .reduce((max, ts) => Math.max(max, ts), -1)

    state.sendingMessage = true
    state.streamingSessionKey = key
    state.streamingText = ''
    state.streamingError = null
    state.transportMode = 'idle'

    // ── 推播模式：持久 SSE 在線時，僅 REST 發送，chunk 由推播自動處理 ────────
    if (state.eventStreamConnected) {
      state.transportMode = 'push'
      const resp = await sendMessage(key, text, images)

      if (!resp.ok) {
        state.sendingMessage = false
        state.streamingText = ''
        state.streamingSessionKey = null
        // UNAUTHORIZED 在 apiFetch 中已設定 unauthorizedState.triggered
        return false
      }

      // REST 發送成功，chunk 和 message-final 由持久 SSE 推送
      // 設定逾時保底：若 30 秒內未收到 message-final，fallback 重載
      const pushTimeout = setTimeout(() => {
        if (state.sendingMessage && state.streamingSessionKey === key) {
          console.warn('[sendMessage] 推播逾時，fallback 重載訊息')
          state.streamingText = ''
          state.streamingSessionKey = null
          state.sendingMessage = false
          sessionsStore.loadMessages()
        }
      }, ASSISTANT_POLL_TIMEOUT_MS)

      // 等待 message-final 到達（由 initEventStream 的 onEvent 設定 sendingMessage = false）
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!state.sendingMessage || state.streamingSessionKey !== key) {
            clearInterval(check)
            clearTimeout(pushTimeout)
            resolve()
          }
        }, 200)
      })

      return true
    }

    // ── Fallback 模式：持久 SSE 離線，使用原有 per-request SSE 串流 ──────────
    let streamSucceeded = false
    let streamReceivedChunk = false
    let streamFailedBeforeChunk = false

    try {
      for await (const event of streamMessage(key, text, images)) {
        // 若 session 已切換，放棄本次串流結果
        if (state.currentSessionKey !== key) break

        if (event.type === 'status') {
          // 已在前端顯示 sendingMessage，無需額外處理
        } else if (event.type === 'chunk') {
          // 即時追加串流文字至畫面
          streamReceivedChunk = true
          state.transportMode = 'stream'
          state.streamingText += event.text
        } else if (event.type === 'done') {
          // 串流完成：先 reload；若回覆尚未落盤，再短輪詢補抓
          streamSucceeded = true
          state.transportMode = 'stream'
          state.streamingText = ''
          state.streamingSessionKey = null
          await sessionsStore.loadMessages()
          await sessionsStore.waitForAssistantReply(previousAssistantTs >= 0 ? previousAssistantTs : null)
          break
        } else if (event.type === 'error') {
          // 串流失敗：依錯誤碼決定是否 fallback
          if (event.code === 'UNAUTHORIZED') {
            // UNAUTHORIZED 不 fallback，直接結束（全域 unauthorizedState 已設定）
            state.sendingMessage = false
            state.streamingText = ''
            state.streamingSessionKey = null
            return false
          }
          // 其他錯誤（STREAMING_UNAVAILABLE / NETWORK_ERROR 等）
          console.warn('[sendMessage] SSE 失敗:', event.code, event.message)
          state.streamingError = event.message
          if (!streamReceivedChunk) {
            streamFailedBeforeChunk = true
          }
          state.streamingText = ''
          state.streamingSessionKey = null
          break
        }
      }
    } catch (err) {
      // SSE generator 拋出例外 → 降級至 polling
      console.warn('[sendMessage] SSE 例外，降級至 polling:', err)
      state.streamingText = ''
      state.streamingSessionKey = null
    }

    // ── Fallback：REST + polling ───────────────────────────────────────────
    if (!streamSucceeded) {
      // 若 SSE 已收到 chunk，代表請求已送達且串流曾輸出；避免重複送出，直接 reload
      if (streamReceivedChunk && !streamFailedBeforeChunk) {
        await sessionsStore.loadMessages()
        state.sendingMessage = false
        return true
      }

      // 僅在「未收到 chunk 就失敗」時才降級為 REST 重送
      state.transportMode = 'fallback'
      const resp = await sendMessage(key, text, images)
      state.sendingMessage = false

      if (!resp.ok) {
        // UNAUTHORIZED 在 apiFetch 中已設定 unauthorizedState.triggered
        return false
      }

      // 等待 assistant 回覆出現（polling）
      await sessionsStore.waitForAssistantReply(previousAssistantTs >= 0 ? previousAssistantTs : null)
      return true
    }

    state.sendingMessage = false
    return true
  },

  /**
   * 重新命名 Session 標題。
   * 呼叫 API 持久化至 Gateway，成功後即時更新本地清單。
   */
  async renameSession(sessionKey: string, title: string): Promise<boolean> {
    state.renamingSessionKey = sessionKey
    state.renameError = null
    const resp = await apiRenameSession(sessionKey, title)
    state.renamingSessionKey = null
    if (!resp.ok) {
      state.renameError = resp.error?.message ?? '重新命名失敗'
      return false
    }
    // 更新清單中的標題
    const idx = state.sessions.findIndex((s) => s.sessionKey === sessionKey)
    if (idx >= 0) {
      state.sessions[idx] = { ...state.sessions[idx], title }
    }
    return true
  },

  /**
   * 封存或取消封存 Session。
   * 成功後即時更新清單；若封存的是當前 Session，清除選中狀態。
   */
  async archiveSession(sessionKey: string, archived: boolean): Promise<boolean> {
    state.archivingSessionKey = sessionKey
    state.archiveError = null
    const resp = await apiArchiveSession(sessionKey, archived)
    state.archivingSessionKey = null
    if (!resp.ok) {
      state.archiveError = resp.error?.message ?? (archived ? '封存失敗' : '取消封存失敗')
      return false
    }
    // 更新清單中的封存狀態
    const idx = state.sessions.findIndex((s) => s.sessionKey === sessionKey)
    if (idx >= 0) {
      state.sessions[idx] = { ...state.sessions[idx], archived }
    }
    // 若封存的是當前選中 Session，清除右側內容
    if (archived && state.currentSessionKey === sessionKey) {
      state.currentSessionKey = null
      state.messages = []
      state.messagesError = null
    }
    return true
  },

  /**
   * 關閉（刪除）Session。
   * 成功後從清單移除；若關閉的是當前 Session，清除選中狀態。
   */
  async closeSession(sessionKey: string): Promise<boolean> {
    state.closingSessionKey = sessionKey
    state.closeError = null
    const resp = await apiCloseSession(sessionKey)
    state.closingSessionKey = null
    if (!resp.ok) {
      state.closeError = resp.error?.message ?? '關閉 Session 失敗'
      return false
    }
    // 從清單移除
    state.sessions = state.sessions.filter((s) => s.sessionKey !== sessionKey)
    // 若關閉的是當前選中 Session，清除右側內容
    if (state.currentSessionKey === sessionKey) {
      state.currentSessionKey = null
      state.messages = []
      state.messagesError = null
    }
    return true
  },

  /** 切換顯示/隱藏封存 Session */
  toggleShowArchived() {
    state.showArchived = !state.showArchived
  },

  /** 清除狀態（登出時使用） */
  reset() {
    // 斷開持久 SSE 連線
    if (disconnectEventStream) {
      disconnectEventStream()
      disconnectEventStream = null
    }
    state.sessions = []
    state.currentSessionKey = null
    state.messages = []
    state.loadingSessions = false
    state.loadingMessages = false
    state.sendingMessage = false
    state.sessionsError = null
    state.messagesError = null
    state.showArchived = false
    state.archivingSessionKey = null
    state.archiveError = null
    state.renamingSessionKey = null
    state.renameError = null
    state.closingSessionKey = null
    state.closeError = null
    state.streamingSessionKey = null
    state.streamingText = ''
    state.streamingError = null
    state.transportMode = 'idle'
    state.eventStreamConnected = false
  },
}
