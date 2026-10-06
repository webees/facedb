<script setup lang="ts">
import { computed, ref } from 'vue'
import CaptureView from './components/CaptureView.vue'
import { t } from './lib/i18n'

type View = 'error' | 'capture' | 'done'
type ErrorKey = 'linkMissing' | 'linkTooLong'

/**
 * 采集编号的前端闸门 —— 与后端 pb_migrations/1791281100 的 pattern 逐条对齐：
 *   ^[^\s\p{Z}\p{Cc}](?:[^\p{Cc}]{0,198}[^\s\p{Z}\p{Cc}])?$
 * 即：长度 1..200、任意位置不得含控制符、首尾不得是空白或分隔符。
 *
 * 长度单位是 **Unicode 码点**，不是 .length（UTF-16 码元）。依据是实测：
 * lib/r11-probe-sid-units.mjs 打生产 PB —— 200 个 😀（码点 200 / 码元 391 / 字节 773）**被接受**，
 * 201 个 😀（码点 201 / 码元 393）**被拒**，报文 validation_max_text_constraint「最多允许 200 个字符」。
 * 用 .length 会把 200 个 emoji 当成 400 而错拒。
 */
const MAX_SESSION_ID = 200
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
  // 去掉全部控制符：\p{Cc} 覆盖 C0 + C1（U+0080–U+009F，含 U+0085 NEL）+ DEL。
  // 原先只去 C0 与 DEL，而后端 pattern 用的是 \p{Cc} —— 漏一个就会让带 NEL 的编号
  // 走完 6 步采集后在上传阶段被 400 拒掉。trim() 覆盖 JS WhiteSpace（含 U+3000/U+00A0/
  // U+2028/U+2029/U+FEFF），与后端的 \s ∪ \p{Z} 一致。
  return id.replace(/\p{Cc}/gu, '').trim()
}

// 同一链接可反复采集：每次都是同一个 session_id，但文件名带毫秒时间戳，不会互相覆盖。
const sessionId = ref(readSessionId())

/**
 * 首帧就定下视图：不合法的链接**绝不挂载 CaptureView**。
 *
 * 原先 view 初值恒为 'capture'、判空却写在 onMounted 里 —— 而 onMounted 晚于子组件挂载。
 * 于是「链接里没有采集编号」这种必然报错的页面仍会真的挂载 CaptureView、请求摄像头、
 * 下载 15.8MB 人脸模型（实测模型初始化日志 31 条），之后才切到错误页：
 * 既浪费流量，又在用户没打算采集时开了摄像头。
 * 超长编号同理 —— 它必然在上传阶段被后端 400 拒掉（pb.ts 对 4xx 立即抛 PermanentError 不重试），
 * 用户白拍一轮且无法恢复，所以也必须挡在首帧。
 */
const errorKey = ref<ErrorKey | null>(
  !sessionId.value ? 'linkMissing' : [...sessionId.value].length > MAX_SESSION_ID ? 'linkTooLong' : null,
)
const view = ref<View>(errorKey.value ? 'error' : 'capture')
const errorText = computed(() => (errorKey.value ? t(errorKey.value) : ''))

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
