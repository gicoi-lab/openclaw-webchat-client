<template>
  <div class="chat-input-area">
    <!-- 圖片預覽列 -->
    <div v-if="pendingImages.length > 0" class="image-previews">
      <div
        v-for="(img, i) in pendingImages"
        :key="i"
        class="preview-item"
      >
        <img :src="img.previewUrl" :alt="img.name" />
        <button
          class="preview-remove"
          type="button"
          :title="`移除 ${img.name}`"
          @click="removeImage(i)"
        >
          ×
        </button>
        <span class="preview-name">{{ img.name }}</span>
      </div>
    </div>

    <!-- 拖曳上傳區（點擊同樣可以觸發選檔） -->
    <div
      class="drop-zone"
      :class="{ 'drag-over': isDragOver }"
      @dragover.prevent="isDragOver = true"
      @dragleave.prevent="isDragOver = false"
      @drop.prevent="handleDrop"
      @click="fileInput?.click()"
    >
      <span v-if="isDragOver">放開以上傳圖片</span>
      <span v-else>📎 拖曳圖片至此，或點擊選取（最多 10 張，每張 ≤ 10MB）</span>
    </div>
    <!-- 隱藏 file input（支援多選） -->
    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      multiple
      style="display: none"
      @change="handleFileSelect"
    />

    <!-- 文字輸入 + 送出按鈕 -->
    <div class="input-row">
      <textarea
        ref="textareaEl"
        v-model="textInput"
        class="message-textarea"
        placeholder="輸入訊息… (Enter 送出，Shift+Enter 換行)"
        :disabled="sending"
        rows="2"
        @keydown="handleKeydown"
        @input="autoResize"
      />
      <button
        class="btn btn-primary send-btn"
        :disabled="sending || (!textInput.trim() && pendingImages.length === 0)"
        @click="handleSend"
      >
        <span v-if="sending" class="spinner-border spinner-border-sm" />
        <span v-else>送出</span>
      </button>
    </div>
    <div class="input-hint">Enter 送出 ／ Shift+Enter 換行</div>

    <!-- 錯誤提示 -->
    <div v-if="sendError" class="alert alert-danger py-1 px-2 mt-2 mb-0" style="font-size: 12px;">
      {{ sendError }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { PendingImage } from '../types'

const props = defineProps<{
  sending: boolean
}>()

const emit = defineEmits<{
  send: [payload: { text: string; images: PendingImage[] }]
}>()

const textInput = ref('')
const pendingImages = ref<PendingImage[]>([])
const isDragOver = ref(false)
const sendError = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)

const MAX_IMAGES = 10
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

/** 新增圖片（檢查限制） */
function addImages(files: File[]) {
  sendError.value = null
  for (const file of files) {
    if (pendingImages.value.length >= MAX_IMAGES) {
      sendError.value = `最多只能上傳 ${MAX_IMAGES} 張圖片`
      break
    }
    if (file.size > MAX_SIZE) {
      sendError.value = `圖片「${file.name}」超過 10MB 大小限制`
      continue
    }
    if (!file.type.startsWith('image/')) {
      sendError.value = `「${file.name}」不是支援的圖片格式`
      continue
    }
    pendingImages.value.push({
      file,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      size: file.size,
      mimeType: file.type,
    })
  }
}

/** 移除預覽圖片（釋放 ObjectURL） */
function removeImage(index: number) {
  const removed = pendingImages.value.splice(index, 1)
  URL.revokeObjectURL(removed[0].previewUrl)
}

/** 清除所有預覽（送出後） */
function clearImages() {
  for (const img of pendingImages.value) {
    URL.revokeObjectURL(img.previewUrl)
  }
  pendingImages.value = []
}

/** 處理拖曳放入 */
function handleDrop(e: DragEvent) {
  isDragOver.value = false
  const files = Array.from(e.dataTransfer?.files ?? [])
  addImages(files)
}

/** 處理 file input 選檔 */
function handleFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  addImages(files)
  // 重置 input 讓同一檔案可重新選取
  input.value = ''
}

/** Enter 送出、Shift+Enter 換行 */
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

/** 動態調整 textarea 高度 */
function autoResize() {
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`
}

/** 送出訊息 */
function handleSend() {
  if (props.sending) return
  const text = textInput.value
  if (!text.trim() && pendingImages.value.length === 0) return
  sendError.value = null
  emit('send', { text, images: [...pendingImages.value] })
  textInput.value = ''
  clearImages()
  // 重置高度
  if (textareaEl.value) {
    textareaEl.value.style.height = 'auto'
  }
}
</script>
