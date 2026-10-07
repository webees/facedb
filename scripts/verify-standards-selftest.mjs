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

function cleanup() {
  spawnSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', WT], { encoding: 'utf8' })
  rmSync(WT, { recursive: true, force: true })
}
cleanup()
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
    apply: () => mutate('scripts/publish-leak-scan.mjs', (t) => t.replace("  'sk-proj-[A-Za-z0-9_-]{20,}',\n", '')) },
  { id: 'M22', target: 'package.json', expect: 'S27', desc: '闸门的变异自检 npm script 被摘掉（写了没人跑）',
    apply: () => mutate('package.json', (t) => t.replace(/\s*"verify:publish-selftest": "node scripts\/publish-leak-scan-selftest\.mjs",/, '')) },
  { id: 'M23', target: '.github/workflows/ci.yml', expect: 'S27', desc: 'CI 里那一步发布卫生闸门被删（PUBLIC 仓库推送前没人扫）',
    apply: () => mutate('.github/workflows/ci.yml', (t) => t.replace(/\s*- name: 发布卫生闸门[^\n]*\n\s*run: npm run verify:publish\n/, '\n')) },
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
  const ok = r.code === 1 && hit.length > 0
  say(`${ok ? '✅' : '❌'} ${m.id} 期望 ${m.expect} 命中：${m.desc}`)
  say(`     exit=${r.code} ${hit.join(' ｜ ') || '（该断言没报红）'}`)
  if (ok) caught++
  restore(m.target)
}

const neg = runJudge()
const tail = (neg.out.split('\n').find((l) => /^通过 \d+，失败 \d+/.test(l)) || '').trim()
say('')
say(`阴性对照（未变异的副本）：exit=${neg.code} ${tail}`)
if (neg.code !== 0) say(neg.out.split('\n').filter((l) => l.startsWith('[FAIL]')).join('\n'))

cleanup()
const ok = caught === M.length && neg.code === 0
say(ok ? `✅ 变异自检 ${caught}/${M.length} 全部命中，且阴性对照绿` : `❌ 变异自检 ${caught}/${M.length}，阴性对照 exit=${neg.code}`)
process.exit(ok ? 0 : 1)
