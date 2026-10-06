/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // remove field
  collection.fields.removeById("select1002749145")

  // remove field
  collection.fields.removeById("select809127039")

  // remove field
  collection.fields.removeById("file2359244304")

  // add field
  collection.fields.addAt(4, new Field({
    "hidden": false,
    "id": "file_photos_slot",
    "maxSelect": 6,
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

  // add field
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
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // add field
  collection.fields.addAt(2, new Field({
    "hidden": false,
    "id": "select1002749145",
    "maxSelect": 1,
    "name": "kind",
    "presentable": false,
    "required": true,
    "system": false,
    "type": "select",
    "values": [
      "image",
      "video"
    ]
  }))

  // add field
  collection.fields.addAt(3, new Field({
    "hidden": false,
    "id": "select809127039",
    "maxSelect": 1,
    "name": "pose",
    "presentable": false,
    "required": true,
    "system": false,
    "type": "select",
    "values": [
      "frontal",
      "left30",
      "right30",
      "left45",
      "right45",
      "liveness"
    ]
  }))

  // add field
  collection.fields.addAt(4, new Field({
    "hidden": false,
    "id": "file2359244304",
    "maxSelect": 1,
    "maxSize": 52428800,
    "mimeTypes": [
      "image/jpeg",
      "image/png",
      "video/mp4",
      "video/webm"
    ],
    "name": "file",
    "presentable": false,
    "protected": false,
    "required": true,
    "system": false,
    "thumbs": null,
    "type": "file"
  }))

  // remove field
  collection.fields.removeById("file_photos_slot")

  // remove field
  collection.fields.removeById("file_video_slot")

  return app.save(collection)
})
