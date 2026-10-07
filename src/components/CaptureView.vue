<script setup lang="ts">
import { MAX_BRIGHT, MIN_BRIGHT } from '../lib/quality'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { closeFace, detectFace, drawOverlay, emptyFrame, initFace } from '../lib/face'
import { judge, POSE_KEY, roiStats, STABLE_FRAMES, type Pose } from '../lib/quality'
import {
  BURST,
  BURST_GAP_MS,
  extFor,
  grabImage,
  stamp,
  MIN_SEGMENT_MS,
  poseRecordingElapsed,
  startPoseRecording,
  stopPoseRecording,
} from '../lib/capture'
import { uploadSession, UPLOAD_BUDGET_MS, type CaptureMeta, type CaptureResult, type PendingFile } from '../lib/pb'
import { primeAudio, resumeAudio, sfx } from '../lib/audio'
import { t, type MessageKey } from '../lib/i18n'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ done: [results: CaptureResult[]] }>()

// 采集流程：6 步 —— 正脸 → 左转 → 右转 → 抬头 → 低头 → 活体视频。
// 5 个采集点覆盖 yaw（左右）与 pitch（上下）两个维度的正反方向，每个点连拍 2 张 = 10 张照片。
// 原方案含左/右 45° 两步，但 45° 处 MediaPipe 的 yaw 抖动大、且与质量门槛的 45° 上限重合，
// 用户几乎无法稳定命中（实测「向某侧转几次都失败」），已按反馈去掉。
const POSES: Pose[] = ['frontal', 'left30', 'right30', 'up', 'down', 'liveness']
// 调试用：?start=liveness 直接跳到录制步骤，便于单独验证末段（录制与提交）逻辑
const startParam = new URLSearchParams(location.search).get('start')
const startIdx = POSES.indexOf(startParam as Pose)
// 推理频率：40ms ≈ 25fps。MediaPipe 在 1080p 下单帧约 10~30ms，这个频率不会成为瓶颈，
// 且直接决定「转到目标角度后要等多久」——达标时长 ≈ INFER_MS × STABLE_FRAMES。
const INFER_MS = 40
const MAX_FAILS = 5

const videoEl = ref<HTMLVideoElement>()
const overlayEl = ref<HTMLCanvasElement>()
const cameras = ref<MediaDeviceInfo[]>([])
const camId = ref('')
const idx = ref(startIdx > 0 ? startIdx : 0)
const hintKey = ref<MessageKey>('loadingModel')
const hintParams = ref<Record<string, string | number>>({})
const ok = ref(false)
const busy = ref(false)
const recording = ref(false)
// 提交状态：最后一步会等上传真正完成才切页。
// uploading 驱动「正在上传」的旋转动画；submit 内部会自动重试，无需用户操作。
const submitting = ref(false)
const uploading = ref(false)
// 仅用于诊断记录最后一次失败原因
const uploadError = ref('')
// 提交重试全部失败后的终态：界面必须显示失败并给出可点的重试入口。
// 修复前该分支只写调试日志、保持「上传中…」，用户既不知道失败也没有入口，
// 而文件只在内存 pendingFiles 里，刷新即全部丢失。
const submitFailed = ref(false)
// 一次识别 = 一条记录：各采集点的文件先缓存在内存，最后一步完成后一次性提交。
// 不在每步提交是因为 captures 的 updateRule 只允许登录用户更新，匿名 PATCH 会被拒；
// 而末次 POST 只需 createRule，且提交是原子的（不会留下「半条记录」）。
// 必须是响应式的（reactive 而非普通数组）：模板诊断行读的是 pendingFiles.length，
// 普通数组不会触发重渲染，计数会一直停在 0 或上一次渲染的旧值（排查上传问题时给出的是假数字）。
// 用 reactive 而不是 ref：所有读写点（push / length / 传给 uploadSession）保持原样，
// 改动只有这一行。
const pendingFiles = reactive<PendingFile[]>([])
/** 把本步产物放进待提交队列 */
function stash(blob: Blob, filename: string, kind: 'image' | 'video', pose: string, meta: CaptureMeta): void {
  pendingFiles.push({ pose, blob, filename, kind, meta })
}
// 连续无法识别的次数；达到 MAX_FAILS 时给出「重新开始」入口
const fails = ref(0)
const results = reactive<CaptureResult[]>([])
const frame = reactive(emptyFrame())
const stats = reactive({ blur: 0, brightness: 0, roi: '0x0' })
// 摄像头实际输出分辨率（来自 track 设置），用于判断视频是否被低分辨率放大
const camRes = ref('')

const pose = computed(() => POSES[idx.value])
const retryable = computed(() => fails.value >= MAX_FAILS)
const hint = computed(() => t(hintKey.value, hintParams.value))
// 需要转头时，在椭圆外侧给出方向箭头（复用提示状态，不额外判断几何）
const turnDir = computed<'left' | 'right' | null>(() =>
  hintKey.value === 'hintTurnLeft' ? 'left' : hintKey.value === 'hintTurnRight' ? 'right' : null,
)

