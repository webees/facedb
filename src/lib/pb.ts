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
  /**
   * 本采集点的视频段是否录制成功（false = 录制器没起来或启动失败）。
   * 落库侧唯一的其它线索是「video 文件为空」，而那与「用户这一步本来就没拍视频」
   * 完全同形 —— 没有这个字段时后台无法区分这两种情况。
   */
  segmentOk: boolean
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
/**
 * 整批提交的总时间预算（含内层重试与退避，也含调用方的多轮重试）。
 * 为什么必须由调用方传入同一个截止时刻：单次 25s × 内层 3 次 + 退避，再 × 外层 3 轮
 * = 最坏 237.6s，期间界面只有「上传中…」，用户无法分辨是慢还是已经卡死。
 * 取 90s —— 一次提交约 2~3 MB，4G 上约 1.5s，90s 足够覆盖弱网下的多次重试，
 * 又不会让人干等到失去耐心。超时后由调用方进入失败态并给出重试入口。
 */
export const UPLOAD_BUDGET_MS = 90000
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
//
// 尾部斜杠必须去掉：PUBLIC_PB_URL 很容易被写成 "https://pb.example.com/"，
// 不归一化就会拼出 "https://pb.example.com//api/collections/..."。
// 【R23 更正】此前这里写的是「PocketBase 对双斜杠回 301 → fetch 把 POST 降级成 GET →
// 重定向后的 GET 回 200 空列表」，实测不是这样：双斜杠的 POST 回 **307** +
// `Location: /api/collections/...`（去重斜杠后的同一路径），fetch 默认跟随；跟随后的那次请求
// 不再被服务端当作合法上传（实测落到 400、库里零写入），而单斜杠的同一份 multipart 正常入库。
// 机制上注意：307/308 按规范**保留方法与请求体**，降级成 GET 的是 301/302/303 —— 所以
// 「301 降级」这套解释对本案不成立；真正要紧的是下面这行把尾部斜杠去掉。
// 两种解释下后果相同：10 张照片 + 1 段视频整批静默丢失，界面显示成功。
// 判据 lib/r11-f2-pburl-verify.mjs 已改钉可观测事实（3xx 重定向 + 库零写入），不钉状态码。
const rawBase = (import.meta.env.PUBLIC_PB_URL || '').trim()
const PB_BASE = rawBase
  ? rawBase.replace(/\/+$/, '') // 显式覆盖：去尾部斜杠
  : typeof location !== 'undefined'
    ? location.port && location.port !== '80' && location.port !== '443'
      ? `${location.protocol}//${location.hostname}:8090` // 直连
      : location.origin // 经网关：同源，由 /api 前缀分流
    : 'http://127.0.0.1:8090'

const API = `${PB_BASE}/api/collections/captures/records`

/** 4xx（字段校验失败等数据问题）重试没有意义，用独立类型标记后直接抛出。 */
class PermanentError extends Error {}

/**
 * 网络层失败：请求根本没到服务端（DNS 失败 / 连接被拒 / 断网 / CORS 预检失败）。
 * 为什么需要它：fetch 在这些情况下抛的是 TypeError，原文是「Failed to fetch」（Chrome）、
 * 「Load failed」（Safari）、「fetch failed」（Node/undici），对用户没有可操作性（W23B-08）。
 *
 * 为什么必须同时命中 TypeError 与措辞（只认 TypeError 不够）：
 * 代码自身抛出的 TypeError（如 Cannot read properties of undefined）也会是 TypeError，
 * 把它说成「网络不可达」会把排查方向彻底带偏 —— 而这里恰好是 catch 的兜底分支。
 * 注意这条分支只管「网络层」，响应层面的 4xx/5xx 在别处分类，不会走到这里。
 */
function isNetworkError(e: unknown): boolean {
  if (!(e instanceof TypeError)) return false
  // R23REV-N4：Node/undici 的文案是 `fetch failed` **且** `cause` 里写 `connect ECONNREFUSED …`；
  // 只匹配 `connection (refused|reset|closed)` 会漏掉它，于是由 Node 驱动的测试/脚本上屏技术原文。
  return /failed to fetch|fetch failed|load failed|networkerror|network error|network request failed|connection (refused|reset|closed)|err_connection|connect(ion)? econn(re|fused)|econn(refused|reset)|getaddrinfo|enotfound|eai_again|socket hang up|certificate/i.test(
    e.message + ' ' + String((e as { cause?: unknown }).cause ?? ''),
  )
}

