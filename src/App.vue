<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CaptureView from './components/CaptureView.vue'
import { t } from './lib/i18n'

type View = 'error' | 'capture' | 'done'

const view = ref<View>('capture')
const errorKey = ref<'linkMissing' | null>(null)
/**
 * 从网址路径取出采集编号，作为本次会话的 session_id。
 *
 * 这里必须防御三种输入（编号来自 URL，用户可控）：
 *   ① 非法百分号编码（如 /100%、/abc%2）—— decodeURIComponent 会抛 URIError。
 *      它在模块顶层求值，一旦抛出会让整页白屏，所以必须兜住，
 *      退回使用原始路径段（未解码总比打不开页面好）。
 *   ② 控制字符（如 %00 解出的 \u0000）—— 存进后端会让后续展示与查询出问题，直接去掉。
 *   ③ 空编号 —— 由调用方判空后给出提示。
 */
function readSessionId(): string {
  const seg = location.pathname.split('/').filter(Boolean).pop() ?? ''
  let id = seg
  try {
    id = decodeURIComponent(seg)
  } catch {
    // 编码非法：保留原始串，不阻断页面
  }
  return id.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

// 同一链接可反复采集：每次都是同一个 session_id，但文件名带毫秒时间戳，不会互相覆盖。
const sessionId = ref(readSessionId())
const errorText = computed(() => (errorKey.value ? t(errorKey.value) : ''))

onMounted(() => {
  if (!sessionId.value) {
    errorKey.value = 'linkMissing'
    view.value = 'error'
  }
})

function onDone(): void {
  view.value = 'done'
}

function again(): void {
  view.value = 'capture'
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-gray-50">
    <main class="flex flex-1 flex-col p-4 md:p-6">
      <!-- shrink-0：否则内容超高时 flex 会把子项压缩，摄像头画面会被挤成小方块 -->
      <div class="m-auto w-full max-w-2xl shrink-0">
        <CaptureView v-if="view === 'capture'" :session-id="sessionId" @done="onDone" />

        <!-- 完成页：用一个大号成功图标表达结果，比一行文字更直观；明细在后台看，前端不展示 -->
        <div v-else-if="view === 'done'" class="space-y-8 text-center">
          <div class="flex justify-center py-6">
            <!-- 视觉上只有图标；用 role+aria-label 让读屏仍能播报结果 -->
            <svg
              class="h-40 w-40 md:h-52 md:w-52"
              viewBox="0 0 52 52"
              fill="none"
              role="img"
              :aria-label="t('doneTitle')"
            >
              <circle class="suc-circle" cx="26" cy="26" r="23" stroke="#16a34a" stroke-width="2.5" />
              <path
                class="suc-check"
                d="M15.5 27l7.5 7.5L37 19"
                stroke="#16a34a"
                stroke-width="4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>

          <button
            class="w-full rounded-xl bg-blue-700 px-6 py-4 text-lg font-semibold text-white active:bg-blue-800 md:w-auto md:px-10"
            @click="again"
          >
            {{ t('again') }}
          </button>
        </div>

        <div v-else class="rounded-xl bg-red-50 px-5 py-6 text-center ring-1 ring-red-300">
          <p class="text-xl font-bold text-red-800">{{ errorText }}</p>
        </div>
      </div>
    </main>
  </div>
</template>