// 提示框固定高度：只有一行主文案（20/24px）＋内边距，取 56 保证手机与桌面都不溢出。
const HINT_BOX_H = 56


// 视频真实尺寸必须用响应式变量记录：videoWidth/videoHeight 是 DOM 属性，
// computed 不会因它们变化而重算，直接读会永远拿到 0。
// 只用于判断视频是否已就绪（决定占位与画面容器谁可见）。
// 曾经还记录 h，但从未被读取；容器比例现在固定为 BOX_AR，不再依赖视频尺寸。
const videoSize = reactive({ w: 0 })

// 容器固定尺寸：宽度与页面其余元素对齐（都撑满 max-w-2xl），高度按 4:3 锁定。
// 不用 3:4 —— 满宽下 3:4 会到 896px 高，超出一屏；也不用跟随摄像头宽高比，
// 那会导致每次打开链接布局都不同。video 用 object-cover 填满。
const BOX_AR = 4 / 3
// 用 BOX_AR 生成，避免与常量各写一份、改一处漏一处。
const boxStyle = { width: '100%', aspectRatio: `${BOX_AR}` }

// 距离提示只由文案承担（「请靠近镜头」）；这里不再做人脸尺寸到取景洞缩放的映射。
// 原因：原先按「人脸宽 / 画面宽」缩放椭圆（<0.25 缩小、>0.5 放大），
// 该比值在阈值附近抖动时会让椭圆在两种尺寸间反复切换，肉眼看到的就是「镂空框一会儿大一会儿小」。

// 椭圆取景框：高度占容器高 92%，宽度按真人脸型比例反推。
// 原用黄金比 1.618（极为高瘦），在 4:3 满宽容器里宽度只占 38%（约 255px），
// 人脸稍宽就会被遮住下半张脸或两颊。真人脸（含发际线到下巴）高宽比约 1.25~1.4，
// 取 1.3 后椭圆宽约占容器 53%（约 356px），能完整容纳常见人脸。
const OVAL_H = 0.92
const FACE_AR = 1.3
const ovalStyle = computed(() => {
  // 椭圆全高（相对容器高）= OVAL_H；换算成相对容器宽的宽度 = OVAL_H × (高/宽) / FACE_AR
  const rxPct = ((OVAL_H * (1 / BOX_AR)) / FACE_AR) * 100
  return {
    width: rxPct + '%',
    height: OVAL_H * 100 + '%',
    // 描边用 spread（无 blur）+ 小半径发光：开销远低于大半径 blur
    // 遮罩全不透明（纯黑），椭圆边缘用青色发光形成取景环
    boxShadow: ok.value
      ? '0 0 0 100vmax #000, 0 0 0 3px #4ade80, 0 0 28px 8px rgba(74,222,128,.65), inset 0 0 24px rgba(74,222,128,.25)'
      : '0 0 0 100vmax #000, 0 0 0 2px #22d3ee, 0 0 24px 5px rgba(34,211,238,.55), inset 0 0 20px rgba(34,211,238,.18)',
    // 位置固定、不做任何缩放；只让描边颜色平滑过渡
    transform: 'translate(-50%, -50%)',
    transition: 'box-shadow .2s ease',
  }
})

let stream: MediaStream | null = null
let raf = 0
let lastInfer = 0
let lastVideoTime = -1
// 保持帧数判定（带滞后 + 上锁）：
// - 失败时递减而非清零：landmark 抖动不会让进度来回跳
// - armed 上锁：达成后只在边沿返回一次，防止连续多帧重复拍摄与音效连播
const held = ref(0)
let armed = false
// 上锁后需要累计这么多帧「不达标」才重新解锁。
// 取 3：偶尔一两次抖动（眨眼、微小晃动）不会让进度清零重来，但用户真的转开了就能立刻重新计数。
const UNLOCK_AFTER_FAILS = 3

function tickHold(pass: boolean): boolean {
  if (pass) {
    if (armed) return false
    held.value += 1
    if (held.value >= STABLE_FRAMES) {
      armed = true
      return true
    }
  } else {
    held.value = Math.max(0, held.value - 1)
    if (armed && held.value <= STABLE_FRAMES - UNLOCK_AFTER_FAILS) armed = false
  }
  return false
}

function resetHold(): void {
  held.value = 0
  armed = false
}

// 诊断日志：默认静默，加 ?debug=1 打开。用来看提示抖动、音效状态与尺寸变化。
const DEBUG = new URLSearchParams(location.search).has('debug')
const dbg = (...a: unknown[]) => {
  if (DEBUG) console.log('[capture]', ...a)
}
let lastLoggedHint = ''

