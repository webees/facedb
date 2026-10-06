import type { FaceFrame } from './face'

const ROI_SCALE = 2.2
const JPEG_QUALITY = 0.92
// 长边目标区间：不足 1280 则放大到此值；超过 1600 则缩小到此值。
// 不加上限时，4K 摄像头下裁切图会长达 2500px 宽，单张 JPEG 超过 500 KB。
// 上限取 1600 而非 1920：实测 4K 源下 1920 画布单张 291~361 KB（10 张约 3.5 MB），
// 而 1600 画布约 210 KB（10 张约 2.1 MB）。人脸识别对 1600 以上的分辨率并不敏感
// —— MediaPipe 会自行缩放到固定输入尺度 —— 所以这里省下的是纯粹的传输量。
// 1600 仍留有余量，后台人工查看时细节足够。
const MIN_LONG_SIDE = 1280
const MAX_LONG_SIDE = 1600
// 分段录制：每个采集点单独录一段，段与段之间互不影响。
// 码率 1.2 Mbps —— 分段后单段通常 2~4 秒，这个码率下画质足够、体积更小。
const POSE_BPS = 1200000
// 单段时长上限：正常一个采集点 2~4 秒即可达标；
// 若用户在该姿态停留过久，到点自动收尾，避免单段无限增长（这是体积失控的主要来源）。
export const POSE_MAX_MS = 8000

// 每个采集点连拍张数：5 个采集点 × 2 张 = 10 张照片（外加 1 段活体视频）。
// 连拍在切换到下一步【之前】完成，确保所有帧都是同一姿态；
// 单张拍摄 + 转码约 60~100ms，2 张连拍只多花约 0.1s，对体验影响很小。
// 采集点：正脸 / 左转 / 右转 / 抬头 / 低头 —— 覆盖 yaw 与 pitch 两个维度的正反方向。
export const BURST = 2
// 连拍间隔：太短会拿到几乎相同的帧（失去多张的意义），太长则用户姿态可能开始变化
export const BURST_GAP_MS = 180

// 只用 webm：实测 Chrome 虽然 isTypeSupported('video/mp4') 返回 true，
// 但 MediaRecorder 产出的是分片 MP4（fMP4，ftyp brand=iso5，moov 仅含初始化信息、
// 数据全在 moof+mdat 分片里），浏览器 <video src> 播放时报 MEDIA_ELEMENT_ERROR: Format error，
// 即「能下载、不能播」。webm(vp9) 自录自播完全正常，故不把 mp4 列入候选。
const CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

export function pickVideoMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return m
  return ''
}

export const extFor = (mime: string): string => (mime.includes('mp4') ? 'mp4' : 'webm')

/** 拍照：人脸框 2.2 倍外扩裁切，JPEG q=0.92；裁切取原生像素，仅长边不足 1280 时等比放大补齐规格。 */
export function grabImage(video: HTMLVideoElement, f: FaceFrame): Promise<Blob> {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const w = Math.round(Math.min(f.bw * vw * ROI_SCALE, vw))
  const h = Math.round(Math.min(f.bh * vh * ROI_SCALE, vh))
  const x = Math.round(Math.min(Math.max(f.cx * vw - w / 2, 0), vw - w))
  const y = Math.round(Math.min(Math.max(f.cy * vh - h / 2, 0), vh - h))
  const longSide = Math.max(w, h)
  // 双向约束：小图放大到下限、大图压到上限，保证规格稳定
  const scale = longSide < MIN_LONG_SIDE ? MIN_LONG_SIDE / longSide : Math.min(1, MAX_LONG_SIDE / longSide)
  const cv = document.createElement('canvas')
  cv.width = Math.round(w * scale)
  cv.height = Math.round(h * scale)
  const ctx = cv.getContext('2d')
  if (!ctx) return Promise.reject(new Error('无法创建画布'))
  ctx.drawImage(video, x, y, w, h, 0, 0, cv.width, cv.height)
  return new Promise((resolve, reject) => {
    cv.toBlob(b => (b ? resolve(b) : reject(new Error('拍照失败'))), 'image/jpeg', JPEG_QUALITY)
  })
}

