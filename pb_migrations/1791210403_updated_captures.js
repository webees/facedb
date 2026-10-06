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
    "thumbs": null,
    "type": "file"
  }))

  return app.save(collection)
})
