// 上传层：一次识别 = 一条记录，各采集点的文件先缓存在内存，最后一步一次性提交。
// 为什么不用「建记录 + 逐步 PATCH 追加」：captures 的 updateRule 是 @request.auth.id != ""，
// 匿名无法 PATCH；若为此放开 updateRule，等于允许任何人修改任意记录。
// 改为内存缓存 + 末次一次性 POST：只需 createRule，且不会出现「半条记录」。
import { t } from './i18n'

export type CaptureMeta = {
  yaw: number
  pitch: number
  roll: number
  faceWidthPx: number
  blurVariance: number
  brightness: number
  qualityScore: number
  capturedAt: number
  deviceInfo: string
  videoWidth: number
  videoHeight: number
}

/** 待提交的单个文件（连同它的姿态与指标） */
export type PendingFile = {
  pose: string
  blob: Blob
  filename: string
  kind: 'image' | 'video'
  meta: CaptureMeta
}

export type CaptureResult = { pose: string; filename: string }

// 单次上传超时。实测：本机 52ms、4G 约 1.5s，25s 已是极宽松的上限。
// 原先取 60s，叠加 4 次重试后又叠加调用方的 3 轮，最坏要 12 分钟才报错，用户被迫干等。
const UPLOAD_TIMEOUT_MS = 25000
// PocketBase 地址（不含 /api 后缀，下方拼接）。
//
// 两种形态，按访问端口自动选择，同一份产物即可同时支持：
//
//   ① 经网关访问（标准端口 80/443）：页面地址本身就是入口，
//      网关把 /api/* 分流到 PocketBase，因此直接用同源地址即可。
//      浏览器里 http 的 80 / https 的 443 会让 location.port 为空字符串。
//
//   ② 直连访问（显式端口，如 http://主机:3000/编号）：此时没有网关，
//      后端在其固定的 8090 端口上，按同主机 + 8090 推导。
//
// 若后端不在同一主机、或需要固定地址，用 PUBLIC_PB_URL 显式覆盖（构建期注入）。
const PB_BASE =
  import.meta.env.PUBLIC_PB_URL ||
  (typeof location !== 'undefined'
    ? location.port && location.port !== '80' && location.port !== '443'
      ? `${location.protocol}//${location.hostname}:8090` // 直连
      : location.origin // 经网关：同源，由 /api 前缀分流
    : 'http://127.0.0.1:8090')

const API = `${PB_BASE}/api/collections/captures/records`

/** 4xx（字段校验失败等数据问题）重试没有意义，用独立类型标记后直接抛出。 */
class PermanentError extends Error {}

// 关于重试与重复记录（已知取舍，非疏漏）：
// 5xx 会重试 3 次。若服务端其实已写入、只是响应在途中丢失，重试会再写一条，
// 于是同一次识别可能产生两条记录。之所以不为此加幂等机制：
//   · captures 没有可用于幂等的唯一约束（PocketBase 的 text 字段不建唯一索引）；
//   · 「提交前查重」需要多一次查询，且查重自身也可能失败，反而更脆；
//   · 两条完整记录 远好于 一条都没有 —— 本项目要保证的是人脸信息不丢。
// 文件名带毫秒时间戳，因此重复记录之间也不会互相覆盖。

/**
 * 提交表单。共 3 次尝试，退避 1s / 2s。
 * @param build 每次尝试都重新构造 FormData —— 规范并不保证 FormData 可重复提交，
 *              重建的成本极低，却能彻底规避「重试时请求体为空」这类问题。
 */
async function post(build: () => FormData, what: string): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), UPLOAD_TIMEOUT_MS)
    try {
      const res = await fetch(API, { method: 'POST', body: build(), signal: ctl.signal })
      if (res.ok) return
      const body = await res.text().catch(() => '')
      const msg = `${what}: ${res.status} ${body.slice(0, 150)}`
      // 4xx 是请求本身的问题，重试只会白白等待
      if (res.status < 500) throw new PermanentError(msg)
      lastErr = new Error(msg)
    } catch (e) {
      if (e instanceof PermanentError) throw e
      lastErr = e
    } finally {
      clearTimeout(timer)
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 提交一次识别的全部文件：照片进 photos（多文件），视频进 video（单文件）。
 * 每次尝试都重建 FormData（见 post 的说明）。
 */
export async function uploadSession(sessionId: string, files: PendingFile[]): Promise<void> {
  if (files.length === 0) throw new Error(t('emptyRecording'))

  // deviceInfo（UA 约 120 字符）与视频尺寸在本次识别内完全相同，
  // 逐文件重复写入会让 11 个文件白多传约 1.5 KB，这里抽到顶层只存一份。
  const head = files[0].meta
  const meta = {
    sessionId,
    deviceInfo: head.deviceInfo,
    videoWidth: head.videoWidth,
    videoHeight: head.videoHeight,
    perFile: files.map((f) => {
      const { deviceInfo: _d, videoWidth: _w, videoHeight: _h, ...rest } = f.meta
      return { pose: f.pose, file: f.filename, ...rest }
    }),
  }

  await post(() => {
    const form = new FormData()
    form.append('session_id', sessionId)
    for (const f of files) {
      form.append(f.kind === 'video' ? 'video' : 'photos', f.blob, f.filename)
    }
    form.append('meta', JSON.stringify(meta))
    return form
  }, t('uploadFailed'))
}
