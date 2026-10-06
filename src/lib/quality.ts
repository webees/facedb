import type { FaceFrame } from './face'
import type { MessageKey } from './i18n'

export type Pose = 'frontal' | 'left30' | 'right30' | 'up' | 'down' | 'liveness'

// 每个采集点的目标区间（度）。角度符号约定与 face.ts 一致：
//   yaw   —— 向左转为【正】
//   pitch —— 低头为【正】、抬头为【负】（详见下方 up/down 处的推导说明）
// yaw / pitch 省略表示该维度不额外约束（仍受 MAX_YAW / MAX_PITCH 兜底）。
//
// 判定口径说明：
// - 转头类：转到 20° 以上即算成功，上界放开（原先 45° 上界会让转多的用户被判「请回正」）。
// - 抬头/低头类：要求 pitch 达到 12° 以上，同时 yaw 保持基本正对（避免用转头糊弄过去）。
export type Target = { yaw?: [number, number]; pitch?: [number, number] }

// 极端侧脸的上限：超过这个角度人脸特征已不足以识别，提示「转过头了」。
// 取 70° 是为了给「20° 以上都算成功」留足余量 —— 45° 时会与目标区间上界冲突。
const MAX_YAW = 70
// 头部姿态容差（兜底用，按姿态的精确范围见 TARGETS）：
// - roll：转头时人会自然带一点侧倾，15° 太紧（侧脸步骤曾因此反复失败），放到 22°。
// - pitch：必须大于「抬头/低头」目标区间的上界（60°），否则兜底会把可用窗口压得极窄
//   —— 22° 时抬头/低头只剩 18~22 这 4° 的窗口，用户根本停不进去。取 65°。
const MAX_PITCH = 65
const MAX_ROLL = 22

export const TARGETS: Record<Pose, Target> = {
  frontal: { yaw: [-12, 12], pitch: [-12, 12] },
  // 上界直接引用 MAX_YAW：写成字面量 90 的话 [70, 90] 永远不可达
  //（姿态兜底会先把 |yaw| > MAX_YAW 拒掉），区间就成了空头承诺。
  left30: { yaw: [20, MAX_YAW], pitch: [-22, 22] },
  right30: { yaw: [-MAX_YAW, -20], pitch: [-22, 22] },
  // 注意 pitch 符号：低头为【正】、抬头为【负】（由 pitch = asin(-m[9]) 与绕 X 轴正向旋转 y→z 推得）。
  // 这里曾把两者写反，导致用户抬头时 pitch 变负、被当作「低头不够」，怎么抬都过不去。
  // yaw 放到 ±30°：抬头/低头时人会自然带一点转头，±18° 太紧；
  // pitch 门槛取 12°：MediaPipe 在俯仰方向的估计偏保守，18° 对不少人偏高。
  up: { yaw: [-30, 30], pitch: [-60, -12] },
  down: { yaw: [-30, 30], pitch: [12, 60] },
  liveness: { yaw: [-12, 12], pitch: [-12, 12] },
}

export const POSE_KEY: Record<Pose, MessageKey> = {
  frontal: 'poseFrontal',
  left30: 'poseLeft30',
  right30: 'poseRight30',
  up: 'poseUp',
  down: 'poseDown',
  liveness: 'poseLiveness',
}

// 连续达标帧数：达标时长 ≈ INFER_MS(40ms) × STABLE_FRAMES，取 5 ≈ 200ms。
// 原为 8 帧（640ms），用户转到目标角度后要明显停顿一下才过，实测体感偏慢。
export const STABLE_FRAMES = 5
export const MIN_FACE_RATIO = 0.2
// 拉普拉斯方差阈值（ROI 已归一到 ≤256 后比较，见 roiStats）。
// 标定实测（1920x1080 视频、人脸宽 631px → ROI 631x800 归一化到 202x256）：
//   理想锐利 1670 / 真实摄像头 700 / 偏软 258 / 偏软+低对比 160 / 明显失焦 82
// 注意：该指标对分辨率与摄像头光学质量极敏感，不同设备绝对值不可比（同一张清晰人脸
// 在 640x480 上算得 2420、在 4K 上仅 ~200）。因此阈值只用于拦截「镜头被遮挡 / 画面几乎
// 无细节」这类极端情况，质量主要由人脸尺寸、姿态与亮度门槛保障 —— 宁可放过偏软画面，
// 也不能把能用的设备一票否决。
export const MIN_BLUR = 10
export const MIN_BRIGHT = 60
export const MAX_BRIGHT = 200
const BLINK = 0.5

export type Verdict = { pass: boolean; hintKey: MessageKey }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** 参与判定的数值是否全是有限数（见 judge 顶部的说明）。 */
function isFiniteFrame(f: FaceFrame, vw: number, blur: number, brightness: number): boolean {
  return (
    Number.isFinite(f.count) &&
    Number.isFinite(f.yaw) &&
    Number.isFinite(f.pitch) &&
    Number.isFinite(f.roll) &&
    Number.isFinite(f.faceWidthPx) &&
    Number.isFinite(f.eyeBlinkLeft) &&
    Number.isFinite(f.eyeBlinkRight) &&
    Number.isFinite(vw) &&
    Number.isFinite(blur) &&
    Number.isFinite(brightness)
  )
}

