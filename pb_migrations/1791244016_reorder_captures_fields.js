/// <reference path="../pb_data/types.d.ts" />
// 固定 captures 的字段顺序。
//
// 为什么需要单独一支迁移：本地是从一个空库逐步调整出来的，字段顺序由每次 addAt 叠加而成；
// 而全新部署是按文件名顺序一次性重放全部迁移，叠加结果与本地不同 ——
// created/updated 会落在 session_id/meta 之前。
// 这里在链末尾统一重排，让两种路径得到相同结果。
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // 目标顺序：业务字段在前，时间字段收尾
  const order = ["id", "note", "photos", "video", "session_id", "meta", "created", "updated"]

  // 先按名字收集现有字段（保留每字段自身的全部配置）
  const byName = {}
  for (const f of collection.fields) byName[f.name] = f

  // 再按目标顺序重建字段列表；不在 order 里的字段追加到末尾，避免丢字段
  const rebuilt = new FieldsList()
  for (const n of order) if (byName[n]) rebuilt.add(byName[n])
  for (const f of collection.fields) if (!order.includes(f.name)) rebuilt.add(f)
  collection.fields = rebuilt

  return app.save(collection)
}, (app) => {
  // 回滚：恢复为迁移前的顺序（created/updated 在 session_id/meta 之前）
  const collection = app.findCollectionByNameOrId("pbc_2343272259")
  const prev = ["id", "note", "photos", "video", "created", "updated", "session_id", "meta"]

  const byName = {}
  for (const f of collection.fields) byName[f.name] = f

  const rebuilt = new FieldsList()
  for (const n of prev) if (byName[n]) rebuilt.add(byName[n])
  for (const f of collection.fields) if (!prev.includes(f.name)) rebuilt.add(f)
  collection.fields = rebuilt

  return app.save(collection)
})
