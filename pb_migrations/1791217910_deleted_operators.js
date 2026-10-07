/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
// ⚠️ 回退边界：本迁移的 down **只重建集合定义，不恢复记录**。
// up 的 app.delete(collection) 在 sqlite 层整表 DROP，记录已随表消失，down 无从还原。
// 实测（R13-X2）：users 1 条 → down 后 0 条；operators 2 条 → down 后 0 条。
// 需要保留数据时，只能在执行本迁移前先导出记录，不能靠 down 找回来。
    const collection = app.findCollectionByNameOrId("pbc_2338068732");

  return app.delete(collection);
}, (app) => {
  const collection = new Collection({
    "authAlert": {
      "emailTemplate": {
        "body": "<p>你好，</p>\n<p>我们注意到你的 {APP_NAME} 账号在新位置登录：</p>\n<p><em>{ALERT_INFO}</em></p>\n<p><strong>如果这不是你本人，你应该立即更改你的 {APP_NAME} 账号密码，以撤销其他所有位置的访问权限。</strong></p>\n<p>如果是你本人，可以忽略此邮件。</p>\n<p>\n  此致，<br/>\n  {APP_NAME} 团队\n</p>",
        "subject": "从新位置登录"
      },
      "enabled": true
    },
    "authRule": "",
    "authToken": {
      "duration": 432000
    },
    "confirmEmailChangeTemplate": {
      "body": "<p>你好，</p>\n<p>点击下方按钮确认你的新邮箱地址。</p>\n<p>\n  <a class=\"btn\" href=\"{APP_URL}/_/#/auth/confirm-email-change/{TOKEN}\" target=\"_blank\" rel=\"noopener\">确认新邮箱</a>\n</p>\n<p><i>如果你没有请求更改邮箱地址，请忽略此邮件。</i></p>\n<p>\n  此致，<br/>\n  {APP_NAME} 团队\n</p>",
      "subject": "确认你的{APP_NAME} 新邮箱地址"
    },
    "createRule": null,
    "deleteRule": null,
    "emailChangeToken": {
      "duration": 1800
    },
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
        "cost": 0,
        "hidden": true,
        "id": "password901924565",
        "max": 0,
        "min": 8,
        "name": "password",
        "pattern": "",
        "presentable": false,
        "required": true,
        "system": true,
        "type": "password"
      },
      {
        "autogeneratePattern": "[a-zA-Z0-9]{50}",
        "hidden": true,
        "id": "text2504183744",
        "max": 60,
        "min": 30,
        "name": "tokenKey",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": true,
        "system": true,
        "type": "text"
      },
      {
        "exceptDomains": null,
        "hidden": false,
        "id": "email3885137012",
        "name": "email",
        "onlyDomains": null,
        "presentable": false,
        "required": true,
        "system": true,
        "type": "email"
      },
      {
        "hidden": false,
        "id": "bool1547992806",
        "name": "emailVisibility",
        "presentable": false,
        "required": false,
        "system": true,
        "type": "bool"
      },
      {
        "hidden": false,
        "id": "bool256245529",
        "name": "verified",
        "presentable": false,
        "required": false,
        "system": true,
        "type": "bool"
      }
    ],
    "fileToken": {
      "duration": 180
    },
    "id": "pbc_2338068732",
    "indexes": [
      "CREATE UNIQUE INDEX `idx_tokenKey_pbc_2338068732` ON `operators` (`tokenKey`)",
      "CREATE UNIQUE INDEX `idx_email_pbc_2338068732` ON `operators` (`email`) WHERE `email` != ''"
    ],
    "listRule": null,
    "manageRule": null,
    "mfa": {
      "duration": 600,
      "enabled": false,
      "rule": ""
    },
    "name": "operators",
    "oauth2": {
      "enabled": false,
      "mappedFields": {
        "avatarURL": "",
        "id": "",
        "name": "",
        "username": ""
      }
    },
    "otp": {
      "duration": 180,
      "emailTemplate": {
        "body": "<p>你好，</p>\n<p>你的一次性密码是：<strong>{OTP}</strong></p>\n<p><i>如果你没有请求一次性密码，可以忽略此邮件。</i></p>\n<p>\n  此致，<br/>\n  {APP_NAME} 团队\n</p>",
        "subject": "{APP_NAME} 的一次性密码"
      },
      "enabled": false,
      "length": 8
    },
    "passwordAuth": {
      "enabled": true,
      "identityFields": [
        "email"
      ]
    },
    "passwordResetToken": {
      "duration": 1800
    },
    "resetPasswordTemplate": {
      "body": "<p>你好，</p>\n<p>点击下方按钮重置你的密码。</p>\n<p>\n  <a class=\"btn\" href=\"{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}\" target=\"_blank\" rel=\"noopener\">重置密码</a>\n</p>\n<p><i>如果你没有请求重置密码，请忽略此邮件。</i></p>\n<p>\n  此致，<br/>\n  {APP_NAME} 团队\n</p>",
      "subject": "重置您的{APP_NAME} 密码"
    },
    "system": false,
    "type": "auth",
    "updateRule": null,
    "verificationTemplate": {
      "body": "<p>你好，</p>\n<p>感谢你加入 {APP_NAME}。</p>\n<p>点击下方按钮验证你的邮箱地址。</p>\n<p>\n  <a class=\"btn\" href=\"{APP_URL}/_/#/auth/confirm-verification/{TOKEN}\" target=\"_blank\" rel=\"noopener\">验证</a>\n</p>\n<p><i>如果你最近没有注册，请忽略此邮件。</i></p>\n<p>\n  此致，<br/>\n  {APP_NAME} 团队\n</p>",
      "subject": "验证您的{APP_NAME} 邮箱"
    },
    "verificationToken": {
      "duration": 86400
    },
    "viewRule": null
  });

  return app.save(collection);
})
