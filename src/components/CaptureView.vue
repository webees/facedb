<script setup lang="ts">
import { MAX_BRIGHT, MIN_BRIGHT, judge, POSE_KEY, roiStats, STABLE_FRAMES, type Pose } from '../lib/quality'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { createHints, uploadFailureHint } from '../lib/hints'
import { closeFace, detectFace, drawOverlay, emptyFrame, initFace } from '../lib/face'
import {
  BURST,
  BURST_GAP_MS,
  grabImage,
  stamp,
  MIN_SEGMENT_MS,
  poseRecordingElapsed,
  startPoseRecording,
  stopPoseRecording,
  takeSegmentDropped,
  teardownRecorder,
} from '../lib/capture'
import { UPLOAD_BUDGET_MS, type CaptureMeta, type CaptureResult, type PendingFile } from '../lib/pb'
import { runUploadBatch, preSubmitQueue } from '../lib/upload-batch'
import { buildPoseFiles } from '../lib/batch-files'
import { primeAudio, resumeAudio, sfx } from '../lib/audio'
import { cameraErrText } from '../lib/camera-error'
import { preferPhysicalCamera } from '../lib/camera-pick'
import { boxStyle, ovalBox, ovalShadow } from '../lib/framing'
import { t } from '../lib/i18n'
import CaptureFooter from './CaptureFooter.vue'

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
// 「本次一个可上传的文件都没有」（整批文件都被判过小丢弃 / 录制结果为空）。
// 与 submitFailed 分开的原因：它既不是网络问题、也不是「传了一半失败」，
// 重发同一批文件永远不会成功 —— 唯一的有效动作是重新采集，
// 所以它换「录制为空」类文案（hintEmptyBatch）并给出重试（重新采集）入口，
// 而不是报「上传失败，请检查网络」把用户引去检查网络（W23B-05）。
const emptyBatch = ref(false)
// 一次识别 = 一条记录：各采集点的文件先缓存在内存，最后一步完成后一次性提交。
// 不在每步提交是因为 captures 的 updateRule 只允许登录用户更新，匿名 PATCH 会被拒；
// 而末次 POST 只需 createRule，且提交是原子的（不会留下「半条记录」）。
// 必须是响应式的（reactive 而非普通数组）：模板诊断行读的是 pendingFiles.length，
// 普通数组不会触发重渲染，计数会一直停在 0 或上一次渲染的旧值（排查上传问题时给出的是假数字）。
// 用 reactive 而不是 ref：所有读写点（push / length / 传给 uploadSession）保持原样，
// 改动只有这一行。
const pendingFiles = reactive<PendingFile[]>([])
// 连续无法识别的次数；达到 MAX_FAILS 时给出「重新开始」入口
const fails = ref(0)
const results = reactive<CaptureResult[]>([])
const frame = reactive(emptyFrame())
const stats = reactive({ blur: 0, brightness: 0, roi: '0x0' })
// 摄像头实际输出分辨率（来自 track 设置），用于判断视频是否被低分辨率放大
const camRes = ref('')

const pose = computed(() => POSES[idx.value])
// 断流后也必须给出入口（R15-F3）：fails 只在 shoot() 的 catch 里自增，而 camLost 时
// loop() 直接跳过 shoot()，于是 fails 永远到不了 MAX_FAILS，「重新识别」按钮永不出现。
// 而提示让用户「刷新页面」——刷新会丢掉内存里本次全部已采集文件。
// emptyBatch 同样并入：队列为空时唯一的出路是重新采集，入口必须可见（W23B-05）。
// camStartFailed 也必须并入（R24 / W24A-03）：摄像头一开始就没取到时 fails 与 camLost 恒 false，
// 三个条件全不成立、按钮永不渲染，用户只能刷新页面 ⇒ 丢掉内存里本次全部已采集文件。
const retryable = computed(
  () => fails.value >= MAX_FAILS || camLost.value || camStartFailed.value || emptyBatch.value,
)
const hint = computed(() => t(hints.key.value, hints.params.value))
// 需要转头时，在椭圆外侧给出方向箭头（复用提示状态，不额外判断几何）
const turnDir = computed<'left' | 'right' | null>(() =>
  hints.key.value === 'hintTurnLeft' ? 'left' : hints.key.value === 'hintTurnRight' ? 'right' : null,
)

