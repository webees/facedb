// 极简提示音：用 Web Audio 合成，不引入任何音频文件。
// 强制开启、不提供开关；浏览器要求音频必须在用户手势之后才能播放，故在首次交互时 primeAudio() 解锁。
// 刻意做成进程级单例：AudioContext 不随部件挂载/卸载创建与关闭，而是整个页面共用一个。
// 依据（R16-A 实测）：20 次用户手势 → 构造 1 次；5 轮挂载/卸载 → 构造 1 次、存活 1（不累积）。
// 因此这里**不导出** close/dispose 入口，也不把上下文跟着组件生命周期关掉 —— 那不是泄漏。
// （若将来要改成跟随组件生命周期，必须同时回答：谁来关、关掉后其他部件如何重新解锁音频。）
let ctx: AudioContext | null = null
// 构造失败（无音频设备、隐私模式、被策略禁止）后不再反复尝试：
// 不缓存的话，每次调用都会重新 new 一次并再抛一次 —— 实测连续 5 次调用抛 5 次。
let audioUnavailable = false
// 被关闭的上下文不可恢复，需要重建；但重建必须有上限，否则浏览器反复立刻关闭时会变成忙循环。
let rebuilds = 0
const MAX_REBUILDS = 3
// 连续发声失败（设备异常）也计入「本次会话不再尝试」，避免每帧重试刷错误。
let toneFailures = 0
const MAX_TONE_FAILURES = 3
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')
const dbg = (...a: unknown[]) => {
  if (DEBUG) console.log('[audio]', ...a)
}

// 清掉历史遗留的静音标记：早期版本提供过静音开关并把状态存进 localStorage，
// 现在强制开启，若不清除，那些老用户会一直静音且找不到原因。
try {
  localStorage.removeItem('facedb.muted')
} catch {
  /* 隐私模式下 localStorage 可能不可用，忽略 */
}

/** 已关闭的上下文不可恢复：回收掉并报告。返回 true 表示「已处理掉一个死上下文」。 */
function recycleIfClosed(): boolean {
  if (ctx && ctx.state === 'closed') {
    ctx = null
    return true
  }
  return false
}

/** 音频是否已可用（AudioContext 已创建且处于 running）。用于提示用户可否听到提示音。 */
export function isAudioReady(): boolean {
  return !!ctx && ctx.state === 'running'
}

export function primeAudio(): void {
  // 已解锁且正常运行：无需做任何事（这个函数会被每次交互重复调用）
  if (isAudioReady()) return

  const wasReady = isAudioReady()
  // 上下文被关闭（浏览器策略、音频设备切换、长时间后台）后必须允许重建：
  // state === 'closed' 的实例永远回不到 running，继续 resume() 只会被拒。
  // 实测（R16-A）：ctx 被 close 后 30 次交互 → resume +37 全被拒、新建 0 次、isAudioReady 恒 false —— 永久静音，
  // 而失败缓存 audioUnavailable 完全没覆盖这条路径。
  if (ctx && recycleIfClosed()) {
    if (rebuilds >= MAX_REBUILDS) {
      audioUnavailable = true
      dbg('AudioContext 反复被关闭，本次会话不再尝试音频')
      return
    }
    rebuilds++
    dbg('AudioContext 已关闭，回收后重建（第 ' + rebuilds + ' 次）')
  }
  if (!ctx) {
    if (audioUnavailable) return
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      dbg('AudioContext 不可用')
      audioUnavailable = true
      return
    }
    // 必须包 try：调用点（CaptureView.vue 首次交互的监听器）没有 try/catch，
    // 构造抛错会直接冒泡到事件回调外层。
    try {
      ctx = new Ctor()
      dbg('AudioContext 已创建, state =', ctx.state)
    } catch (err) {
      ctx = null
      audioUnavailable = true
      dbg('AudioContext 构造失败，本次及后续不再尝试：', err)
      return
    }
  }
  if (ctx.state === 'suspended') {
    // resume() 会 reject（上下文已被关闭 / 被策略拒绝），不接住就是 unhandledRejection。
    void ctx
      .resume()
      .then(() => {
        dbg('resume 完成, state =', ctx?.state)
        // 刚解锁时放一声确认音：听到即说明链路正常
        if (!wasReady && isAudioReady()) tone(1175, 0.1, 0.2)
      })
      .catch((err) => dbg('resume 失败（忽略）：', err))
  } else if (!wasReady) {
    tone(1175, 0.1, 0.2)
  }
}

