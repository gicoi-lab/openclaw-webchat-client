import { reactive, computed } from 'vue'
import type { AuthTokenSession } from '../types'

const LOCAL_STORAGE_KEY = 'auth'

/** 讀取儲存的登入狀態 */
function loadFromStorage(): AuthTokenSession | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as AuthTokenSession) : null
  } catch {
    return null
  }
}

/** 全域登入狀態 Store */
const state = reactive({
  session: loadFromStorage() as AuthTokenSession | null,
})

export const authStore = {
  /** 是否已登入 */
  isLoggedIn: computed(() => !!state.session?.token),
  /** 目前 Token */
  token: computed(() => state.session?.token ?? null),
  /** 登入（儲存 Token 至 localStorage） */
  login(token: string) {
    const session: AuthTokenSession = {
      token,
      verifiedAt: new Date().toISOString(),
    }
    state.session = session
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(session))
  },
  /** 登出（清除 Token） */
  logout() {
    state.session = null
    localStorage.removeItem(LOCAL_STORAGE_KEY)
  },
}