// 提示框固定高度：只有一行主文案（20/24px）＋内边距，取 56 保证手机与桌面都不溢出。
const HINT_BOX_H = 56


// 视频真实尺寸必须用响应式变量记录：videoWidth/videoHeight 是 DOM 属性，
// computed 不会因它们变化而重算，直接读会永远拿到 0。
// 只用于判断视频是否已就绪（决定占位与画面容器谁可见）。
// 曾经还记录 h，但从未被读取；容器比例现在固定为 BOX_AR，不再依赖视频尺寸。
const videoSize = reactive({ w: 0 })

// 取景几何（容器比例、椭圆取景环）与「环外不再涂黑」的口径都在 lib/framing.ts 里，
// 这里只做组合：形状来自 ovalBox()，配色来自 ovalShadow(是否达标)。
const ovalStyle = computed(() => ({ ...ovalBox(), boxShadow: ovalShadow(ok.value) }))

let stream: MediaStream | null = null
let raf = 0
// 卸载标志（R13-F8）：onMounted 的异步链与 submit 的重试循环都要在每步之后查它，
// 否则「模型还在下载时用户离开页面」会继续开摄像头、开录制、起逐帧循环，之后再无人回收。
let disposed = false
// 轨道 'ended' 监听器登记表：注册与解绑必须成对（此前只 add 不 remove，
// 每条被丢弃的轨道都留一个闭包，闭包捕获整个组件实例）。
const trackEndHandlers: { track: MediaStreamTrack; fn: () => void }[] = []
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

// 提示稳定化与表决逻辑在 src/lib/hints.ts（R13-F11 外移：组件行数曾越过 800 行高风险阈值）。
const hints = createHints('loadingModel', (from, to) => dbg('hint:', from || '(none)', '→', to))

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
  if (n === 'NotAllowedError') hints.set('cameraDenied')
  else if (n === 'NotFoundError' || n === 'OverconstrainedError') hints.set('cameraNotFound')
  else if (n === 'NotReadableError') hints.set('cameraBusy')
  else hints.set('cameraFailed', { err: cameraErrText(n) })
}

function stopStream(): void {
  // 先摘监听器再停流：解绑只认函数引用，停完之后 track 仍可解绑，
  // 但顺序反了会让「同一批 track 被停两次」这类路径依赖实现细节。
  for (const { track, fn } of trackEndHandlers) track.removeEventListener('ended', fn)
  trackEndHandlers.length = 0
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
  hints.set('segmentFailed')
  return false
}

/** 设备是否已断开。断开后停止用逐帧判定覆盖提示（否则「摄像头已断开」会被姿态提示盖掉）。 */
const camLost = ref(false)

