import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// 姿态符号约定：yaw > 0 表示用户向左转头（任务书 §4 约定）。
// 已用侧脸照实测确认：人物向左转得 +20°，其水平镜像得 -20°。更换模型/坐标系若符号反转，把 YAW_SIGN 改成 -1 即可。
const YAW_SIGN = 1

export type FaceFrame = {
  count: number
  yaw: number
  pitch: number
  roll: number
  faceWidthPx: number
  eyeBlinkLeft: number
  eyeBlinkRight: number
  cx: number
  cy: number
  bw: number
  bh: number
}

export const emptyFrame = (): FaceFrame => ({
  count: 0, yaw: 0, pitch: 0, roll: 0, faceWidthPx: 0,
  eyeBlinkLeft: -1, eyeBlinkRight: -1, cx: 0.5, cy: 0.5, bw: 0, bh: 0,
})

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const DEG = 180 / Math.PI

let landmarker: FaceLandmarker | null = null
/** 进行中的初始化；并发调用时复用它，避免重复创建模型（会泄漏一个实例）。 */
let initPromise: Promise<void> | null = null
/**
 * 初始化代次：closeFace() 每调一次就自增。模型加载要数秒，这期间组件可能已经卸载并
 * 调过 closeFace() —— 那次 close 手上没有实例可关，若初始化落地后仍写回 landmarker，
 * 这个实例就再也没人关（实测 created=1 / closed=0，且关闭后仍被 detectFace 使用）。
 */
let initGen = 0

/**
 * 最多检测的人脸数。**必须 >= 2**。
 *
 * MediaPipe 的 numFaces 是「最多检测几张脸」的上限，设为 1 时返回值最多含 1 张，
 * 于是 quality.ts 里的 `if (f.count > 1) return no('hintMultiFace')` 永远为假 ——
 * 「画面中只能有一人」这个提示会彻底失效，且不会报错。
 *
 * 提成常量是为了让这个约束可见、可被检查脚本读到。
 */
const NUM_FACES = 2

async function createLandmarker(): Promise<void> {
  const gen = initGen
  // 落地即检查代次：不一致说明这次创建已被 closeFace 作废，直接关掉、绝不写回模块变量。
  const adopt = (inst: FaceLandmarker): void => {
    if (gen !== initGen) {
      try {
        inst.close()
      } catch {
        // 已关闭：忽略
      }
      return
    }
    landmarker = inst
  }
  const fileset = await FilesetResolver.forVisionTasks('/wasm')
  const base = {
    runningMode: 'VIDEO' as const,
    numFaces: NUM_FACES,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  }
  try {
    adopt(
      await FaceLandmarker.createFromOptions(fileset, {
        ...base,
        baseOptions: { modelAssetPath: '/face_landmarker.task', delegate: 'GPU' },
      }),
    )
  } catch {
    // GPU 委托不可用时回退 CPU（部分设备/浏览器没有可用的 WebGL2）
    adopt(
      await FaceLandmarker.createFromOptions(fileset, {
        ...base,
        baseOptions: { modelAssetPath: '/face_landmarker.task', delegate: 'CPU' },
      }),
    )
  }
}

export function initFace(): Promise<void> {
  if (landmarker) return Promise.resolve()
  initPromise ??= createLandmarker()
    .catch((e) => {
      initPromise = null // 失败后允许重试
      throw e
    })
  return initPromise
}

/** 释放模型资源；不释放会在移动端残留耗电与显存占用。 */
export function closeFace(): void {
  // 自增代次：让还在地飞中的初始化在落地时自我作废（R13-F10）
  initGen++
  landmarker?.close()
  landmarker = null
  initPromise = null
  overlayCtx = null
  overlayCanvas = null
}

export function detectFace(video: HTMLVideoElement, ts: number): FaceFrame {
  const out = emptyFrame()
  if (!landmarker || video.readyState < 2) return out
  const vw = video.videoWidth
  const vh = video.videoHeight
  const r = landmarker.detectForVideo(video, ts)
  out.count = r.faceLandmarks.length
  if (out.count === 0) return out

  let x0 = 1, y0 = 1, x1 = 0, y1 = 0
  for (const p of r.faceLandmarks[0]) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  out.bw = x1 - x0
  out.bh = y1 - y0
  out.cx = (x0 + x1) / 2
  out.cy = (y0 + y1) / 2
  out.faceWidthPx = out.bw * vw

  // 变换矩阵是列主序（OpenGL 约定）；索引读法与 three.js Matrix4.setFromRotationMatrix(m,'YXZ') 一致。
  const m = r.facialTransformationMatrixes[0]?.data
  if (m && m.length >= 11) {
    const m13 = m[8], m23 = m[9], m33 = m[10], m21 = m[1], m22 = m[5]
    out.pitch = Math.asin(-clamp(m23, -1, 1)) * DEG
    out.yaw = YAW_SIGN * Math.atan2(m13, m33) * DEG
    out.roll = Math.atan2(m21, m22) * DEG
  }

  const cats = r.faceBlendshapes[0]?.categories
  if (cats) {
    out.eyeBlinkLeft = cats.find(c => c.categoryName === 'eyeBlinkLeft')?.score ?? -1
    out.eyeBlinkRight = cats.find(c => c.categoryName === 'eyeBlinkRight')?.score ?? -1
  }
  return out
}

// 覆盖层上下文缓存：这个函数每帧都会被调用，getContext 每次都要走一遍
// canvas 的上下文查找（同参数虽会返回同一实例，但查找本身有成本）。
let overlayCtx: CanvasRenderingContext2D | null = null
let overlayCanvas: HTMLCanvasElement | null = null

/** 把人脸框画到覆盖层 canvas 上（镜像，与视频的 scale-x-[-1] 一致）。 */
export function drawOverlay(cv: HTMLCanvasElement, f: FaceFrame): void {
  if (overlayCanvas !== cv || !overlayCtx) {
    overlayCtx = cv.getContext('2d')
    overlayCanvas = cv
  }
  const ctx = overlayCtx
  if (!ctx) return
  const w = cv.width, h = cv.height
  ctx.clearRect(0, 0, w, h)
  if (f.count === 0) return
  const x = (1 - f.cx - f.bw / 2) * w
  const y = (f.cy - f.bh / 2) * h
  ctx.strokeStyle = f.count > 1 ? '#dc2626' : '#22c55e'
  ctx.lineWidth = 2
  ctx.strokeRect(x, y, f.bw * w, f.bh * h)
  // 中线：转到目标姿态时帮助对准
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'
  ctx.beginPath()
  ctx.moveTo(w / 2, 0)
  ctx.lineTo(w / 2, h)
  ctx.stroke()
}
