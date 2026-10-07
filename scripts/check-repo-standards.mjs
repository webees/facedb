// R15：把运行根的判据 check-repo-standards.mjs（S1–S24）移植成**仓库内**脚本。
//
// 移植时必做三处适配（不照抄）：
//  1. 根目录改为「脚本自身位置的上两级」，并支持 STD_ROOT 覆盖（变异自检要用副本）。
//  2. S20（hints.ts 死导出）原先搜索范围含运行根 `RUN/lib/*.mjs`；仓库里没有运行根 →
//     搜 src/ 与 scripts/ 下所有模块，规则不变（必须被真的 import 过）。
//  3. S23 原先 spawn 运行根的 check-runmd-doc.mjs（D0–D19）→ 仓库内改为可独立机检的等价物：
//     RUN.md 里提到的每个文件路径必须真实存在（这是 D0–D19 里与「文档与源码一致」最相关、
//     且不依赖运行根的那部分；其余文本口径检查留在运行根）。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.STD_ROOT ? path.resolve(process.env.STD_ROOT) : path.resolve(HERE, '..')
const R = (rel) => path.join(ROOT, rel)
const read = (rel) => readFileSync(R(rel), 'utf8')
const has = (rel) => existsSync(R(rel))
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts })
const tracked = sh('git', ['ls-files']).stdout.split('\n').filter(Boolean)
const lines = []
let pass = 0
let fail = 0
const log = (s) => lines.push(s)
const ck = (name, ok, detail = '') => {
  if (ok) pass++
  else fail++
  log(`${ok ? '[OK]  ' : '[FAIL]'} ${name} | ${detail}`)
}
function add(c) { CHECKS.push(c) }
const CHECKS = []

// ── S1 README 链接可达 ────────────────────────────────────────────────────
add({ id: 'S1', covers: ['README.md'], name: 'README 的相对链接都指向真实存在的文件', run() {
  const t = read('README.md')
  const links = [...t.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:|#)/.test(u))
  const dead = links.filter((u) => { const p = u.split('#')[0]; return p && !has(p) })
  return { ok: dead.length === 0, detail: dead.length ? '死链：' + dead.join('、') : `${links.length} 个相对链接全部可达` }
} })

// ── S2 README 有快速开始与许可段 ─────────────────────────────────────────
add({ id: 'S2', covers: ['README.md'], name: 'README 有快速开始与许可段，且写出许可证名', run() {
  const t = read('README.md')
  const q = /(快速开始|快速上手|Quick ?Start|快速启动)/i.test(t)
  const lic = /##\s*许可|##\s*License/i.test(t)
  const mit = /\bMIT\b/.test(t)
  const miss = []
  if (!q) miss.push('缺快速开始段')
  if (!lic) miss.push('缺许可段')
  if (!mit) miss.push('未写出许可证名 MIT')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '快速开始段、许可段、MIT 均在' }
} })

// ── S3 文档提到的 npm script 都存在 ─────────────────────────────────────
add({ id: 'S3', covers: ['.github/PULL_REQUEST_TEMPLATE.md', 'CONTRIBUTING.md', 'README.md'], name: '文档里提到的 npm script 都真实存在', run() {
  const pkg = JSON.parse(read('package.json'))
  const scripts = Object.keys(pkg.scripts || {})
  const docs = ['README.md', 'CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md'].filter(has)
  const bad = []
  for (const d of docs) for (const m of read(d).matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) if (!scripts.includes(m[1])) bad.push(`${d}: ${m[1]}`)
  const seen = docs.reduce((n, d) => n + (read(d).match(/npm run [a-zA-Z0-9:_-]+/g) || []).length, 0)
  if (seen === 0) return { ok: false, detail: '没有任何 npm run 样本 —— 覆盖面不完整，不得判通过' }
  return { ok: bad.length === 0, detail: bad.length ? '不存在的 script：' + bad.join('；') : `${seen} 处引用全部存在` }
} })