/** 摄像头**从头就没起来**（getUserMedia 直接抛错）。camLost 只在 startCamera 成功末尾清零，故启动即失败时它恒 false（R24 / W24A-03 的死锁）。 */
const camStartFailed = ref(false)

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
  let next = await navigator.mediaDevices.getUserMedia({ video, audio: false })
  // 未指定设备时，系统默认可能选中**虚拟摄像头**（本机实测 macOS/Chrome 默认就是
  // 「OBS Virtual Camera」：不推流时永远没有帧，推流时画面里也没有用户），
  // 用户看到的就是「一直没有我」。这里尽力改选实体设备；失败就沿用原流。
  // 带 deviceId 的路径（下拉框显式选择、重试）不做任何改动。
  if (!deviceId) next = (await preferPhysicalCamera(next)) ?? next
  // 卸载守卫（R13-F10）：等待期间组件可能已经卸载（onBeforeUnmount 里的 stopStream/cleanup
  // 早就跑完了）。这条流此刻没有任何接管者，必须就地停掉 —— 否则轨道一直活着、
  // 摄像头指示灯亮着。实测修复前：tracks_live=1 / tracks_stopped=0 / streams_live=1。
  if (disposed) {
    for (const t of next.getTracks()) t.stop()
    return
  }
  stopStream()
  stream = next
  // 采集中途设备断开时 video 会停在最后一帧，逐帧判定只会报「未检测到人脸」，
  // 用户会误以为是自己姿势的问题 —— 这里直接给出确切原因。
  for (const track of next.getVideoTracks()) {
    const onEnded = () => {
      // 只在「这条流仍是当前流」时提示：切设备会主动停掉旧轨道，那种情况不该报断开。
      if (stream !== next) return
      dbg('摄像头轨道 ended，判定设备断开')
      camLost.value = true
      hints.set('cameraLost')
    }
    track.addEventListener('ended', onEnded)
    trackEndHandlers.push({ track, fn: onEnded })
  }
  const el = videoEl.value
  if (el) {
    el.srcObject = next
    await el.play().catch(() => {})
  }
  camLost.value = false
  camStartFailed.value = false
  camId.value = next.getVideoTracks()[0]?.getSettings().deviceId ?? ''
  const set = next.getVideoTracks()[0]?.getSettings()
  camRes.value = set?.width && set?.height ? `${set.width}x${set.height}` : `${videoEl.value?.videoWidth ?? 0}x${videoEl.value?.videoHeight ?? 0}`
  if (videoEl.value?.videoWidth) videoSize.w = videoEl.value.videoWidth
  const all = await navigator.mediaDevices.enumerateDevices()
  cameras.value = all.filter(d => d.kind === 'videoinput')
  hints.set('hintCameraOn', { pose: t(POSE_KEY[pose.value]) })
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
    if (isLastStep) hints.set('hintFinalizing')
    // 用户可能瞬间达标（例如正脸很标准），此时本段还不到 0.4 秒、体积低于有效性门槛，
    // 取出来也会被丢弃，导致该采集点没有视频。这里补足最短录制时长再取
    // —— 秒过的用户最多多等不到 1.2 秒，却能保证每段视频都可用。
    const elapsed = poseRecordingElapsed()
    if (elapsed < MIN_SEGMENT_MS) await new Promise((r) => setTimeout(r, MIN_SEGMENT_MS - elapsed))
    // 取段失败不得连坐本采集点的照片：段收尾出错（录制器异常、或 iOS WKWebView 上
    // stop() 被接受但 onstop 永不触发后超时）只应表现为「本步没有视频」，而不是把整批照片丢掉。
    let poseVideo: { blob: Blob; mime: string } | null = null
    let segmentErrored = false
    try {
      poseVideo = await stopPoseRecording()
    } catch (e) {
      segmentErrored = true
      dbg('本段录制收尾出错，按「本步没有视频」处理：', e)
    }
    // 段是否因体积过小被丢弃：必须在这里取 —— 段的收尾（含「过小 → 不保留」的判定）
    // 就发生在 stopPoseRecording() 内部，早于它读只会读到上一采集点的旧事实。
    // 读后即复位；复位时机与「跨采集点不串味」写在 capture.ts 的 takeSegmentDropped 注释里。
    const segmentDropped = takeSegmentDropped()
    dbg(
      '本段录制收尾:',
      step,
      poseVideo ? poseVideo.blob.size + ' 字节' : '(为空)',
      segmentDropped ? '（段被丢弃：本采集点没有可用视频）' : '',
    )
    // meta 必须在这里构造（而不是赶在连拍结束时就构造）：segmentOk 要回答的是
    // 「这一段到底有没有留下可用视频」，而这件事只有 stopPoseRecording() 跑完才成定局（W23B-06）。
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
      // 录制状态随本采集点的每个文件落库，两种情况都置 false：
      //   ① 录制器没起来（segmentFailed）；
      //   ② 段收到了但被判过小丢弃、本采集点一段都没有（segmentDropped）——
      //      此前这条路径没有任何对外信号，落库侧只看到「video 为空」，
      //      与「用户这一步本来就没拍视频」完全同形。
      segmentOk: !segmentFailed.value && !segmentDropped && !segmentErrored,
    }
    // 照片与视频段一起入队（装配在 src/lib/batch-files.ts，两侧文件名同源）
    const pose = buildPoseFiles({ step, shots, poseVideo, meta, stamp })
    for (const f of pose.files) pendingFiles.push(f)
    // results 是「本次采集产出的结果清单」，视频段同样是结果的一部分。
    if (pose.videoResult) results.push(pose.videoResult)

    if (isLastStep) {
      // 最后一步：等整批文件真正提交完成，成功后才切到完成页。
      // 不先 advance()——否则「识别完成」会在上传还没结束时显示，用户可能提前离开。
      // 传 true：队列此刻已定（本步文件刚入队），不必再去等自己收尾（否则会等满 drain 上限）。
      await submit(true)
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
    if (fails.value >= MAX_FAILS) hints.set('failedMax')
    else hints.set('failed', { msg: t('captureFailed') })
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
  hints.setNow('hintCameraOn', { pose: t(POSE_KEY[pose.value]) })
}

