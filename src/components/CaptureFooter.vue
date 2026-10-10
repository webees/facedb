<script setup lang="ts">
// 采集页底部控制区（R24 从 CaptureView.vue 抽出，仅为把组件行数拉回 S20 的阈值内）：
//   ① 摄像头切换（多路设备时）
//   ② 两个恢复入口：「重试」（相机/质量失败）与「重新提交」（提交失败，已采集文件仍在内存里）
//   ③ ?debug=1 时的实时指标
// 为什么值得独立：这三块都是**只读展示 + 向上抛事件**，不含任何采集/录制状态机，
// 抽出来既缩小了 CaptureView，也让这块可以在不改状态机的前提下单独看。
import { computed } from 'vue'
import { isVirtualCameraLabel } from '../lib/camera-pick'
import { t } from '../lib/i18n'

const props = defineProps<{
  cameras: MediaDeviceInfo[]
  camId: string
  retryable: boolean
  submitFailed: boolean
  camRes: string
  frame: { yaw: number; pitch: number; roll: number; eyeBlinkLeft: number; eyeBlinkRight: number; faceWidthPx: number }
  stats: { blur: number; brightness: number; roi: string }
  uploading: boolean
  uploadError: string
  pendingCount: number
}>()

const emit = defineEmits<{
  (e: 'update:camId', v: string): void
  (e: 'cameraChanged'): void
  (e: 'retryRequested'): void
  (e: 'retrySubmitRequested'): void
}>()

// 与 CaptureView 同一口径：只在 ?debug=1 时显示逐帧变化的数字
const DEBUG = new URLSearchParams(location.search).has('debug')
// 【R25 / W25A-02（P3）】这些指标来自 MediaPipe 的关键点计算，边界情况下可能不是有限数
// （NaN/Infinity），下游解析失败时甚至可能是字符串。直接 `.toFixed()` 会印出「脸宽 NaNpx」，
// 字符串则**在渲染期抛 TypeError**（实测 50 组组合里 10 组抛错，整行指标消失）。
// 统一口径：非有限数一律印「—」（`?debug=1` 是排查通道，宁可显式留白也不要假读数）。
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const fx = (v: unknown, d = 0): string => { const n = fin(v); return n === null ? '—' : n.toFixed(d) }
const px = (v: unknown): string => { const n = fin(v); return n === null ? '—' : String(Math.round(n)) }
const pitchHint = computed(() => {
  const p = fin(props.frame.pitch)
  return p === null ? t('debugLevel') : p < -3 ? t('debugUp') : p > 3 ? t('debugDown') : t('debugLevel')
})
// 当前正在采集的设备名。枚举出来的 label 在授权后就可用；拿不到就回落到 camId 匹配。
// 为什么要显示它：有虚拟摄像头（如 OBS Virtual Camera）的机器上，界面若只说「未检测到人脸」，
// 用户没有任何线索判断采集用的是哪个设备；把名字摆出来（虚拟设备额外提醒）才能自查。
const camLabel = computed(() => {
  const hit = props.cameras.find((c) => c.deviceId === props.camId)
  return hit?.label || ''
})
const camIsVirtual = computed(() => isVirtualCameraLabel(camLabel.value))
</script>

<template>
  <!-- 当前摄像头：常显设备名（虚拟设备给提醒），位置就在画面下方的控制区 -->
  <p
    v-if="camLabel"
    class="text-center text-xs leading-relaxed"
    :class="camIsVirtual ? 'text-amber-600' : 'text-gray-400'"
  >
    {{ camIsVirtual ? t('activeCameraVirtual', { name: camLabel }) : t('activeCamera', { name: camLabel }) }}
  </p>

  <!-- 摄像头切换（多路设备时）；选项写**真实设备名**，不再只写「摄像头 1/2」-->
  <div v-if="cameras.length > 1" class="flex justify-center">
    <select
      :value="camId"
      class="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-base text-gray-800 md:w-auto"
      @change="emit('update:camId', ($event.target as HTMLSelectElement).value); emit('cameraChanged')"
    >
      <option v-for="(c, i) in cameras" :key="c.deviceId || i" :value="c.deviceId">
        {{ c.label || t('camera', { n: i + 1 }) }}
      </option>
    </select>
  </div>

  <!-- 重试 -->
  <button
    v-if="retryable"
    class="w-full rounded-xl bg-blue-700 px-6 py-4 text-lg font-semibold text-white active:bg-blue-800 md:w-auto"
    @click="emit('retryRequested')"
  >
    {{ t('retry') }}
  </button>

  <!-- 提交失败的恢复入口：已采集的文件仍在内存里，点它整批重发；
       不给入口的话用户只能刷新页面，而刷新会丢掉本次全部采集 -->
  <button
    v-if="submitFailed"
    class="w-full rounded-xl bg-blue-700 px-6 py-4 text-lg font-semibold text-white active:bg-blue-800 md:w-auto"
    @click="emit('retrySubmitRequested')"
  >
    {{ t('retryUpload') }}
  </button>

  <!-- 实时指标：逐帧变化的数字会让界面看起来在「跳」，因此只在 ?debug=1 时显示，便于排查 -->
  <p v-if="DEBUG" class="text-center text-xs leading-relaxed text-gray-400">
    {{ t('metricCamera') }} {{ camRes }} · {{ t('metricYaw') }} {{ fx(frame.yaw) }}° ·
    {{ t('metricPitch') }} {{ fx(frame.pitch) }}° ({{ pitchHint }}) · {{ t('metricRoll') }} {{ fx(frame.roll) }}° ·
    {{ t('metricFaceWidth') }} {{ px(frame.faceWidthPx) }}px · {{ t('metricSharpness') }}
    {{ px(stats.blur) }} ({{ stats.roi }}) · {{ t('metricLight') }} {{ px(stats.brightness) }}
    · {{ t('metricBlink') }} {{ fx(frame.eyeBlinkLeft, 2) }}/{{ fx(frame.eyeBlinkRight, 2) }}
    · {{ uploading ? t('debugUploading') : uploadError ? t('debugUploadFailed') + uploadError.slice(0, 40) : t('debugPending') + ' ' + pendingCount + ' ' + t('debugFilesUnit') }}
  </p>
</template>
