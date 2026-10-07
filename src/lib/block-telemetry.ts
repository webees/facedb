// MediaPipe（TensorFlow Lite Tasks）会向其遥测端点上报使用数据，实测域名形如
// odml.pa.googleapis.com/v1/log。本项目处理人脸数据，不应有任何数据外发。
// 这里在应用启动前把外发请求拦掉：返回一个成功的空响应（而不是 reject），
// 避免 MediaPipe 认为失败后重试、反而产生更多请求。
//
// 放独立模块而非 main.ts 顶部的目的：import 会被提升，能确保在 App.vue（进而 MediaPipe）
// 加载之前执行，且逻辑不与入口文件混在一起。

// 尾点也要拦：`googleapis.com.` 是 FQDN 的绝对形式，`new URL()` 会把尾点保留在 hostname 里，
// 而 /(^|\.)googleapis\.com$/ 匹配不到它 —— 实测 https://odml.pa.googleapis.com./v1/log
// 会被放行到真实网络（`%2e` 同理）。这里运行时还有 CSP 兜底，但那是「两层防线漏了一层」。
const BLOCKED = /(^|\.)googleapis\.com\.?$/i

function hostOf(input: RequestInfo | URL): string {
  try {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    return new URL(url, location.href).hostname
  } catch {
    return ''
  }
}

function isBlocked(input: RequestInfo | URL): boolean {
  const h = hostOf(input)
  return h !== '' && BLOCKED.test(h)
}

const EMPTY = (): Response =>
  new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

// 一层「可还原的补丁」。
// 重复安装（HMR 重新 import、模块被再次求值）以前会一层套一层：实测层数 1→2→3→4，
// 每个请求多穿一层、旧层闭包永远不可回收。
// 这里做成「先撤上一层、再装新的」而不是「已有就跳过」—— 跳过会留下旧代码的补丁，
// 于是改了规则却不生效，比多一层更难发现。
// 内联层（index.html）与模块层各用各的 window 槽位：模块层撤层时**不能**把内联层一起撤掉。
type Layer = { uninstall: () => void }
const w = window as unknown as { __facedbBlockModule?: Layer }

function install(): Layer {
// 刻意不 bind：bind 会造出新的函数对象，上层撤层后 window.fetch 与我们装的这个不再是同一个对象，
// 于是「还原」永远失败（实测过）。原生 fetch 要求 this 是 window，所以在调用点用 call。
const prevFetch = window.fetch
const patchedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  isBlocked(input) ? Promise.resolve(EMPTY()) : prevFetch.call(window, input, init)) as typeof window.fetch
window.fetch = patchedFetch

// XMLHttpRequest
const origOpen = XMLHttpRequest.prototype.open
const origSend = XMLHttpRequest.prototype.send
const blockedXhr = new WeakSet<XMLHttpRequest>()
const patchedOpen = function (
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  // 必须成对：同一个 XHR 对象可以反复 open（先 open 拦截目标、后 open 放行目标是正常用法）。
  // 只在命中时 add、不在未命中时 delete 的话，复用的对象会一直留在集合里，
  // 于是**真正要发的请求也不发**，还伪造一个 200 '{}' 交给调用方 —— 静默丢请求。
  if (isBlocked(url)) blockedXhr.add(this)
  else blockedXhr.delete(this)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origOpen as any).call(this, method, url, ...rest)
} as typeof XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = patchedOpen
const patchedSend = function (this: XMLHttpRequest, ...args: unknown[]) {
  if (blockedXhr.has(this)) {
    // 不真正发送，但要模拟一次【完整且成功】的响应：
    // 只补发事件而不设置 readyState/status/responseText 的话，调用方读到的是 status=0、
    // 空响应体，会当成失败（MediaPipe 可能因此重试，反而制造更多请求）。
    // 这里与 fetch 路径保持一致：200 + '{}'。
    // abort() 之后不得再派发这组假事件：调用方会在 abort 里清理状态，之后再收到 load
    // 会当成「成功」处理（实测 abort 后仍派发 load 1 次）。标记挂在实例上，不动原型。
    let aborted = false
    const prevAbort = this.abort
    this.abort = function (this: XMLHttpRequest, ...a: unknown[]) {
      aborted = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (prevAbort as any).apply(this, a)
    } as typeof XMLHttpRequest.prototype.abort
    setTimeout(() => {
      if (aborted) return
      const def = (k: string, v: unknown) =>
        Object.defineProperty(this, k, { value: v, configurable: true })
      def('readyState', 4)
      def('status', 200)
      def('statusText', 'OK')
      def('responseText', '{}')
      def('response', '{}')
      def('responseURL', '')
      this.dispatchEvent(new Event('readystatechange'))
      this.dispatchEvent(new ProgressEvent('load'))
      this.dispatchEvent(new ProgressEvent('loadend'))
    }, 0)
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origSend as any).apply(this, args)
} as typeof XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.send = patchedSend

// navigator.sendBeacon
// 不能 bind：bind 返回新函数对象，撤层时按身份还原必然失败（fetch 段踩过同一个坑）。
const prevBeacon = navigator.sendBeacon
const patchedBeacon = prevBeacon
  ? (((url: string | URL, data?: BodyInit | null) =>
      isBlocked(url) ? true : prevBeacon.call(navigator, url, data)) as typeof navigator.sendBeacon)
  : undefined
if (patchedBeacon) navigator.sendBeacon = patchedBeacon

return {
  uninstall() {
    // 只还原「仍然是我们装的那一层」——别人后来改过就不要动它。
    // 【撤层顺序】必须后装先撤（LIFO）。顺序不对时本层已不在顶层，下面的守卫会**全部落空**，
    // 结果是「调用方以为撤了、补丁却仍生效」。所以这里不静默：还原数少于应还原数就告警。
    let restored = 0
    if (window.fetch === patchedFetch) {
      window.fetch = prevFetch
      restored++
    }
    if (XMLHttpRequest.prototype.open === patchedOpen) {
      XMLHttpRequest.prototype.open = origOpen
      restored++
    }
    if (XMLHttpRequest.prototype.send === patchedSend) {
      XMLHttpRequest.prototype.send = origSend
      restored++
    }
    if (patchedBeacon && navigator.sendBeacon === patchedBeacon) {
      navigator.sendBeacon = prevBeacon!
      restored++
    }
    const expected = patchedBeacon ? 4 : 3
    if (restored < expected) {
      console.warn(
        `[telemetry] 撤层时本层不在顶层：${expected} 个补丁点只还原了 ${restored} 个。` +
          '撤层必须后装先撤（先撤模块层再撤内联层），否则本层补丁会残留。'
      )
    }
  },
}
}

// 装之前先撤掉上一次模块层（内联层不受影响）
w.__facedbBlockModule?.uninstall?.()
w.__facedbBlockModule = install()
