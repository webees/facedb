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
  // 入参硬化：这里是唯一把「人脸框比例」变成像素的地方。
  // 非正、非有限的宽高比会一路穿过下面的 Math.min/max：实测 bw=bh=-1 会产出一张
  // 2285x1280 的伪造画布并 resolve（画的是画面一角，与人脸无关），bw=NaN 同理；
  // 视频尺寸为 0 时也一样。宁可明确拒绝，也不要静默交出一张无意义的照片。
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) {
    return Promise.reject(new Error('视频尺寸不可用，无法拍照'))
  }
  if (![f.bw, f.bh, f.cx, f.cy].every(Number.isFinite) || f.bw <= 0 || f.bh <= 0) {
    return Promise.reject(new Error('人脸框不可用，无法拍照'))
  }
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

/**
 * 「本采集点收到的段被判过小丢弃、丢掉之后一段都没有」这一事实（W23B-06）。
 * 为什么必须有：collectSegment 的丢弃分支此前只写一行 console.debug —— 对外零信号，
 * 于是调用方的 segmentOk 只看「录制器有没有起来」，段被丢弃时仍是 true，
 * 落库侧便无法区分「录制失败」与「这一步没有视频」。
 *
 * 谁在读：CaptureView 的 shoot()，在 stopPoseRecording() 之后立刻 takeSegmentDropped() 取一次，
 *         折算进 meta.segmentOk。
 * 何时复位：① takeSegmentDropped() 读取时立即复位（take/consume 语义）；
 *           ② startPoseRecording()（新采集点 / 新流）与 teardownRecorder() 里复位。
 * 跨采集点会不会串味：不会。每个采集点开始时清零、读取即消费，
 *           上一个采集点的丢弃不可能被下一个采集点读到（判据 C20 专门量这一条）。
 * 注意只用于「丢掉之后一段都没有」：同一采集点若已有保留段（如 8 秒上限切开的前半段），
 * 尾段被丢弃不影响本采集点仍有视频，此时不置真；反过来，若先丢了一段、之后又保住了
 * 一段（8 秒上限续录的那段正常），置起的标记会被撤回 —— 判据 C22/C23 专门量这两条。
 */
let segmentDropped = false

/**
 * 取走「本采集点的段被判过小丢弃」这一事实（读后即复位）。
 * 为什么是 take 而不是读属性：读属性要调用方自己记得复位，漏一次就把上一个采集点的失败
 * 带到下一个采集点 —— 而 segmentOk 的存在意义正是防这类错配。
 * @returns true = 本采集点至今没有可用视频段（收到的段为空，或被判过小丢弃）
 */
export function takeSegmentDropped(): boolean {
  const v = segmentDropped
  segmentDropped = false
  return v
}

/**
 * 最近一次「段被丢弃」的原因（R24 / W24C-02·03·07）。只用于日志与排查，不导出成新的判定入口。
 *
 * 为什么必须统一走一个入口：这三条丢弃分支原先各自「静默」得不一样 ——
 *   · 代次过期（collectSegment 的 fromEpoch 守卫）：只有一行 console.debug，**不置 segmentDropped**；
 *   · 陈旧的自发停止回调（begin 里 onstop 的 `rec !== r`）：直接 return，连日志都没有；
 *   · 同一采集点被并发取段时被抛弃的那一次：静默返回 null。
 * 后果是同一个：界面与落库侧都看不出「这一步其实丢了一段视频」。这与 W23B-06 / R23-06 同族
 * ——丢弃有多个分支、对外信号只有一个分支，于是「段被丢掉」这件事整体不可观测。
 *
 * 口径与体积过小那条分支**完全一致**：只有「丢掉之后本采集点一段都没有」才置 segmentDropped；
 * 已有保留段（如 8 秒上限切开的前半段）时不置真。
 */
let lastDropReason = ''
/** 本采集点已被取走段的次数（R24 / W24C-07）：>0 时后到的取段调用拿到 null 就是「被并发取走」，不是「没有视频」。 */
let takeCount = 0
function noteSegmentDrop(reason: string, detail: string): void {
  lastDropReason = reason
  if (lastSegment === null) segmentDropped = true
  console.debug('[seg] 丢弃段（' + reason + '）：' + detail)
}

