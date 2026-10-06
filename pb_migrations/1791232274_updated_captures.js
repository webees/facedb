/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // update field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "file_photos_slot",
    "maxSelect": 24,
    "maxSize": 20971520,
    "mimeTypes": [
      "image/jpeg",
      "image/png"
    ],
    "name": "photos",
    "presentable": false,
    "protected": false,
    "required": false,
    "system": false,
    "thumbs": [
      "600x0"
    ],
    "type": "file"
  }))

  // update field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "file_video_slot",
    "maxSelect": 8,
    "maxSize": 104857600,
    "mimeTypes": [
      "video/mp4",
      "video/webm"
    ],
    "name": "video",
    "presentable": false,
    "protected": false,
    "required": false,
    "system": false,
    "thumbs": [
      "600x0"
    ],
    "type": "file"
  }))

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // update field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "file_photos_slot",
    "maxSelect": 20,
    "maxSize": 20971520,
    "mimeTypes": [
      "image/jpeg",
      "image/png"
    ],
    "name": "photos",
    "presentable": false,
    "protected": false,
    "required": false,
    "system": false,
    "thumbs": [
      "600x0"
    ],
    "type": "file"
  }))

  // update field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "file_video_slot",
    "maxSelect": 3,
    "maxSize": 104857600,
    "mimeTypes": [
      "video/mp4",
      "video/webm"
    ],
    "name": "video",
    "presentable": false,
    "protected": false,
    "required": false,
    "system": false,
    "thumbs": [
      "600x0"
    ],
    "type": "file"
  }))

// 回滚字段顺序。
  // `FieldsList.addAt(index, field)` 的语义是「按 id 移除同 id 的旧字段，再插入到 index」——
  // 它会**搬动既有字段**。本迁移的 up 用 addAt 顺带改了字段位置，down 若再用同一个 index
  // 就等于不动位置：实测回滚后字段顺序与迁移前不一致（取值正确、顺序漂移）。
  // 这里按迁移前的真实顺序按名重建字段列表（与 1791244016_reorder_captures_fields.js 同范式）。
  const order = ["id","note","created","updated","photos","video","session_id","meta"]
  const byName = {}
  for (const f of collection.fields) byName[f.name] = f
  const rebuilt = new FieldsList()
  for (const n of order) if (byName[n]) rebuilt.add(byName[n])
  for (const f of collection.fields) if (!order.includes(f.name)) rebuilt.add(f)
  collection.fields = rebuilt

  return app.save(collection)
})
