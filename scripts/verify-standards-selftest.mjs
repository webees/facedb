#!/usr/bin/env node
// 仓库标准件判据的**变异自检**：证明 check-repo-standards.mjs 的每条断言真的能抓到对应的坏状态。
//
// 为什么必须有这一步：「判据自己写错了」和「仓库有问题」在输出上长得一模一样，
// 只有主动注入坏状态、确认该红的红、干净的绿，才能把两者分开。
//
// 做法：用 `git worktree` 拉一份干净副本到临时目录（软链 node_modules，
// 否则 S21 类型检查在副本里就会红，那时「变异体变红」和「副本本来就不行」分不清），
// 用 STD_ROOT 指向副本跑判据，逐个注入缺陷再恢复。
//
// 纪律：变异体若没生效（文本未变化）直接报错退出 —— 那说明测试自己坏了，不构成任何结论。
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(import.meta.dirname, '..')
const JUDGE = join(ROOT, 'scripts', 'check-repo-standards.mjs')
const WT = process.env.SELFTEST_ROOT || join(tmpdir(), 'facedb-standards-selftest-' + process.pid)

const say = (s) => console.log(s)

// 清理必须**可观测**、并且**被打断后能自愈**（R24-01 实测的三条事实）：
//   ① `git worktree remove` 的退出码以前被忽略 ⇒ 失败时静默留下注册条目（`git worktree list` 里多一条）；
//   ② 进程被 SIGINT/SIGTERM 打断时以前不清理 ⇒ 副本目录 + 注册条目双双留在主仓库里
//      （实测：kill -TERM 退出码 143、kill -INT 退出码 130，两种情形目录残留 1、注册残留 1）；
//   ③ 只靠 JS 信号处理器**不可靠**：本脚本大量时间阻塞在 spawnSync 里，Node 会把信号推迟到事件循环空转时才跑，
//      而脚本末尾的 process.exit() 会直接终止进程 ⇒ 处理器可能永远不执行（实测：注册处理器后 kill -TERM，
//      进程反而跑完全程、退出码 0、清理靠正常路径完成）。因此真正的兜底是**下次运行开局清扫历史残留**。
// 残留会让后续的 `git worktree list`／路径探测读到幽灵条目，也让 CI 机器累积临时副本。
let residue = false

// 本脚本在 tmpdir 下按 `facedb-standards-selftest-<pid>` 建副本；pid 不存活即视为历史残留。
const WT_PREFIX = 'facedb-standards-selftest-'
const pidAlive = (pid) => {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function sweepStale() {
  const listed = spawnSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout || ''
  const paths = listed.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim())
  const swept = []
  for (const p of paths) {
    const base = p.split('/').pop() || ''
    if (!base.startsWith(WT_PREFIX)) continue
    if (p === WT) continue
    const pid = Number(base.slice(WT_PREFIX.length))
    if (pidAlive(pid)) continue // 可能是另一个正在跑的实例，别动
    spawnSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', p], { encoding: 'utf8' })
    try { rmSync(p, { recursive: true, force: true }) } catch {}
    swept.push(base)
  }
  if (swept.length) say(`🧹 清扫历史残留副本 ${swept.length} 条：${swept.join('、')}`)
  return swept.length
}

function cleanup() {
  const rm = spawnSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', WT], { encoding: 'utf8' })
  try { rmSync(WT, { recursive: true, force: true }) } catch {}
  if (rm.status !== 0) spawnSync('git', ['-C', ROOT, 'worktree', 'prune'], { encoding: 'utf8' })
  const stillDir = existsSync(WT)
  const stillReg = (spawnSync('git', ['-C', ROOT, 'worktree', 'list'], { encoding: 'utf8' }).stdout || '').includes(WT)
  if (stillDir || stillReg) {
    residue = true
    console.error(`⚠️ 副本清理未完成：目录残留=${stillDir} 注册残留=${stillReg}（${WT}）`)
    console.error('   git worktree remove 输出：' + ((rm.stderr || '') + (rm.stdout || '')).trim().slice(0, 200))
  }
  return !(stillDir || stillReg)
}
sweepStale()
cleanup()
// 被 Ctrl-C / kill 打断时尽力清理。注意：**这不是兜底**（脚本大量时间阻塞在 spawnSync 里，
// Node 会把信号推迟到事件循环空转，而末尾的 process.exit 不等人 ⇒ 处理器可能永不执行，R24-01 实测）。
// 真正的兜底是下次运行开局的 sweepStale()。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanup()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  })
}

const add = spawnSync('git', ['-C', ROOT, 'worktree', 'add', '--detach', WT, 'HEAD'], { encoding: 'utf8' })
if (add.status !== 0) {
  console.error('❌ 无法创建 worktree 副本：' + (add.stderr || '').trim())
  process.exit(2)
}
try { unlinkSync(join(WT, 'node_modules')) } catch {}
symlinkSync(join(ROOT, 'node_modules'), join(WT, 'node_modules'))

// 副本取的是 HEAD 内容：本轮尚未提交的文件要从工作区拷进去，否则测的不是当前版本。
// 必须带 -uall：默认的 git status 会把「整目录未跟踪」折叠成 `?? scripts/lib/` 一行，
// 下面的拷贝循环读到目录就会 EISDIR 抛错（R21/W21-A 实测：新增 scripts/lib/ 后本脚本直接崩在拷贝阶段）。
const WORKTREE_STATE = spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '-uall'], { encoding: 'utf8' }).stdout
  .split('\n').filter(Boolean).map((l) => l.slice(3).trim())