// ---- 分段录制：每个采集点一段，段内自管收尾，绝不无限录制 ----
let rec: MediaRecorder | null = null
let chunks: Blob[] = []
let mime = ''
let timer: ReturnType<typeof setTimeout> | undefined
// 单段最小有效体积：低于此值的段视为「刚开就被切掉」的尾段，不应覆盖已有的有效段。
// 取 60 KB —— 按 1.2 Mbps 约合 0.4 秒；而正常一段（数秒）在 300 KB 以上。
// 同时也避免了内容过少的 webm 被 PocketBase 以 mime 不符拒收。
const MIN_SEGMENT_BYTES = 60 * 1024

/** 已收好的段：只保留最后一段（用户达标时的姿态最有价值，且体积恒定） */
let lastSegment: { blob: Blob; mime: string } | null = null
/** 正在进行的收尾操作；用于串行化，避免并发调用读到尚未赋值的 lastSegment */
let finalizing: Promise<void> | null = null
/** 正在录制的采集点；未录制时为 null。用于让「开段」幂等。 */
let currentPose: string | null = null
/**
 * 当前录制器绑定的流。
 * 为什么必须记它：幂等判断若只看「姿态名 + rec 是否存在」，换摄像头（重新 getUserMedia）
 * 或摄像头掉线重连后，补偿调用会被当成重复调用直接返回 true —— 新流在整个采集点内
 * 一次都没被录，而 segmentFailed 仍是 false，用户拿不到任何提示，该采集点的视频段静默丢失。
 */
let recStream: MediaStream | null = null
/** 当前段的开始时刻（performance.now()）；用于保证最短录制时长。 */
let segmentStart = 0

/** 本段最少录制时长：太短的片段体积会低于 MIN_SEGMENT_BYTES 而被丢弃，
 *  导致该采集点没有视频、甚至整批提交因「无文件」失败。
 *  取 1200ms —— 按 1.2 Mbps 约合 180 KB，远高于 60 KB 门槛；对用户几乎无感。 */
export const MIN_SEGMENT_MS = 1200

/** 当前段已录制的毫秒数（未录制时为 0）。 */
export function poseRecordingElapsed(): number {
  return rec ? performance.now() - segmentStart : 0
}

const buildBlob = (): { blob: Blob; mime: string } | null => {
  const type = mime || chunks[0]?.type || 'video/webm'
  const blob = new Blob(chunks, { type })
  chunks = []
  return blob.size > 0 ? { blob, mime: type } : null
}

/**
 * 把已攒下的 chunk 收成一个段并写进 lastSegment。
 * 被 finalize 的 onstop 回调与 begin 里挂的「自发停止」回调共用。
 */
function collectSegment(): void {
  const seg = buildBlob()
  if (seg && seg.blob.size >= MIN_SEGMENT_BYTES) {
    lastSegment = seg // 只留最新一段
    console.debug('[seg] 收段 ' + Math.round(seg.blob.size / 1024) + ' KB（保留为最终结果）')
  } else if (seg) {
    // 刚开就被切掉的尾段：不覆盖已有的有效段
    console.debug(
      '[seg] 尾段仅 ' + Math.round(seg.blob.size / 1024) + ' KB，过小，保留上一段' +
        (lastSegment ? '（' + Math.round(lastSegment.blob.size / 1024) + ' KB）' : '（无）'),
    )
  } else {
    console.debug('[seg] 收段为空')
  }
}

/**
 * 收掉当前段并把结果存进 lastSegment（覆盖更早的段）。
 * 内部自管，不依赖外部调用返回值 —— 这是超时路径不丢数据的关键。
 */
function finalize(): Promise<void> {
  // 已有一个收尾在跑：直接复用，避免并发时重复 stop 与竞态
  if (finalizing) return finalizing

  clearTimeout(timer)
  const r = rec
  rec = null
  recStream = null
  if (!r) return Promise.resolve()

  const p = new Promise<void>((resolve) => {
    const done = () => {
      collectSegment()
      resolve()
    }
    if (r.state === 'inactive') {
      done()
      return
    }
    r.onstop = done
    try {
      r.stop()
    } catch {
      done()
    }
  })
  finalizing = p.then(() => {
    finalizing = null
  })
  return finalizing
}

