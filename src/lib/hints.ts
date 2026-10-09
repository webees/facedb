// 提示稳定化与多数表决（R13-F11 从 CaptureView.vue 外移）。
//
// 外移的理由是硬门槛而不是审美：组件单文件行数越过了 800 行的高风险阈值
// （legacy selfcheck 第 10 节 / lib/audit-file-integrity.mjs 会拦），
// 而这块逻辑与渲染无关 —— 它只维护「当前文案键 + 参数」。
// 外移后：① 组件回到阈值以内；② 表决逻辑可被独立测试（见 lib/r11-p3-hintbuf-verify.mjs）。
import { ref, type Ref } from 'vue'
import type { MessageKey } from './i18n'

export interface Hints {
  readonly key: Ref<MessageKey>
  readonly params: Ref<Record<string, string | number>>
  /** 普通提示：走 5/3 多数表决，避免单帧噪声抖动界面 */
  set(key: MessageKey, params?: Record<string, string | number>): void
  /** 立刻换文案，不走表决 */
  setNow(key: MessageKey, params?: Record<string, string | number>): void
}

// 提示稳定化：yaw 在区间边界附近抖动时，「请再向左转」与「转过头了」会逐帧反复横跳。
// 因此普通提示要求最近若干帧中达成多数共识才切换；错误/无人脸一类必须立即显示，不走表决。
export const URGENT_HINTS: MessageKey[] = [
  'cameraDenied', 'cameraNotFound', 'cameraBusy', 'cameraFailed', 'modelFailed',
  'failedMax', 'hintNoFace', 'hintMultiFace', 'hintTooFar', 'hintUploading',
  // 收尾阶段的「正在处理」取代了原先过早出现的「上传中…」，同样必须立即显示：
  // 收尾期间 loop 因 busy 已停止投提示，但收尾前最后一帧投出的姿态提示还留在表决缓冲里，
  // 走表决的话它会被反复压回「保持不动，正在拍摄…」，用户就看不到「正在收尾」。
  'hintFinalizing',
  // 提交失败的终态必须立即显示：它同时是「失败」与「有重试入口」的唯一提示
  'hintUploadFailed',
  // 服务端拒绝（4xx）的终态同理必须立即显示（R28 W28C-02）：它与「网络失败」是两条
  // 不同的归因，绝不能被打架的姿态提示盖回「保持不动，正在拍摄…」。
  'hintUploadRejected',
  // 录制段创建失败：该采集点不会有视频，必须立即告知而不是被姿态提示盖掉
  'segmentFailed',
  // 设备断开需要立即显示：否则会被逐帧判定投出的姿态提示盖掉
  'cameraLost',
  // 采集失败同样如此：画面达标时 loop 每帧都在投 hintHoldStill，
  // 会把「失败」挤成「保持不动，正在拍摄…」——而实际并没有在拍。
  'failed',
]
export const HINT_BUF = 5
export const HINT_NEED = 3

// 提交失败要分两种性质说（R28 W28C-02）：4xx 拒绝（文件过大 / 数量超限 / 字段校验失败）与网络故障
// 是两条不同的路。对前者说「请检查网络」会把用户推去反复点「重新提交」，而那个入口对同一批是
// 幂等的失败 —— 真正有效的动作只有重新采集。
const UPLOAD_FAILURE_HINTS = {
  permanent: 'hintUploadRejected',
  transient: 'hintUploadFailed',
} as const

/** 提交失败时的提示键：服务端拒绝与网络故障要给不同的下一步动作。 */
export function uploadFailureHint(permanent: boolean): MessageKey {
  return UPLOAD_FAILURE_HINTS[permanent ? 'permanent' : 'transient']
}

/**
 * 建一个提示状态机。
 * @param initial 初始文案键（组件首屏是「正在加载模型」）
 * @param onSwitch 文案键切换时的回调（组件用它打诊断日志）
 */
export function createHints(
  initial: MessageKey,
  onSwitch?: (from: string, to: MessageKey) => void,
): Hints {
  const key = ref<MessageKey>(initial)
  const params = ref<Record<string, string | number>>({})
  const buf: MessageKey[] = []
  let lastLogged = ''

function apply(k: MessageKey, p?: Record<string, string | number>): void {
  if (k !== lastLogged) {
    onSwitch?.(lastLogged, k)
    lastLogged = k
  }
  key.value = k
  params.value = p ?? {}
}

function set(k: MessageKey, p?: Record<string, string | number>): void {
  if (URGENT_HINTS.includes(k)) {
    buf.length = 0
    apply(k, p)
    return
  }
  buf.push(k)
  if (buf.length > HINT_BUF) buf.shift()
  const agree = buf.filter(x => x === k).length
  if (k !== key.value && agree < HINT_NEED) return
  apply(k, p)
}

/**
 * 立刻换文案（不等 5/3 多数表决），用于「进新采集点」与用户主动重试。
 *
 * 不清空缓冲的话：buffer 里还留着上一步的键，新一步开头会继续显示旧文案
 * （换文案要 3 票），「请{姿态}」这类提示还会因为旧键占位而更难攒够票数。
 * 普通提示仍然走 set() 的多数表决，避免单帧噪声抖动界面。
 */
function setNow(k: MessageKey, p?: Record<string, string | number>): void {
  buf.length = 0
  apply(k, p)
}

  return { key, params, set, setNow }
}
