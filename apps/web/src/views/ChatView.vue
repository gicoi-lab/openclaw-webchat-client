<template>
  <div class="chat-layout">
    <!-- 左側：Session 清單 -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="brand">
          <div class="brand-icon">O</div>
          <span>OpenClaw Chat</span>
        </div>
      </div>

      <div class="sidebar-actions">
        <button
          class="btn btn-primary btn-sm w-100"
          :disabled="creatingSession"
          @click="handleNewSession"
        >
          <span v-if="creatingSession" class="spinner-border spinner-border-sm me-1" />
          {{ creatingSession ? '建立中…' : '+ 新對話' }}
        </button>
      </div>

      <!-- 封存切換按鈕 -->
      <div class="archive-toggle">
        <button
          class="btn btn-link btn-sm p-0"
          :class="{ active: store.state.showArchived }"
          @click="store.toggleShowArchived()"
        >
          {{ store.state.showArchived ? '▾ 隱藏封存' : '▸ 顯示封存' }}
        </button>
      </div>

      <!-- Session 清單 -->
      <div class="session-list">
        <div v-if="store.state.loadingSessions" class="session-loading">
          <span class="spinner-border spinner-border-sm me-2" />
          載入中…
        </div>
        <div v-else-if="store.state.sessionsError" class="session-error">
          {{ store.state.sessionsError }}
          <button class="btn btn-link btn-sm p-0 ms-1" @click="store.loadSessions()">重試</button>
        </div>
        <div v-else-if="store.visibleSessions.value.length === 0" class="session-empty">
          尚無對話，點擊「新對話」開始
        </div>
        <div
          v-for="session in store.visibleSessions.value"
          :key="session.sessionKey"
          class="session-item"
          :class="{
            active: store.state.currentSessionKey === session.sessionKey,
            archived: session.archived,
          }"
          @click="!session.archived && store.selectSession(session.sessionKey)"
        >
          <div class="session-main">
            <!-- 內聯編輯模式 -->
            <template v-if="editingSessionKey === session.sessionKey">
              <input
                class="session-title-input"
                v-model="editingTitle"
                @keydown.enter.prevent="confirmRename()"
                @keydown.escape.prevent="cancelRename()"
                @blur="confirmRename()"
                @click.stop
                ref="renamingInput"
              />
            </template>
            <!-- 一般顯示模式 -->
            <template v-else>
              <div class="session-title">
                <span v-if="session.archived" class="archived-badge">封存</span>
                {{ session.title || session.sessionKey }}
              </div>
            </template>
            <div class="session-meta">
              {{ formatTime(session.updatedAt ?? session.createdAt) }}
            </div>
          </div>
          <!-- 操作按鈕（hover 顯示） -->
          <div class="session-actions" @click.stop>
            <!-- 重新命名按鈕 -->
            <button
              v-if="!session.archived && editingSessionKey !== session.sessionKey"
              class="btn-action rename"
              title="重新命名"
              @click.stop="startRename(session.sessionKey, session.title || session.sessionKey)"
            >
              ✎
            </button>
            <span
              v-if="store.state.archivingSessionKey === session.sessionKey"
              class="spinner-border spinner-border-sm"
            />
            <template v-else>
              <button
                v-if="session.archived"
                class="btn-action unarchive"
                title="取消封存"
                @click.stop="handleUnarchive(session.sessionKey)"
              >
                ↩
              </button>
              <button
                v-else
                class="btn-action archive"
                title="封存"
                @click.stop="handleArchive(session.sessionKey)"
              >
                ⊟
              </button>
            </template>
            <span
              v-if="store.state.closingSessionKey === session.sessionKey"
              class="spinner-border spinner-border-sm"
            />
            <button
              v-else
              class="btn-action close-session"
              title="關閉（永久刪除）"
              @click.stop="handleClose(session.sessionKey)"
            >
              ✕
            </button>
          </div>
        </div>
      </div>

      <!-- 操作錯誤提示 -->
      <div v-if="store.state.renameError" class="sidebar-error">
        重新命名失敗：{{ store.state.renameError }}
      </div>
      <div v-if="store.state.archiveError" class="sidebar-error">
        封存失敗：{{ store.state.archiveError }}
      </div>
      <div v-if="store.state.closeError" class="sidebar-error">
        關閉失敗：{{ store.state.closeError }}
      </div>

      <div class="sidebar-footer">
        <button class="btn logout-btn btn-sm" @click="handleLogout">登出</button>
      </div>
    </aside>

    <!-- 右側：對話主區域 -->
    <main class="chat-main">
      <template v-if="store.state.currentSessionKey">
        <!-- 對話 Header -->
        <div class="chat-header">
          <span>{{ currentSession?.title || store.state.currentSessionKey || '對話' }}</span>
          <span class="transport-badge" :class="store.state.transportMode">
            {{ transportModeLabel }}
          </span>
        </div>

        <!-- 訊息列表 -->
        <div ref="messagesEl" class="chat-messages">
          <div v-if="store.state.loadingMessages" class="messages-loading">
            <span class="spinner-border spinner-border-sm me-2" />
            載入訊息中…
          </div>
          <div v-else-if="store.state.messagesError" class="messages-error">
            {{ store.state.messagesError }}
            <button class="btn btn-link btn-sm p-0 ms-1" @click="store.loadMessages()">
              重試
            </button>
          </div>
          <div v-else-if="store.state.messages.length === 0 && !isStreaming" class="messages-empty">
            尚無訊息，輸入內容開始對話
          </div>
          <template v-else>
            <div
              v-for="msg in store.state.messages"
              :key="msg.id"
              class="message-bubble"
              :class="msg.role"
            >
              <div class="bubble-content">
                <span v-if="msg.text">{{ msg.text }}</span>
                <div v-if="msg.images?.length" class="message-images">
                  <img
                    v-for="img in msg.images"
                    :key="img.id ?? img.name"
                    :src="img.url ?? img.previewObjectUrl"
                    :alt="img.name"
                    :title="img.name"
                  />
                </div>
              </div>
              <div class="bubble-meta">{{ formatTime(msg.createdAt) }}</div>
            </div>

            <!-- 串流中的 AI 訊息泡泡（即時顯示 chunk） -->
            <div
              v-if="isStreaming"
              class="message-bubble assistant streaming-bubble"
            >
              <div class="bubble-content">
                <span v-if="store.state.streamingText">{{ store.state.streamingText }}</span>
                <span class="streaming-cursor" />
              </div>
              <div class="bubble-meta">傳送中…</div>
            </div>
          </template>
        </div>

        <!-- 輸入區 -->
        <MessageInput
          :sending="store.state.sendingMessage"
          @send="handleSend"
        />
      </template>

      <!-- 尚未選擇 Session 的佔位畫面 -->
      <div v-else class="chat-placeholder">
        <div class="placeholder-icon">💬</div>
        <p>請從左側選擇對話，或建立新對話</p>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { authStore } from '../stores/auth'