// 提示稳定化：yaw 在区间边界附近抖动时，「请再向左转」与「转过头了」会逐帧反复横跳。
// 因此普通提示要求最近若干帧中达成多数共识才切换；错误/无人脸一类必须立即显示，不走表决。
const URGENT_HINTS: MessageKey[] = [
  'cameraDenied', 'cameraNotFound', 'cameraBusy', 'cameraFailed', 'modelFailed',
  'failedMax', 'hintNoFace', 'hintMultiFace', 'hintTooFar', 'hintUploading',
  // 收尾阶段的「正在处理」取代了原先过早出现的「上传中…」，同样必须立即显示：
  // 收尾期间 loop 因 busy 已停止投提示，但收尾前最后一帧投出的姿态提示还留在表决缓冲里，
  // 走表决的话它会被反复压回「保持不动，正在拍摄…」，用户就看不到「正在收尾」。
  'hintFinalizing',
  // 提交失败的终态必须立即显示：它同时是「失败」与「有重试入口」的唯一提示
  'hintUploadFailed',
  // 录制段创建失败：该采集点不会有视频，必须立即告知而不是被姿态提示盖掉
  'segmentFailed',
  // 设备断开需要立即显示：否则会被逐帧判定投出的姿态提示盖掉
  'cameraLost',
  // 采集失败同样如此：画面达标时 loop 每帧都在投 hintHoldStill，
  // 会把「失败」挤成「保持不动，正在拍摄…」——而实际并没有在拍。
  'failed',
]
const HINT_BUF = 5
const HINT_NEED = 3
const hintBuf: MessageKey[] = []

function applyHint(key: MessageKey, params?: Record<string, string | number>): void {
  if (key !== lastLoggedHint) {
    dbg('hint:', lastLoggedHint || '(none)', '→', key)
    lastLoggedHint = key
  }
  hintKey.value = key
  hintParams.value = params ?? {}
}

function setHint(key: MessageKey, params?: Record<string, string | number>): void {
  if (URGENT_HINTS.includes(key)) {
    hintBuf.length = 0
    applyHint(key, params)
    return
  }
  hintBuf.push(key)
  if (hintBuf.length > HINT_BUF) hintBuf.shift()
  const agree = hintBuf.filter(k => k === key).length
  if (key !== hintKey.value && agree < HINT_NEED) return
  applyHint(key, params)
}

/**
 * 立刻换文案（不等 5/3 多数表决），用于「进新采集点」与用户主动重试。
 *
 * 不清空缓冲的话：buffer 里还留着上一步的键，新一步开头会继续显示旧文案
 * （换文案要 3 票），「请{姿态}」这类提示还会因为旧键占位而更难攒够票数。
 * 普通提示仍然走 setHint() 的多数表决，避免单帧噪声抖动界面。
 */
function setHintNow(key: MessageKey, params?: Record<string, string | number>): void {
  hintBuf.length = 0
  applyHint(key, params)
}

// 质量分仅供诊断展示（不参与判定）。
// 亮度门槛直接引用 quality.ts 的常量，避免两处各写一份、改一处漏一处。
const IDEAL_BRIGHT = 130
const BRIGHT_TOLERANCE = 70
function qualityScore(): number {
  const blurPart = Math.min(1, stats.blur / 200)
  const b = stats.brightness
  const lightPart =
    b < MIN_BRIGHT || b > MAX_BRIGHT ? 0 : Math.max(0, 1 - Math.abs(b - IDEAL_BRIGHT) / BRIGHT_TOLERANCE)
  const alignPart = Math.max(0, 1 - (Math.abs(frame.pitch) + Math.abs(frame.roll)) / 30)
  return Math.max(0, Math.min(1, 0.5 * blurPart + 0.25 * lightPart + 0.25 * alignPart))
}

function cameraError(e: unknown): void {
  const n = (e as DOMException | undefined)?.name
  if (n === 'NotAllowedError') setHint('cameraDenied')
  else if (n === 'NotFoundError' || n === 'OverconstrainedError') setHint('cameraNotFound')
  else if (n === 'NotReadableError') setHint('cameraBusy')
  else setHint('cameraFailed', { err: n ?? 'unknown' })
}

function stopStream(): void {
  stream?.getTracks().forEach(t => t.stop())
  stream = null
}

/**
 * 当前采集点的录制器是否创建失败（true = 本采集点不会有视频段）。
 * 置真后逐帧判定不再覆盖提示，否则「本段没有视频」会被「请正对镜头」之类的常态提示盖掉。
 */
const segmentFailed = ref(false)

/**
 * 为当前采集点开一段录制，并把失败做成可见（此前三个调用点都不检查返回值，
 * MediaRecorder 构造失败时视频段静默丢失：既不上屏也不进日志）。
 * 返回是否成功开始录制。
 */
function openPoseSegment(): boolean {
  if (!stream) return false
  if (startPoseRecording(stream, pose.value)) {
    segmentFailed.value = false
    return true
  }
  segmentFailed.value = true
  console.warn('[seg] startPoseRecording 失败：本采集点将没有视频段')
  dbg('录制器创建失败，本采集点无视频段')
  sfx.warn()
  setHint('segmentFailed')
  return false
}

/** 设备是否已断开。断开后停止用逐帧判定覆盖提示（否则「摄像头已断开」会被姿态提示盖掉）。 */
const camLost = ref(false)