/** 正在进行的收尾操作；用于串行化，避免并发调用读到尚未赋值的 lastSegment */
let finalizing: Promise<void> | null = null
/**
 * 所有「创建成功」的录制器都登记在这里，拆卸时逐个停（R13-F10）。
 * 为什么不能只靠模块级的 rec：它只指最新那一个实例，而下面两条路径都会让更早的实例
 * 落到 rec 之外 —— ① 收尾还在飞时上层又开了新段（retry 与 advance 交叉）；② 收尾在飞时组件被卸载。
 * 实测（桩环境）：拆卸后仍有 4 个非 inactive 的录制器没人停。
 */
const liveRecorders = new Set<MediaRecorder>()
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

/**
 * 把一段 chunk 收成 Blob。
 * 参数化 chunk 数组（而不是直接读模块级的 chunks）是为了让「段的归属」与「代次」对齐：
 * 每一代在 begin 时拿到新数组，收尾捕获自己那一份，
 * 于是迟到的旧收尾既不会污染新段，也不会把新段的数据一起卷走。
 */
const buildBlob = (src: Blob[]): { blob: Blob; mime: string } | null => {
  const type = mime || src[0]?.type || 'video/webm'
  const blob = new Blob(src, { type })
  return blob.size > 0 ? { blob, mime: type } : null
}

/**
 * 段代次。startPoseRecording / stopPoseRecording 各自递增一次；
 * collectSegment 只接受「同代」写入，代次不符的迟到回写直接丢弃。
 *
 * 为什么需要：收尾有兜底（onstop 1.5s 未触发）与护栏（stopPoseRecording 3s 上限）两条超时路径，
 * 它们都可能让「上一段的收尾」晚于「下一采集点的开始」才落地。迟到的段一旦覆盖 lastSegment，
 * 就会被下一次 stopPoseRecording 当成当前采集点的视频取走 —— 视频与姿态错配，
 * 而且错得很隐蔽（时长、体积都正常，看不出来）。
 * 注：在当前超时参数下这个窗口不可达（finalize 自身的 1500ms 兜底必先于 3000ms 护栏生效），
 * 这里的守卫是防御性的：成本只是一个整数自增，换来的是这类回归不会悄悄发生。
 */
let epoch = 0

// 自动续录闸门（R13-F8）：8 秒硬上限到点后会「收段并立刻续录下一段」，
// 这条自我续命的链条必须能被外部一次性关掉 —— 否则组件卸载后，
// 已经停掉的流上仍会不断重建 MediaRecorder，并每次都再挂一个 8 秒定时器。
// 显式开始录制（startPoseRecording）会重新打开它，因此组件重新挂载后行为不变。
let autoRearm = true

/**
 * 把已攒下的 chunk 收成一个段并写进 lastSegment。
 * 被 finalize 的 onstop 回调与 begin 里挂的「自发停止」回调共用。
 * @param src 本代的 chunk 数组（由调用方在发起收尾时捕获，见 buildBlob 的说明）。
 * @param fromEpoch 发起收段的代次；代次已翻篇则丢弃（见上方 epoch 的说明）。
 */
function collectSegment(src: Blob[], fromEpoch: number): void {
  if (fromEpoch !== epoch) {
    // 直接丢弃：src 是调用方自己那一代的 chunk 数组（begin 时独立开辟），
    // 既不会覆盖 lastSegment 去冒充下一个采集点的视频，也不会动到新段正在攒的数据。
    // R24 / W24C-02：丢弃必须**对外可见**（此前只有这一行 console.debug，segmentDropped 不置位）。
    noteSegmentDrop('stale-epoch', '采集点已切换，代次 ' + fromEpoch + ' ≠ ' + epoch)
    return
  }
  const seg = buildBlob(src)
  if (seg && seg.blob.size >= MIN_SEGMENT_BYTES) {
    lastSegment = seg // 只留最新一段
    // 本采集点已经有可用段了：把此前可能置起的「一段都没有」撤回。
    // 同一采集点内可能收多次段（8 秒上限到点会先收一段再续录），
    // 若前一段因过小被丢弃、后一段正常保留，本采集点是有视频的，不能报成没有。
    segmentDropped = false
    console.debug('[seg] 收段 ' + Math.round(seg.blob.size / 1024) + ' KB（保留为最终结果）')
  } else if (seg) {
    // 刚开就被切掉的尾段：不覆盖已有的有效段。
    // lastSegment 非空 = 同一采集点已有有效段（例如 8 秒上限切开的前半段），本采集点仍有视频，
    // 不能因为这一小段被丢弃就把整批标成「没有视频」；只有「丢掉之后一段都没有」才算没有。
    if (lastSegment === null) segmentDropped = true
    console.debug(
      '[seg] 尾段仅 ' + Math.round(seg.blob.size / 1024) + ' KB，过小，保留上一段' +
        (lastSegment ? '（' + Math.round(lastSegment.blob.size / 1024) + ' KB）' : '（无）'),
    )
  } else {
    // 一个字节都没收到：本采集点同样没有可用视频段（与「过小丢弃」是同一后果）
    if (lastSegment === null) segmentDropped = true
    console.debug('[seg] 收段为空')
  }
}

