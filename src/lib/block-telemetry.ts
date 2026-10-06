// MediaPipe（TensorFlow Lite Tasks）会向其遥测端点上报使用数据，实测域名形如
// odml.pa.googleapis.com/v1/log。本项目处理人脸数据，不应有任何数据外发。
// 这里在应用启动前把外发请求拦掉：返回一个成功的空响应（而不是 reject），
// 避免 MediaPipe 认为失败后重试、反而产生更多请求。
//
// 放独立模块而非 main.ts 顶部的目的：import 会被提升，能确保在 App.vue（进而 MediaPipe）
// 加载之前执行，且逻辑不与入口文件混在一起。

const BLOCKED = /(^|\.)googleapis\.com$/i

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
  if (isBlocked(url)) blockedXhr.add(this)
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