import { sessionsStore as store } from '../stores/sessions'
import MessageInput from '../components/MessageInput.vue'
import type { PendingImage } from '../types'

const router = useRouter()
const route = useRoute()
const messagesEl = ref<HTMLElement | null>(null)
const creatingSession = ref(false)

/** 內聯編輯：正在編輯的 sessionKey */
const editingSessionKey = ref<string | null>(null)
/** 內聯編輯：編輯中的標題文字 */
const editingTitle = ref('')

const currentSession = computed(() =>
  store.state.sessions.find((s) => s.sessionKey === store.state.currentSessionKey),
)

/** 是否正在串流（用於顯示串流訊息泡泡） */
const isStreaming = computed(
  () =>
    store.state.streamingSessionKey === store.state.currentSessionKey &&
    store.state.sendingMessage,
)

const transportModeLabel = computed(() => {
  if (store.state.transportMode === 'push') return 'push'
  if (store.state.transportMode === 'stream') return 'stream'
  if (store.state.transportMode === 'fallback') return 'fallback'
  return 'idle'
})

/** 格式化時間顯示 */
function formatTime(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-TW', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/** 捲動至最新訊息 */
async function scrollToBottom() {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}

/** 建立新 Session */
async function handleNewSession() {
  creatingSession.value = true
  const session = await store.createSession()
  creatingSession.value = false
  if (session) {
    await store.selectSession(session.sessionKey)
  }
}

/** 封存 Session（含 confirm） */
async function handleArchive(sessionKey: string) {
  if (!window.confirm('確定要封存此對話？封存後可在「顯示封存」中找到，並可取消封存。')) return
  await store.archiveSession(sessionKey, true)
}

/** 取消封存 Session */
async function handleUnarchive(sessionKey: string) {
  await store.archiveSession(sessionKey, false)
}

/** 關閉（永久刪除）Session（含 confirm） */
async function handleClose(sessionKey: string) {
  const session = store.state.sessions.find((s) => s.sessionKey === sessionKey)
  const name = session?.title || sessionKey
  if (!window.confirm(`確定要永久關閉「${name}」？此操作無法復原。`)) return
  await store.closeSession(sessionKey)
}

/** 開始內聯編輯 Session 標題 */
function startRename(sessionKey: string, currentTitle: string) {
  editingSessionKey.value = sessionKey
  editingTitle.value = currentTitle
}

/** 確認重新命名 */
async function confirmRename() {
  const key = editingSessionKey.value
  if (!key) return
  const trimmed = editingTitle.value.trim()
  editingSessionKey.value = null
  if (!trimmed) return // 空白標題不送出
  // 若標題未變更，不送出
  const session = store.state.sessions.find((s) => s.sessionKey === key)
  if (session && (session.title || session.sessionKey) === trimmed) return
  await store.renameSession(key, trimmed)
}

/** 取消編輯 */
function cancelRename() {
  editingSessionKey.value = null
  editingTitle.value = ''
}

/** 處理登出 */
function handleLogout() {
  authStore.logout()
  store.reset()
  router.push({ name: 'login' })
}

/** 處理發送訊息 */
async function handleSend(payload: { text: string; images: PendingImage[] }) {
  const success = await store.sendMessage(payload.text, payload.images)
  if (success) {
    scrollToBottom()
  }
}

// ── UNAUTHORIZED 自動登出監聽 ─────────────────────────────────────────────────
// 任何 API 請求收到 401 時，unauthorizedState.triggered 會被設為 true
watch(
  () => store.unauthorizedState.triggered,
  (triggered) => {
    if (!triggered) return
    // 重置 flag，避免重複觸發
    store.unauthorizedState.triggered = false
    // 執行登出
    authStore.logout()
    store.reset()
    // 導回登入頁，帶上 reason 讓登入頁顯示提示
    router.push({ name: 'login', query: { reason: 'session_expired' } })
  },
)

// 訊息更新時捲動至底部
watch(
  () => store.state.messages.length,
  () => scrollToBottom(),
)

// 內聯編輯啟動時自動聚焦並選取全文
watch(editingSessionKey, async (key) => {
  if (!key) return
  await nextTick()
  const input = document.querySelector('.session-title-input') as HTMLInputElement | null
  if (input) {
    input.focus()
    input.select()
  }
})

// 串流文字追加時捲動至底部
watch(
  () => store.state.streamingText,
  () => {
    if (isStreaming.value) scrollToBottom()
  },
)

onMounted(async () => {
  await store.loadSessions()
  // loadSessions 成功後，啟動持久 SSE 推播連線
  if (!store.state.sessionsError) {
    store.initEventStream()
  }
})
</script>

<style scoped>
/* ── Session 列表項目 ─────────────────────────────────────────────────────── */
.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.session-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.session-item.active {
  background: rgba(99, 179, 237, 0.15);
}

.session-item.archived {
  opacity: 0.55;
  cursor: default;
}

.session-main {
  flex: 1;
  min-width: 0;
}

.archived-badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.12);
  color: #a0aec0;
  margin-right: 4px;
  vertical-align: middle;
}

