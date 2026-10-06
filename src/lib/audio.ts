// 极简提示音：用 Web Audio 合成，不引入任何音频文件。
// 强制开启、不提供开关；浏览器要求音频必须在用户手势之后才能播放，故在首次交互时 primeAudio() 解锁。
let ctx: AudioContext | null = null
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

/** 音频是否已可用（AudioContext 已创建且处于 running）。用于提示用户可否听到提示音。 */
export function isAudioReady(): boolean {
  return !!ctx && ctx.state === 'running'
}

export function primeAudio(): void {
  // 已解锁且正常运行：无需做任何事（这个函数会被每次交互重复调用）
  if (isAudioReady()) return

  const wasReady = isAudioReady()
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      dbg('AudioContext 不可用')
      return
    }
    ctx = new Ctor()
    dbg('AudioContext 已创建, state =', ctx.state)
  }
  if (ctx.state === 'suspended') {
    void ctx.resume().then(() => {
      dbg('resume 完成, state =', ctx?.state)
      // 刚解锁时放一声确认音：听到即说明链路正常
      if (!wasReady && isAudioReady()) tone(1175, 0.1, 0.2)
    })
  } else if (!wasReady) {
    tone(1175, 0.1, 0.2)
  }
}

/** 切后台/来电回来后恢复音频（此时 AudioContext 常被挂起） */
export function resumeAudio(): void {
  if (ctx?.state === 'suspended') void ctx.resume()
}

// 音量不宜过小：0.07 在普通系统音量下几乎听不见，实测需要 0.2 以上才清晰可辨
const VOL = 0.25

function tone(freq: number, dur: number, vol = VOL, delay = 0): void {
  if (!ctx) {
    dbg('跳过发声：AudioContext 未创建（需要一次用户手势）')
    return
  }
  // 不因 suspended 就放弃：先恢复再发声（否则首次音效会静默丢失）
  if (ctx.state !== 'running') {
    dbg('state =', ctx.state, '尝试恢复后重发')
    void ctx.resume().then(() => {
      if (ctx?.state === 'running') tone(freq, dur, vol, delay)
    })
    return
  }
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
