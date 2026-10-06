/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // update collection data
  unmarshal({
    "indexes": [
      "CREATE INDEX idx_captures_session ON captures (session_id)"
    ]
  }, collection)

  // remove field
  collection.fields.removeById("relation1570731425")

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2343272259")

  // update collection data
  unmarshal({
    "indexes": [
      "CREATE INDEX idx_captures_session ON captures (session_id)",
      "CREATE INDEX idx_captures_employee ON captures (employee)"
    ]
  }, collection)

  // add field
  collection.fields.addAt(1, new Field({
    "cascadeDelete": false,
    "collectionId": "pbc_3735627160",
    "hidden": false,
    "id": "relation1570731425",
    "maxSelect": 1,
    "minSelect": 0,
    "name": "employee",
    "presentable": false,
    "required": false,
    "system": false,
    "type": "relation"
  }))

  return app.save(collection)
})