/** 切后台/来电回来后恢复音频（此时 AudioContext 常被挂起） */
export function resumeAudio(): void {
  if (recycleIfClosed()) return
  if (ctx?.state === 'suspended') void ctx.resume().catch((err) => dbg('resume 失败（忽略）：', err))
}

// 音量不宜过小：0.07 在普通系统音量下几乎听不见，实测需要 0.2 以上才清晰可辨
const VOL = 0.25

function tone(freq: number, dur: number, vol = VOL, delay = 0): void {
  if (!ctx) {
    dbg('跳过发声：AudioContext 未创建（需要一次用户手势）')
    return
  }
  // 已关闭的上下文不会再发声：对它 resume() 只会被拒（每次交互一次无用调用）。
  if (ctx.state === 'closed') {
    recycleIfClosed()
    dbg('跳过发声：AudioContext 已关闭')
    return
  }
  // 不因 suspended 就放弃：先恢复再发声（否则首次音效会静默丢失）
  if (ctx.state !== 'running') {
    dbg('state =', ctx.state, '尝试恢复后重发')
    void ctx
      .resume()
      .then(() => {
        if (ctx?.state === 'running') tone(freq, dur, vol, delay)
      })
      .catch((err) => dbg('resume 失败（忽略）：', err))
    return
  }
  // 合成与排程整段包 try：调用点分布在采集状态机里，且不都在 try 内
  // （CaptureView.vue 的 shoot() 从 358 行才有 try，openPoseSegment() 内没有任何 try）。
  // 实测（R16-A）：注入 createOscillator 抛 NotSupportedError 后异常冒泡出 sfx.shot()，会打断采集。
  try {
    const t0 = ctx.currentTime + delay
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, t0)
    // 包络起止值不能为 0：exponentialRampToValueAtTime 不收 0，用 0.0001 且淡入避免爆音
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + dur + 0.03)
    dbg('发声', freq + 'Hz / ' + dur + 's')
  } catch (err) {
    toneFailures++
    dbg('发声失败（忽略，不打断采集）：', err)
    if (toneFailures >= MAX_TONE_FAILURES) {
      audioUnavailable = true
      dbg('连续发声失败，本次会话不再尝试音频')
    }
  }
}

// 同一音效 250ms 内只播一次：否则逐帧判定会连播成噪声。
// 初值用 -Infinity 而不是 0：performance.now() 在页面刚加载时也很小，
// 用 0 作初值会让「首次播放」在头 250ms 内被误判为「刚播过」而静默丢弃。
const THROTTLE_MS = 250
const lastPlay = new Map<string, number>()
function throttled(key: string, fn: () => void): void {
  const now = performance.now()
  const prev = lastPlay.get(key)
  if (prev !== undefined && now - prev < THROTTLE_MS) return
  lastPlay.set(key, now)
  fn()
}

export const sfx = {
  /** 对准且开始拍摄 */
  shot: () => throttled('shot', () => tone(988, 0.12)),
  /** 进入下一个姿态：与 shot 之间天然错开，留出视觉动画的时间 */
  step: () =>
    throttled('step', () => {
      tone(659, 0.09)
      tone(988, 0.14, VOL * 0.85, 0.1)
    }),
  /** 全部完成 */
  done: () =>
    throttled('done', () => {
      tone(659, 0.12)
      tone(880, 0.12, VOL * 0.85, 0.13)
      tone(1319, 0.24, VOL * 0.85, 0.26)
    }),
  /** 出错 */
  warn: () => throttled('warn', () => tone(294, 0.18, VOL * 0.7)),
}