for (const rel of WORKTREE_STATE) {
  const src = join(ROOT, rel)
  if (!existsSync(src)) continue
  const dst = join(WT, rel)
  mkdirSync(join(dst, '..'), { recursive: true })
  writeFileSync(dst, readFileSync(src))
}
say(`副本：${WT}（已软链 node_modules、同步 ${WORKTREE_STATE.length} 个未提交文件）`)

const ORIG = new Map()
const load = (rel) => {
  const abs = join(WT, rel)
  if (!ORIG.has(rel)) ORIG.set(rel, existsSync(abs) ? readFileSync(abs, 'utf8') : null)
}
const mutate = (rel, fn) => {
  const abs = join(WT, rel)
  const before = readFileSync(abs, 'utf8')
  const after = fn(before)
  if (after === before) throw new Error(`${rel} 的变异未生效 —— 测试自身坏了，本次不构成结论`)
  writeFileSync(abs, after)
}
const restore = (rel) => {
  const abs = join(WT, rel)
  if (ORIG.get(rel) === null) rmSync(abs, { force: true })
  else writeFileSync(abs, ORIG.get(rel))
}
const runJudge = () => {
  const r = spawnSync(process.execPath, [JUDGE], { env: { ...process.env, STD_ROOT: WT, CK_LOG: '' }, encoding: 'utf8', timeout: 600000 })
  return { code: r.status, out: r.stdout + r.stderr }
}

