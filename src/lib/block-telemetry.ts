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

// fetch
const origFetch = window.fetch.bind(window)
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  isBlocked(input) ? Promise.resolve(EMPTY()) : origFetch(input, init)) as typeof window.fetch

// XMLHttpRequest
const origOpen = XMLHttpRequest.prototype.open
const origSend = XMLHttpRequest.prototype.send
const blockedXhr = new WeakSet<XMLHttpRequest>()
XMLHttpRequest.prototype.open = function (
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
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
  if (blockedXhr.has(this)) {
    // 不真正发送，但要模拟一次【完整且成功】的响应：
    // 只补发事件而不设置 readyState/status/responseText 的话，调用方读到的是 status=0、
    // 空响应体，会当成失败（MediaPipe 可能因此重试，反而制造更多请求）。
    // 这里与 fetch 路径保持一致：200 + '{}'。
    setTimeout(() => {
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

// navigator.sendBeacon
const origBeacon = navigator.sendBeacon?.bind(navigator)
if (origBeacon) {
  navigator.sendBeacon = ((url: string | URL, data?: BodyInit | null) =>
    isBlocked(url) ? true : origBeacon(url, data)) as typeof navigator.sendBeacon
}
