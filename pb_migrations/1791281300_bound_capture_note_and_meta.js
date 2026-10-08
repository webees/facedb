/// <reference path="../pb_data/types.d.ts" />
// R26 安全面修复：给 captures 里两个「匿名可写、却没有任何上限」的字段加上限。
//
// 发现（W26-B 的 W26B-05 报 meta + run-lead 从夹具读到 note，两条路径互证）：
//   createRule 是公开的（""），而这两个字段在 schema 里都是**无上限**：
//     · note  text  实测 max = 0（PocketBase 里 0 = 不限制长度）
//     · meta  json  实测 maxSize = 0（0 = 不限制序列化字节数）
//   实测读数（W26B-05）：meta 可以是 100 KB、200 层嵌套、任意类型（对象/字符串/数组），
//   全部原样落库；note 同理（本项目里前端根本不写 note，字段目前只有后台手工用）。
//   ⇒ 对一个「知道地址就能写」的集合，这是一条存储放大通道：一次 POST 就能塞进任意大小。
//
// 上限取值的依据（不是随手取的数）：
//   · meta：前端 `src/lib/pb.ts` 的 build() 构造的 meta 是
//       { sessionId, deviceInfo(约 120 字符), videoWidth, videoHeight,
//         perFile: [{ idx, pose, file, blurVariance, brightness, qualityScore, capturedAt, segmentOk }] }
//     一次提交最多 16 个文件（5 个照片点 × 2 张 + 6 个视频点），单条 perFile 实测约 160~200 字节
//     ⇒ 真实 meta 约 3.5 KB。取 64 KB 上限 = 约 18 倍余量：正常采集永远碰不到，
//     而「100 KB 起步的放大写入」会被 400 挡掉。
//   · note：本项目代码从不写它（全仓 grep `note` 在 src/ 只命中无关的 noteSegmentDrop），
//     是后台手工字段。取 2000 字符 —— 比任何人工备注都宽，同时挡住「一次 POST 写 5000 字符」
//     这类实测过的垃圾写入（`1791280417` 给 session_id 加 200 上限时用的是同一套理由）。
//
// 边界（如实登记，不要读成「meta 已经安全」）：
//   maxSize 管的是**序列化字节数**，管不了**嵌套深度**：`[[[[…]]]]` 这种 200 层嵌套仍然
//   远小于 64 KB。深度限制在 PocketBase 的 schema 里无法表达，属未覆盖面（见 findings/W26-LEAD.json）。
//   本迁移只关「大小放大」这一条。
//
// 兼容性：字段上限只在**写入时**校验，已有记录不受影响（不会因为加了上限而读不出来）。
migrate((app) => {
  const collection = app.findCollectionByNameOrId("captures")

  const note = collection.fields.getByName("note")
  note.max = 2000

  const meta = collection.fields.getByName("meta")
  meta.maxSize = 65536

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("captures")

  // 回滚：恢复 PocketBase 默认（0 = 不限制），即 1791232274 的产物
  const note = collection.fields.getByName("note")
  note.max = 0

  const meta = collection.fields.getByName("meta")
  meta.maxSize = 0

  return app.save(collection)
})
