# 参与贡献

本项目按「可复核」的标准维护：**每一个结论都要有能重跑的判据**，每一个修复都要有
「修复前失败、修复后通过」的证据。请按下面的规范提交改动。

## 分支模型

`main` 是受保护分支，只接受经主题分支合并的改动。

| 分支前缀 | 用途 | 示例 |
| --- | --- | --- |
| `audit/r<N>-` | 审计第 N 轮的修复 | `audit/r13-f8-unmount-resource-reclaim` |
| `feat/` | 新功能 | `feat/pose-preset` |
| `fix/` | 常规缺陷修复 | `fix/upload-timeout-budget` |
| `docs/` | 仅文档 | `docs/runmd-deploy-sync` |
| `chore/` | 构建、依赖、工具链 | `chore/ci-bootstrap` |

## 提交信息

首行格式：`<type>(<scope>): <结论>`，正文说明**测到了什么、怎么测的、为什么这么改**。
审计轮统一用 `audit(round-N): <范围> - <结论>`。

```
audit(round-13): src/lib/pb.ts - 把 429/408 从永久错误改为可重试

复现：限流窗口内 3 次尝试全部 429，整批 16 个文件一起失败。
判据：<运行根>/lib/r13-f5-retry-verify.mjs（修复前 3/6 → 修复后 6/6）。

判据脚本与运行记录放在审计运行根（`~/.dsh-codepunk/projects/<id>/runs/<run>/`），
**不入库**；PR 描述里给出可重跑的命令与修复前后的读数即可。
```

禁止把「尝试过什么」写成提交信息；提交信息描述的是**改动的结论**。

## 合并方式

- **一律产生合并提交**：`git merge --no-ff <主题分支>`，或通过 GitHub PR 使用
  **Merge commit** 方式合并。不要使用 fast-forward / squash（会丢掉分支边界）。
- **不要直接向 `main` 推送**；不要对被推送过的历史做 rebase / `--amend` / force push。
- 合并前确保主题分支已包含 `main` 的最新提交，避免把冲突带到 `main`。

```bash
git switch -c audit/r14-<slug> main
# …改动与验证…
npm run verify && npm run typecheck
git commit -m "audit(round-14): <scope> - <结论>"
git switch main && git merge --no-ff audit/r14-<slug>
```

## 提交前检查

```bash
npm ci
npm run verify      # 资源指纹 / 迁移可解析性与约束不变量 / 文案键对称
npm run typecheck   # vue-tsc --noEmit
npm run build       # 生产构建必须成功
docker compose config -q   # 若改动 docker-compose.yml
```

下面几条是**仓库标准件**与**配置卫生**的机检，CI 会逐步执行；改了 README、治理文件、
`.github/`、`scripts/`、`.editorconfig`、`.gitattributes` 或哈希资产时请一并跑：

```bash
npm run verify:standards    # 45 项：文档 / 治理文件 / 工作流 / 脚本之间的交叉核对
npm run verify:hygiene      # 5 项：零命中规则、哈希资产保护、行尾口径
npm run verify:standards-selftest   # 判据自身的变异自检（106 个变异体必须全部被抓到）
npm run verify:all          # 本地快速一键（不构建、不跑变异自检）
npm run verify:ci           # 与 CI 逐条同集同序的一键（含构建、体积/许可判据与全部变异自检）
```

`verify:ci` 的步骤序列由 `S30` 断言与工作流**逐条对齐** —— 它存在的理由是：本地捷径
（`verify:all`）一旦落后于 CI，就会出现「本地全绿、CI 判红」，而那种红与工程缺陷无关，
纯属**捷径本身不完整**（R23 实测：`verify:all` 曾缺 `typecheck`、`verify:notices`、
`verify:size` 与全部自检电池）。

被判据挡下来时，先看它打印的失败原因，不要直接改判据：断言都锚在仓库自己声明的规范
或生态硬约束上，报红通常意味着**代码与文档已经不一致**。

改动 `pb_migrations/` 时，必须实测「空库重放」与「`down` 回退」；改动阈值或约束时，
必须附**边界两侧**的实测值（例如 200 通过 / 201 拒绝），不能只测中间值。

## 证据要求

评审会按下面四条检查每个修复，缺一即退回：

1. **成对对照**：同一条命令在修复前必须失败、修复后必须通过（给出两侧输出）。
2. **零样本不得判通过**：判据若一次样本都没执行，必须报「未执行」并非零退出。
3. **变异自检**：故意注入一个缺陷（或把断言反向），确认判据会变红 —— 证明它有判别力。
4. **断言读取真实来源**：判据要读被测代码/真实服务，不得在判据里复刻一遍实现。

## 不要写进仓库

真实采集数据（照片、视频、`pb_data/`）、凭据与令牌、公网 IP、个人本地绝对路径、
构建产物（`dist/`）、依赖目录（`node_modules/`）、本地化二进制本体（只入库指纹清单）。

## 报告问题

见 [`SECURITY.md`](SECURITY.md)（安全问题）与 Issue 模板（功能缺陷 / 需求）。