const M = [
  { id: 'M1', target: 'README.md', expect: 'S1', desc: 'README 链接指向不存在的文件',
    apply: () => mutate('README.md', (t) => t + '\n[死链](docs/NOT-A-REAL-FILE.md)\n') },
  { id: 'M2', target: 'README.md', expect: 'S2', desc: 'README 不再写出许可证名',
    apply: () => mutate('README.md', (t) => t.replace('**MIT** 许可证', '某个许可证')) },
  { id: 'M3', target: 'README.md', expect: 'S3', desc: '文档提到不存在的 npm script',
    apply: () => mutate('README.md', (t) => t + '\n```\nnpm run verify:nonexistent\n```\n') },
  { id: 'M4', target: 'SECURITY.md', expect: 'S5', desc: '去掉受支持版本表',
    apply: () => mutate('SECURITY.md', (t) => t.replace(/## 受支持版本[\s\S]*?(?=\n## )/, '')) },
  { id: 'M5', target: 'CHANGELOG.md', expect: 'S7', desc: '版本段日期不存在（2026-13-45）',
    apply: () => mutate('CHANGELOG.md', (t) => t + '\n## [9.9.9] - 2026-13-45\n\n### 修复\n\n- 假条目\n') },
  { id: 'M6', target: '.github/workflows/ci.yml', expect: 'S15', desc: 'CI 引用不存在的 npm script',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace('run: npm run verify\n', 'run: npm run verify:nope\n')) },
  { id: 'M7', target: '.github/workflows/ci.yml', expect: 'S15', desc: 'CI 用了过期 action 版本',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/actions\/checkout@v\d+/, 'actions/checkout@v2')) },
  { id: 'M8', target: '.github/CODEOWNERS', expect: 'S16', desc: 'CODEOWNERS 里写一条永不生效的模式',
    apply: () => mutate('.github/CODEOWNERS', (t) => t + '\n*.avif @webees\n') },
  { id: 'M9', target: '.github/ISSUE_TEMPLATE/bug_report.yml', expect: 'S11', desc: 'issue 表单 YAML 变成非法（值以反引号开头）',
    apply: () => mutate('.github/ISSUE_TEMPLATE/bug_report.yml', (t) => t.replace('      label: 浏览器与版本', '      label: `Chrome 154`')) },
  { id: 'M10', target: '.github/dependabot.yml', expect: 'S14', desc: 'dependabot 版本号写成 3',
    apply: () => mutate('.github/dependabot.yml', (t) => t.replace(/^version: 2$/m, 'version: 3')) },
  { id: 'M11', target: 'src/lib/hints.ts', expect: 'S20', desc: 'hints.ts 里出现没人用的死导出',
    apply: () => mutate('src/lib/hints.ts', (t) => t + '\nexport const HINT_NOBODY_USES = 42\n') },
  { id: 'M12', target: '.github/BRANCHING.md', expect: 'S24', desc: '往 .github/ 新加一个没人给它写检查的非 YAML 文件',
    apply: () => writeFileSync(join(WT, '.github/BRANCHING.md'), '# 分支约定\n\n（新增文件，尚无任何断言覆盖）\n') },
  { id: 'M12b', target: 'ARCHITECTURE.md', expect: 'S24', desc: '仓库根新加一个没人给它写检查的文档',
    apply: () => writeFileSync(join(WT, 'ARCHITECTURE.md'), '# 架构\n\n（新增根文档，尚无任何断言覆盖）\n') },
  { id: 'M13', target: 'RUN.md', expect: 'S23', desc: 'RUN.md 提到一个不存在的仓库内文件',
    apply: () => mutate('RUN.md', (t) => t + '\n参见 `src/lib/does-not-exist-at-all.ts`。\n') },
  { id: 'M15', target: '.github/workflows/deploy.yml', expect: 'S15', desc: '新增工作流里引用不存在的 npm script 且 action 版本过期（S22 只验可解析，S24 会误判有归属）',
    apply: () =>
      writeFileSync(
        join(WT, '.github/workflows/deploy.yml'),
        [
          'name: deploy',
          'on: { push: { branches: [main] } }',
          'permissions: { contents: read }',
          'jobs:',
          '  deploy:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v1',
          '      - run: npm run verify:nope',
          '',
        ].join('\n'),
      ) },
  // R20-F7：S25 守的是「第三方声明文件与分发链接线」。三种接线段各来一个变异体 ——
  // 光验「文件在」是不够的：文件在但构建不复制 = 分发物里没有它；判据没接进 CI = 没人跑。
  { id: 'M16', target: 'rsbuild.config.ts', expect: 'S25', desc: '构建不再把第三方声明复制进 dist（分发物里没有许可原文）',
    apply: () => mutate('rsbuild.config.ts', (t) => t.replace(/\s*copy: \[\{ from: 'THIRD-PARTY-NOTICES\.md'[^\]]*\],?/, '')) },
  { id: 'M16b', target: 'package.json', expect: 'S25', desc: 'npm script 里的第三方许可判据被摘掉（写了没人跑）',
    apply: () => mutate('package.json', (t) => t.replace(/\s*"verify:notices": "node scripts\/check-third-party-notices\.mjs",/, '')) },
  { id: 'M16c', target: '.github/workflows/ci.yml', expect: 'S25', desc: 'CI 不再跑第三方许可判据',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/\s*- name: 第三方许可随分发物提供[\s\S]*?run: npm run verify:notices\n/, '\n')) },
  // R21/W21-A：S26 守的是「产物体积与构成判据的接线」。两条接线段各来一个变异体 ——
  // 判据文件在、但没人跑（script 被摘 / CI 步骤被删）= 等于没写。
  { id: 'M17', target: 'package.json', expect: 'S26', desc: '体积判据的 npm script 被摘掉（写了没人跑）',
    apply: () => mutate('package.json', (t) => t.replace(/\s*"verify:size": "node scripts\/check-dist-size-budget\.mjs",/, '')) },
  { id: 'M18', target: '.github/workflows/ci.yml', expect: 'S26', desc: 'CI 里那一步体积判据被删（构建之后没人量产物）',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/\s*- name: 产物体积与构成判据[^\n]*\n\s*run: npm run verify:size\n/, '\n')) },
  // R22：S27 守的是「发布卫生闸门已接线且修复不许回退」。五个接线段各来一个变异体 ——
  // 旧版闸门的六类漏检全部来自「按扩展名当二进制跳过」，所以回退这类修复必须报红。
  { id: 'M19', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '闸门退回按扩展名白名单判二进制（.pem/.bak 里的凭据会被静默跳过）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace('const RULES = [', "const TEXT_EXT = ['.txt', '.md', '.js']\n\nconst RULES = [")) },
  { id: 'M20', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '阻断线默认退回 P0（公网 IP / Tailscale / 超管口令命中不再阻断）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace("process.env.LEAK_BLOCK_AT || 'P1'", "process.env.LEAK_BLOCK_AT || 'P0'")) },
  { id: 'M21', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '令牌前缀收窄（摘掉 sk-proj- 这类新式形态）',
    // 【R26 重锚】v3 把长随机体的字符类改成了允许换行（`[A-Za-z0-9_\n-]`）⇒ 旧锚点（写死 `_-`）失配、
    // 变异「未生效」。改为按行首前缀匹配，字符类怎么改都不影响命中（本轮第 6 次同族坑：锚点比目标脆）。
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace(/^  'sk-proj-\[[^\n]*\n/m, '')) },
  { id: 'M22', target: 'package.json', expect: 'S27', desc: '闸门的变异自检 npm script 被摘掉（写了没人跑）',
    apply: () => mutate('package.json', (t) => t.replace(/\s*"verify:publish-selftest": "node scripts\/publish-leak-scan-selftest\.mjs",/, '')) },
  { id: 'M23', target: '.github/workflows/ci.yml', expect: 'S27', desc: 'CI 里那一步发布卫生闸门被删（PUBLIC 仓库推送前没人扫）',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/\s*- name: 发布卫生闸门[^\n]*\n\s*run: npm run verify:publish\n/, '\n')) },
  { id: 'M24', target: '.github/workflows/ci.yml', expect: 'S28', desc: 'CI 里那一步仓库判据自检被删（判据的判别力在 CI 里没人守）',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/\s*- name: 仓库判据的变异自检[^\n]*\n\s*run: npm run verify:selfcheck\n/, '\n')) },
  { id: 'M25', target: 'scripts/verify-repo.mjs', expect: 'S28', desc: 'img-src 取值断言被摘（退回「img-src 这个词存在即通过」）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => t.replace(/const imgLoose = [^\n]*\n/, '')) },
  // 【R22-21】CI 上真实发生过的两条：判据的绿/红取决于文件系统大小写。
  { id: 'M26', target: '.github/PULL_REQUEST_TEMPLATE.md', expect: 'S27', desc: 'PR 模板被删（判据必须说「已跟踪但工作区缺失」，而不是静默读空串后放行）',
    apply: () => { rmSync(join(WT, '.github/PULL_REQUEST_TEMPLATE.md'), { force: true }) } },
  { id: 'M27', target: 'scripts/check-repo-standards.mjs', expect: 'S29', desc: '判据里新增一个大小写写错的读取点（macOS 上解析得到、Linux 上 ENOENT）',
    apply: () => mutate('scripts/check-repo-standards.mjs', (t) => t + "\nconst _r22caseProbe = () => has('.github/issue_template/bug_report.yml')\n") },
  // 【R23-LEAD-05】本地一键与 CI 步骤对齐：M28–M31 分别打「本地少一步」「CI 多一步」
  // 「顺序错（构建跑到依赖 dist 的判据之后）」「本地凭空多一步」四种坏状态。
  { id: 'M28', target: 'package.json', expect: 'S30', desc: 'verify:ci 少了一步 CI 真在跑的判据（本地一键静默不完整）',
    apply: () => mutate('package.json', (t) => t.replace(' && npm run verify:notices &&', ' &&')) },
  { id: 'M29', target: '.github/workflows/ci.yml', expect: 'S30', desc: 'CI 里新增一个 verify:ci 没有的 npm 步骤（本地一键与 CI 分叉）',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t + '\n      - name: 探针步骤（M29）\n        run: npm run preview\n') },
  { id: 'M30', target: 'package.json', expect: 'S30', desc: 'verify:ci 里构建与体积判据的顺序被调换（体积判据会判未判定）',
    apply: () => mutate('package.json', (t) => t.replace('npm run build && npm run verify:size', 'npm run verify:size && npm run build')) },
  { id: 'M31', target: 'package.json', expect: 'S30', desc: 'verify:all 里塞进一个 CI 侧不存在的步骤（本地捷径凭空长出步骤）',
    apply: () => mutate('package.json', (t) => t.replace(/"verify:all": "[^"]*"/, (s) => s.slice(0, -1) + ' && npm run preview"')) },
  // 【R23REV-N1/N2】S30 的两条盲区：`if: false` 让「同集同序」在 CI 永不执行时恒真；
  // block scalar 形式的 `run:` 让步骤凭空消失、反向误报「本地多了 CI 不跑的步骤」。
  { id: 'M32', target: '.github/workflows/ci.yml', expect: 'S30', desc: '给承载 npm run 的步骤加 `if: false`（CI 永不执行它，S30 不许判绿）',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/^(\s*)run: npm run verify:publish\s*$/m, '$1if: false\n$1run: npm run verify:publish')) },
  // 这一条是**阴性对照型**变异体（staysGreen）：改法合法（YAML 语义等价），S30 不许因此报红。
  // R23REV-N2 实测的旧行为是把它误报成「verify:ci 多了 CI 不跑的步骤」——那正是本变异体要守住的反例。
  { id: 'M33', target: '.github/workflows/ci.yml', expect: 'S30', staysGreen: true, desc: '把步骤的 `run:` 改成 block scalar —— 语义等价，S30 不许误报（R23REV-N2）',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/^(\s*)run: npm run verify:notices\s*$/m, '$1run: |\n$1  npm run verify:notices')) },
  { id: 'M34', target: '.github/workflows/ci.yml', expect: 'S30', desc: '给整个 job 加 `if: false`（整个 job 的步骤都不再执行）',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/^(\s*runs-on: ubuntu-latest\s*)$/m, '    if: false\n$1')) },
  // 【R23 第四次重锚（PR #27 的 CI 抓到）】体积判据的「dist 与源码同源」前提：摘掉它就会退回
  // 「本地用陈旧 dist 重锚 ⇒ 本地 16/16 全绿、CI 一跑就红」。M35/M36 分别打前提块与它的变异体。
  { id: 'M35', target: 'scripts/check-dist-size-budget.mjs', expect: 'S26', desc: '摘掉「dist 与源码同源」（SOURCE_FINGERPRINT）前提块',
    apply: () => mutate('scripts/check-dist-size-budget.mjs', (t) => t.replace(/const SOURCE_FINGERPRINT = '(?:[a-f0-9]{64}|PLACEHOLDER_SOURCE_FINGERPRINT)'/, 'const SOURCE_FINGERPRINT_OFF = 1')) },
  { id: 'M36', target: 'scripts/check-dist-size-budget-mutants.mjs', expect: 'S26', desc: '摘掉源码同源前提的阴性对照变异体 m8a（只留 m8b 无法排除「复制本身触发」）',
    apply: () => mutate('scripts/check-dist-size-budget-mutants.mjs', (t) => t.replace("id: 'm8a-src-copied-control'", "id: 'm8x-removed-control'")) },
  // R24-01：自检自己的副本清理（S31）
  { id: 'M37', target: 'scripts/verify-standards-selftest.mjs', expect: 'S31', desc: '拿掉开局清扫历史残留（被中断后留下的副本再也没人清）',
    apply: () => mutate('scripts/verify-standards-selftest.mjs', (t) => t.replace('sweepStale()\ncleanup()', 'cleanup()')) },
  { id: 'M38', target: 'scripts/verify-standards-selftest.mjs', expect: 'S31', desc: '清理结果不再进判定（残留也能报通过）',
    // 必须**行锚定**替换：裸字符串替换会先命中本变异体自己的定义行（S31 旧版正是因此被自匹配骗过）。
    apply: () => mutate('scripts/verify-standards-selftest.mjs', (t) => t.replace(/^const cleanOk = cleanup\(\)$/m, 'cleanup()\nconst cleanOk = true')) },
  // R24 / W24-E：判据的运行落点与采样并发安全（S32）
  { id: 'M39', target: 'scripts/verify-repo.mjs', expect: 'S32', desc: '自检副本退回仓库内固定路径（并发互删、崩溃留残留）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => t.replace("mkdtempSync(join(tmpdir(), 'facedb-verify-selfcheck-'))", "join(ROOT, '.verify-selfcheck')")) },
  { id: 'M40', target: 'scripts/check-third-party-notices-mutants.mjs', expect: 'S32', desc: '许可变异自检退回硬编码 /tmp 落点（并发互删致崩溃）',
    apply: () => mutate('scripts/check-third-party-notices-mutants.mjs', (t) => t.replace("mkdtempSync(path.join(tmpdir(), 'facedb-notices-mutants-'))", "'/tmp/r20-f7-notices-mutants'")) },
  { id: 'M41', target: 'scripts/check-dist-size-budget.mjs', expect: 'S32', desc: '摘掉体积判据的一次采样自洽守卫（读数自相矛盾也能报通过）',
    // 【R24 复核席修正】锚点必须**全局**替换：该短语在文件里出现 3 次（1 处注释 + check/un 两个分支），
    // 裸 `String.replace` 只改第一处（注释）⇒ M41 不再命中、自检恒 43/44、verify:selfcheck 永久红。
    apply: () => mutate('scripts/check-dist-size-budget.mjs', (t) => t.replaceAll('一次采样自洽（快照期间产物未被改动）', '未使用的占位前提')) },
  { id: 'M42', target: 'scripts/verify-repo.mjs', expect: 'S32', desc: 'scanFile 退回直接读盘（与 checkCsp 读到两个版本 ⇒ 撕裂读）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => t.replace('const src = readStable(p)', "const src = readFileSync(p, 'utf8')")) },
  // 【R24 复核席 P3】S31 原先还有两处「文本在位即通过」：注释掉存活判定、反转前缀过滤都保持绿。
  // 断言已改行锚定正则（`^    if \(pidAlive\(pid\)\) continue/m` 等），这两个变异体就是它的判别力证明。
  { id: 'M43', target: 'scripts/verify-standards-selftest.mjs', expect: 'S31', desc: '注释掉清扫的存活判定（会误删并发实例的副本）',
    apply: () => mutate('scripts/verify-standards-selftest.mjs', (t) => t.replace(/^(    if \(pidAlive\(pid\)\) continue)/m, '    // $1')) },
  { id: 'M44', target: 'scripts/verify-standards-selftest.mjs', expect: 'S31', desc: '反转副本前缀过滤（只清扫不该扫的、放过真残留）',
    apply: () => mutate('scripts/verify-standards-selftest.mjs', (t) => t.replace(/^    if \(!base\.startsWith\(WT_PREFIX\)\) continue$/m, '    if (base.startsWith(WT_PREFIX)) continue')) },
  // 【R25 / W25E-01（P1）】发布卫生闸门的二进制旁路：旧形态「前 8KB 有 NUL 就整份跳过」会放行含凭据的文件。
  // 三个变异体分别打「解码方式」「适用规则集」「报告口径」—— 少任何一条都会让修复被静默回退或让读数误导读者。
  { id: 'M45', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '二进制内容退回整份跳过（W25E-01：含 ghp_ 的文件 exit 0 放行）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace(
      "  const isBinary = buf.subarray(0, 8192).includes(0)\n",
      "  const isBinary = buf.subarray(0, 8192).includes(0)\n  if (isBinary) {\n    skippedBinary++\n    continue\n  }\n")) },
  { id: 'M46', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '摘掉 BINARY_RULES 适用集（二进制会退回跑全部规则或全部不跑）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace('const BINARY_RULES = new Set(', 'const UNUSED_BINARY_RULES = new Set(')) },
  { id: 'M47', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '扫描面报告不再写明「二进制已扫凭据类规则」（读者会把干净误读成全规则扫过）',
    // 该短语在文件里出现 2 次（1 处说明注释 + 1 处报告行）⇒ 锚点必须带 `binaryScanned +` 才能唯一命中报告行。
    // 裸字符串替换会改中注释、报告行照旧，变异体于是「未生效」（本轮第 5 次同族坑：断言/变异被注释满足）。
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace(/binaryScanned \+ ' 个（凭据类规则照扫；定位类规则只在真实解码视图上跑，逐字节 latin1 视图不跑）/, "binaryScanned + ' 个'")) },

  // 【R25 / W25E-02（P2）】配置卫生判据的空真命题：样本为 0 时四条断言各自退化成 ✅（`零命中 0 条均已标注`、
  // `0 项全部一致`），整体 `通过 5，失败 0`、exit 0；且退出码只有 `fail === 0 ? 0 : 1`，表达不了「没构成结论」。
  // 三个变异体分别打「零样本分支」「退出码三态」「自检接线」—— 少任何一条都会让修复被静默回退。
  { id: 'M48', target: 'scripts/check-repo-config-hygiene.mjs', expect: 'S33', desc: 'A3 摘掉「文本类 0 个 ⇒ 未判定」分支（空样本退回空真命题 ✅）',
    // 锚点必须带 `else if (` 前缀：裸 `textish.length === 0` 在别处也出现（注释里），裸替换会改中注释、分支照旧。
    apply: () => mutate('scripts/check-repo-config-hygiene.mjs', (t) => t.replace(/else if \(textish\.length === 0\) unk\('A3/, "else if (false) unk('A3")) },
  { id: 'M49', target: 'scripts/check-repo-config-hygiene.mjs', expect: 'S33', desc: '退出码退回两态（fail === 0 ? 0 : 1），未判定无法表达',
    apply: () => mutate('scripts/check-repo-config-hygiene.mjs', (t) => t.replace('process.exit(fail > 0 ? 1 : un > 0 ? 2 : 0)', 'process.exit(fail === 0 ? 0 : 1)')) },
  { id: 'M50', target: 'package.json', expect: 'S33', desc: '摘掉 verify:hygiene-selftest 接线（自检从此不进 CI）',
    apply: () => mutate('package.json', (t) => t.replace('    "verify:hygiene-selftest": "node scripts/check-repo-config-hygiene-selftest.mjs",\n', '')) },
  // ── R25：本判据自己的两条空真命题守卫（W25E-03/04）─────────────────────
  // 这两条的变异体只能锚**源码断言**（S33）：S1 的样本来自 README、S24 的样本来自磁盘枚举，
  // 单文件变异造不出「样本为 0」的现场；而守卫一旦被摘掉，零样本就会退回 ✅ 空真命题。
  { id: 'M51', target: 'scripts/check-repo-standards.mjs', expect: 'S33', desc: '摘掉 S1 的「README 里 0 个相对链接 ⇒ 不得判通过」守卫',
    apply: () => mutate('scripts/check-repo-standards.mjs', (t) => t.replace(/^  if \(links\.length === 0\) return \{ ok: false, detail: 'README 里没有任何相对链接[^\n]*\n/m, '')) },
  { id: 'M52', target: 'scripts/check-repo-standards.mjs', expect: 'S33', desc: '摘掉 S24 的「受管来源为空 ⇒ 不得判通过」守卫',
    apply: () => mutate('scripts/check-repo-standards.mjs', (t) => t.replace(/^  if \(emptySources\.length\) \{\n(?:.*\n)*?  \}\n/m, '')) },
  // 【R25-INCIDENT-02】类型检查判据的可执行文件真实性前提：摘掉它，「vue-tsc 被换成桩」就会
  // 退化成「无判别力」一条含糊结论（甚至被误读成仓库有类型错误）。
  { id: 'M53', target: 'scripts/typecheck-guard.mjs', expect: 'S34', desc: '摘掉「可执行文件被桩替换」整支静态判据',
    apply: () => mutate('scripts/typecheck-guard.mjs', (t) => t.replace(/  const head = st && st\.isFile\(\) \? readFileSync\(vueTscBin, 'utf8'\)\.slice\(0, 400\) : ''\n  const isJs = [^\n]*\n  const shellish = [^\n]*\n  if \(!st \|\| !st\.isFile\(\)[^\n]*\{\n(?:.*\n)*?  \}\n/m, '  const head = \'\'\n  const isJs = true\n  const shellish = false\n')) },
  { id: 'M54', target: 'scripts/typecheck-guard.mjs', expect: 'S34', desc: '摘掉 `vue-tsc --version` 行为前提（只留静态判据）',
    apply: () => mutate('scripts/typecheck-guard.mjs', (t) => t.replace(/  const v = spawnSync\('npx', \['vue-tsc', '--version'\][^\n]*\n(?:.*\n)*?    process\.exit\(2\)\n  \}\n/m, '')) },
  { id: 'M55', target: 'scripts/typecheck-guard.mjs', expect: 'S34', desc: '摘掉 TCG_ROOT 覆盖通道（自检电池无法造桩现场）',
    apply: () => mutate('scripts/typecheck-guard.mjs', (t) => t.replace('process.env.TCG_ROOT || ', '')) },
  { id: 'M56', target: 'scripts/typecheck-guard-selftest.mjs', expect: 'S34', desc: '把整个 node_modules 软链过去（桩会写穿到真仓库）',
    apply: () => mutate('scripts/typecheck-guard-selftest.mjs', (t) => t.replace(/  for \(const name of readdirSync\(NODE_MODULES\)\) \{\n(?:.*\n)*?  \}\n  \/\/ 只有 vue-tsc 是实体拷贝[^\n]*\n  cpSync\([^\n]*\n/m, "  symlinkSync(NODE_MODULES, path.join(nm, 'node_modules'), 'dir')\n")) },
  // R25 / W25E-05：两条都打「迁移语法检查把环境问题记成迁移缺陷」的修复（S35 的判别力）。
  { id: 'M57', target: 'scripts/verify-repo.mjs', expect: 'S35', desc: '摘掉 Invalid package config 分类（环境问题重新变成「迁移语法错误」）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => t.replace(/      if \(\/Invalid package config\/i\.test\(err\)\) \{ envBad\+\+; envMsg = err\.split\('\\n'\)\[0\]; continue \}\n/, '')) },
  { id: 'M58', target: 'scripts/verify-repo.mjs', expect: 'S35', desc: 'M29 摘掉 expectAbsent 反向断言（多出来的假红不再被看见）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => t.replace(/, expectAbsent: \['全部迁移可被 node 解析'\]/, '')) },
  // R25 收口发现（P2）：阴性对照的基线锚在 HEAD ⇒ 修复提交一落地对照就崩塌（R14 / R21 / R25 三次同型）；
  // 收口期 PR #29 又实测出「现取 git 历史」在浅克隆下取不到 ⇒ 改为读冻结快照。
  { id: 'M59', target: 'scripts/check-repo-config-hygiene-selftest.mjs', expect: 'S33', desc: '阴性对照的基线退回「用修复后的判据自己当基线」（对照恒真）',
    apply: () => mutate('scripts/check-repo-config-hygiene-selftest.mjs', (t) => t.replace(
      /path\.join\(HERE, 'fixtures', 'check-repo-config-hygiene\.prefix-v1\.mjs'\)/,
      "path.join(HERE, 'check-repo-config-hygiene.mjs')")) },
  { id: 'M60', target: 'scripts/check-repo-config-hygiene-selftest.mjs', expect: 'S33', desc: '退出码退回两态（跳过项被当成通过）',
    apply: () => mutate('scripts/check-repo-config-hygiene-selftest.mjs', (t) => t.replace(
      /process\.exit\(fail > 0 \? 1 : skipped > 0 \? 2 : 0\)/,
      'process.exit(fail === 0 ? 0 : 1)')) },
  // R25REV-N1（P2）/ R26 v3（P1）：UTF-16 解码视图被摘掉 ⇒ UTF-16 保存的凭据文件整类漏检。
  // 【R26 重锚】v2 的「单条 utf16le 视图」已被 v3 的「LE/BE × 对齐」循环取代 ⇒ 改打那个循环。
  { id: 'M61', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '只试一种字节对齐（奇数长度前缀让整段 UTF-16 视图错位漏检）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace('      for (const off of [0, 1]) {', '      for (const off of [0]) {')) },
  // 【R26 / W26-E 的 B 族】这两个变异体只摘**机制**、不动任何被断言的字面量：
  // 结构断言照样全绿（函数在、门控在、报告行在），只有 S27 末尾那条**行为探针**会红。
  // 它们就是「文本在位即通过」这条缺口的判别力证明 —— 没有行为探针，这一对根本抓不到。
  { id: 'M72', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: 'UTF-16 视图整块不再生成（结构断言全绿，只有行为探针能抓到）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace('  if (hasNul) {', '  if (false) {')) },
  { id: 'M73', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '压缩内容解出后不再复扫（拿掉递归那一步；结构断言全绿）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace('      for (const v of viewsFor(Buffer.from(a.text, \'utf8\'), depth + 1).views) {', '      for (const v of []) {')) },
  // R25REV-N2（P3）：A5 退回「无条件 ck + 另记一条 ⚠️」⇒ 零样本时同一断言行 ✅/⚠️ 并存，通过计数被垫高。
  { id: 'M62', target: 'scripts/check-repo-config-hygiene.mjs', expect: 'S33', desc: 'A5 退回无条件 ck（零样本时 ✅ 与 ⚠️ 并存）',
    apply: () => mutate('scripts/check-repo-config-hygiene.mjs', (t) => t.replace(
      /\} else \{\n  ck\('public\/SHA256SUMS 登记的每项都与磁盘一致'[\s\S]*?\n\}/,
      "}\nck('public/SHA256SUMS 登记的每项都与磁盘一致', mismatch.length === 0, `${sums.length} 项`)")) },
  // R25 收口期 PR #29 首跑实测：CI 是浅克隆（fetch-depth 1），`git show <ref>:` 取不到历史提交 ⇒
  // 阴性对照被跳过、自检 exit 2。此后基线改成 `scripts/fixtures/` 下的冻结快照。这两条守住回退：
  // M63 = 电池退回「现取 git 历史」；M64 = 冻结快照被更新成修复版（对照变成两侧都成立）。
  { id: 'M63', target: 'scripts/check-repo-config-hygiene-selftest.mjs', expect: 'S33', desc: '阴性对照退回「现取 git 历史」（浅克隆下取不到 ⇒ 对照被跳过）',
    apply: () => mutate('scripts/check-repo-config-hygiene-selftest.mjs', (t) => t.replace(
      /process\.env\.HYG_BASELINE \|\| path\.join\(HERE, 'fixtures', 'check-repo-config-hygiene\.prefix-v1\.mjs'\)/,
      "process.env.HYG_BASE_REF || 'a5514c3'")) },
  { id: 'M64', target: 'scripts/fixtures/check-repo-config-hygiene.prefix-v1.mjs', expect: 'S33', desc: '冻结快照被更新成修复版（阴性对照变成「两侧都成立」的恒真）',
    apply: () => mutate('scripts/fixtures/check-repo-config-hygiene.prefix-v1.mjs', (t) => t + '\nconst trackedOk = true\n') },
  // R26 / W26E-01…E-09（P1/P2）：发布闸门 v2 只扫**一种**解读（只加了一个 UTF-16LE 视图，还要求前 8KB 的
  // NUL 密度够高、按字节 0 对齐、不解压）⇒ 十三类真实漏检形态（电池 m19–m31 是行为侧的证据）。
  // 下面这些变异体打 v3 的每一块机制：少任何一块，对应的漏检形态就会静默回来。
  { id: 'M65', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '主循环不走多解读视图（退回「只扫一种解读」的 v2 形态）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace(
      'const { views, archiveError } = viewsFor(buf)',
      'const { views, archiveError } = { views: viewsFor(buf).views, archiveError: undefined } // M65')) },
  { id: 'M66', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '规则适用面不再按视图判（逐字节视图也跑定位类规则 / 真实解码视图被整片跳过）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace(
      /if \(isBinary && !view\.decoded && !BINARY_RULES\.has\(r\.id\)\) continue/,
      'if (!view.textual && !BINARY_RULES.has(r.id)) continue // M66')) },
  { id: 'M67', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '压缩内容解不开时不再判未判定（读不到被记成干净）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace(/按魔数识别为压缩内容但解不开/g, '压缩内容')) },
  { id: 'M68', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '归一化不做 NFKC（全角同形令牌漏检）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace("normalize('NFKC')", "normalize('NFC')")) },
  { id: 'M69', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: '手写 UTF-16BE 解码被摘掉（Buffer 不认 utf16be ⇒ 整类漏检或闸门崩溃）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace('function decodeUtf16be(', 'function decodeUtf16beLegacy(')) },
  { id: 'M70', target: 'scripts/publish-leak-scan-selftest.mjs', expect: 'S27', desc: '电池丢掉一个 v3 行为场景（机制有结构断言但行为无证据）',
    apply: () => mutate('scripts/publish-leak-scan-selftest.mjs', (t) => t.replace("    name: 'm26 ", "    name: 'z26 ")) },
  { id: 'M71', target: 'scripts/publish-leak-scan-selftest.mjs', expect: 'S27', desc: '电池汇总行写死场景数（加场景后说过期的话，而它是 CI 的读数来源）',
    apply: () => mutate('scripts/publish-leak-scan-selftest.mjs', (t) => t.replace('const positives = CASES.filter', 'const positives = 31 || CASES.filter')) },
  // 【R26 / W26E-17…E-18】S28 原先只验变异体的**声明行**在不在 ⇒ 原子被掏空 / 改错文件照样 [OK]。
  // 两个变异体分别打「原子不再改那个文件」与「改了别的文件」，都由 S28 新增的逐原子断言抓住。
  { id: 'M74', target: 'scripts/verify-repo.mjs', expect: 'S28', desc: 'M12 原子改错文件（往别的文件注入，等于没造出 img-src 全开的缺陷）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => {
      const i = t.indexOf("name: 'M12 ")
      const j = t.indexOf("name: 'M13 ")
      if (i < 0 || j < 0) return t
      return t.slice(0, i) + t.slice(i, j).replace("put('index.html'", "put('README.md'") + t.slice(j)
    }) },
  { id: 'M75', target: 'scripts/verify-repo.mjs', expect: 'S28', desc: 'M15 原子改错文件（跨源 url() 注入到别的样式文件，前提锁看不到）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => t.replace("put('src/style.css'", "put('src/style2.css'")) },
  { id: 'M76', target: 'scripts/typecheck-guard.mjs', expect: 'S34', desc: '入口解析失败回归「静默跳过」（删掉一个 package.json 就让真实性护栏整段消失）',
    apply: () => mutate('scripts/typecheck-guard.mjs', (t) => t.replace(/\n\} else \{\n[\s\S]*?process\.exit\(2\)\n\}\n/, '\n}\n')) },
  { id: 'M77', target: 'scripts/typecheck-guard-selftest.mjs', expect: 'S34', desc: '电池丢掉「入口读不到 ⇒ 判无法验证」这一场景（机制在、行为无证据）',
    apply: () => mutate('scripts/typecheck-guard-selftest.mjs', (t) => t.replace(/s6 入口读不到/gi, 's6 入口场景')) },
  { id: 'M78', target: 'scripts/verify-repo.mjs', expect: 'S35', desc: 'notExecuted 不再把「样本为 0」计入 undetermined（调用点字面量还在，机制被掏空）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => t.replace('  if (byDesign) skippedByDesign++\n  else undetermined++', '  if (byDesign) skippedByDesign++')) },
  { id: 'M79', target: 'scripts/verify-repo.mjs', expect: 'S35', desc: '摘掉「有样本为 0 的未执行项 ⇒ 不构成通过」的判定分支（**锚点非唯一**：该串在文件里有两处，必须全局替换，否则只改第一处、S35 照样绿 —— R24REV-N3 同族）',
    apply: () => mutate('scripts/verify-repo.mjs', (t) => t.replace(/if \(undetermined > 0\) \{/g, 'if (false) {')) },
  { id: 'M80', target: 'scripts/publish-leak-scan.mjs', expect: 'S27', desc: 'zip 不再校验压缩方法（method=99 AES 的载荷被 raw inflate 解出即当「已扫描且干净」）',
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace("      if (method !== 0 && method !== 8) throw new Error(`zip 条目用了未支持的压缩方法 ${method}（可能是加密/AES）`)\n", '')) },
  { id: 'M81', target: 'scripts/check-repo-standards.mjs', expect: 'S27', desc: '行为探针退回「第一行含 BEARER 的文本 + 命中数」（两端都能被一行普通日志欺骗）',
    apply: () => mutate('scripts/check-repo-standards.mjs', (t) => t.replace("const bearerLine = (out.match(/^\\s*[✅❌] P\\d BEARER\\s.*?命中 (\\d+) 处.*$/m) || [])[0] || ''", "const bearerLine = out.split('\\n').find((l) => l.includes('BEARER')) || ''")) },
]

let caught = 0
say('')
for (const m of M) {
  load(m.target)
  try { m.apply() } catch (e) {
    say(`❌ ${m.id} 变异体未生效：${e.message}`)
    restore(m.target)
    continue
  }
  const r = runJudge()
  const hit = r.out.split('\n').filter((l) => l.startsWith('[FAIL]') && l.includes(m.expect)).map((l) => l.trim().slice(0, 120))
  // staysGreen：改法语义等价（或刻意不改坏），该断言**不许报红**；其余变异体必须报红。
  const ok = m.staysGreen ? r.code === 0 && hit.length === 0 : r.code === 1 && hit.length > 0
  say(`${ok ? '✅' : '❌'} ${m.id} 期望 ${m.expect} ${m.staysGreen ? '不报红（阴性对照型）' : '命中'}：${m.desc}`)
  say(`     exit=${r.code} ${hit.join(' ｜ ') || (m.staysGreen ? '（正确地没报红）' : '（该断言没报红）')}`)
  if (ok) caught++
  restore(m.target)
}

const neg = runJudge()
const tail = (neg.out.split('\n').find((l) => /^通过 \d+，失败 \d+/.test(l)) || '').trim()
say('')
say(`阴性对照（未变异的副本）：exit=${neg.code} ${tail}`)
if (neg.code !== 0) say(neg.out.split('\n').filter((l) => l.startsWith('[FAIL]')).join('\n'))

const cleanOk = cleanup()
const ok = caught === M.length && neg.code === 0 && cleanOk
say(ok
  ? `✅ 变异自检 ${caught}/${M.length} 全部命中，且阴性对照绿，副本已清理`
  : `❌ 变异自检 ${caught}/${M.length}，阴性对照 exit=${neg.code}${cleanOk ? '' : '，副本清理未完成（见上）'}`)
process.exit(ok ? 0 : 1)
