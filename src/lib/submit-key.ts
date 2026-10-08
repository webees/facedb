// 提交级幂等键与「重复批次」判别式（R27）。
//
// 为什么单独成一个模块：这两个都是**纯函数**，抽出来之后判据可以把它们直接加载起来做行为断言。
// 留在 `pb.ts` 里就得连带桩掉 fetch / Blob / 浏览器 API 才能加载，判据只能退化成「正则断言文本在位」——
// R27 复核席（R27REV-1-N2）实测过这种退化：把 `submitIdOf` 换成随机值、把判别式换成恒 `true`，
// 只断言文本在位的判据仍然 8/8 全绿、退出码 0，而实际后果分别是「幂等失效、重复入库」与
// 「真实字段级 400 被当成已写入 ⇒ 界面假成功而库里一条没写」。
// 现在由 `$RUN/lib/r27-client-idempotency-verify.mjs` 直接跑这两个函数，并有变异电池守判别力。

/** 只依赖结构的最小入参类型：与 `pb.ts` 的 `PendingFile` 结构兼容，且不引入任何依赖（便于单独加载）。 */
export type SubmitKeyFile = {
  kind: string
  pose: string
  filename: string
  blob: { size: number; type: string }
  meta: { capturedAt: number; qualityScore: number }
}

/**
 * 这个 400 是不是「这一批已经写进去了」？
 *
 * PocketBase 对**唯一索引冲突**的回包是
 * `{"data":{},"message":"创建记录失败.","status":400}` —— data 是空对象、没有顶层 code。
 * 而字段级校验错误（文件数超限 / 文本超长 / JSON 超限）都带 `data.<字段>.code`
 * （如 `validation_too_many_files`、`validation_max_text_constraint`）。故只能按形态识别：
 * 400 + 有 data 且为空 + 无顶层 code。
 *
 * 退化行为（万一将来 PB 改了文案或形态）：这条分支不再命中 ⇒ 回到 R27 之前的体验
 * （界面报「上传失败」、给出重试入口），而**服务端仍然挡住重复写入** —— 最坏是假失败，
 * 不会写重复记录，也不会把别的字段校验错误误判成成功。
 *
 * `Array.isArray` 排除是必要的：`typeof [] === 'object'`，否则 `{"data":[],…}` 会被判成重复批次
 * （PB 0.40 实测的 6 种错误形态 data 一律是对象，故当前不可达 —— 但判别式不该依赖这个巧合）。
 */
export function isDuplicateBatch(body: string): boolean {
  try {
    const j = JSON.parse(body) as { data?: Record<string, unknown>; code?: unknown } | null
    if (!j || typeof j !== 'object' || Array.isArray(j)) return false
    if (j.code) return false
    if (!j.data || typeof j.data !== 'object' || Array.isArray(j.data)) return false
    return Object.keys(j.data).length === 0
  } catch {
    return false
  }
}

/**
 * 提交级幂等键（R27）：由**冻结批次的内容**确定性派生。
 *
 * 为什么不随机生成一次：重试发生在上传层的外层（runUploadBatch 每一轮都重新调用
 * uploadSession），随机值每轮都会变 ⇒ 去重直接失效。派生则天然满足「同一批的每次重试
 * 得到同一个键、不同批几乎不可能相同」。
 *
 * 描述串里放的都是**冻结后不再变**的字段：sessionId、每个文件的 kind / pose / filename /
 * 字节数 / MIME、以及采集时刻（毫秒）与质量分。不放 blob 内容（那要读全部字节 + 异步哈希，
 * 而毫秒级 capturedAt 已足以把两次真实采集分开）。
 *
 * 哈希用 FNV-1a 64 位（BigInt）：同步、零依赖。这里要的是「同批同值、异批几无碰撞」，
 * 不是密码学强度 —— 键只用于唯一索引，碰撞的后果是「两批里后一批被服务端拒掉」。
 */
export function submitIdOf(sessionId: string, batch: SubmitKeyFile[]): string {
  const desc = batch
    .map((f) =>
      [sessionId, f.kind, f.pose, f.filename, f.blob.size, f.blob.type, f.meta.capturedAt, f.meta.qualityScore].join(
        '\u0001',
      ),
    )
    .join('\u0002')
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < desc.length; i++) {
    h ^= BigInt(desc.charCodeAt(i))
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return 'sub-' + h.toString(16).padStart(16, '0')
}
