/// <reference path="../pb_data/types.d.ts" />
// R11-B21 发现修复：session_id 的 pattern 仍漏 C1 控制符（含 U+0085 NEL）。
//
// 背景（第二轮 W6 的 B20 对照电池 + 独立的离线字符集分析，两条路径互证）：
//   1791281000 把 pattern 加宽为 [^\s\p{Z}\x00-\x1F\x7F]，关掉了 19 个 Unicode 空白里的 18 个，
//   但 U+0085（NEL，NEXT LINE）仍被接受。根因是 U+0085 在 Unicode 里属于 **Cc（控制符）**
//   而非 Z（分隔符），所以 \p{Z} 盖不到；而 RE2 的 \s = [\t\n\f\r ] 也不含它。
//   实测：B20 下 "\u0085a\u0085"、纯 "\u0085\u0085" 均被【接受】—— 又是「不可见字符可作
//   为唯一业务分组键」，与第一轮 U+3000 是同一类缺陷，属修复不完整。
//   同时测得 U+0080–U+009F 这 32 个 C1 控制符在 B20 下**全部放行**。
//
// 修复：把显式枚举的 [\x00-\x1F\x7F] 整体换成 Unicode 控制类 \p{Cc}，
//       一次覆盖 C0(0x00-0x1F) + C1(0x80-0x9F，含 U+0085) + DEL(0x7F)。
//       首尾与中间三段都换，与 C0 的既有处理保持一致。
//
// 为什么**不**一并禁 \p{Cf}（格式字符 U+200B/U+200D/U+FEFF 等）：
//   emoji 的 ZWJ 序列（如 👨‍👩‍👧 = U+1F468 ZWJ U+1F469 ZWJ U+1F467）内含 U+200D，
//   禁 Cf 会让含 emoji 的采集编号被拒，属过度收紧。实测已确认含 ZWJ 的 emoji 串在
//   本式下仍被接受。此决定记入 RUN.md 约束表。
//
// 为什么新建迁移而不是改 B20：B20 已在生产库应用过，PB 按文件名记录已应用集合，改内容不会重跑。
migrate((app) => {
  const collection = app.findCollectionByNameOrId("captures")
  const field = collection.fields.getByName("session_id")

  field.pattern = '^[^\\s\\p{Z}\\p{Cc}](?:[^\\p{Cc}]{0,198}[^\\s\\p{Z}\\p{Cc}])?$'

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("captures")
  const field = collection.fields.getByName("session_id")

  // 回滚到 B20 的产物（含 \p{Z}，但不含 \p{Cc}）
  field.pattern = '^[^\\s\\p{Z}\\x00-\\x1F\\x7F](?:[^\\x00-\\x1F\\x7F]{0,198}[^\\s\\p{Z}\\x00-\\x1F\\x7F])?$'

  return app.save(collection)
})