// 关于重试与重复记录（已知取舍，非疏漏）：
// 5xx 会重试 3 次。若服务端其实已写入、只是响应在途中丢失，重试会再写一条，
// 于是同一次识别可能产生两条记录。之所以不为此加幂等机制：
//   · captures 没有可用于幂等的唯一约束（PocketBase 的 text 字段不建唯一索引）；
//   · 「提交前查重」需要多一次查询，且查重自身也可能失败，反而更脆；
//   · 两条完整记录 远好于 一条都没有 —— 本项目要保证的是人脸信息不丢。
// 文件名带毫秒时间戳，因此重复记录之间也不会互相覆盖。

// 在途请求的控制器 + 一条独立于定时器的中断路径。
//
// 为什么单靠 setTimeout 不够：页面转后台时浏览器会节流甚至暂停定时器，
// 而恰恰是「到点 abort」这条唯一的中断路径 —— 此时在途的 await fetch 与驱动它的定时器
// **一起被挂起**，谁也叫不醒谁，界面就停在「上传中」直到回到前台。
// visibilitychange 与定时器无关，是第二条中断路径：让 await 立刻 reject
// （AbortError → 可重试错误），回到前台后正常进入重试。
//
// 但这条兜底不能「一切后台就打断」：切出去看一眼消息再切回来是最常见的操作，
// 而那时请求往往还在正常跑 —— 立刻 abort 会把本可在后台传完的上传打断，
// 服务端可能留下半写记录，下一次尝试整批重传。所以先给 HIDE_GRACE_MS 宽限：
// 只有「后台持续超过宽限且请求仍未结束」才中止。
const HIDE_GRACE_MS = 5000
let inflightCtl: AbortController | null = null
let hideHooked = false
let graceTimer: ReturnType<typeof setTimeout> | undefined

// HMR / 测试里同一个模块会被重新求值：模块态 hideHooked 随之归零，而 document 上那一代注册的
// 监听器还在 —— 每重新求值一次就多一个回调，切一次后台被处理多次。所以把「当前生效的回调」
// 寄存在 window 上：装新的之前先摘掉旧的，document 上恒为 1 个（而不是「装载次数个」）。
// 无 window（Node 测试环境）时这个槽位不存在，退化成原来的行为。
const HOOK_SLOT =
  typeof window !== 'undefined'
    ? (window as unknown as { __facedbHideHook?: { handler: () => void } })
    : undefined

function clearGrace(): void {
  if (graceTimer === undefined) return
  clearTimeout(graceTimer)
  graceTimer = undefined
}

/**
 * 已转入后台且有在途请求时武装宽限定时器（幂等：重复调用不会堆出第二个定时器）。
 * 此刻已在后台时新发起的尝试也要走这里，否则「在后台里开始的那次请求」不受宽限保护。
 */
function armHideGrace(): void {
  if (typeof document === 'undefined' || !document.hidden) return
  if (graceTimer !== undefined || !inflightCtl) return
  graceTimer = setTimeout(() => {
    graceTimer = undefined // 到期即自清：三个出口（到期 / 回前台 / 请求成功）都不留悬挂定时器
    if (typeof document === 'undefined' || !document.hidden) return // 人已回来
    const ctl = inflightCtl
    if (!ctl) return // 请求已结束：没有可中止的对象
    console.debug('[upload] 转入后台超过 ' + HIDE_GRACE_MS + 'ms 仍未完成，中止在途请求（可重试）')
    ctl.abort()
  }, HIDE_GRACE_MS)
}

function hookHideAbort(): void {
  // 模块级只注册一次：post 会被反复调用，重复注册会让同一次切后台触发多个回调。
  // 无 document（Node 测试环境）时直接跳过。
  if (hideHooked || typeof document === 'undefined') return
  hideHooked = true
  const handler = (): void => {
    if (!document.hidden) {
      // 回到前台：宽限期内的请求本来还能传完，取消这次中止
      clearGrace()
      return
    }
    armHideGrace()
  }
  if (HOOK_SLOT) {
    // 摘掉上一代（若本模块被重复求值过）。只动我们自己注册的那个回调，不动别人挂在
    // document 上的监听器 —— 摘旧的前提是「旧回调确实还挂着」，用存在性判断而非无条件调。
    if (HOOK_SLOT.__facedbHideHook) document.removeEventListener('visibilitychange', HOOK_SLOT.__facedbHideHook.handler)
    HOOK_SLOT.__facedbHideHook = { handler }
  }
  document.addEventListener('visibilitychange', handler)
}