/**
 * 上次采集失败的时间戳。
 * 失败提示是「立即显示」的，但画面此时往往仍然达标，loop() 每帧都在投 hintHoldStill，
 * 3 票后就把失败提示盖成「保持不动，正在拍摄…」——而实际并没有在拍。
 * 这里给失败提示一个冷却期，冷却内不覆盖；判定与重试不受影响。
 */
const failAt = ref(0)
const FAIL_HINT_HOLD_MS = 2500

async function startCamera(deviceId?: string): Promise<void> {
  const video: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 } }
  if (deviceId) video.deviceId = { exact: deviceId }
  else video.facingMode = 'user'
  // 先取到新流再停旧流：切换失败时旧流仍可用，采集会话不作废。
  const next = await navigator.mediaDevices.getUserMedia({ video, audio: false })
  stopStream()
  stream = next
  // 采集中途设备断开时 video 会停在最后一帧，逐帧判定只会报「未检测到人脸」，
  // 用户会误以为是自己姿势的问题 —— 这里直接给出确切原因。
  for (const track of next.getVideoTracks()) {
    track.addEventListener('ended', () => {
      // 只在「这条流仍是当前流」时提示：切设备会主动停掉旧轨道，那种情况不该报断开。
      if (stream !== next) return
      dbg('摄像头轨道 ended，判定设备断开')
      camLost.value = true
      setHint('cameraLost')
    })
  }
  const el = videoEl.value
  if (el) {
    el.srcObject = next
    await el.play().catch(() => {})
  }
  camLost.value = false
  camId.value = next.getVideoTracks()[0]?.getSettings().deviceId ?? ''
  const set = next.getVideoTracks()[0]?.getSettings()
  camRes.value = set?.width && set?.height ? `${set.width}x${set.height}` : `${videoEl.value?.videoWidth ?? 0}x${videoEl.value?.videoHeight ?? 0}`
  if (videoEl.value?.videoWidth) videoSize.w = videoEl.value.videoWidth
  const all = await navigator.mediaDevices.enumerateDevices()
  cameras.value = all.filter(d => d.kind === 'videoinput')
  setHint('hintCameraOn', { pose: t(POSE_KEY[pose.value]) })
}

// 切换设备期间的守卫：避免连点触发多次 getUserMedia（多出来的流没人释放）
let switching = false

async function switchCam(): Promise<void> {
  if (!camId.value || switching) return
  switching = true
  try {
    await startCamera(camId.value)
    // 旧 track 已被 startCamera 停掉，当前采集点的录制器随之失效，
    // 必须为新流重新开一段，否则这个采集点最终拿不到视频。
    openPoseSegment()
  } catch (e) {
    cameraError(e)
  } finally {
    switching = false
  }
}