/** 提交整批文件；成功后切到完成页，失败则留在本页等待重试。 */
/** 自动重试次数与间隔（用户无需操作，失败自己再试）与等收尾上限：20ms × 60 = 1.2s */
const SUBMIT_TRIES = 3
const SUBMIT_BACKOFF_MS = 1200
const DRAIN_TRIES = 60
const DRAIN_MS = 20

async function submit(fromShoot = false): Promise<void> {
  // R24B-01：自守，守卫不能只挂在 retrySubmit 上。实测 dbl 场景：同拍并发两次 submit()
  // ⇒ 两个 POST 同时在飞、载荷逐字相同 ⇒ 服务端落两条等价记录。这里在第一个 await 之前置位。
  if (submitting.value) {
    dbg('提交入口：已有一次提交在飞，忽略这次调用（R24B-01）')
    return
  }
  submitting.value = true
  uploading.value = true
  uploadError.value = ''
  submitFailed.value = false
  emptyBatch.value = false
  try {
    // 提交入口先判队列前提（W23B-05 / R23REV-N3）：整批被判过小丢弃时队列为空，进重试循环毫无意义，
    // 界面还会报「上传失败，请检查网络」把用户引向错误方向；而等收尾超时属于**队列状态未知**，
    // 既不能报「录制为空」也不能给「重新采集」。两种情形都一个网络请求都不发（见 upload-batch.ts）。
    // 从 shoot() 内部调用（最后一步）时队列已定，不必等；从按钮调用时必须先等。
    // 等满上限仍忙 ⇒ 队列状态未知（R23REV-N3）：如实提示「仍在收尾」，不发任何请求、也不给「重新采集」。
    if (!fromShoot) {
      const q = await preSubmitQueue(() => busy.value, DRAIN_TRIES, DRAIN_MS, pendingFiles.length)
      if (q === 'finalizing') { uploadError.value = t('stillFinalizing'); hints.setNow('hintStillFinalizing'); sfx.warn(); return }
    }
    if (pendingFiles.length === 0) {
      emptyBatch.value = true
      uploadError.value = t('emptyRecording')
      dbg('提交中止：待提交文件数为 0，无文件可上传，跳过网络重试（不发出任何请求）')
      hints.setNow('hintEmptyBatch')
      sfx.warn()
      return
    }
    // 「上传中…」与 uploading（驱动旋转动画）必须与「真的开始上传」同一时刻出现。
    // 此前这行提示提前到了 shoot() 里用户刚达标的那一刻，收尾阶段就已经显示「上传中」，
    // 收尾一旦卡住，界面便永久停在这个文案上 —— 用户以为在上传，其实什么都没发出去。
    hints.set('hintUploading')
    dbg('开始提交，文件数:', pendingFiles.length)

    // R24B-02：**冻结这一批**。runUploadBatch 每轮、post() 每次重试都会重跑构造 FormData 的
    // 回调，而回调闭包引用这个数组；不冻结的话「提交在飞期间新入队的文件」会进重试那次的 body，
    // 却不在同一时刻算出的 meta.perFile 里（实测 latefile：late_extra.jpg 无 meta 条目）。
    const batch = pendingFiles.slice()
    // 轮次 / 退避 / 预算的编排在 src/lib/upload-batch.ts（策略与界面状态解耦，可单独驱动）
    const run = await runUploadBatch(
      batch,
      props.sessionId,
      { tries: SUBMIT_TRIES, backoffMs: SUBMIT_BACKOFF_MS, budgetMs: UPLOAD_BUDGET_MS },
      { isDisposed: () => disposed, onAttemptFail: (n, m) => dbg('第 ' + n + ' 次提交失败：', m) },
    )
    if (run.ok) {
      dbg('提交成功（第 ' + run.attempts + ' 次尝试）')
      sfx.done()
      cleanup()
      // 已卸载时不再对外发事件（emit 到已卸载组件会命中 Vue 的开发期告警）
      if (!disposed) emit('done', [...results])
      return
    }
    // 组件已卸载：不发事件也不改界面状态
    if (run.reason === 'disposed') return
    // 预算耗尽但一次都没发出去时没有技术消息，退回本地化文案
    uploadError.value = run.error || t('uploadFailed')
    // 全部尝试都失败：切成明确的失败态并给出重试入口。不能只停动画 —— 文案仍是「上传中…」时
    // 用户会一直等下去，而本次采集的文件只在内存里，刷新页面就全丢了。
    submitFailed.value = true
    // 归因分流（R28 W28C-02）：4xx 拒绝与网络故障的下一步动作不同（映射见 hints.ts）
    hints.set(uploadFailureHint(run.permanent))
    sfx.warn()
    dbg('提交最终失败：', uploadError.value, '（原因：', run.reason, '）')
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
  // 队列为空时点「重试」= 重新采集：必须先清掉 emptyBatch，否则 shoot() 的
  // retryable 守卫会把后续每一次达标都挡回去（用户点了却什么都不再发生）。
  emptyBatch.value = false
  resetHold()
  // 设备可能已断开：此时直接设「请{pose}」会让用户以为一切正常，而画面其实是静止的。
  // 先尝试重新取流；成功则 camLost 会被 startCamera 清掉，失败则保留断开提示。
  // R24 / W24A-03：启动即失败（camStartFailed）也要走这条重取流路径，否则点了「重试」只改提示。
  if (camLost.value || camStartFailed.value) {
    try {
      await startCamera(camId.value || undefined)
    } catch (e) {
      camStartFailed.value = true
      cameraError(e)
      return
    }
  }
  hints.setNow('hintCameraOn', { pose: t(POSE_KEY[pose.value]) })
  // R24 / W24A-03：挂载即失败时逐帧循环**从未启动**（raf 恒 0），不补启动则重取流成功也不判定。
  if (!raf && !disposed) raf = requestAnimationFrame(loop)
  // 重开录制段：retry 之前录制器可能已因异常收尾被置空（此后一直没人在录），
  // 而重新取流的路径会让旧段与新流不再同源（switchCam 早已补了同样的补偿，这里此前漏了）。
  // startPoseRecording 对「同姿态且录制器仍在」是幂等的，健康时重复调用不会空转。
  openPoseSegment()
}

function loop(): void {
  raf = requestAnimationFrame(loop)
  const el = videoEl.value
  const ov = overlayEl.value
  // 程序性停止（track.stop()）按规范不派发 ended 事件（实测 endedEventsFired=0），只能主动查 readyState。
  // 不查的话画面冻结在最后一帧，逐帧判定只会报「未检测到人脸」，用户以为是自己姿势的问题；
  // 而且 fails 不增长 —— 连重试入口都等不到（R15-F2 实测 C2-1 红）。
  if (stream && !camLost.value) {
    const tracks = stream.getVideoTracks()
    if (tracks.length > 0 && tracks.every((tr) => tr.readyState === 'ended')) {
      dbg('视频轨道 readyState=ended（程序性停止），判定设备断开')
      camLost.value = true
      hints.set('cameraLost')
    }
  }
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
  // 用户看不到失败也不知道可以重试；录制段创建失败同理；
  // 「本次没录到可上传的文件」同样是一条终态提示，被姿态提示盖掉就等于没告诉用户（W23B-05）。
  const inFailHold = Date.now() - failAt.value < FAIL_HINT_HOLD_MS
  if (!recording.value && !submitting.value && !camLost.value && !inFailHold && !segmentFailed.value && !submitFailed.value && !emptyBatch.value)
    hints.set(verdict.hintKey)
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
    hints.set('modelFailed')
    return
  }
  // 卸载守卫：模型可能下载数秒，这期间用户离开页面则必须停在这里 ——
  // 继续下去会再开一次摄像头（指示灯亮着）并起一个无人回收的逐帧循环。
  if (disposed) return
  try {
    await startCamera()
  } catch (e) {
    // R24 / W24A-03：置位「摄像头没起来」，否则 retryable 三条件全不成立、按钮永不渲染。
    camStartFailed.value = true
    cameraError(e)
    return
  }
  if (disposed) {
    // 卸载竞态：模型/摄像头是异步拿到的，等它回来时组件已经卸载，
    // 这条流不会被任何后续逻辑接管，必须在这里释放。
    stopStream()
    return
  }
  // 摄像头就绪即为第 1 个采集点开录（后续各段由 advance() 启动）。
  // 注意：必须在 onMounted 里调用一次，不能放在 loop() 里 —— 那会变成每帧调用，
  // 既是无谓开销，也会在录制器异常置空后反复重开段。
  openPoseSegment()
  raf = requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  // 先置标志再清理：清理过程中若有 await 落地，异步链看到的就是「已卸载」
  disposed = true
  document.removeEventListener('visibilitychange', onVisibility)
  // 与 onMounted 的注册逐事件配对解绑（否则每轮重新挂载都在 window 上多留 4 个闭包）。
  // 不传 options：解绑只看 capture 标志，注册时的 passive 不参与匹配，默认值即一致。
  for (const e of UNLOCK_EVENTS) window.removeEventListener(e, unlockAudio)
  cleanup()
  // cleanup() 里的 stopPoseRecording() 在「收尾在飞」时是空操作，必须再无条件拆一次
  teardownRecorder()
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
      <!-- 相机未就绪时提示同样必须可见（R15-F1）：下面的画面容器是 v-show="videoSize.w"，
           此刻 display:none —— 权限被拒 / 找不到设备 / 模型加载失败这类文案若只挂在那个容器里，
           用户只会看到「正在启动摄像头…」，永远看不到真正的原因。
           这里直接显示当前提示（初始为「正在加载人脸模型…」）。 -->
      <p class="hint-outline text-lg font-bold text-white">{{ hint }}</p>
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

    <!-- 底部控制区（相机选择 / 两个恢复入口 / ?debug=1 指标）已抽到 CaptureFooter.vue（R24） -->
    <CaptureFooter
      v-model:cam-id="camId"
      :cameras="cameras"
      :retryable="retryable"
      :submit-failed="submitFailed"
      :cam-res="camRes"
      :frame="frame"
      :stats="stats"
      :uploading="uploading"
      :upload-error="uploadError"
      :pending-count="pendingFiles.length"
      @camera-changed="switchCam"
      @retry-requested="retry"
      @retry-submit-requested="retrySubmit"
    />
  </div>
</template>
