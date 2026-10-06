/// <reference path="../pb_data/types.d.ts" />
// 采集链接只带时间戳编号（如 /202610050513），不含员工信息，
// 因此 employee 关系由必填改为可选；该字段保留，后续需要关联员工时仍可使用。
migrate((app) => {
  const collection = app.findCollectionByNameOrId("captures")
  const field = collection.fields.getByName("employee")
  field.required = false
  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId("captures")
  const field = collection.fields.getByName("employee")
  field.required = true
  return app.save(collection)
})
