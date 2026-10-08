/// <reference path="../pb_data/types.d.ts" />
// R26 安全面修复：captures 的两个文件字段改为受保护（protected: true），关闭匿名直链取图/取视频。
//
// 发现（W26-A 的 W26A-02 + run-lead 独立复现 R26-LEAD-02，两条路径互证）：
//   文件端点 /api/files/captures/<记录 id>/<文件名> **不看 viewRule**。而 captures 的
//   listRule/viewRule/updateRule 都是 "@request.auth.id != \"\""（仅认证用户），
//   photos 与 video 却是 protected: false ⇒ 匿名可直接下载原图与缩略图：
//     匿名 GET /api/files/captures/<id>/<file>            → 200 image/jpeg 160B（= 原图字节数）
//     匿名 GET /api/files/captures/<id>/<file>?thumb=600x0 → 200 image/jpeg 6369B（缩略图同样可取）
//   同一记录的匿名 GET /api/collections/captures/records/<id> 是 404 —— 差异在端点，不在记录可见性。
//
// 可利用性：需要先知道 15 位 base36 记录 id 与 10 位随机文件 token，而记录端点对匿名是 404，
//   故属「需二次泄漏」类，不是直接可枚举的敞口。修复成本极低、功能面零影响，因此照修。
//
// 修复：photos 与 video 两个 file 字段置 protected: true。
//   实测成对读数（同一 URL，改前/改后/还原）：
//     改前 200 image/jpeg 160B → 改后 404 → 还原后 200
//     缩略图面同理（改前 200/6369B）
//   受保护文件需要 file token（Admin UI 自带该机制）；带超管 Authorization 头直接取文件仍是 404，
//   这是 PB 的既定行为（文件端点认 token 不认 Authorization），不是本修复的副作用。
//
// 为什么不改前端：仓库内 grep `api/files` 与 `photoUrl` 零命中，采集端只用本地 object URL 预览；
//   且实测 protected: true 下**匿名 create（含照片上传）仍 200**，采集链路不受影响。
//
// 为什么新建迁移而不是改 1791232274_updated_captures.js：
//   该迁移已在生产库应用过，PB 按文件名记录已应用集合，改内容不会重跑。
migrate((app) => {
  const collection = app.findCollectionByNameOrId("captures")

  for (const name of ["photos", "video"]) {
    const field = collection.fields.getByName(name)
    field.protected = true
  }

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("captures")

  // 回滚到 1791232274 的产物：两个文件字段都是公开的
  for (const name of ["photos", "video"]) {
    const field = collection.fields.getByName(name)
    field.protected = false
  }

  return app.save(collection)
})