async function shoot(): Promise<void> {
  const el = videoEl.value
  if (busy.value || submitting.value || retryable.value || !el || !stream) return
  busy.value = true
  // 注意：录制在「进入采集点」时启动（见 onMounted 与 advance()），
  // 这里不再补启动 —— 若在达标瞬间才开录，本段视频几乎是空的。
  const step = pose.value
  const isVideo = step === 'liveness'
  try {
    // 连拍产出的多张照片（视频步为空：该步不产生照片，视频段在下面统一取出）
    let shots: { blob: Blob; filename: string }[] = []
    if (isVideo) {
      // 活体步与其它采集点同等对待：进入本步时录制已启动（分段录制），
      // 达标即完成，不再要求用户额外保持数秒 —— 那纯粹是多余的等待。
      // 活体防伪由这一整段连续画面 + 正脸姿态下的眨眼检测共同保证。
      dbg('活体步达标（本段视频由下方 stopPoseRecording 取出）')
    } else {
      // 连拍：在切换步骤【之前】完成，保证这几张都是同一姿态。
      // 第 1 张同时作为本步的主文件（命名不带序号，保持既有习惯）。
      shots = []
      for (let i = 0; i < BURST; i++) {
        const b = await grabImage(el, frame)
        shots.push({ blob: b, filename: i === 0 ? `${step}_${stamp()}.jpg` : `${step}_${i + 1}_${stamp()}.jpg` })
        if (i < BURST - 1) await new Promise((r) => setTimeout(r, BURST_GAP_MS))
      }
      dbg('本步连拍', shots.length, '张：', shots.map((x) => x.filename).join(', '))
    }
    const meta: CaptureMeta = {
      yaw: Number(frame.yaw.toFixed(1)),
      pitch: Number(frame.pitch.toFixed(1)),
      roll: Number(frame.roll.toFixed(1)),
      faceWidthPx: Math.round(frame.faceWidthPx),
      blurVariance: Number(stats.blur.toFixed(2)),
      brightness: Number(stats.brightness.toFixed(2)),
      qualityScore: Number(qualityScore().toFixed(3)),
      capturedAt: Date.now(),
      deviceInfo: navigator.userAgent,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      // 录制状态随本采集点的每个文件落库：录制器没起来时置 false，
      // 后台据此区分「录制失败」与「这一步没有视频」。
      segmentOk: !segmentFailed.value,
    }
    // 拍到就立刻切到下一步，上传放到后台队列。
    // 之前是 await 上传完再 advance，用户转到目标角度后还要额外等 0.5~1s 才进入下一步，
    // 这就是「向左转要等一两秒」的主要来源。
    for (const x of shots) results.push({ pose: step, filename: x.filename })
    sfx.shot()
    // 收下本采集点的视频段：advance() 在最后一步会调 cleanup()，
    // 而 cleanup() 里会 stopPoseRecording()，所以必须在这里先取走。
    const isLastStep = step === POSES[POSES.length - 1]
    // 收尾阶段（等 onstop、补足最短录制时长）改用与上传无关的「正在处理，请稍候…」：
    // 早先这里直接设「上传中…」，而收尾在 iOS WKWebView 上会卡住
    // （stop() 被接受但 onstop 永不触发），界面便永久停在「上传中」，服务端一条请求都收不到。
    // 只在最后一步设：非最后一步收尾完就 advance()，多设一次只会让下一步的姿态提示
    // 被表决缓冲多挡几帧才显示（那一步的收尾通常只有几十毫秒，不值得为它换文案）。
    if (isLastStep) setHint('hintFinalizing')
    // 用户可能瞬间达标（例如正脸很标准），此时本段还不到 0.4 秒、体积低于有效性门槛，
    // 取出来也会被丢弃，导致该采集点没有视频。这里补足最短录制时长再取
    // —— 秒过的用户最多多等不到 1.2 秒，却能保证每段视频都可用。
    const elapsed = poseRecordingElapsed()
    if (elapsed < MIN_SEGMENT_MS) await new Promise((r) => setTimeout(r, MIN_SEGMENT_MS - elapsed))
    const poseVideo = await stopPoseRecording()
    dbg('本段录制收尾:', step, poseVideo ? poseVideo.blob.size + ' 字节' : '(为空)')
    const kind: 'image' | 'video' = isVideo ? 'video' : 'image'
    // 视频步不产生独立文件（整段视频在收尾时统一取出），只有照片步需要入队
    const batch = isVideo ? [] : shots
    for (const x of batch) {
      stash(x.blob, x.filename, kind, step, meta)
    }
    // 本采集点的视频段与照片一起入队（文件名带 pose，便于后台分辨）
    if (poseVideo) {
      // 文件名先取成变量：results 与 pendingFiles 必须用同一个名字。
      const vidName = `${step}_video_${stamp()}.${extFor(poseVideo.mime)}`
      pendingFiles.push({
        pose: step,
        blob: poseVideo.blob,
        filename: vidName,
        kind: 'video',
        meta,
      })
      // results 是「本次采集产出的结果清单」，视频段同样是结果的一部分。
      // 早先只在连拍分支写 results（照片），于是 emit payload 恒为 10 条而真实上传 16 个文件
      // （缺的 6 个正是各采集点的 *_video_*.webm），与 CaptureResult[] 的声明自相矛盾。
      results.push({ pose: step, filename: vidName })
    }

    if (isLastStep) {
      // 最后一步：等整批文件真正提交完成，成功后才切到完成页。
      // 不先 advance()——否则「识别完成」会在上传还没结束时显示，用户可能提前离开。
      await submit()
      return
    }
    advance()
  } catch (e) {
    // 内部异常的技术消息只进控制台（dbg 仅在 ?debug=1 时输出）。
    // 界面用本地化文案：直接把 e.message 上屏会在英文界面里出现中文，
    // 而且这类内部错误对用户没有可操作性。
    dbg('采集流程出错：', e)
    failAt.value = Date.now()
    // 必须重置达标计数：否则 armed 一直是 true，tickHold 再也不返回 true，
    // shoot() 就不会被再次触发 —— 界面承诺的「保持姿态会自动重试」会变成不重试。
    resetHold()
    fails.value++
    if (fails.value >= MAX_FAILS) setHint('failedMax')
    else setHint('failed', { msg: t('captureFailed') })
  } finally {
    recording.value = false
    busy.value = false
  }
}

function advance(): void {
  fails.value = 0
  ok.value = false
  resetHold()
  if (idx.value >= POSES.length - 1) {
    cleanup()
    sfx.done()
    emit('done', [...results])
    return
  }
  idx.value++
  // 进入新的采集点：开始录这一段（上一段已在 shoot() 里取走）
  openPoseSegment()
  sfx.step()
  setHintNow('hintCameraOn', { pose: t(POSE_KEY[pose.value]) })
}

/** 提交整批文件；成功后切到完成页，失败则留在本页等待重试。 */
/** 自动重试次数与间隔：用户无需任何操作，失败就自己再试。 */
const SUBMIT_TRIES = 3
const SUBMIT_BACKOFF_MS = 1200