/** 开一段新的录制；到点自动收段并【立即续录】，保证画面不断。 */
function begin(stream: MediaStream, pose: string | null): boolean {
  currentPose = pose
  segmentStart = performance.now()
  mime = pickVideoMime()
  chunks = []
  let r: MediaRecorder
  try {
    r = new MediaRecorder(
      stream,
      mime ? { mimeType: mime, videoBitsPerSecond: POSE_BPS } : { videoBitsPerSecond: POSE_BPS },
    )
  } catch {
    rec = null
    recStream = null
    return false
  }
  rec = r
  recStream = stream
  r.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  r.onerror = (e) => {
    // 出错时就地收尾：必须走 finalize，否则定时器不会被清、chunks 也不会被收走
    // （早先这里直接置空 rec，导致定时器与已录数据一起泄漏）
    console.warn('[seg] 录制器出错，就地收尾', e)
    void finalize()
  }
  // 录制器会**自己**停下：实测 track.stop() 后浏览器立即把录制器置为 inactive 且**不触发 onerror**。
  // 早先只有 finalize() 会挂 onstop，于是这种情况留下一个 inactive 的悬挂句柄：
  // 8 秒定时器到点后对已死的流 finalize→begin 空转（报「成功」但 0 字节），每 8 秒一次，
  // 直到切采集点或卸载页面。这里让「自发停止」也走同一条收尾路径。
  // 注意：finalize() 会把 rec 置空后再覆盖 onstop，因此本回调里用 `rec !== r` 判定是否已被接管。
  r.onstop = () => {
    if (rec !== r) return // 已被 finalize 接管，或已经换了新实例
    clearTimeout(timer)
    timer = undefined
    collectSegment()
    rec = null
    recStream = null
    currentPose = null
    console.debug('[seg] 录制器自发停止（流已结束），已收尾并清空句柄')
  }
  r.start(500)
  console.debug('[seg] 开段')

  timer = setTimeout(() => {
    // 硬上限到点：先收掉这段，再立刻续录下一段。
    // 这样「用户迟迟不达标」不会导致无限录制，也不会出现空档。
    console.debug('[seg] 到 ' + POSE_MAX_MS / 1000 + ' 秒上限，收段并续录')
    const keepPose = currentPose
    void finalize().then(() => begin(stream, keepPose)) // begin 内部会重置 segmentStart
  }, POSE_MAX_MS)

  return true
}

/**
 * 开始录制一个新的采集点。
 * 无论上一段处于什么状态，都先强制收掉 —— 避免段与段叠加导致时长失控。
 */
export function startPoseRecording(stream: MediaStream, pose: string): boolean {
  // 幂等：同一个采集点重复调用时直接返回，避免「开段→收段→再开段」空转
  // （空转产生的段都是空的：刚创建、还没攒到第一个 chunk）
  //
  // 但幂等必须同时满足三个条件，缺一不可：
  //   · 姿态名相同 —— 同一采集点
  //   · 录制器仍在录制（state !== 'inactive'）—— 已停的句柄不能再算「正在录」
  //   · 流是同一条 —— 换摄像头 / 掉线重连后是新的 MediaStream
  // 早先只比前两个中的第一个与 rec 是否存在，于是换流后的补偿调用被当成重复调用返回 true，
  // 新流整个采集点内一次都没录，而 segmentFailed 仍是 false（用户无任何提示），视频段静默丢失。
  if (currentPose === pose && rec && rec.state !== 'inactive' && recStream === stream) return true

  if (rec) {
    console.debug('[seg] 切换到新采集点或新流，收掉上一段')
    void finalize()
  }
  lastSegment = null // 新采集点：丢弃上一采集点的内容
  return begin(stream, pose)
}

/**
 * 结束当前采集点的录制并取回视频段。
 * 若中途因超过单段上限被切开，返回的是【最后一段】（即用户达标时的画面）。
 */
export async function stopPoseRecording(): Promise<{ blob: Blob; mime: string } | null> {
  // 若有收尾正在进行（例如刚好到 8 秒上限），先等它完成，
  // 否则可能读到尚未被赋值的 lastSegment 而错误地返回 null。
  if (finalizing) await finalizing
  await finalize()
  currentPose = null
  const out = lastSegment
  lastSegment = null
  return out
}

/** 当前是否有采集点正在录制（诊断用） */
export function isPoseRecording(): boolean {
  return !!rec
}

/** 当前正在录制的采集点（诊断用） */
export function currentPoseName(): string | null {
  return currentPose
}

export const stamp = (): string => String(Date.now())