/** 姿态名必须是 TARGETS 的**自有**属性。
 *  用 `TARGETS[pose]` 直接索引会把原型链上的名字也算命中（见 judge 里的说明）。 */
function isKnownPose(pose: Pose): boolean {
  return Object.prototype.hasOwnProperty.call(TARGETS, pose)
}

/** 各项门槛按任务书 §4 的编号顺序判定。
 *
 *  注意：本函数只判断「当前这一帧是否达标」，不做连续帧的累计 ——
 *  阈值 STABLE_FRAMES 由本文件导出，但「已连续达标几帧」由组件自己维护
 *  （见 CaptureView 的 tickHold）。 */
export function judge(f: FaceFrame, vw: number, blur: number, brightness: number, pose: Pose): Verdict {
  const no = (hintKey: MessageKey): Verdict => ({ pass: false, hintKey })

  // —— 先做输入合法性把关，再谈门槛 ——
  // NaN 与任何比较都是 false（`NaN < 0.2` 与 `NaN > 0.2` 同为 false），
  // 于是下面所有 `if (x < 阈值) return no(...)` 会被**静默跳过**，无效帧被判【达标】。
  // 后果不止是误提示：CaptureView 会把它计入连续达标帧并触发拍摄，NaN 还会被写进 meta
  //（`JSON.stringify(NaN)` 得 null），事后无法从 meta 复现。
  // 实测 11 组反例（任一数值字段为 NaN、count=-1）全部穿透；Infinity 中的
  // faceWidthPx 同样穿透（`Infinity < vw*0.2` 为 false）。
  // 说明：MediaPipe 在本工程未观测到 NaN，但本函数收到的数值是多处算术合成的产物
  //（欧拉角、包围盒、ROI 统计），按「不信任输入」处理成本最低。
  // 返回 hintHoldStill 而不是某个方向性文案：这是测量失败、不是用户姿势不对，
  // 给方向反而会把人引偏；关键是它 pass=false，不会被计入达标帧。
  if (!isFiniteFrame(f, vw, blur, brightness)) return no('hintHoldStill')

  // 姿态名必须是自己认识的：TARGETS['__proto__'] / ['constructor'] / ['toString'] 都会
  // 命中原型链上的属性，t.yaw 与 t.pitch 为 undefined，yaw 与 pitch 两段判定被整段跳过
  //（实测这三个名字都静默判通过）；而拼错的姿态名会抛 TypeError 冒泡到组件的 loop()，
  // 那里没有 try/catch，会中断该帧的后续处理。
  if (!isKnownPose(pose)) return no('hintHoldStill')

  // count 是探测器的「脸数」：0 与 >1 各有专门文案，负值与非整数是无意义输入，
  // 且 count=-1 会同时绕开「无脸」与「多人」两条判定（实测被判通过）。
  if (!Number.isInteger(f.count) || f.count < 0) return no('hintNoFace')
  if (f.count === 0) return no('hintNoFace')
  if (f.count > 1) return no('hintMultiFace')
  if (vw <= 0 || f.faceWidthPx < vw * MIN_FACE_RATIO) return no('hintTooFar')
  if (Math.abs(f.yaw) > MAX_YAW) return no(f.yaw > 0 ? 'hintYawTooMuchLeft' : 'hintYawTooMuchRight')
  if (Math.abs(f.pitch) > MAX_PITCH) return no(f.pitch > 0 ? 'hintPitchTooFarDown' : 'hintPitchTooFarUp')
  if (Math.abs(f.roll) > MAX_ROLL) return no('hintRoll')

  const t = TARGETS[pose]

  // yaw：正脸类要求居中，转头类要求达到下界（上界放开）
  if (t.yaw) {
    const [lo, hi] = t.yaw
    if (pose === 'frontal' || pose === 'liveness') {
      if (f.yaw < lo || f.yaw > hi) return no('hintFaceFront')
    } else if (f.yaw < lo) {
      // 低于下界：正区间说明转得还不够（继续转），负区间说明已经转过头了（回正）
      return no(lo < 0 ? 'hintStraighten' : 'hintTurnLeft')
    } else if (f.yaw > hi) {
      // 高于上界：正区间说明转过头了（回正），负区间说明还不够（继续右转）
      return no(hi > 0 ? 'hintStraighten' : 'hintTurnRight')
    }
  }

  // pitch：抬头/低头步要求俯仰达到目标；正脸类要求居中
  if (t.pitch) {
    const [plo, phi] = t.pitch
    // 越负越像抬头（up 区间在负侧）、越正越像低头（down 区间在正侧）
    // 下界侧（比下界更负）：down 步说明还没低够；up/正脸类说明已经抬过了，需要低头回调。
    // 注意：目标上界（±60）与兜底上限（MAX_PITCH=65）之间有一条 5° 死带，
    // 此处若给「头回正一点」这类无方向文案，用户在带内既不知道往哪边动、也不知道幅度。
    if (f.pitch < plo) return no(pose === 'down' ? 'hintLookDown' : 'hintPitchDown')
    // 上界侧（比上界更正）：up 步说明还没抬够；down/正脸类说明已经低过了，需要抬头回调。
    if (f.pitch > phi) return no(pose === 'up' ? 'hintLookUp' : 'hintPitchUp')
  }

  if (blur < MIN_BLUR) return no('hintBlurry')
  if (brightness < MIN_BRIGHT) return no('hintTooDark')
  if (brightness > MAX_BRIGHT) return no('hintTooBright')
  // 眨眼检测只在正面姿态生效。
  // 原因：转头时远侧眼睛会被鼻梁/脸颊遮挡，MediaPipe 把「看不见」误判成「闭眼」（blendshape 飙升），
  // 于是越转头越被判「请睁开眼睛」，用户永远过不了侧脸这一步。
  // 眨眼的本意是活体防伪（防照片攻击），只在正面录制视频时才有意义，侧脸无需检查。
  if (pose === 'frontal' || pose === 'liveness') {
    if (f.eyeBlinkLeft >= BLINK || f.eyeBlinkRight >= BLINK) return no('hintOpenEyes')
  }
  return { pass: true, hintKey: 'hintHoldStill' }
}