async function submit(): Promise<void> {
  submitting.value = true
  uploading.value = true
  uploadError.value = ''
  submitFailed.value = false
  // 「上传中…」与 uploading（驱动旋转动画）必须与「真的开始上传」同一时刻出现。
  // 此前这行提示提前到了 shoot() 里用户刚达标的那一刻，收尾阶段就已经显示「上传中」，
  // 收尾一旦卡住，界面便永久停在这个文案上 —— 用户以为在上传，其实什么都没发出去。
  setHint('hintUploading')
  dbg('开始提交，文件数:', pendingFiles.length)

  try {
    // 整批提交（含下面所有轮次与内层重试）共用一个截止时刻：
    // 不共享的话最坏耗时 = 外层 3 轮 × 内层 3 次 × 25s 单次上限 + 退避 ≈ 237.6s，
    // 期间没有任何进度反馈，用户只能干等。
    const deadline = Date.now() + UPLOAD_BUDGET_MS
    for (let attempt = 1; attempt <= SUBMIT_TRIES; attempt++) {
      // 预算已耗尽：不再发起新一轮，直接进入失败态（否则总耗时突破预算，失败态永远到不了）
      if (Date.now() >= deadline) {
        if (!uploadError.value) uploadError.value = t('uploadFailed')
        break
      }
      try {
        await uploadSession(props.sessionId, pendingFiles, deadline)
        dbg('提交成功（第 ' + attempt + ' 次尝试）')
        sfx.done()
        cleanup()
        emit('done', [...results])
        return
      } catch (e) {
        uploadError.value = e instanceof Error ? e.message : String(e)
        dbg('第 ' + attempt + ' 次提交失败：', uploadError.value)
        if (attempt < SUBMIT_TRIES) {
          // 间隔递增：1.2s、2.4s。退避同样计入预算，剩余时间不够就直接进失败态，
          // 不让用户多等一个注定超时的间隔。
          const wait = SUBMIT_BACKOFF_MS * attempt
          if (Date.now() + wait >= deadline) break
          await new Promise((r) => setTimeout(r, wait))
        }
      }
    }
    // 全部尝试都失败：切成明确的失败态并给出重试入口。
    // 不能只停动画 —— 文案仍是「上传中…」时用户会一直等下去，
    // 而本次采集的文件只在内存里，刷新页面就全丢了。
    submitFailed.value = true
    setHint('hintUploadFailed')
    sfx.warn()
    dbg('提交最终失败：', uploadError.value)
  } finally {
    // 任何出口（成功切页、提交失败、预算耗尽、内部抛错）都必须复位这两个状态，
    // 否则旋转动画会一直转，观感上就是「永远在上传」。
    submitting.value = false
    uploading.value = false
  }
}

/** 提交失败后的重试入口：保留已采集的文件，只重发整批提交。 */
async function retrySubmit(): Promise<void> {
  if (submitting.value) return
  await submit()
}

async function retry(): Promise<void> {
  // 用于「连续多帧无法识别」时的重新开始（上传失败走 retrySubmit）
  fails.value = 0
  resetHold()
  // 设备可能已断开：此时直接设「请{pose}」会让用户以为一切正常，而画面其实是静止的。
  // 先尝试重新取流；成功则 camLost 会被 startCamera 清掉，失败则保留断开提示。
  if (camLost.value) {
    try {
      await startCamera(camId.value || undefined)
    } catch (e) {
      cameraError(e)
      return
    }
  }
  setHintNow('hintCameraOn', { pose: t(POSE_KEY[pose.value]) })
  // 重开录制段：retry 之前录制器可能已因异常收尾被置空（此后一直没人在录），
  // 而重新取流的路径会让旧段与新流不再同源（switchCam 早已补了同样的补偿，这里此前漏了）。
  // startPoseRecording 对「同姿态且录制器仍在」是幂等的，健康时重复调用不会空转。
  openPoseSegment()
}

function loop(): void {
  raf = requestAnimationFrame(loop)
  const el = videoEl.value
  const ov = overlayEl.value
  if (!el || !ov || el.videoWidth === 0) return
  // 视频尺寸就绪后同步给响应式变量（相机启动瞬间 videoWidth 可能还是 0）
  if (videoSize.w !== el.videoWidth) videoSize.w = el.videoWidth
  if (ov.width !== el.videoWidth) {
    ov.width = el.videoWidth
    ov.height = el.videoHeight
  }
  const now = performance.now()
  if (now - lastInfer < INFER_MS || busy.value || recording.value) return
  // 同一视频帧不重复推理（摄像头帧率低于推理频率时能省下大量算力）
  if (el.currentTime === lastVideoTime) return
  lastVideoTime = el.currentTime
  lastInfer = now
  const f = detectFace(el, now)
  Object.assign(frame, f)
  drawOverlay(ov, f)
  if (retryable.value) return
  const s = roiStats(el, f)
  stats.blur = s.blur
  stats.brightness = s.brightness
  stats.roi = s.roi
  const verdict = judge(f, el.videoWidth, s.blur, s.brightness, pose.value)
  ok.value = verdict.pass
  // 正在录制或正在上传时，不要用逐帧判定结果覆盖提示 ——
  // 否则「保持不动，正在拍摄…」「上传中…」会被冲掉，动画一闪而过。
  // 设备断开后不再用逐帧判定覆盖提示：画面已静止，判定结果没有意义。
  // 失败提示的冷却期内同样不覆盖，否则「失败」会被立刻盖成「正在拍摄」。
  // 提交失败后也不能被覆盖：否则「上传失败…」3 帧后就被「保持不动」盖掉，
  // 用户看不到失败也不知道可以重试；录制段创建失败同理。
  const inFailHold = Date.now() - failAt.value < FAIL_HINT_HOLD_MS
  if (!recording.value && !submitting.value && !camLost.value && !inFailHold && !segmentFailed.value && !submitFailed.value)
    setHint(verdict.hintKey)
  if (!camLost.value && tickHold(verdict.pass)) void shoot()
}