/**
 * 收尾时等待 onstop 的硬上限。
 * 为什么必须有：finalize 原本唯一的 resolve 路径是 MediaRecorder.onstop，
 * 而 iOS WKWebView（含 WhatsApp 内置浏览器）在页面转后台时会「接受 stop() 但不触发 onstop」。
 * 此时 Promise 永不 resolve，采集流程永久停在收尾，界面一直显示「上传中」，
 * 而服务端连一条请求都收不到。
 * 取 1500ms：正常 onstop 实测在几十毫秒内到达，1.5s 已极宽松。
 * 代价（别写成「不丢数据」）：正常路径下 dataavailable 先于 onstop 事件，尾块不丢；
 * 但超时兜底路径会摘掉回调，浏览器随后随 onstop 补发的最后一块（timeslice 500ms）
 * 会被丢掉 —— 即最多少最后 500ms 画面。这是刻意取舍：用 500ms 尾块换界面不永久卡死。
 */
const STOP_TIMEOUT_MS = 1500

/**
 * 给任意等待加硬上限：到点就按 fallback 继续，绝不无限挂起。
 * 用于所有「等一个可能永远不来的事件」的地方 —— 这类等待在移动端浏览器里一旦不返回，
 * 界面就会永久卡在某个中间态（本项目踩到的正是「上传中」）。
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      console.warn('[seg] 等待收尾超过 ' + ms + 'ms，不再阻塞调用方')
      resolve(fallback)
    }, ms)
    const finish = (v: T) => {
      if (settled) return
      settled = true
      clearTimeout(t)
      resolve(v)
    }
    void p.then(finish, (e) => {
      // 不要静默吞掉 reject：本工具是通用的、被多处复用，
      // 把失败无声地换成 fallback，排查时只会看到「什么都没发生」。
      // fallback 语义保持不变（调用方依赖它不挂起），这里只是留下痕迹。
      console.warn('[seg] 等待失败，按兜底值继续', e)
      finish(fallback)
    })
  })
}

/**
 * 收掉当前段并把结果存进 lastSegment（覆盖更早的段）。
 * 内部自管，不依赖外部调用返回值 —— 这是超时路径仍能交出「已收到的数据」的关键
 * （代价见 STOP_TIMEOUT_MS 的说明：兜底路径可能丢最后 ≤500ms 的尾块）。
 */