// ── S4 CONTRIBUTING 提交规范与 PR 流程 ──────────────────────────────────
add({ id: 'S4', covers: ['CONTRIBUTING.md'], name: 'CONTRIBUTING 有提交信息规范与 PR 流程，链接可达', run() {
  const t = read('CONTRIBUTING.md')
  const conv = /<type>\(<scope>\)|feat\(|fix\(|chore\(|docs\(|audit\(|refactor\(/.test(t)
  const pr = /(Pull Request|PR)\b/.test(t)
  const links = [...t.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]).filter((u) => !/^(https?:|mailto:|#)/.test(u))
  const dead = links.filter((u) => { const p = u.split('#')[0]; return p && !has(p) })
  const miss = []
  if (!conv) miss.push('缺提交信息规范')
  if (!pr) miss.push('缺 PR 流程')
  if (dead.length) miss.push('死链：' + dead.join('、'))
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `提交规范与 PR 流程均在，${links.length} 个相对链接可达` }
} })

// ── S5 SECURITY 受支持版本表与私密渠道 ─────────────────────────────────
add({ id: 'S5', covers: ['SECURITY.md'], name: 'SECURITY 有受支持版本表与私密报告渠道', run() {
  const t = read('SECURITY.md')
  const table = /\|\s*版本/.test(t)
  const secret = /(advisories|私密|邮箱|security@|vulnerability)/i.test(t)
  const miss = []
  if (!table) miss.push('缺受支持版本表')
  if (!secret) miss.push('缺私密报告渠道')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '版本表与私密渠道均在' }
} })

// ── S6 CoC 四级阶梯与私密渠道 ──────────────────────────────────────────
add({ id: 'S6', covers: ['CODE_OF_CONDUCT.md'], name: '行为准则有分级处置阶梯与私密举报渠道', run() {
  const t = read('CODE_OF_CONDUCT.md')
  const tiers = ['纠正', '警告', '临时', '永久'].filter((k) => t.includes(k))
  const secret = /(私密|advisories|邮箱|conduct@|@)/.test(t)
  const miss = []
  if (tiers.length < 4) miss.push(`分级阶梯不完整（命中 ${tiers.join('/') || '无'}）`)
  if (!secret) miss.push('缺私密举报渠道')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '四级阶梯与私密渠道均在' }
} })

// ── S7 CHANGELOG 版本段格式与真实日期 ──────────────────────────────────
add({ id: 'S7', covers: ['CHANGELOG.md'], name: 'CHANGELOG 版本段格式与日期都合法', run() {
  const t = read('CHANGELOG.md')
  const heads = [...t.matchAll(/^##\s*\[([^\]]+)\](?:\s*-\s*(\S+))?\s*$/gm)]
  const bad = []
  let dated = 0
  for (const h of heads) {
    const [, ver, date] = h
    if (/^(Unreleased|未发布)$/i.test(ver.trim())) continue
    if (!date) { bad.push(`版本段 ${ver} 缺日期`); continue }
    dated++
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { bad.push(`日期格式不对：${ver} - ${date}`); continue }
    const d = new Date(date + 'T00:00:00Z')
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) bad.push(`日期不存在：${ver} - ${date}`)
  }
  if (heads.length === 0) return { ok: false, detail: '没有任何版本段 —— 覆盖面不完整，不得判通过' }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('；') : `${heads.length} 个版本段，${dated} 个带真实日期` }
} })

// ── S8 CHANGELOG 的 tag 链接真实存在（或已声明未打 tag） ────────────────
add({ id: 'S8', covers: ['CHANGELOG.md'], name: 'CHANGELOG 引用的版本 tag 真实存在（或已声明未打 tag）', run() {
  const t = read('CHANGELOG.md')
  const tags = sh('git', ['tag', '-l']).stdout.split('\n').filter(Boolean)
  // 反引号包起来的 `releases/tag/...` 是占位符，不是真链接；去掉反引号与省略号再判
  const refs = [...t.matchAll(/releases\/tag\/([^\s)`]+)/g)].map((m) => m[1]).filter((r) => !/^\.+$/.test(r))
  const bad = refs.filter((r) => !tags.includes(r))
  // 尚未发布时，文档必须显式声明「还没打 tag」——否则读者会以为这些链接可直接打开。
  const disclaimed = /(尚未打\s*tag|未打\s*tag|not yet tagged)/.test(t)
  if (bad.length && disclaimed) return { ok: true, detail: `${bad.length} 个链接指向尚未创建的 tag，文档已显式声明「尚未打 tag」` }
  return { ok: bad.length === 0, detail: bad.length ? '指向不存在的 tag 且未声明：' + bad.join(', ') : `${refs.length} 个 tag 链接全部存在` }
} })

// ── S9 LICENSE 是完整 MIT ───────────────────────────────────────────────
add({ id: 'S9', covers: ['LICENSE'], name: 'LICENSE 是完整的 MIT 文本', run() {
  const t = read('LICENSE')
  const miss = []
  if (!/MIT License/i.test(t)) miss.push('缺 MIT License 标题')
  if (!/Copyright \(c\) \d{4}/i.test(t)) miss.push('缺版权年')
  if (!/WITHOUT WARRANTY/i.test(t)) miss.push('缺免责条款')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '标题 / 版权年 / 免责条款均在' }
} })

// ── S10 PR 模板有检查清单 ──────────────────────────────────────────────
add({ id: 'S10', covers: ['.github/PULL_REQUEST_TEMPLATE.md'], name: 'PR 模板有可勾选的检查清单', run() {
  const n = (read('.github/PULL_REQUEST_TEMPLATE.md').match(/^\s*-\s*\[ \]/gm) || []).length
  return { ok: n >= 3, detail: `${n} 个勾选项` }
} })

// ── S11–S12 issue 表单：YAML 合法 + 结构完整 ───────────────────────────
const YAML_CODE = 'require "yaml";require "json";require "date";d=YAML.safe_load(File.read(ARGV[0]),aliases:true,permitted_classes:[Date,Time]);puts JSON.generate(d)'
function parseYaml(rel) {
  const r = sh('ruby', ['-ryaml', '-rjson', '-rdate', '-e', YAML_CODE, R(rel)])
  if (r.status !== 0) return { err: 'YAML 非法：' + (r.stderr || '').split('\n').find((l) => l.includes('Error')) || r.stderr }
  try { return { doc: JSON.parse(r.stdout) } } catch (e) { return { err: '解析结果不是 JSON：' + e.message } }
}
function formCheck(rel) {
  const p = parseYaml(rel)
  if (p.err) return { ok: false, detail: p.err }
  const b = p.doc.body
  if (!Array.isArray(b) || !b.length) return { ok: false, detail: 'body 为空' }
  const miss = []
  b.forEach((it, i) => {
    if (it.type === 'markdown') return
    if (!it.id) miss.push(`body[${i}] 缺 id`)
    if (!it.attributes?.label) miss.push(`body[${i}] 缺 attributes.label`)
    const a = it.attributes || {}
    if (it.type === 'textarea' || it.type === 'input') {
      // 自由输入项必须给用户一句「写什么」的指引：description 或 placeholder 至少有一个
      if (!a.description && !a.placeholder) miss.push(`body[${i}]（${it.type} ${it.id}）既没有 description 也没有 placeholder`)
    }
    if (it.type === 'dropdown' || it.type === 'checkboxes') {
      if (!Array.isArray(a.options) || !a.options.length) miss.push(`body[${i}]（${it.type} ${it.id}）缺 attributes.options`)
      else a.options.forEach((o, k) => {
        // 选项允许写成纯字符串（GitHub 两种都接受）
        const label = typeof o === 'string' ? o : o?.label
        if (!label || !String(label).trim()) miss.push(`body[${i}].options[${k}] 空选项`)
      })
    }
  })
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${b.length} 个字段结构完整` }
}
add({ id: 'S11', covers: ['.github/ISSUE_TEMPLATE/bug_report.yml'], name: 'bug_report.yml YAML 合法且结构完整', run: () => formCheck('.github/ISSUE_TEMPLATE/bug_report.yml') })
add({ id: 'S12', covers: ['.github/ISSUE_TEMPLATE/feature_request.yml'], name: 'feature_request.yml YAML 合法且结构完整', run: () => formCheck('.github/ISSUE_TEMPLATE/feature_request.yml') })

// ── S13 issue 模板选择页配置 ──────────────────────────────────────────
add({ id: 'S13', covers: ['.github/ISSUE_TEMPLATE/config.yml'], name: 'issue 模板选择页有布尔开关与联系入口', run() {
  const p = parseYaml('.github/ISSUE_TEMPLATE/config.yml')
  if (p.err) return { ok: false, detail: p.err }
  const d = p.doc
  const miss = []
  if (typeof d.blank_issues_enabled !== 'boolean') miss.push('blank_issues_enabled 不是布尔值')
  if (!Array.isArray(d.contact_links) || !d.contact_links.length) miss.push('缺 contact_links')
  else d.contact_links.forEach((c, i) => { if (!c.name || !c.url) miss.push(`contact_links[${i}] 缺 name/url`) })
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${d.contact_links.length} 个联系入口` }
} })

// ── S14 dependabot 结构与仓库实况一致 ─────────────────────────────────
add({ id: 'S14', covers: ['.github/dependabot.yml'], name: 'dependabot 结构与仓库实况一致', run() {
  const p = parseYaml('.github/dependabot.yml')
  if (p.err) return { ok: false, detail: p.err }
  const d = p.doc
  const miss = []
  if (d.version !== 2) miss.push('version 必须是 2')
  const eco = new Set(['npm', 'docker', 'github-actions', 'pip', 'gomod', 'cargo', 'bundler', 'composer', 'gradle', 'maven', 'nuget', 'pub', 'swift', 'devcontainers', 'terraform'])
  if (!Array.isArray(d.updates) || !d.updates.length) miss.push('缺 updates')
  else d.updates.forEach((u, i) => {
    if (!u['package-ecosystem']) miss.push(`updates[${i}] 缺 package-ecosystem`)
    else if (!eco.has(u['package-ecosystem'])) miss.push(`updates[${i}] 生态未知：${u['package-ecosystem']}`)
    if (!u.directory) miss.push(`updates[${i}] 缺 directory`)
    else if (u['package-ecosystem'] === 'npm' && !has(`${u.directory.replace(/^\.\//, '').replace(/\/$/, '')}/package.json`.replace(/^\/?/, ''))) miss.push(`updates[${i}] directory=${u.directory} 下没有 package.json`)
    if (!u.schedule?.interval) miss.push(`updates[${i}] 缺 schedule.interval`)
  })
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${d.updates.length} 个生态配置` }
} })

// ── S15 CI 步骤引用的东西都存在 ───────────────────────────────────────
add({ id: 'S15', covers: ['.github/workflows/ci.yml'], name: 'CI 步骤引用的 npm script 都存在，action 版本不过期，权限不写 write-all', run() {
  const rel = '.github/workflows/ci.yml'
  const p = parseYaml(rel)
  if (p.err) return { ok: false, detail: p.err }
  const scripts = Object.keys(JSON.parse(read('package.json')).scripts || {})
  const txt = read(rel)
  const miss = []
  let runs = 0
  let uses = 0
  for (const m of txt.matchAll(/^\s*(?:-\s*)?run:\s*(.+)$/gm)) {
    runs++
    const v = m[1].trim()
    if (!v) miss.push('有空 run:')
    for (const n of v.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) if (!scripts.includes(n[1])) miss.push(`CI 里的 npm run ${n[1]} 不存在于 package.json`)
  }
  for (const m of txt.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
    uses++
    const [, act, ver] = m
    const num = Number(String(ver).replace(/^v/, '').split('.')[0])
    if (Number.isFinite(num) && num < 4) miss.push(`action 版本过旧（${act}@${ver}）：低于 v4 的 action 跑在已弃用的 Node 运行时上`)
  }
  const permsOk = /\bpermissions:/.test(txt) && !/permissions:\s*write-all/.test(txt)
  if (!permsOk) miss.push('缺 permissions 或写成了 write-all')
  if (runs === 0) miss.push('没有解析到任何 run: 步骤')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${runs} 个 run 步骤、${uses} 个 action，权限已收窄` }
} })

// ── S16 CODEOWNERS 每条模式真的命中文件 ───────────────────────────────
add({ id: 'S16', covers: ['.github/CODEOWNERS'], name: 'CODEOWNERS 每条模式都至少匹配 1 个已跟踪文件', run() {
  const t = read('.github/CODEOWNERS')
  const patterns = t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]).filter((p) => p && !p.startsWith('!'))
  // gitignore 式语义：前导 '/' = 从仓库根锚定；尾随 '/' = 目录（匹配其下所有文件）；无 '/'(除尾随) = 任意深度。
  const matchOne = (p, f) => {
    if (p === '*') return true
    let pat = p
    const anchored = pat.startsWith('/')
    if (anchored) pat = pat.slice(1)
    const isDir = pat.endsWith('/')
    if (isDir) pat = pat.slice(0, -1)
    let re = ''
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i]
      if (c === '*') { if (pat[i + 1] === '*') { re += '.*'; i++; if (pat[i + 1] === '/') i++ } else re += '[^/]*' }
      else if (c === '?') re += '[^/]'
      else if ('.[]()+${}^$|\\'.includes(c)) re += '\\' + c
      else re += c
    }
    const rx = anchored ? new RegExp('^' + re + '($|/)') : new RegExp('(^|/)' + re + '($|/)')
    return rx.test(f)
  }
  const dead = patterns.filter((p) => !tracked.some((f) => matchOne(p, f)))
  return { ok: dead.length === 0, detail: dead.length ? '永不生效的模式：' + dead.join('、') : `${patterns.length} 条模式全部命中` }
} })

// ── S17 配置卫生（同目录的姊妹判据） ──────────────────────────────────
add({ id: 'S17', covers: ['.editorconfig', '.gitattributes', 'scripts/check-repo-config-hygiene.mjs'], name: '配置卫生 A1–A5（零命中规则、哈希资产保护、行尾口径）全绿', run() {
  const r = sh(process.execPath, [path.join(HERE, 'check-repo-config-hygiene.mjs')], { env: { ...process.env, HYG_ROOT: ROOT } })
  const tail = (r.stdout || '').trim().split('\n').slice(-1)[0] || ''
  if (r.status === 2) return { ok: false, detail: '姊妹判据未判定（样本为 0）：' + tail }
  return { ok: r.status === 0, detail: `exit=${r.status} ${tail}` }
} })

// ── S18 仓库脚本语法与引用 ────────────────────────────────────────────
add({ id: 'S18', covers: ['scripts/check-repo-config-hygiene.mjs', 'scripts/check-repo-standards.mjs', 'scripts/publish-leak-scan.mjs', 'scripts/typecheck-guard.mjs', 'scripts/verify-repo.mjs', 'scripts/verify-standards-selftest.mjs'], name: '仓库脚本语法正确且都被 npm script 引用（不是死文件）', run() {
  const pkg = read('package.json')
  const files = readdirSync(R('scripts')).filter((f) => f.endsWith('.mjs'))
  // 两个判据脚本必须挂上 npm script：否则「写了没人跑」等于没写。
  const miss = []
  for (const f of files) {
    const c = sh(process.execPath, ['--check', R('scripts/' + f)])
    if (c.status !== 0) miss.push(`${f} 语法错误：${(c.stderr || '').split('\n')[0]}`)
    if (!pkg.includes(f)) miss.push(`${f} 没有被任何 npm script 引用`)
  }
  if (files.length === 0) miss.push('scripts/ 下没有 mjs 文件')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${files.length}/${files.length} OK` }
} })

// ── S19 package.json 里 node 引用的文件都存在 ─────────────────────────
add({ id: 'S19', covers: ['package.json'], name: 'package.json 里 node 脚本引用的文件都存在', run() {
  const scripts = JSON.parse(read('package.json')).scripts || {}
  const miss = []
  let n = 0
  for (const [k, v] of Object.entries(scripts)) for (const m of String(v).matchAll(/node\s+(\.\/)?([^\s|&;]+\.m?js)/g)) {
    n++
    const rel = m[2]
    if (!has(rel)) miss.push(`${k}: ${rel} 不存在`)
  }
  if (n === 0) return { ok: false, detail: '没有任何 node 引用样本 —— 不得判通过' }
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${n} 个 script 的引用全部存在` }
} })

// ── S20 hints.ts 导出真的被 import 过 ─────────────────────────────────
add({ id: 'S20', covers: ['src/lib/hints.ts'], name: 'hints.ts 的导出与组件的用法一致，且文件未越行数阈值', run() {
  const h = read('src/lib/hints.ts')
  const c = read('src/components/CaptureView.vue')
  const exp = [...h.matchAll(/^export (?:const|function|interface)\s+(\w+)/gm)].map((m) => m[1])
  const imp = c.match(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*['"][^'"]*hints['"]/)
  const miss = []
  if (!imp) miss.push('CaptureView 没有从 hints 导入任何东西')
  else {
    const used = imp[1].split(',').map((s) => s.replace(/^\s*type\s+/, '').trim()).filter(Boolean)
    for (const u of used) if (!exp.includes(u)) miss.push(`CaptureView 导入了不存在的导出：${u}`)
  }
  const mods = []
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else if (/\.(ts|mjs|js|vue)$/.test(e.name)) mods.push(q) } }
  for (const d of ['src', 'scripts']) if (has(d)) walk(R(d))
  // 显式豁免：这三个导出是给**外部探针**驱动提示状态机用的（审计运行根的 harness 会 import 它们），
  // 仓库内没有使用者。豁免必须写明理由，且「新加一个真没人用的导出」仍然报红。
  const PROBE_ONLY_EXPORTS = ['URGENT_HINTS', 'HINT_BUF', 'HINT_NEED']
  for (const e of exp) {
    if (e.startsWith('Hints')) continue
    if (PROBE_ONLY_EXPORTS.includes(e)) continue
    if (c.includes(e)) continue
    // 「被使用」= 有别的模块 **import 过 hints** 并且出现了这个标识符。
    // 只看「字符串出现过」会把注释、文档、乃至变异自检脚本里的名字也算进来。
    const usedOutside = mods.some((f) => {
      if (f === R('src/lib/hints.ts')) return false
      const t = readFileSync(f, 'utf8')
      if (!/import[^;]*from\s*['"][^'"]*hints['"]/.test(t)) return false
      return new RegExp('\\b' + e + '\\b').test(t)
    })
    if (!usedOutside) miss.push(`hints.ts 导出的 ${e} 在组件与判据里都没用到（死导出）`)
  }
  for (const f of ['src/lib/hints.ts', 'src/components/CaptureView.vue']) {
    const n = read(f).split('\n').length
    if (n > 800) miss.push(`${f} ${n} 行 > 800`)
  }
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${exp.length} 个导出全部被使用，行数在阈值内` }
} })

// ── S21 类型检查 ──────────────────────────────────────────────────────
add({ id: 'S21', covers: ['src/lib/hints.ts'], name: 'vue-tsc --noEmit 全绿（类型层面的 L2 证据）', run() {
  const r = sh('npx', ['vue-tsc', '--noEmit'], { timeout: 300000 })
  if (r.status === null) return { ok: false, detail: '类型检查超时（300s）' }
  return { ok: r.status === 0, detail: r.status === 0 ? 'exit=0，无 TS 错误' : 'exit=' + r.status }
} })

// ── S22 .github 下所有 YAML 都能解析（含将来新增的） ──────────────────
function yamlFilesUnder(rel) {
  const out = []
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.DS_Store') continue
      const rel2 = prefix ? prefix + '/' + e.name : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), rel2)
      else if (/\.ya?ml$/.test(e.name)) out.push(rel2)
    }
  }
  if (has(rel)) walk(R(rel), rel)
  return out
}
add({ id: 'S22', covers: yamlFilesUnder('.github'), name: '.github 下所有 YAML 都可被解析（含将来新增的）', run() {
  const files = yamlFilesUnder('.github')
  if (files.length === 0) return { ok: false, detail: '.github 下没有 YAML —— 不得判通过' }
  const bad = files.filter((f) => parseYaml(f).err).map((f) => `${f}：${parseYaml(f).err}`)
  return { ok: bad.length === 0, detail: bad.length ? bad.join('；') : `${files.length} 个 YAML 全部可解析` }
} })

// ── S23 RUN.md 里提到的文件路径真实存在 ───────────────────────────────
add({ id: 'S23', covers: ['RUN.md'], name: 'RUN.md 提到的文件路径都真实存在（文档与源码一致的最低要求）', run() {
  const t = read('RUN.md')
  const cand = new Set()
  for (const m of t.matchAll(/`([A-Za-z0-9_.@/-]+\.(?:mjs|js|ts|vue|json|yml|yaml|scss|md|sh|task|wasm))`/g)) cand.add(m[1])
  const skip = (p) => /^(https?:|node_modules\/|dist\/|\.\/)/.test(p) || p.includes('*') || p.startsWith('@') || p.startsWith('/')
  // RUN.md 是「运行手册」：它同时记录本仓库的文件、**审计运行根**的脚本、以及上游 PocketBase
  // 源码树与构建产物的文件名。后两类本来就不在本仓库里，无法用磁盘存在性判定。
  // 因此只核对带仓库自有目录前缀的引用；其余计入「未纳入」并把数量打出来，
  // 让读者一眼看出这条断言覆盖了多少、漏了多少，而不是把「查不了」当成「查过了」。
  const OWN = ['src/', 'scripts/', 'public/', 'pb_migrations/', 'pb-bin/', '.github/', 'docs/']
  let notInRepo = 0
  const dead = []
  let checked = 0
  for (const p of cand) {
    if (skip(p)) continue
    if (!OWN.some((o) => p.startsWith(o))) { notInRepo++; continue }
    checked++
    if (!has(p)) dead.push(p)
  }
  if (checked === 0) return { ok: false, detail: '没解析到任何仓库内文件路径样本 —— 不得判通过' }
  return { ok: dead.length === 0, detail: dead.length ? '文档提到但仓库里没有：' + dead.join('、') : `${checked} 个仓库内路径全部存在（另有 ${notInRepo} 处裸文件名/运行根引用不在本仓库，未纳入）` }
} })

// ── S24 每个受管文件都被某条断言以具体文件名覆盖（前向断言） ──────────
add({ id: 'S24', covers: [], name: '仓库根与 .github 下的每个受管文件都被本判据的某条断言覆盖（新文件没人查即红）', run() {
  const onDisk = (rel) => {
    const out = []
    const walkDir = (d, prefix) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.DS_Store') continue
        const rel2 = prefix ? prefix + '/' + e.name : e.name
        if (e.isDirectory()) walkDir(path.join(d, e.name), rel2)
        else out.push(rel2)
      }
    }
    if (has(rel)) walkDir(R(rel), rel)
    return out
  }
  // 根文档按磁盘实况枚举：写死清单会让「新加一个根文档没人查」永远看不出来（前向断言失效）。
  const rootDocs = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && (/\.md$/i.test(e.name) || e.name === 'LICENSE'))
    .map((e) => e.name)

  const watched = [...onDisk('.github'), ...rootDocs, ...onDisk('scripts')]
  // 只认【具体文件】的归属声明：通配会让「新加文件没人管」永远看不出来。
  const covered = new Set()
  for (const c of CHECKS) for (const v of c.covers || []) if (!v.includes('*')) covered.add(v)
  const missing = watched.filter((f) => !covered.has(f))
  return { ok: missing.length === 0, detail: missing.length ? '没有任何断言覆盖：' + missing.join('、') : `${watched.length} 个受管文件全部有归属` }
} })

for (const c of CHECKS) {
  let r
  try { r = c.run() } catch (e) { r = { ok: false, detail: '断言抛错：' + e.message } }
  ck(`${c.id} | ${c.name}`, r.ok, r.detail)
}
log('')
log(`通过 ${pass}，失败 ${fail}`)
const out = lines.join('\n')
console.log(out)
if (process.env.CK_LOG) writeFileSync(process.env.CK_LOG, out + '\n')
process.exit(fail === 0 ? 0 : 1)