let roiCanvas: HTMLCanvasElement | null = null
let roiCtx: CanvasRenderingContext2D | null = null
// 灰度缓冲复用：这个函数每帧（约 25fps）都要跑，若每次都新建 Float32Array
// （256×256 即 64K 元素、256KB）会持续产生垃圾，给 GC 造成不必要的压力。
let grayBuf = new Float32Array(0)

// 清晰度必须在固定尺度上比较：同一张脸在 1080p 下 ROI 有六十多万像素，
// 摄像头的光学细节被摊薄到这么多像素上，相邻像素差极小，方差会低到个位数；
// 而在小分辨率下又会偏高。归一到固定尺寸后阈值才能跨设备通用（只缩小、不放大）。
const ROI_MAX = 256

/** 人脸 ROI 的拉普拉斯方差（清晰度）与平均亮度，ROI 先归一到固定尺寸再计算。
 *  同时回传归一化后尺寸，便于诊断行显示——方差与分辨率强相关，尺寸是排查误报的关键信息。 */
export function roiStats(
  video: HTMLVideoElement,
  f: FaceFrame,
): { blur: number; brightness: number; roi: string } {
  if (!roiCanvas) {
    roiCanvas = document.createElement('canvas')
    roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (!roiCtx || video.videoWidth === 0) return { blur: 0, brightness: 0, roi: '0x0' }
  const vw = video.videoWidth
  const vh = video.videoHeight
  const sx = Math.round(clamp(f.cx - f.bw / 2, 0, 1) * vw)
  const sy = Math.round(clamp(f.cy - f.bh / 2, 0, 1) * vh)
  // 先按百分比算出理想宽度，再夹到「不越出视频」的范围内，最后才抬到最小采样尺寸：
  // 顺序若反过来（先 max(3) 再 min），在 vw < 3 时会得到 sw > vw 的越界矩形，
  // 浏览器会画出透明区域，方差恒为 0，用户就被永远判成「画面模糊」。
  const maxW = Math.max(1, vw - sx)
  const maxH = Math.max(1, vh - sy)
  const sw = Math.min(maxW, Math.max(Math.min(3, maxW), Math.round(clamp(f.bw, 0.01, 1) * vw)))
  const sh = Math.min(maxH, Math.max(Math.min(3, maxH), Math.round(clamp(f.bh, 0.01, 1) * vh)))
  const scale = Math.min(1, ROI_MAX / Math.max(sw, sh))
  const dw = Math.max(8, Math.round(sw * scale))
  const dh = Math.max(8, Math.round(sh * scale))
  if (roiCanvas.width !== dw || roiCanvas.height !== dh) {
    roiCanvas.width = dw
    roiCanvas.height = dh
  }
  roiCtx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh)
  const d = roiCtx.getImageData(0, 0, dw, dh).data

  if (grayBuf.length < dw * dh) grayBuf = new Float32Array(dw * dh)
  const g = grayBuf
  let sum = 0
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    g[j] = v
    sum += v
  }
  let ls = 0
  let lsq = 0
  for (let y = 1; y < dh - 1; y++) {
    for (let x = 1; x < dw - 1; x++) {
      const i = y * dw + x
      const l = g[i - dw] + g[i + dw] + g[i - 1] + g[i + 1] - 4 * g[i]
      ls += l
      lsq += l * l
    }
  }
  const n = (dw - 2) * (dh - 2)
  const mean = ls / n
  return { blur: lsq / n - mean * mean, brightness: sum / (dw * dh), roi: dw + 'x' + dh }
}