function cleanup(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  void stopPoseRecording()
  stopStream()
  if (videoEl.value) videoEl.value.srcObject = null
  // 释放模型，否则移动端会残留摄像头指示灯与耗电
  closeFace()
}

// 手势解锁音频：注册与解绑必须用同一个函数引用，事件表也在 setup 作用域里共用一份
//（此前注册用的是行内匿名箭头，onBeforeUnmount 无从解绑）。
const UNLOCK_EVENTS = ['pointerdown', 'touchstart', 'click', 'keydown'] as const
const unlockAudio = (): void => primeAudio()

// 切后台再回来：音频常被挂起、视频也可能暂停，需要恢复
function onVisibility(): void {
  if (document.visibilityState !== 'visible') return
  resumeAudio()
  const el = videoEl.value
  if (el && el.paused) void el.play().catch(() => {})
}

onMounted(async () => {
  document.addEventListener('visibilitychange', onVisibility)
  // 提示音强制开启、界面不做任何提示，但浏览器要求音频必须在用户手势中解锁，
  // 所以在全页面挂手势监听：用户点过任意处（或按过键）后提示音即可正常播放。
  // 监听一直保留而不在解锁后移除 —— 切后台再回来时 AudioContext 可能又被挂起，需要再次解锁。
  // 注意：解绑需要同一个函数引用，因此这里用具名常量而不是行内匿名箭头
  //（此前用匿名箭头注册，onBeforeUnmount 无从解绑，每轮重新挂载都会叠加 4 个监听器）。
  for (const e of UNLOCK_EVENTS) window.addEventListener(e, unlockAudio, { passive: true })

  try {
    await initFace()
  } catch {
    setHint('modelFailed')
    return
  }
  try {
    await startCamera()
  } catch (e) {
    cameraError(e)
    return
  }
  // 摄像头就绪即为第 1 个采集点开录（后续各段由 advance() 启动）。
  // 注意：必须在 onMounted 里调用一次，不能放在 loop() 里 —— 那会变成每帧调用，
  // 既是无谓开销，也会在录制器异常置空后反复重开段。
  openPoseSegment()
  raf = requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  // 与 onMounted 的注册逐事件配对解绑（否则每轮重新挂载都在 window 上多留 4 个闭包）。
  // 不传 options：解绑只看 capture 标志，注册时的 passive 不参与匹配，默认值即一致。
  for (const e of UNLOCK_EVENTS) window.removeEventListener(e, unlockAudio)
  cleanup()
})
</script>