/**
 * 提交表单。共 3 次尝试，退避 1s / 2s。
 * @param build 每次尝试都重新构造 FormData —— 规范并不保证 FormData 可重复提交，
 *              重建的成本极低，却能彻底规避「重试时请求体为空」这类问题。
 * @param deadline 整批提交的截止时刻（Date.now() 口径）。由调用方传入，
 *                 使内层重试与外层多轮重试共享同一份预算；缺省时按单轮预算计。
 */
async function post(build: () => FormData, what: string, deadline: number): Promise<void> {
  // 入口就记下本次实际拿到的预算：错误消息必须按实际预算说话，
  // 不能引用模块常量 —— 调用方给的 deadline 可能只剩余很少时间（如第二版预算的尾巴）。
  const budgetMs = Math.max(0, deadline - Date.now())
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    // 预算耗尽就不再发起新尝试：否则「最坏耗时」完全由重试次数决定，用户只能一直等
    const left = deadline - Date.now()
    if (left <= 0) break
    hookHideAbort()
    const ctl = new AbortController()
    // 记在模块级：页面转后台时由 visibilitychange 回调用它打断在途请求
    inflightCtl = ctl
    armHideGrace() // 若此刻已在后台，武装宽限（幂等）
    // 单次超时不超过剩余预算，否则最后一次尝试会把总耗时拖到预算之外
    const slice = Math.min(UPLOAD_TIMEOUT_MS, left)
    const timer = setTimeout(() => ctl.abort(), slice)
    try {
      const res = await fetch(API, { method: 'POST', body: build(), signal: ctl.signal })
      // 成功判定不能只看 res.ok：地址拼接错误（如双斜杠）会让 PocketBase 回 301，
      // fetch 会把 POST 降级成 GET 并丢掉请求体，重定向后的 GET 回 200 + 空列表 ——
      // res.ok 为真、其实一条记录都没写。这里把「被重定向」和「响应不是 JSON」
      // 都当成永久错误抛出，宁可报错也不能让用户以为拍成功了。
      if (res.redirected) {
        throw new PermanentError(`${what}: 请求被重定向到 ${res.url}（疑似后端地址拼接错误，如多余斜杠）`)
      }
      if (res.ok) {
        const ct = res.headers.get('content-type') || ''
        if (!ct.includes('json')) {
          throw new PermanentError(`${what}: 响应不是 JSON（content-type=${ct || '空'}），不能确认写入成功`)
        }
        clearGrace() // 请求已成功结束：后台宽限没有意义，别留一个到点就想 abort 的定时器
        return
      }
      const body = await res.text().catch(() => '')
      const msg = `${what}: ${res.status} ${body.slice(0, 150)}`
      // 4xx 是请求本身的问题，重试只会白白等待 —— 但 429（限流）与 408（请求超时）例外：
      // 它们的语义是「同一个请求稍后可以成功」，属暂时性错误，必须走退避重试。
      // 实测 PocketBase 的 429 **不带 Retry-After**，无法按响应头退避，只能走固定退避（1s/2s）；
      // 而一旦把 429 当永久错误，用户已拍好的整批文件（实测 16 个）会一起失败。
      if (res.status < 500 && res.status !== 429 && res.status !== 408) throw new PermanentError(msg)
      lastErr = new Error(msg)
    } catch (e) {
      if (e instanceof PermanentError) throw e
      const netErr = isNetworkError(e)
      if (netErr) {
        // 原始错误必须先落到控制台：换成可读文案后 message 里就没有浏览器原文了，
        // 排查时看不出到底是 DNS、连接被拒还是 CORS 预检失败（W23B-08）。
        console.warn('[upload] 网络层错误（原始信息，供排查）：', e)
      }
      // AbortError 的技术消息（"The operation was aborted"）对用户与排查都没有信息量，
      // 换成「第 N 次尝试在 X 秒内无响应」，与网络错误区分开。
      // 中止有两种来源，文案必须分开：① 单次超时到点（定时器）；② 后台宽限期满（visibilitychange）。
      // 两者都只作废这一次尝试、都走重试 —— 都不是永久错误。
      // ②的文案不写「页面转入后台」：abort 发生时页面确实在后台，但用户往往是回到前台才看见
      // 这条消息，写「转入后台」会让人以为失败是自己切出去造成的，也看不出「可以直接重试」。
      // 已完成的请求不受影响：请求结束时 inflightCtl 已被清空，abort 不会落到它身上；
      // 即便落到，AbortController.abort() 对已 settle 的 fetch 也没有任何副作用。
      // 网络层失败同样换成本地化文案（只换文案，不换分类：它仍按普通错误走退避重试）。
      // 文案在这里单独求值、用字符串拼接而不是写进模板字面量的插值里：
      // 死键判据（lib/check-i18n-dead-keys.mjs）会把模板字面量内部整体屏蔽成字符串，
      // 写在插值里的键引用扫不到，该键会被误判成「已定义未被引用」。
      const netMsg = netErr ? t('uploadNetworkFailed') : ''
      lastErr =
        e instanceof DOMException && e.name === 'AbortError'
          ? new Error(
              typeof document !== 'undefined' && document.hidden
                ? `${what}: 连接中断，第 ${attempt + 1} 次尝试已中止（可重试）`
                : `${what}: 第 ${attempt + 1} 次尝试 ${Math.round(slice / 1000)}s 内无响应，已中止`,
            )
          : netErr
            ? new Error(what + ': ' + netMsg)
            : e
    } finally {
      clearTimeout(timer)
      // 只清自己那一个：若下一次尝试已经接手，不能把它也清掉
      if (inflightCtl === ctl) {
        inflightCtl = null
        // 后台宽限定时器也一并清（R13-F10）：早先只有「成功」与「回到前台」两条路径调
        // clearGrace()，而失败 / 永久错误 / 预算耗尽都会留下一个 5 秒定时器（实测 1 个）。
        clearGrace()
      }
    }
    if (attempt < 2) {
      const backoff = 1000 * 2 ** attempt
      // 退避也计入预算：剩余时间连退避都不够时直接放弃，不再空等
      if (deadline - Date.now() <= backoff) break
      await new Promise((r) => setTimeout(r, backoff))
    }
  }

  if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  // 走到这里一定是「一次请求都没发出去」：任何一次尝试失败都会写 lastErr 并在上一行抛出，
  // 成功的尝试已在循环里 return。所以只可能是入口预算不足 —— 此时若仍报「已用满 90s」，
  // 在 0ms 耗时下显然荒谬，必须按实际拿到的预算说话。
  // 早先这里还有一个「重试中耗尽」分支（靠临时布尔量区分），但它不可达：那条路径永远由
  // lastErr 命中、抛出更具体的错误。留着只会让人误以为存在「重试中预算用尽」这种失败。
  throw new Error(
    `${what}: 提交预算已耗尽（可用 ${Math.round(budgetMs)}ms，不足一次尝试），未发出任何请求`,
  )
}

/**
 * 提交一次识别的全部文件：照片进 photos（多文件），视频进 video（单文件）。
 * 每次尝试都重建 FormData（见 post 的说明）。
 * @param deadline 整批提交（含调用方的多轮重试）共用的截止时刻。
 *                 调用方必须传入同一个值，否则最坏耗时会按轮数倍增。
 */
export async function uploadSession(
  sessionId: string,
  files: PendingFile[],
  deadline: number = Date.now() + UPLOAD_BUDGET_MS,
): Promise<void> {
  if (files.length === 0) throw new Error(t('emptyRecording'))

  // deviceInfo（UA 约 120 字符）在每个文件上重复，逐文件写会让整批白多传约 1.5 KB，
  // 故抽到顶层只存一份（取首文件的值）。
  // 注意：不能据此认为「同一次识别里每个文件的设备与尺寸必然相同」——
  // 采集过程中可以切换摄像头（switchCam），换机后分辨率确实会变，
  // 而 perFile 里已把这三个字段解构丢弃，各文件的差异不落库。这是体积换信息的取舍，不是等价。
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
  }, t('uploadFailed'), deadline)
}
