/// <reference path="../pb_data/types.d.ts" />
// R03-A 发现修复：session_id 的 pattern 漏掉 Unicode 空白。
//
// 背景：1791280417_restrict_captures_session_id.js 用 Go(RE2) 的 \s 表示「空白」，
// 但 RE2 的 \s 只等于 [\t\n\f\r ]，**不含 Unicode 空白**。
// 实测（$RUN/tmp 一次性实例，20 用例）：
//   首部/尾部/纯 U+3000（全角空格）、U+00A0（不换行空格）、U+2003（EM SPACE）、
//   U+2028（行分隔符）共 7 例全部被【接受】—— 即「　　」（纯全角空格）能作为合法
//   session_id 落库，而 session_id 是唯一的业务分组键，正是该迁移要防的破坏归组的输入。
//
// 修复：把 \s 扩展为 \s\p{Z}（Unicode 分隔符类 Zs+Zl+Zp）。
// 实测对比（同一批 15 用例：10 应拒 + 5 应接受）：
//   原式     → 通过 8 / 失败 7
//   加 \p{Z} → 通过 15 / 失败 0
//
// 为什么新建迁移而不是改旧的：旧迁移已在生产库应用过，PB 按文件名记录已应用集合，
// 改内容不会重跑。
migrate((app) => {
  const collection = app.findCollectionByNameOrId("captures")
  const field = collection.fields.getByName("session_id")

  // 与旧式相比只多了 \p{Z}（覆盖 U+3000/U+00A0/U+2003/U+2028 等）
  field.pattern = '^[^\\s\\p{Z}\\x00-\\x1F\\x7F](?:[^\\x00-\\x1F\\x7F]{0,198}[^\\s\\p{Z}\\x00-\\x1F\\x7F])?$'

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("captures")
  const field = collection.fields.getByName("session_id")

  // 回滚到上一版（仅 \s）—— 与 1791280417 的产物一致
  field.pattern = '^[^\\s\\x00-\\x1F\\x7F](?:[^\\x00-\\x1F\\x7F]{0,198}[^\\s\\x00-\\x1F\\x7F])?$'

  return app.save(collection)
})
