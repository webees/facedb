/// <reference path="../pb_data/types.d.ts" />
// R27 数据完整性修复：给 captures 加提交级幂等键 `submit_id`（唯一索引）。
//
// 发现（W27-A 的 W27A-01 / W27A-05 + W27-C 的 W27C-06，两条独立路径互证，P2）：
//   提交是一次匿名 POST，**没有任何幂等键、也没有按 session 去重**。只要「服务端已写入、
//   而响应在途中丢失 / 连接被掐」，客户端就会判定失败并给出重试入口；用户再点一次重试
//   （或 runUploadBatch 的下一轮）就会把**逐字相同的整批**再写一遍。
//   W27-A 实测最坏形态：内层 3 次尝试 × 外层 3 轮 = 同一批最多 9 条记录
//   （4 文件批 → 36 个文件；按真实 16 文件批线性外推 144 个文件）；W27-C 实测
//   逐字相同提交 3 次 → 记录 3 条、文件数 4→8→12→16。
//   注意这是**存储与配额**问题，不是数据丢失问题：一条记录都不少，是多出来了。
//
// 修复：客户端按**冻结批次的内容**确定性派生 `submit_id`（同一批的每次重试天然同值，
//   不同批不同值），随表单一起提交；服务端用唯一索引挡住第二批。冲突时 PocketBase 回
//   400 `validation_not_unique`，客户端把它当「这一批已经写进去了」处理（不重试、不报错）。
//
// 为什么必须「派生」而不是「随机生成一次」：重试发生在上传层的外层（runUploadBatch 每轮
//   都会重新调用 uploadSession），随机值每轮都会变，去重直接失效。
//
// 【R27 收口期实测更正 —— 这条注释原先写错了，代价是一次真缺陷】`submit_id` 缺失时
//   PocketBase **不是**存 NULL，而是存**空字符串**（实测响应里 `"submit_id":""`）。所以
//   「多个 NULL 互不相同」的推理不成立：不加条件的话，**第二条不带键的记录**（历史客户端、
//   任何不发键的调用方、判据里的匿名提交）会与第一条撞唯一约束，回 400
//   `{"data":{},"message":"创建记录失败."}` —— 等于把「可选字段」变成了「只准写一条」。
//   由 R26 暴露面判据（`lib/r26-file-exposure-verify.mjs` 的 E1/B6）在收口期抓到。
//   ⇒ 唯一索引必须带条件：`WHERE submit_id <> ''`（SQLite 部分索引），只对真正带了键的记录生效。
//
// 为什么历史记录不受影响：`submit_id` 是可选字段（required = false），且索引带
//   `WHERE submit_id <> ''` 条件，空值记录之间永不互相冲突。
//
// 未覆盖面（如实登记，别当成已解决）：
//   · 唯一索引只挡「同一批的重复提交」。不同批但内容相同的两次采集（用户真的连点两次
//     采集、且每张照片逐字节相同）仍会产生两条记录 —— 这是正确语义，不是缺陷。
//   · 服务端**不校验** `meta.perFile` 与实际上传文件是否对应（W27A-03 / W27B-02 / W27B-03）：
//     PocketBase 的 json 字段没有结构校验能力，schema 层表达不了；只能靠客户端自检。
//   · 回退路径的文件清理（W27C-02 / W27C-03 / W27C-07）：`migrate down` 把 file 字段移出
//     schema 后，已落盘的文件不会随之删除，且 PB 没有孤儿清扫命令 —— 见 RUN.md 的说明。
migrate((app) => {
  const collection = app.findCollectionByNameOrId("captures")

  if (!collection.fields.getByName("submit_id")) {
    collection.fields.add(new Field({
      "hidden": false,
      "id": "text_submit_id",
      "name": "submit_id",
      "presentable": false,
      "required": false,
      "system": false,
      "type": "text",
      "autogeneratePattern": "",
      "max": 64,
      "min": 0,
      "pattern": "",
      "primaryKey": false,
    }))
  }

  const idx = "CREATE UNIQUE INDEX idx_captures_submit_id ON captures (submit_id) WHERE submit_id <> ''"
  if (!collection.indexes.includes(idx)) {
    collection.indexes = [...collection.indexes, idx]
  }

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("captures")

  const idx = "CREATE UNIQUE INDEX idx_captures_submit_id ON captures (submit_id) WHERE submit_id <> ''"
  collection.indexes = collection.indexes.filter((i) => i !== idx)

  const f = collection.fields.getByName("submit_id")
  if (f) collection.fields.removeById(f.id)

  return app.save(collection)
})
