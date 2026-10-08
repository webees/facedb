// 整批提交的「轮次 / 退避 / 预算」编排。
//
// 为什么单独成模块（R23 抽出，非新功能）：
// 1. 这段策略与界面状态无关 —— 它只决定「再试一次还是就此失败」，而界面状态
//    （submitting/uploading/uploadError/submitFailed、提示键、音效、emit）全留在组件里。
//    混在一起时，任何一次「提前 return」都可能漏掉 finally 里的状态复位。
// 2. 它是最坏耗时（3 轮 × 内层 3 次 × 25s 上限 + 退避 ≈ 237.6s）的唯一来源，
//    单独成文件后可以直接被判据驱动，不需要挂载组件。
// 3. `src/components/CaptureView.vue` 有 800 行的硬阈值（仓库标准 S20），
//    把策略抽出来是为了让组件只留编排入口。
//
// 语义（与原实现逐条一致，改前改后都由 lib/r12-w37-verify.mjs 与
// lib/r23-weaknet-verify.mjs 驱动真实源码取证）：
// - 所有轮次共用同一个截止时刻 `deadline`：不共享的话最坏耗时会按轮数倍增。
// - 每一轮开始前先看预算：`Date.now() >= deadline` 就不再发起新请求，
//   否则总耗时突破预算，失败态永远到不了。
// - 退避同样计入预算：剩余时间不够一个注定超时的间隔时，直接进失败态，不让用户白等。
// - 组件已卸载（`isDisposed()`）时立即停止：后台继续重试既没有意义，
//   也会在已卸载的组件上发事件。
import { uploadSession, type PendingFile } from './pb'

/** 提交策略：轮数、退避基数、整批共享预算 */
export interface BatchPolicy {
  /** 最多尝试几轮（含首次） */
  tries: number
  /** 退避基数，第 n 轮失败后等 `backoffMs * n` 毫秒（1.2s、2.4s…） */
  backoffMs: number
  /** 整批共享的时间预算（毫秒） */
  budgetMs: number
}

export type BatchReason = 'ok' | 'disposed' | 'budget' | 'exhausted'

export interface BatchRun {
  ok: boolean
  /** 实际发起的尝试次数（成功时含成功那一次） */
  attempts: number
  /** 最后一次失败的技术消息；从未发起过尝试时为空串 */
  error: string
  /** 未成功时的原因：组件已卸载 / 预算耗尽 / 尝试用尽 */
  reason: BatchReason
}

/**
 * 逐轮提交整批文件，直到成功、卸载、预算耗尽或轮数用尽。
 *
 * @param files 待提交文件（调用方保证非空；空数组会被 uploadSession 抛出）
 * @param sessionId 采集编号
 * @param policy 轮数 / 退避 / 预算
 * @param opts.isDisposed 组件是否已卸载（每轮开始前与成功回调前都会问一次）
 * @param opts.onAttemptFail 每轮失败时的回调（只用于日志，不得改变控制流）
 */
export async function runUploadBatch(
  files: PendingFile[],
  sessionId: string,
  policy: BatchPolicy,
  opts: { isDisposed: () => boolean; onAttemptFail?: (attempt: number, message: string) => void },
): Promise<BatchRun> {
  const deadline = Date.now() + policy.budgetMs
  let error = ''
  for (let attempt = 1; attempt <= policy.tries; attempt++) {
    if (opts.isDisposed()) return { ok: false, attempts: attempt - 1, error, reason: 'disposed' }
    if (Date.now() >= deadline) return { ok: false, attempts: attempt - 1, error, reason: 'budget' }
    try {
      await uploadSession(sessionId, files, deadline)
      return { ok: true, attempts: attempt, error: '', reason: 'ok' }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      opts.onAttemptFail?.(attempt, error)
      if (attempt < policy.tries) {
        const wait = policy.backoffMs * attempt
        // 退避也计入预算：等完这一个间隔就没有预算了，那就没必要等
        if (Date.now() + wait >= deadline) return { ok: false, attempts: attempt, error, reason: 'budget' }
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
  return { ok: false, attempts: policy.tries, error, reason: 'exhausted' }
}

/**
 * 等「正在飞的采集收尾」结束（有界轮询）。
 *
 * 为什么必须有：本采集点的照片与视频段都在**段收尾之后**才入队，而采集是
 * `void shoot()` 调用的（不 await）。若在它还在飞时同步判定「待提交队列为空」，
 * 就会把「还没入队」误判成「本次一个文件都没录到」—— 用户明明拍到 10 张，
 * 界面却说「录制结果为空」并给出「重新采集」，点下去这一批就全丢了。
 * 这正是「空队列早退」这条修复自己引入的假空路径。
 *
 * 从采集内部调用（最后一步）时队列已定，调用方应直接跳过本函数（否则会等满上限）。
 *
 * @param isBusy 采集是否仍在进行
 * @param tries 轮询次数上限
 * @param ms 每次轮询的间隔
 * @returns 是否在预算内等到不忙（false = 等满了上限，此时队列状态未知，调用方须如实处理）
 */
export async function drainWhileBusy(isBusy: () => boolean, tries: number, ms: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (!isBusy()) return true
    await new Promise((r) => setTimeout(r, ms))
  }
  return !isBusy()
}

/**
 * 提交前的队列前提（R23REV-N3）：把「等收尾 → 判队列」这段策略收进模块，
 * 因为它与 drainWhileBusy 的返回值语义是同一件事 —— 调用方**必须**如实处理 false。
 *
 * 为什么不能简化成「等不到就直接往下走」：往下走会命中 `pendingFiles.length === 0`，
 * 于是「shoot 还在收尾、文件即将入队」被报成「本次没有可上传文件」，并把用户引去点
 * 「重新采集」—— 而 `retry()` 会清空待提交队列，那一批就真丢了。
 *
 * @returns 'finalizing' 等满上限仍忙（队列状态未知，须按「稍后重试」处理，且不得发请求）
 *          'empty' 队列确实为空（可以给「录制为空」类提示，同样不发请求）
 *          'ok' 有文件可提交
 */
export async function preSubmitQueue(
  isBusy: () => boolean,
  tries: number,
  ms: number,
  queued: number,
): Promise<'ok' | 'finalizing' | 'empty'> {
  if (!(await drainWhileBusy(isBusy, tries, ms))) return 'finalizing'
  return queued === 0 ? 'empty' : 'ok'
}
