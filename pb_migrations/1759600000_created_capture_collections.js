/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  // 1. operators — auth collection, 仅超级用户/Admin UI 可管理
  const operators = new Collection({
    type: "auth",
    name: "operators",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })
  app.save(operators)

  // 2. employees — base collection，需先保存以便 captures 引用其 id
  const employees = new Collection({
    type: "base",
    name: "employees",
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "text", name: "employee_no", required: true },
      { type: "text", name: "name", required: true },
      { type: "text", name: "dept" },
      { type: "select", name: "status", values: ["active", "inactive"], maxSelect: 1, required: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_employees_employee_no ON employees (employee_no)",
    ],
  })
  app.save(employees)

  // 3. captures — base collection，relation 字段需要 employees 的真实 id
  const employeesId = app.findCollectionByNameOrId("employees").id
  const captures = new Collection({
    type: "base",
    name: "captures",
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: null,
    fields: [
      // cascadeDelete 必须为 false：该选项语义是「删除本条记录时级联删除被引用的记录」，
      // 设为 true 会导致删除一条采集记录时把员工记录一并删掉。
      { type: "relation", name: "employee", collectionId: employeesId, maxSelect: 1, required: true, cascadeDelete: false },
      { type: "text", name: "session_id", required: true },
      { type: "select", name: "kind", values: ["image", "video"], maxSelect: 1, required: true },
      { type: "select", name: "pose", values: ["frontal", "left30", "right30", "left45", "right45", "liveness"], maxSelect: 1, required: true },
      { type: "file", name: "file", required: true, maxSelect: 1, maxSize: 52428800, mimeTypes: ["image/jpeg", "image/png", "video/mp4", "video/webm"] },
      { type: "json", name: "meta" },
      { type: "bool", name: "analyzed" },
    ],
    indexes: [
      "CREATE INDEX idx_captures_session ON captures (session_id)",
      "CREATE INDEX idx_captures_employee ON captures (employee)",
    ],
  })
  app.save(captures)
}, (app) => {
  // 反向删除：先删依赖 employees 的 captures
  const names = ["captures", "employees", "operators"]
  for (let i = 0; i < names.length; i++) {
    try {
      app.delete(app.findCollectionByNameOrId(names[i]))
    } catch (e) {
      // 已不存在则忽略
    }
  }
})
