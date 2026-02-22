<template>
  <div class="login-page">
    <div class="login-card">
      <!-- 品牌 Logo -->
      <div class="login-logo">
        <div class="logo-icon">O</div>
        <h1>OpenClaw Chat</h1>
      </div>

      <p class="text-muted mb-4" style="font-size: 14px;">
        請輸入您的 OpenClaw Access Token 以繼續
      </p>

      <!-- Token 過期提示（由 ChatView 重導時帶入 reason=session_expired） -->
      <div
        v-if="sessionExpired"
        class="alert alert-warning py-2 mb-3"
        style="font-size: 13px;"
      >
        登入已過期，請重新輸入 Token 登入。
      </div>

      <!-- 登入表單 -->
      <form @submit.prevent="handleLogin">
        <div class="mb-3">
          <label for="token" class="form-label fw-semibold" style="font-size: 14px;">
            Access Token
          </label>
          <textarea
            id="token"
            v-model="tokenInput"
            class="form-control token-input"
            placeholder="貼上您的 OpenClaw Token..."
            rows="3"
            :disabled="loading"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.ctrl.prevent="handleLogin"
          />
          <div class="form-text">可貼上純 Token，或直接貼上含 `?token=` 的 OpenClaw URL</div>
        </div>

        <!-- 錯誤提示 -->
        <div v-if="error" class="alert alert-danger py-2 mb-3" style="font-size: 13px;">
          {{ error }}
        </div>

        <button
          type="submit"
          class="btn btn-primary w-100"
          :disabled="loading || !tokenInput.trim()"
        >
          <span v-if="loading" class="spinner-border spinner-border-sm me-2" role="status" />
          {{ loading ? '驗證中…' : '登入' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { verifyToken } from '../api/client'
import { authStore } from '../stores/auth'

const router = useRouter()
const route = useRoute()
const tokenInput = ref('')
const loading = ref(false)
const error = ref<string | null>(null)

/** 若由 Token 過期自動重導而來，顯示提示訊息 */
const sessionExpired = computed(() => route.query.reason === 'session_expired')

/** 處理登入 */
function normalizeToken(input: string): string {
  const raw = input.trim()
  if (!raw) return ''

  // 支援直接貼上 Dashboard URL（例如：https://host:8443/?token=xxx）
  try {
    const url = new URL(raw)
    const qToken = url.searchParams.get('token')
    if (qToken) return qToken.trim()
  } catch {
    // 非 URL，當作純 token
  }

  return raw
}

async function handleLogin() {
  const token = normalizeToken(tokenInput.value)
  if (!token) return

  loading.value = true
  error.value = null

  const resp = await verifyToken(token)
  loading.value = false

  if (resp.ok) {
    authStore.login(token)
    router.push({ name: 'chat' })
  } else {
    error.value = resp.error?.message ?? 'Token 驗證失敗，請確認後重試'
  }
}
</script>
