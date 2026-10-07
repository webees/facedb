/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // update field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "file_video_slot",
    "maxSelect": 1,
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
  // 回退到 up 之前的位置：up 用 addAt(2, …) 把 video 从索引 5 搬到了索引 2
  //（FieldsList.addAt 是「按 id 移除旧字段再插入到 index」，不是就地替换），
  // 所以 down 若也写 2 就是空操作，回滚后字段序会停在 id,session_id,video,meta,analyzed,photos。
  // 必须搬回索引 5，才能复原 up-07 态 id,session_id,meta,analyzed,photos,video。
  // 实测依据：W18-B2 的逐步 up/down 走查 + lib/r18-mig-order-verify.mjs 的前后对照。
  collection.fields.addAt(5, new Field({
    "hidden": false,
    "id": "file_video_slot",
    "maxSelect": 1,
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
    "thumbs": null,
    "type": "file"
  }))

  return app.save(collection)
})
