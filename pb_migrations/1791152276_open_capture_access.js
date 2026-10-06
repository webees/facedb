/// <reference path="../pb_data/types.d.ts" />
// 采集端免登录：放开匿名访问所需的最小权限。
// employees 允许匿名查询（否则采集端查不到员工）；captures 允许匿名创建（上传采集结果）。
// 其余规则（captures 的 list/view/update、employees 的写操作）保持仅认证用户，后台仍走超级用户。
migrate((app) => {
  const employees = app.findCollectionByNameOrId("employees")
  employees.listRule = ""
  employees.viewRule = ""
  app.save(employees)

  const captures = app.findCollectionByNameOrId("captures")
  captures.createRule = ""
  app.save(captures)
}, (app) => {
  const employees = app.findCollectionByNameOrId("employees")
  employees.listRule = '@request.auth.id != ""'
  employees.viewRule = '@request.auth.id != ""'
  app.save(employees)

  const captures = app.findCollectionByNameOrId("captures")
  captures.createRule = '@request.auth.id != ""'
  app.save(captures)
})
