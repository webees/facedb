/// <reference path="../pb_data/types.d.ts" />
// D-F04（R01-D）裁定落地：给 captures.session_id 加长度上限与字符约束。
//
// 背景：createRule 为公开（""），任何人可直接 POST 写入垃圾编号 —— 实测 5000 个字符、
// 纯空格「   」、含控制字符都能落库（evidence/R01-D-05-write-controls.log D07/D08/D09）。
// session_id 是唯一的业务分组键（后台按编号归组与检索），垃圾编号会直接破坏归组与展示。
//
// 裁定（decisions/R02-decisions.md #2）：不引入上传令牌（会破坏免登录采集动线），
// 改为最小侵入的字段约束。前端 App.vue 的 readSessionId() 本来就会去控制字符并 trim，
// 因此约束不会影响正常链接；采集编号仍是「任意非空字符串」，不新增格式要求。
//
// 约束（两条并存，互相独立）：
//   · max = 200：上限足够（实际编号是短串），同时挡住 5000 字符这类超长输入。
//   · pattern：首尾不得为空白、任何位置不得出现控制字符（\x00-\x1F、\x7F）。
//     只禁「首尾空白」而允许内部空格 —— 编号里出现空格是既有文档允许的形态
//     （RUN.md：编号可以是任意非空字符串），本轮只收紧会破坏归组的输入。
migrate((app) => {
  const collection = app.findCollectionByNameOrId("captures")
  const field = collection.fields.getByName("session_id")

  field.max = 200
  // Go(RE2) 正则；JS 字符串里 \\s / \\x00 各需要一个反斜杠
  field.pattern = '^[^\\s\\x00-\\x1F\\x7F](?:[^\\x00-\\x1F\\x7F]{0,198}[^\\s\\x00-\\x1F\\x7F])?$'

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("captures")
  const field = collection.fields.getByName("session_id")

  // 回滚：恢复 PocketBase 默认（max=0 表示用默认上限，pattern="" 表示不做正则校验）
  field.max = 0
  field.pattern = ""

  return app.save(collection)
})