<template>
  <div class="space-y-5">
    <!-- 步骤指示：用图形而非文字，避免与画面内的提示文案重复表达同一件事。
         已完成=绿点，当前=青色胶囊，未开始=灰点 -->
    <div class="flex items-center justify-center gap-2.5">
      <span
        v-for="(p, i) in POSES"
        :key="p"
        class="h-2.5 rounded-full transition-all duration-300"
        :class="i < idx ? 'w-2.5 bg-green-500' : i === idx ? 'w-8 bg-cyan-400' : 'w-2.5 bg-gray-300'"
      />
    </div>

    <!-- 摄像头未就绪：占位必须与下面的视频容器用同一份尺寸样式，
         否则授权成功那一刻占位→容器切换会明显跳动（用户实测可见）。
         用 v-show 而非 v-if —— video 元素必须始终在 DOM 里才能取流播放 -->
    <div
      v-if="!videoSize.w"
      class="mx-auto flex items-center justify-center rounded-xl bg-gray-900 ring-1 ring-gray-300"
      :style="boxStyle"
    >
      <p class="text-lg font-medium text-gray-300">{{ t('startingCamera') }}</p>
    </div>

    <!-- 摄像头画面。容器比例固定为 BOX_AR（4:3），不跟随视频真实比例 ——
         跟随的话，摄像头授权成功那一刻分辨率从 0 变为真实值，容器尺寸会突变（用户实测可见跳动）。
         画面用 object-cover 填满，多余部分裁掉；椭圆遮罩的百分比因此参照的是一个恒定区域。
         未就绪前整块隐藏，避免先用占位比例再突变。
         分层顺序固定：video(z0) → 关键点 canvas(z1) → 遮罩(z2) → 箭头(z3)。
         遮罩用 CSS box-shadow 反向压暗而非 SVG mask：尺寸不变时由合成层缓存，不产生每帧重绘。
         椭圆半轴比取自 FACE_AR（= 1.3）。最初按黄金比 1.618 设过，但那个比例太高，
         装不下整张脸（用户反馈后改为 1.3）。 -->
    <div
      v-show="videoSize.w"
      class="relative mx-auto overflow-hidden rounded-xl bg-gray-900 ring-1 ring-gray-300"
      :style="boxStyle"
    >
      <video ref="videoEl" class="absolute inset-0 h-full w-full scale-x-[-1] object-cover" autoplay playsinline muted></video>
      <canvas ref="overlayEl" class="pointer-events-none absolute inset-0 z-[1] h-full w-full"></canvas>

      <!-- 椭圆遮罩：自身不可见，靠 box-shadow 的外圈 spread 压暗椭圆之外（容器已 overflow-hidden 裁掉溢出）。
           常驻显示、不随是否检测到人脸而出现/消失 —— 否则无脸时会整块画面变亮，造成明显闪烁。 -->
      <div
        class="pointer-events-none absolute left-1/2 top-1/2 z-[2] rounded-full"
        :style="ovalStyle"
      />

      <!-- 转向引导箭头：位于遮罩之上 -->
      <div
        v-if="turnDir"
        class="pointer-events-none absolute inset-y-0 z-[3] flex items-center"
        :class="turnDir === 'left' ? 'left-0 pl-2 md:pl-4' : 'right-0 pr-2 md:pr-4'"
      >
        <svg class="h-10 w-10 animate-pulse text-white md:h-14 md:w-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path v-if="turnDir === 'left'" d="M19 12H5M11 18l-6-6 6-6" />
          <path v-else d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </div>

      <!-- 取景框装饰：只保留一道缓慢扫过的光带（四角标记按反馈去除） -->
      <div class="pointer-events-none absolute inset-0 z-[3]">
        <div class="scan-line absolute inset-x-0 h-20" />
      </div>

      <!-- 状态提示悬浮在画面内【顶部】，无背景，文字加黑边保证在画面上依然清晰。
           高度固定（HINT_BOX_H）保证不因文字长短而跳动。 -->
      <div class="pointer-events-none absolute inset-x-0 top-0 z-[5] p-3">
        <div class="flex items-center justify-center" :style="{ height: HINT_BOX_H + 'px' }">
          <p
            class="hint-outline flex items-center justify-center gap-3 text-xl font-bold leading-snug md:text-2xl"
            :class="ok ? 'text-green-300' : 'text-white'"
          >
            <span v-if="uploading" class="upload-spinner" aria-hidden="true"></span>
            {{ hint }}
          </p>
        </div>
      </div>
    </div>

    <!-- 摄像头切换 -->
    <div v-if="cameras.length > 1" class="flex justify-center">
      <select
        v-model="camId"
        class="w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-base text-gray-800 md:w-auto"
        @change="switchCam"
      >
        <option v-for="(c, i) in cameras" :key="c.deviceId || i" :value="c.deviceId">
          {{ t('camera', { n: i + 1 }) }}
        </option>
      </select>
    </div>

    <!-- 重试 -->
    <button
      v-if="retryable"
      class="w-full rounded-xl bg-blue-700 px-6 py-4 text-lg font-semibold text-white active:bg-blue-800 md:w-auto"
      @click="retry"
    >
      {{ t('retry') }}
    </button>

    <!-- 提交失败的恢复入口：已采集的文件仍在内存里，点它整批重发；
         不给入口的话用户只能刷新页面，而刷新会丢掉本次全部采集 -->
    <button
      v-if="submitFailed"
      class="w-full rounded-xl bg-blue-700 px-6 py-4 text-lg font-semibold text-white active:bg-blue-800 md:w-auto"
      @click="retrySubmit"
    >
      {{ t('retryUpload') }}
    </button>

    <!-- 实时指标：逐帧变化的数字会让界面看起来在「跳」，因此只在 ?debug=1 时显示，便于排查 -->
    <p v-if="DEBUG" class="text-center text-xs leading-relaxed text-gray-400">
      {{ t('metricCamera') }} {{ camRes }} · {{ t('metricYaw') }} {{ frame.yaw.toFixed(0) }}° ·
      {{ t('metricPitch') }} {{ frame.pitch.toFixed(0) }}° ({{ frame.pitch < -3 ? t('debugUp') : frame.pitch > 3 ? t('debugDown') : t('debugLevel') }}) · {{ t('metricRoll') }} {{ frame.roll.toFixed(0) }}° ·
      {{ t('metricFaceWidth') }} {{ Math.round(frame.faceWidthPx) }}px · {{ t('metricSharpness') }}
      {{ Math.round(stats.blur) }} ({{ stats.roi }}) · {{ t('metricLight') }} {{ Math.round(stats.brightness) }}
      · {{ t('metricBlink') }} {{ frame.eyeBlinkLeft.toFixed(2) }}/{{ frame.eyeBlinkRight.toFixed(2) }}
      · {{ uploading ? t('debugUploading') : uploadError ? t('debugUploadFailed') + uploadError.slice(0, 40) : t('debugPending') + ' ' + pendingFiles.length + ' ' + t('debugFilesUnit') }}
    </p>
  </div>
</template>
