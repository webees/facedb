/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  // 幂等：集合不存在就跳过。
  // 本迁移曾叫 1791206104_deleted_employees.js（与 updated_captures 同时间戳，
  // 排序后先于它执行，导致全新部署时「captures 仍引用 employees」而失败）。
  // 改名后，已经应用过旧名字的库会把它当新迁移重跑 —— 此时集合早已删除，
  // 必须安全跳过而不是抛错。
  let collection;
  try {
    collection = app.findCollectionByNameOrId("pbc_3735627160");
  } catch {
    return; // 已删除，无需处理
  }

  return app.delete(collection);
}, (app) => {
  const collection = new Collection({
    "createRule": null,
    "deleteRule": null,
    "fields": [
      {
        "autogeneratePattern": "[a-z0-9]{15}",
        "hidden": false,
        "id": "text3208210256",
        "max": 15,
        "min": 15,
        "name": "id",
        "pattern": "^[a-z0-9]+$",
        "presentable": false,
        "primaryKey": true,
        "required": true,
        "system": true,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "text1418771987",
        "max": 0,
        "min": 0,
        "name": "employee_no",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": true,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "text1579384326",
        "max": 0,
        "min": 0,
        "name": "name",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": true,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "text2739632720",
        "max": 0,
        "min": 0,
        "name": "dept",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "hidden": false,
        "id": "select2063623452",
        "maxSelect": 1,
        "name": "status",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "select",
        "values": [
          "active",
          "inactive"
        ]
      }
    ],
    "id": "pbc_3735627160",
    "indexes": [
      "CREATE UNIQUE INDEX idx_employees_employee_no ON employees (employee_no)"
    ],
    "listRule": "",
    "name": "employees",
    "system": false,
    "type": "base",
    "updateRule": null,
    "viewRule": ""
  });

  return app.save(collection);
})