/* ── 操作按鈕（hover 顯示） ──────────────────────────────────────────────── */
.session-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.session-item:hover .session-actions {
  opacity: 1;
}

.btn-action {
  background: none;
  border: none;
  padding: 2px 5px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  color: #a0aec0;
  line-height: 1;
  transition: background 0.1s, color 0.1s;
}

.btn-action:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #e2e8f0;
}

.btn-action.close-session:hover {
  background: rgba(245, 101, 101, 0.2);
  color: #fc8181;
}

.btn-action.unarchive:hover {
  background: rgba(72, 187, 120, 0.2);
  color: #68d391;
}

.btn-action.rename:hover {
  background: rgba(99, 179, 237, 0.2);
  color: #63b3ed;
}

/* ── 內聯編輯標題 Input ──────────────────────────────────────────────────── */
.session-title-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(99, 179, 237, 0.5);
  border-radius: 4px;
  color: #e2e8f0;
  padding: 2px 6px;
  font-size: 13px;
  outline: none;
}

.session-title-input:focus {
  border-color: #63b3ed;
  box-shadow: 0 0 0 2px rgba(99, 179, 237, 0.25);
}

/* ── 封存切換 ─────────────────────────────────────────────────────────────── */
.archive-toggle {
  padding: 4px 12px 0;
}

.archive-toggle .btn-link {
  font-size: 12px;
  color: #718096;
  text-decoration: none;
}

.archive-toggle .btn-link:hover,
.archive-toggle .btn-link.active {
  color: #a0aec0;
}

/* ── 操作錯誤 ─────────────────────────────────────────────────────────────── */
.sidebar-error {
  margin: 4px 12px;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(245, 101, 101, 0.15);
  color: #fc8181;
  font-size: 12px;
}

/* ── 串流訊息泡泡 ─────────────────────────────────────────────────────────── */
.streaming-bubble {
  opacity: 0.9;
}

.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: currentColor;
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.transport-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #a0aec0;
}

.transport-badge.push {
  color: #63b3ed;
  border-color: rgba(99, 179, 237, 0.45);
}

.transport-badge.stream {
  color: #68d391;
  border-color: rgba(104, 211, 145, 0.45);
}

.transport-badge.fallback {
  color: #f6ad55;
  border-color: rgba(246, 173, 85, 0.45);
}
</style>
