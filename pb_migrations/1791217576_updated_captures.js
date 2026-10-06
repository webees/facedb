/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // update field
  collection.fields.addAt(1, new Field({
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

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // update field
  collection.fields.addAt(1, new Field({
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

  return app.save(collection)
})