function finalize(): Promise<void> {
  // 已有一个收尾在跑：复用它的 promise（不能重复收尾，否则 stop 与 collectSegment 互相抢），
  // 但**不能就此把当前这一段丢在外面**：并发窗口里上层可能已经重开了段，那个新实例既不在
  // 老收尾的持有范围内，也没有别人会停它 —— 实测它会一直录到页面销毁。
  if (finalizing) {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const stray = rec
    rec = null
    recStream = null
    if (stray && stray.state !== 'inactive') {
      liveRecorders.delete(stray)
      try {
        stray.stop()
      } catch {
        // 已停止 / 实现不支持 stop：句柄已清空，不再持有
      }
    }
    return finalizing
  }
  // 记下本段属于哪一代、以及哪一代的 chunk 数组：
  // 收段是异步落地的，期间采集点可能已经翻篇、新段也已开始攒数据。
  const myEpoch = epoch
  const myChunks = chunks

  clearTimeout(timer)
  timer = undefined
  const r = rec
  rec = null
  recStream = null
  if (!r) return Promise.resolve()

  const p = new Promise<void>((resolve) => {
    let settled = false
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    // 收段只能做一次：超时兜底与「迟到才到的 onstop」都可能触发 done，
    // 第二次收的是空 chunks，除了误导日志没有别的效果。顺手摘掉回调，
    // 让这个已经交还的录制器不再产生任何回调。
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(stopTimer)
      r.onstop = null
      r.ondataavailable = null
      // 摘掉回调的代价：浏览器随后随 onstop 补发的最后一块（timeslice 500ms）会被丢掉。
      // 这是超时兜底路径的已知取舍 —— 用最多 500ms 尾块换界面不永久卡死。
      // 不能为保住尾块而留着回调：那会与 done 的幂等保证冲突（可能二次收段、把空 chunk 收成段）。
      collectSegment(myChunks, myEpoch)
      resolve()
    }
    if (r.state === 'inactive') {
      done()
      return
    }
    r.onstop = done
    // 兜底路径：stop() 不抛异常、onstop 却永不触发时，到点按已收到的 chunk 收段并放行。
    // 正常路径（onstop 及时到达）下这个定时器会被 done 清掉，行为与修复前完全一致。
    stopTimer = setTimeout(() => {
      console.debug('[seg] onstop ' + STOP_TIMEOUT_MS + 'ms 未触发，按已收到的数据收段并放行')
      done()
    }, STOP_TIMEOUT_MS)
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
  // 开新段前先停掉上一个还活着的实例（若有）：它已经不属于任何一段了，
  // 留着就是「界面以为没在录、实际还在录」。
  if (rec && rec.state !== 'inactive') {
    const prev = rec
    liveRecorders.delete(prev)
    try {
      prev.stop()
    } catch {
      // 已停止：忽略
    }
  }
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  // 本代自己的 chunk 数组：本代回调只写这一份（闭包捕获 mine，不再读模块级 chunks）。
  // 为什么必须这样：finalize() 调 stop() 后排队的 dataavailable 可能在本代结束之后才派发，
  // 若回调读模块级 chunks，那一块就会被 push 进【新段】的数组，成为新 blob 的第一个 chunk ——
  // 上一采集点的画面接在新采集点头上，而时长与体积都看不出异常。
  const mine: Blob[] = []
  chunks = mine
  // 本段属于哪一代：8 秒上限的回调会跨代执行（收尾在飞时又开了新段），
  // 到点时若代次已经翻篇，这次续录不再属于任何一段，必须放弃。
  const myEpoch = epoch
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
  liveRecorders.add(r)
  r.ondataavailable = (e) => {
    if (e.data.size > 0) mine.push(e.data)
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
    if (rec !== r) {
      liveRecorders.delete(r) // 已被 finalize 接管：登记表里也不能再留着它
      // R24 / W24C-03：这条分支是**整段静默丢弃**（连日志都没有）。
      // 实测 self-stop-stale-handler 场景：128KB 的段就此消失，而对外读数全是「没丢」。
      // 它确实是迟到回调（内容属于上一代，不该冒充本采集点的视频），但「丢过」必须可见。
      noteSegmentDrop('stale-self-stop', '录制器已被接管，其 onstop 迟到；本代不再收段')
      return
    }
    liveRecorders.delete(r)
    clearTimeout(timer)
    timer = undefined
    collectSegment(mine, epoch)
    rec = null
    recStream = null
    currentPose = null
    console.debug('[seg] 录制器自发停止（流已结束），已收尾并清空句柄')
  }
  try {
    r.start(500)
  } catch (e) {
    // 启动失败（流已结束、编解码组合不被支持）时必须把句柄清干净：
    // 否则 isPoseRecording() 会返回 true，上层以为在录、不再重试，而一个字节都没录到。
    console.warn('[seg] 录制器启动失败', e)
    liveRecorders.delete(r)
    rec = null
    recStream = null
    currentPose = null
    return false
  }
  console.debug('[seg] 开段')

  timer = setTimeout(() => {
    // 硬上限到点：先收掉这段，再立刻续录下一段。
    // 这样「用户迟迟不达标」不会导致无限录制，也不会出现空档。
    // 已被拆卸（cleanup/卸载）：不再收段、不再续录（R13-F8）
    if (!autoRearm) return
    // 代次已翻篇（本段早已被收掉、上层开了新段）：这次到点不属于任何一段，放弃续录（R13-F10）
    if (epoch !== myEpoch) return
    console.debug('[seg] 到 ' + POSE_MAX_MS / 1000 + ' 秒上限，收段并续录')
    const keepPose = currentPose
    void finalize().then(() => {
      // 收尾期间可能已被拆卸或已换代：续录前再判一次，堵住「收尾在飞时空转」这条路径
      if (autoRearm && epoch === myEpoch) begin(stream, keepPose) // begin 内部会重置 segmentStart
    })
  }, POSE_MAX_MS)

  return true
}

/**
 * 开始录制一个新的采集点。
 * 无论上一段处于什么状态，都先强制收掉 —— 避免段与段叠加导致时长失控。
 */
export function startPoseRecording(stream: MediaStream, pose: string): boolean {
  // 显式开始录制 = 重新打开自动续录闸门（拆卸会关掉它，重新挂载后要恢复）
  autoRearm = true
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
  segmentDropped = false // 新采集点：上一个采集点的「段被丢弃」事实不得串味到这一段
  lastDropReason = ''
  takeCount = 0 // 新采集点：取段次数重新计数
  epoch++ // 新代次：上一段任何迟到的回写从此被丢弃，不会再冒充本采集点的视频
  return begin(stream, pose)
}

/**
 * 结束当前采集点的录制并取回视频段。
 * 若中途因超过单段上限被切开，返回的是【最后一段】（即用户达标时的画面）。
 */
export async function stopPoseRecording(): Promise<{ blob: Blob; mime: string } | null> {
  // 若有收尾正在进行（例如刚好到 8 秒上限），先等它完成，
  // 否则可能读到尚未被赋值的 lastSegment 而错误地返回 null。
  //
  // 两处等待都加上限：本函数被 shoot() 直接 await，它一旦不返回，
  // 界面就永久停在收尾提示上（这正是 P0 缺陷的表象）。
  // finalize 自身已带 onstop 兜底，这里的护栏兜的是「finalizing 已被别处挂起」的情况：
  // 宁可返回 null（该采集点没有视频）也不能让整条采集流程卡死。
  if (finalizing) await withTimeout(finalizing, STOP_TIMEOUT_MS * 2, undefined)
  // 翻代（顺序很关键）：
  //   · 必须在上面那次等待【之后】—— 若那个收尾是本代发起的（例如刚好到 8 秒上限），
  //     它的段属于本采集点，得先让它落地，否则会被下面的自增误判为过期而丢弃；
  //   · 必须在 finalize() 调用【之前】—— 此后任何仍挂起的旧收尾（护栏已放弃的那个）
  //     就算最终落地，代次也对不上，不会再写进 lastSegment 冒充下一个采集点的视频。
  epoch++
  await withTimeout(finalize(), STOP_TIMEOUT_MS * 2, undefined)
  currentPose = null
  const out = lastSegment
  lastSegment = null
  // R24 / W24C-07：同一采集点被并发取段时，后到的那次会拿到 null —— 与「这一步真没有视频」
  // 在对外读数上完全一样（此前是静默返回）。取过就记一笔，让后到的那次不再是静默的。
  if (out) takeCount++
  else if (takeCount > 0) noteSegmentDrop('already-taken', '本采集点的段已被并发取走，这次调用没有可返回的内容')
  return out
}

/**
 * 全量拆卸录制链（R13-F8）。组件卸载/清理时调用：关掉自动续录闸门、清掉 8 秒硬上限
 * 定时器、停下在录的录制器并清空全部句柄。
 *
 * 为什么不能只调 stopPoseRecording()：它内部走 finalize()，而 finalize() 在
 * 「已有收尾在飞」时直接返回既有 promise —— 既不停止录制器、也不清它的定时器，
 * 于是「切采集点/重开录制后再卸载」会留下孤儿定时器与自我续命的录制器。
 * 实测（R13-F8 判据）：修复前 submitInFlightUnmount 卸载后残留 rec_live=3 / timer=6，
 * zombieAfterUnmount 残留 rec_live=6 / timer=19。
 */
export function teardownRecorder(): void {
  autoRearm = false
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  const r = rec
  rec = null
  recStream = null
  currentPose = null
  // 拆卸后不得留下「段被丢弃」的陈旧事实：组件重新挂载会新建采集点，
  // 若这里不清，上一次会话的丢弃会被新会话的第一次 take 读到。
  segmentDropped = false
  lastDropReason = ''
  takeCount = 0
  // 登记表里的每一个都要停：模块级 rec 只覆盖最新那一个（R13-F10）
  for (const other of [...liveRecorders]) {
    if (other === r) continue
    liveRecorders.delete(other)
    try {
      if (other.state !== 'inactive') other.stop()
    } catch {
      // 已停止 / 实现不支持 stop：忽略
    }
  }
  if (r) liveRecorders.delete(r)
  if (r && r.state !== 'inactive') {
    try {
      r.stop()
    } catch (e) {
      // 已停止 / 实现不支持 stop：都不影响「句柄已清空」这一事实
      console.debug('[seg] 拆卸时停止录制器失败（可忽略）', e)
    }
  }
  chunks = []
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
