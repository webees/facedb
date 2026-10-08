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

// 【R22-21】大小写不敏感文件系统造成的「本地绿、CI 红」：
// `.github/pull_request_template.md` 在 macOS（APFS 默认不敏感）上会把**实际跟踪的**
// `.github/PULL_REQUEST_TEMPLATE.md` 解析出来，在 Linux CI 上却是 ENOENT —— 判据的绿/红
// 取决于跑在哪种文件系统上，与工程内容无关。规矩：仓库内路径一律用 `git ls-files` 的
// **字面结果**解析（git 的输出与文件系统大小写无关）；大小写变体多于一个直接判失败
// （歧义比缺失更危险：读哪一个取决于文件系统）。
const resolveTracked = (rel) => {
  const want = rel.toLowerCase()
  const hits = tracked.filter((t) => t.toLowerCase() === want)
  if (hits.length === 0) return { path: null, reason: `没有跟踪这个路径（大小写敏感查找）：${rel}` }
  if (hits.length > 1) return { path: null, reason: `有 ${hits.length} 个大小写变体，读哪个取决于文件系统：${hits.join(' / ')}` }
  if (!existsSync(R(hits[0]))) return { path: null, reason: `已跟踪但工作区缺失：${hits[0]}` }
  return { path: hits[0], reason: null }
}
const isDirPath = (rel) => tracked.some((t) => t.startsWith(rel.replace(/\/$/, '') + '/'))

// 【R23REV-N2】工作流里的 `run:` 有两种写法：单行（`run: npm run X`）与 block scalar
// （`run: |` + 缩进正文，多命令步骤的常规写法）。只认单行会让后者的步骤**凭空消失**，
// 于是「CI 有没有以独立步骤跑某判据」被反向误判（实测：把 `run: npm run verify:notices`
// 改成 block scalar 后，S25/S30 同时报「CI 没有以独立步骤跑 / verify:ci 多了 CI 不跑的步骤」）。
// 所有解析工作流步骤的地方都必须走这个函数，不要再各自写 `^\s*run:\s*(.+)$`。
const ciRunBodies = (text) => {
  const out = []
  const all = text.split('\n')
  for (let i = 0; i < all.length; i++) {
    const m = all[i].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/)
    if (!m) continue
    const indent = m[1].length
    const inline = m[2].trim()
    if (inline && !/^[|>]/.test(inline)) { out.push(inline); continue }
    const body = []
    for (let j = i + 1; j < all.length; j++) {
      const l = all[j]
      if (!l.trim()) continue
      if (l.match(/^\s*/)[0].length <= indent) break
      body.push(l.trim())
    }
    out.push(body.join(' '))
  }
  return out
}
// 某个 npm script 是否以**独立步骤**出现在 CI 里（单行或 block scalar 都算）。
const ciHasStep = (text, script) => ciRunBodies(text).some((b) => b.trim() === `npm run ${script}`)

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
// 按磁盘枚举**所有**工作流：只查 ci.yml 的话，新加一个工作流就没人查它的 script/action/权限，
// 而 S22 会声称「这个 YAML 有归属」（它只验可解析）—— 归属必须由做实质检查的断言提供。
add({ id: 'S15', covers: yamlFilesUnder('.github/workflows'), name: '每个工作流的 npm script 都存在，action 版本不过期，权限不写 write-all', run() {
  const rels = yamlFilesUnder('.github/workflows')
  if (rels.length === 0) return { ok: false, detail: '.github/workflows 下没有工作流 —— 不得判通过' }
  const scripts = Object.keys(JSON.parse(read('package.json')).scripts || {})
  const miss = []
  let runs = 0
  let uses = 0
  let checked = 0
  for (const rel of rels) {
  const p = parseYaml(rel)
  if (p.err) { miss.push(`${rel}：${p.err}`); continue }
  checked++
  const txt = read(rel)
  const m0 = miss.length
  for (const v of ciRunBodies(txt)) {
    runs++
    if (!v) miss.push(`${rel}: 有空 run:`)
    for (const n of v.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) if (!scripts.includes(n[1])) miss.push(`${rel} 里的 npm run ${n[1]} 不存在于 package.json`)
  }
  for (const m of txt.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
    uses++
    const [, act, ver] = m
    const num = Number(String(ver).replace(/^v/, '').split('.')[0])
    if (Number.isFinite(num) && num < 4) miss.push(`${rel}: action 版本过旧（${act}@${ver}）：低于 v4 的 action 跑在已弃用 Node 运行时上`)
  }
  const permsOk = /\bpermissions:/.test(txt) && !/permissions:\s*write-all/.test(txt)
  if (!permsOk) miss.push(`${rel}: 缺 permissions 或写成了 write-all`)
  if (miss.length === m0 && !/^\s*(?:-\s*)?run:/m.test(txt)) miss.push(`${rel}: 没有解析到任何 run: 步骤`)
  }
  if (checked === 0) miss.push('没有一个工作流被真正检查到')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${rels.length} 个工作流、${runs} 个 run 步骤、${uses} 个 action，权限已收窄` }
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
add({ id: 'S18', covers: ['scripts/check-repo-config-hygiene.mjs', 'scripts/check-repo-standards.mjs', 'scripts/publish-leak-scan.mjs', 'scripts/typecheck-guard.mjs', 'scripts/verify-repo.mjs', 'scripts/verify-standards-selftest.mjs', 'scripts/check-third-party-notices.mjs', 'scripts/check-third-party-notices-mutants.mjs', 'scripts/lib/checker.mjs', 'scripts/check-dist-size-budget.mjs', 'scripts/check-dist-size-budget-mutants.mjs'], name: '仓库脚本语法正确且都被 npm script 引用（不是死文件）', run() {
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
  // 定向归属：工作流文件的实质检查只可能在 S15，被别的断言（如「能解析」的 S22）覆盖不算数。
  const wfOwner = new Set((CHECKS.find((c) => c.id === 'S15')?.covers || []).filter((v) => !v.includes('*')))
  for (const f of watched) {
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(f) && !wfOwner.has(f)) missing.push(`${f}（未被 S15 逐个检查，只是被别的断言覆盖）`)
  }
  return { ok: missing.length === 0, detail: missing.length ? '没有任何断言覆盖：' + missing.join('、') : `${watched.length} 个受管文件全部有归属` }
} })

// ── S25 第三方声明文件与分发链接线（R20-F7） ──────────────────────────
// 为什么单独立一条：文件本身（Apache 全文 / 闭包与 lock 一致 / dist 副本）由
// `scripts/check-third-party-notices.mjs` 深查；这里守的是**接线**——它必须真的被构建复制、
// 必须真的挂上 npm script 与 CI。否则「写了文件但没人分发、没人跑判据」在仓库层面看不出来
// （S24 只能要求「有归属」，不能要求「归属是真的」）。
add({ id: 'S25', covers: ['THIRD-PARTY-NOTICES.md'], name: '第三方声明文件被构建复制、且判据与 CI 已接线', run() {
  const miss = []
  if (!has('THIRD-PARTY-NOTICES.md')) miss.push('THIRD-PARTY-NOTICES.md 不存在')
  else {
    const t = read('THIRD-PARTY-NOTICES.md')
    for (const m of ['Apache License', 'END OF TERMS AND CONDITIONS', 'APPENDIX: How to apply the Apache License to your work', 'Permission is hereby granted, free of charge']) {
      if (!t.includes(m)) miss.push(`声明文件缺标记：${m}`)
    }
  }
  const rs = has('rsbuild.config.ts') ? read('rsbuild.config.ts') : ''
  if (!/copy:\s*\[[\s\S]*?from:\s*'THIRD-PARTY-NOTICES\.md'[\s\S]*?to:\s*'THIRD-PARTY-NOTICES\.md'/.test(rs)) miss.push('rsbuild.config.ts 的 output.copy 没有复制该文件（构建产物里不会有它）')
  const pkg = has('package.json') ? read('package.json') : ''
  for (const s of ['verify:notices', 'verify:notices-selftest']) if (!pkg.includes(`"${s}"`)) miss.push(`package.json 缺 npm script：${s}`)
  const ci = has('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : ''
  // 必须按**整行**匹配：'npm run verify:notices' 是 'npm run verify:notices-selftest' 的前缀，
  // 用 includes 会让「摘掉真判据、只留下自检」也判绿（M16c 变异体实测踩到，已改成行级正则）。
  for (const s of ['verify:notices', 'verify:notices-selftest']) {
    if (!ciHasStep(ci, s)) miss.push(`CI 没有以独立步骤跑：npm run ${s}`)
  }
  if (!has('docs/THIRD-PARTY.md') || !read('docs/THIRD-PARTY.md').includes('THIRD-PARTY-NOTICES.md')) miss.push('docs/THIRD-PARTY.md 没有引用该文件（文档与处置脱钩）')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '文件标记齐备 · 构建复制 · npm script 与 CI 接线 · 文档引用' }
} })

// ── S26 产物体积与构成判据的接线（R21/W21-A） ─────────────────────────
// 为什么单独立一条：`dist/` 是 web 容器的静态根，体积与构成回归原先没有任何断言看得见。
// 判据本身（gzip 传输面 / 原始总字节 / 文件名清单 / 逐文件 sha256）由
// `scripts/check-dist-size-budget.mjs` 深查；这里守的是**接线** —— 文件在、能自定位
// （不硬编码绝对路径）、阈值常量齐、npm script 与 CI 真的跑它。否则「写了判据但没人跑」
// 在仓库层面看不出来（S24 只能要求「有归属」，不能要求「归属是真的」）。
add({ id: 'S26', covers: ['scripts/lib/checker.mjs', 'scripts/check-dist-size-budget.mjs', 'scripts/check-dist-size-budget-mutants.mjs'], name: '产物体积与构成判据已接线（文件 / 自定位 / 阈值常量 / npm script / CI 步骤 / 阈值来源）', run() {
  const GUARD = 'scripts/check-dist-size-budget.mjs'
  const MUT = 'scripts/check-dist-size-budget-mutants.mjs'
  const LIB = 'scripts/lib/checker.mjs'
  const miss = []
  for (const f of [GUARD, MUT, LIB]) if (!has(f)) miss.push(`${f} 不存在`)
  const g = has(GUARD) ? read(GUARD) : ''
  if (g) {
    // 自定位：根目录来自 SIZE_ROOT 或脚本自身位置；产物目录允许 --dist 覆盖
    if (!/process\.env\.SIZE_ROOT/.test(g) || !/import\.meta\.dirname/.test(g)) miss.push('判据没有 SIZE_ROOT / import.meta.dirname 自定位通道')
    if (!/--dist/.test(g)) miss.push('判据没有 --dist 覆盖通道')
    // 硬编码绝对路径是本轮一条 P1 的同型缺陷：判据自身不得出现 /Users/…
    if (/\/Users\//.test(g)) miss.push('判据里出现硬编码 /Users/ 绝对路径')
    // 5 个阈值常量（基线/上限 各两档 + 产物文件数）
    for (const k of ['WEB_GZIP_BASELINE_BYTES', 'WEB_GZIP_CAP_BYTES', 'RAW_TOTAL_BASELINE_BYTES', 'RAW_TOTAL_CAP_BYTES', 'EXPECTED_FILE_COUNT']) {
      if (!new RegExp(`const ${k}\\s*=`).test(g)) miss.push(`判据缺阈值常量 ${k}`)
    }
    // 阈值来源：docs/ 与 RUN.md 不在本轮的写集里，故由判据自带的注释承担（实测基线 + 运行根证据）
    const docFiles = has('docs') ? readdirSync(R('docs')).filter((f) => /\.md$/.test(f)).map((f) => `docs/${f}`) : []
    const cited = docFiles.filter((f) => read(f).includes(GUARD))
    const sourceInComment = /W21-A/.test(g) && /95700/.test(g) && /27429645/.test(g)
    if (cited.length === 0 && !sourceInComment) miss.push('既没有文档引用该判据，判据自带注释也没写明阈值来源（实测基线）')
    // 环境前提与零样本纪律：非默认构建环境、缺产物，都不得判通过
    if (!/PUBLIC_PB_URL/.test(g)) miss.push('判据没有 PUBLIC_PB_URL 环境前提断言（该变量会改产物内容与文件名）')
    if (!/from '\.\/lib\/checker\.mjs'/.test(g)) miss.push('判据没有复用 scripts/lib/checker.mjs（未判定/关键跳过不得判通过的纪律）')
  }
  const pkg = has('package.json') ? read('package.json') : ''
  for (const s of ['verify:size', 'verify:size-selftest']) if (!pkg.includes(`"${s}"`)) miss.push(`package.json 缺 npm script：${s}`)
  // 不得塞进 verify:all：该判据需要 dist，全新克隆无构建即失败（与 verify:notices 的既有取舍一致）
  if (/"verify:all":[^\n]*verify:size/.test(pkg)) miss.push('verify:size 被塞进 verify:all（全新克隆无构建时会直接失败）')
  const ci = has('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : ''
  // 必须按**整行**匹配：'npm run verify:size' 是 'npm run verify:size-selftest' 的前缀，
  // 用 includes 会让「摘掉真判据、只留下自检」也判绿（S25/M16c 已踩过同型坑）。
  for (const s of ['verify:size', 'verify:size-selftest']) {
    if (!new RegExp(`^\\s*run:\\s*npm run ${s}\\s*$`, 'm').test(ci)) miss.push(`CI 没有以独立步骤跑：npm run ${s}`)
  }
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '3 个新文件 · 自定位（SIZE_ROOT / --dist）· 5 个阈值常量 · npm script 与 CI 步骤接线 · 阈值来源写明 · 未塞进 verify:all' }
} })

// ── S27 发布卫生闸门与它的变异自检的接线（R22） ──────────────────────
// 为什么单独立一条：`webees/facedb` 是 PUBLIC 仓库，闸门漏检 = 不可逆泄露。R14REV 复核席实测
// 旧版闸门对 6 类真实泄露形态全部 exit 0 命中 0（.bak 等非白名单扩展名被当二进制跳过、
// .pem 私钥同样跳过、新式令牌前缀无规则、>2MB 文本跳过、被忽略的 .env 不在扫描面、
// 默认阻断线只到 P0）。这里守的是**修复不许被改回去** + **接线是真的**：
// 内容判二进制（不许退回扩展名白名单）、未判定必须 exit 2、阻断线默认 P1、
// 令牌前缀齐、npm script 与 CI 以独立步骤跑闸门与电池。
add({ id: 'S27', covers: ['scripts/publish-leak-scan.mjs', 'scripts/publish-leak-scan-selftest.mjs'], name: '发布卫生闸门已接线且修复不许回退（内容判二进制 / 未判定 exit 2 / 阻断线 P1 / 令牌前缀 / 电池接线）', run() {
  const GATE = 'scripts/publish-leak-scan.mjs'
  const MUT = 'scripts/publish-leak-scan-selftest.mjs'
  const miss = []
  for (const f of [GATE, MUT]) if (!has(f)) miss.push(`${f} 不存在`)
  const g = has(GATE) ? read(GATE) : ''
  const m = has(MUT) ? read(MUT) : ''
  if (g) {
    if (!/process\.env\.LEAK_SCAN_ROOT/.test(g) || !/import\.meta\.dirname/.test(g)) miss.push('闸门没有 LEAK_SCAN_ROOT / import.meta.dirname 自定位通道')
    // 注意：闸门里允许出现 `/Users/<name>/` —— 那是 LOCAL-PATH 规则自身的正则文本（不是硬编码根）。
    // 这里禁的是「拿本机绝对路径当扫描根」，即 /Users/<真用户名>/<真实目录>。
    if (/\/Users\/[A-Za-z0-9_.-]+\/(Desktop|__GITHUB__|Projects|Documents)/.test(g)) miss.push('闸门里出现硬编码的本机绝对路径')
    // 修复不许回退：内容判二进制（NUL 字节），且不许再出现扩展名白名单
    if (!/subarray\(0,\s*8192\)\.includes\(0\)/.test(g)) miss.push('闸门没有按内容判二进制（前 8KB NUL 字节）—— 会退回按扩展名跳过 .pem/.bak')
    if (/TEXT_EXT/.test(g)) miss.push('闸门里又出现了扩展名白名单 TEXT_EXT（R22 已删）')
    if (/st\.size > 2 \* 1024 \* 1024/.test(g)) miss.push('闸门又按 2MB 静默跳过（R22 已改为全量扫 + 超上限判未判定）')
    if (!/LEAK_MAX_BYTES/.test(g)) miss.push('闸门没有 LEAK_MAX_BYTES 扫描上限通道')
    // 未判定语义：读不到 / 超上限 ⇒ exit 2，绝不判通过
    if (!/voided/.test(g) || !/process\.exit\(2\)/.test(g)) miss.push('闸门没有未判定（voided → exit 2）语义')
    // 阻断线默认 P1（PUBLIC 仓库）
    if (!/process\.env\.LEAK_BLOCK_AT \|\| 'P1'/.test(g)) miss.push('闸门默认阻断线不是 P1')
    // 令牌前缀扩面：必须在 **TOKEN_PATTERNS 数组内**逐条存在。
    // 只对整份源码做 includes 会被文件头注释满足（M21 实测：摘掉数组里的 sk-proj- 仍然判绿）。
    const tp = (g.match(/const TOKEN_PATTERNS = \[([\s\S]*?)\n\]/) || [])[1] || ''
    if (!tp) miss.push('闸门里找不到 TOKEN_PATTERNS 数组')
    for (const k of ['github_pat_', 'glpat-', 'xox[baprs]-', 'AKIA', 'ASIA', 'sk-proj-', 'sk-ant-', 'AIza', 'ya29', 'hf_', 'npm_', 'dckr_pat_', 'pypi-', 'SG\\', 'eyJ']) {
      if (!tp.includes(k)) miss.push(`TOKEN_PATTERNS 缺 ${k}`)
    }
    // 被忽略的敏感文件必须可见（提示区）
    if (!/'--others', '--ignored', '--exclude-standard'/.test(g) || !/SENSITIVE_IGNORED/.test(g)) miss.push('闸门没有「被 .gitignore 忽略的敏感命名文件」提示区')
    // 自匹配防护（R13-F9 自阻断教训）：私钥头不许以完整字面量出现。
    // 注意：断言自己也不能写这个字面量 —— 否则 check-repo-standards.mjs 本身
    // 就会被发布闸门判成 P0 PRIVATEKEY（R22 实测踩中：闸门自扫 exit 1）。
    const SSH_HDR = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')
    if (g.includes(SSH_HDR)) miss.push('闸门源码里出现完整 OPENSSH 私钥头字面量（会自阻断）')
  }
  if (m) {
    // 电池的覆盖面：15 阳性 + 2 阴性 + 未判定语义（读不到 / 扫描面为空）+ 提示区 + 自扫
    for (const k of ['m1 ', 'm5 ', 'm8 ', 'm13', 'm14', 'm15', 'n1 ', 'n2 ', 'u1 ', 'u2 ', 'i1 ', 's1 自扫真实仓库']) {
      if (!m.includes(k)) miss.push(`电池缺场景 ${k.trim()}`)
    }
    if (!/process\.exit\(1\)/.test(m)) miss.push('电池失败时不 exit 1（会把失败读成通过）')
    // R23REV-N6：闸门必须对「扫描面为空」判未判定（零样本不得判通过），且该分支不许只剩 exit 0
    if (!/files\.length === 0/.test(g) || !/扫描面为空/.test(g)) miss.push('闸门对空扫描面没有判未判定（R23REV-N6 回归）')
    // R23REV-N8：SECRET-ASSIGN 的前导边界不许退回 `\b`（下划线前缀键名会整类漏检）
    if (!/\(\?<!\[A-Za-z0-9\]\)/.test(g)) miss.push('SECRET-ASSIGN 前导边界退回 \\b 形态（下划线前缀键名整类漏检，R23REV-N8 回归）')
  }
  // 接线：npm script + CI 独立步骤（includes 会让「摘掉真判据只留自检」也判绿）
  const pkg = has('package.json') ? read('package.json') : ''
  for (const s of ['verify:publish', 'verify:publish-selftest']) {
    if (!new RegExp(`"${s}":`).test(pkg)) miss.push(`package.json 缺 script ${s}`)
  }
  if (/verify:all[^\n]*verify:publish-selftest/.test(pkg)) miss.push('电池被塞进 verify:all（应只在 CI 的判据自检 job 里跑）')
  const ci = has('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : ''
  for (const s of ['verify:publish', 'verify:publish-selftest']) {
    if (!new RegExp(`^\\s*run:\\s*npm run ${s}\\s*$`, 'm').test(ci)) miss.push(`CI 没有以独立步骤跑：npm run ${s}`)
  }
  // 文档口径：PR 模板与 CI 步骤名必须写明真实阻断线（R14REV must_fix：旧文案声称覆盖「地址/本地路径」而默认只挡 P0）
  // 读取点必须大小写敏感解析 —— 否则该断言在 macOS 上恒绿、在 Linux CI 上恒红（R22-21）。
  const prHit = resolveTracked('.github/pull_request_template.md')
  if (!prHit.path) miss.push(`PR 模板：${prHit.reason}`)
  const pr = prHit.path ? read(prHit.path) : ''
  if (prHit.path && (!/verify:publish/.test(pr) || !/阻断/.test(pr))) miss.push('PR 模板没有写明发布卫生闸门的真实阻断线')
  if (!/P1/.test(ci.split('\n').find((l) => /name: 发布卫生闸门/.test(l)) || '')) miss.push('CI 步骤名没有写明阻断线（P0/P1）')
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '2 个文件 · 内容判二进制（禁扩展名白名单回退）· 未判定 exit 2（读不到 / 扫描面为空）· 阻断线默认 P1 · 15 个令牌前缀 · 提示区 · 电池 15+2+2+1 场景 · npm/CI 接线 · 文档口径一致' }
} })

// ── S28 仓库判据的变异自检接线与判别力（R22） ──────────────────────────
// 为什么单独立一条：`scripts/verify-repo.mjs` 是仓库结构面与 CSP 面的判据，它的判别力来自
// `--self-check` 的 30 个变异体（M1–M19 沿用 + 零样本 4 条 + 越界 2 条；R23 的 W23-H 修
// R22-04/05 时补了 M16–M19，R23 的六指令 CSP 又补了 M20–M25 六条 —— 判据的计数必须跟着走，
// 否则 CI 步骤名与真实判别力脱钩）。R22 实测：这个自检
// **从未进 CI**（package.json 有 `verify:selfcheck`，但 CI 里一次都没跑）—— 于是「判据被无声
// 削弱」的路径正坐在 CI 绿灯的背面。这与 R22REV 报的「只验 img-src 这个词存在」是同一层级的
// 两个问题：一个是断言太弱，一个是守断言的东西没接线。这里守三件事：
//  ① 接线是真（npm script 指向真文件、CI 有独立步骤、自检失败必须非零退出）；
//  ② 取值断言与前提锁的关键实现不许被摘（摘掉就退回「词存在即通过」与「只扫 src/」）；
//  ③ M12–M15 四个变异体不许消失（判别力的载体）。
add({ id: 'S28', covers: ['scripts/verify-repo.mjs', 'package.json', '.github/workflows/ci.yml'], name: '仓库判据的变异自检已接线且判别力不许回退（img-src 取值 / 前提锁扩面 / 注释遮蔽 / M12–M15）', run() {
  const V = 'scripts/verify-repo.mjs'
  const miss = []
  if (!has(V)) miss.push(`${V} 不存在`)
  const v = has(V) ? read(V) : ''
  const ci = has('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : ''
  let pkg = {}
  try { pkg = has('package.json') ? JSON.parse(read('package.json')) : {} } catch { miss.push('package.json 不是合法 JSON') }
  const script = (pkg.scripts || {})['verify:selfcheck'] || ''
  if (!script) miss.push('package.json 缺少 verify:selfcheck script')
  else {
    if (!script.includes('verify-repo.mjs')) miss.push(`verify:selfcheck 指向的不是仓库判据：${script}`)
    if (!script.includes('--self-check')) miss.push(`verify:selfcheck 丢了 --self-check（等于只跑一遍判据，判别力为 0）：${script}`)
  }
  // CI 步骤用**行级正则**匹配，不用 includes：includes 会被注释或别的脚本里的同名字符串满足
  // （S25/M16c 与 S27/M21 都踩过同型坑）。
  if (!ciHasStep(ci, 'verify:selfcheck')) miss.push('CI 没有以独立步骤跑 npm run verify:selfcheck（判据的判别力在 CI 里无人守）')
  if (v) {
    // 必须锚在**声明行**上：只测 /imgLoose/ 会被「声明被摘、引用还在」的变异体骗过（M25 实测：
    // 摘掉 `const imgLoose = …` 后文件里仍有 `imgLoose.length === 0`，断言照旧为真 → 变异体漏检）。
    if (!/const imgLoose = /.test(v)) miss.push('缺少 img-src 取值断言（imgLoose 声明）—— 收紧可被无声改回全开')
    if (!/img-src 取值落回收紧集合/.test(v)) miss.push('img-src 取值断言的标题被改名或摘掉')
    if (!v.includes("['src', 'public', 'docs', 'index.html']")) miss.push('前提锁没有扩到 src/public/docs/index.html')
    if (!v.includes('/<img[\\s/>]/i')) miss.push('前提锁丢了大小写不敏感的 <img 匹配')
    if (!v.includes('/<!--[\\s\\S]*?-->/g')) miss.push('缺少注释遮蔽 —— 说明文字里的 <img> 会被自己的检查判成标签')
    if (!/样式里没有跨源 url\(\) 图片引用/.test(v)) miss.push('缺少样式跨源图片断言的标题')
    for (const m of ['M12', 'M13', 'M14', 'M15']) if (!v.includes(`name: '${m} `)) miss.push(`变异体 ${m} 被摘掉`)
    // R23：六指令 CSP 的取值护栏（每条都是「指令在、取值被改回宽松」的形态，只验词存在的断言无感）
    for (const d of ['script-src', 'style-src', 'frame-src', 'worker-src']) {
      if (!v.includes(`dirToks('${d}')`)) miss.push(`缺少 ${d} 的取值断言（只验指令存在的话，取值被改回宽松抓不到）`)
    }
    if (!/worker-src 恰好放行 blob:\/data:/.test(v)) miss.push('worker-src 取值断言的标题被改名或摘掉（省掉它会回落 script-src 的 self）')
    if (!/CSP 声明了 frame-src 'none'/.test(v)) miss.push("缺少 frame-src 'none' 断言")
    for (const m of ['M20', 'M21', 'M22', 'M23', 'M24', 'M25']) {
      // 变异体名里可能含单引号（如 `'wasm-unsafe-eval'`），那时声明行用双引号 —— 两种都要认，
      // 否则「改名/换引号」会被误报成「被摘掉」（本检查第一次就跑出过这个假红）。
      if (!v.includes(`name: '${m} `) && !v.includes(`name: "${m} `)) miss.push(`变异体 ${m} 被摘掉（CSP 取值护栏的判别力载体）`)
    }
    if (!/process\.exit\(bad \? 1 : 0\)/.test(v)) miss.push('自检失败没有非零退出（自检本身变成恒真）')
  }
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '3 个文件 · npm script 指向真文件且带 --self-check · CI 独立步骤 · 取值断言 + 前提锁扩面 + 注释遮蔽 · M12–M15 · 自检非零退出' }
} })

// 【R22-21】判据自己不许依赖大小写不敏感文件系统：本文件与仓库判据里每一处
// 「按字面量读仓库内文件」的点，都必须能在 **git ls-files 的字面结果**里唯一命中且真实存在。
// 触发这件事的真实事故：S27 读 `.github/pull_request_template.md`（小写），而仓库实际跟踪的是
// `.github/PULL_REQUEST_TEMPLATE.md`（大写）⇒ 本地 macOS 全绿、CI（Ubuntu）判红，且红的原因
// 与工程无关、纯属路径大小写。变异体 M27 守着这条断言。
add({ id: 'S29', covers: ['scripts/check-repo-standards.mjs', 'scripts/verify-repo.mjs'], name: '判据里的仓库内读取点都按大小写敏感语义唯一命中（禁止依赖不敏感文件系统）', run() {
  const SCAN = ['scripts/check-repo-standards.mjs', 'scripts/verify-repo.mjs', 'scripts/publish-leak-scan.mjs', 'scripts/publish-leak-scan-selftest.mjs']
  // 只扫**读取点**的字面量参数：散文、变异体夹具路径、目录名都不是读取点，扫进来只会造噪音
  // （干跑实测：不限定调用点时 117 条里 24 条是噪音；限定 read/has/existsSync 后只剩目录那一类）。
  // 参数必须与 `git ls-files` 的字面结果**逐字符相等**：大小写差一个字母时 macOS 读得到、
  // Linux 读不到 —— 那正是「本地绿、CI 红」的来源，必须在这里判死。
  // 例外：`resolveTracked(…)` 自身就是「按大小写不敏感解析但要求唯一命中」的合法读取器，不扫它的参数。
  const RE = /\b(?:read|has|readFileSync|existsSync)\(\s*'([^'\n]+)'/g
  const miss = []
  let scanned = 0
  for (const f of SCAN) {
    if (!has(f)) { miss.push(`${f} 不存在`); continue }
    for (const m of read(f).matchAll(RE)) {
      const lit = m[1]
      if (isDirPath(lit)) continue          // 目录不是 git 跟踪的对象，另有断言守目录内容
      scanned++
      if (tracked.includes(lit)) continue
      const variants = tracked.filter((t) => t.toLowerCase() === lit.toLowerCase())
      miss.push(variants.length
        ? `${f} 的读取点 ${lit} 大小写与跟踪名不一致（实际是 ${variants[0]}）—— macOS 上能读到、Linux CI 上 ENOENT`
        : `${f} 的读取点 ${lit} 没有跟踪这个路径`)
    }
  }
  return { ok: miss.length === 0, detail: miss.length ? miss.slice(0, 4).join('；') : `${SCAN.length} 个判据脚本 · ${scanned} 个读取点全部与跟踪名逐字符一致` }
} })

// ── S30 本地一键必须与 CI 步骤逐条对齐（R23） ────────────────────────────
// 触发事故（R23-LEAD-05，实测）：`verify:all` 自称「本地一键」，但它是一个**陈旧聚合**——
// 缺 `typecheck`、缺 `verify:notices`、缺 `verify:size`，且从不含任何变异自检电池；
// 而 CI 实际跑 16 步（含构建、体积/许可判据、5 个自检电池）。于是「本地 `verify:all` 全绿」
// 与「CI 全绿」之间隔着一大片没人跑的面 —— 这与 R22-21（本地绿、CI 红）同族：
// **假通过的来源可以是「本地那条捷径本身不完整」**，而不是任何一条断言写错。
// 守两件事：
//  ① 存在 `verify:ci`，其 npm 步骤序列与工作流里出现的 `npm run X` 步骤**同集同序**；
//  ② `verify:all` 的步骤集合必须是 `verify:ci` 的子集（允许存在更小的本地捷径，但不许凭空多步骤）。
// 为什么要求「同序」：构建必须先于一切依赖 dist 的判据（体积/许可/自检电池），顺序错了会判未判定。
add({ id: 'S30', covers: ['package.json', '.github/workflows/ci.yml'], name: '本地一键与 CI 步骤逐条对齐（verify:ci 同集同序，verify:all 为其子集）', run() {
  const miss = []
  let pkg = {}
  try { pkg = has('package.json') ? JSON.parse(read('package.json')) : {} } catch { return { ok: false, detail: 'package.json 不是合法 JSON' } }
  const scripts = pkg.scripts || {}
  const wf = tracked.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
  if (!wf.length) return { ok: false, detail: '没有跟踪任何工作流文件（判据无从对齐）' }
  // CI 侧的 npm 步骤（去重、保持首次出现顺序）；`npm ci` 不是 `npm run`，天然不入集
  // 步骤正文解析必须同时支持单行 `run: npm run X` 与 block scalar（`run: |` + 缩进正文）——
  // 只认单行会让 `run: |` 形式的步骤**凭空消失**，于是 verify:ci 被反向误报成「多了 CI 不跑的步骤」
  // （R23REV-N2 实测：把 `run: npm run verify:notices` 改成 block scalar 后 S30 报红）。
  const ciSteps = []
  for (const f of wf) {
    if (!has(f)) { miss.push(`${f} 已跟踪但工作区缺失`); continue }
    const text = read(f)
    const lines = text.split('\n')
    for (const r of ciRunBodies(text)) {
      for (const n of r.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) if (!ciSteps.includes(n[1])) ciSteps.push(n[1])
    }
    // R23REV-N1：`if: false` 会让「同集同序」在**CI 永不执行**的情况下同时为真。
    // 窗口判定：从 `if:` 行往下，直到出现缩进 ≤ 该行的新键为止，窗口里出现 `npm run` 即命中。
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)if:\s*(.*)$/)
      if (!m) continue
      const val = m[2].trim().replace(/^['"]|['"]$/g, '')
      if (!/^(false|\$\{\{\s*false\s*\}\})$/.test(val)) continue
      const indent = m[1].length
      let hit = false
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (!l.trim()) continue
        const li = l.match(/^\s*/)[0].length
        // 新步骤（`- name:` 形式的列表项）或缩进更浅的新键 ⇒ 窗口结束
        if (/^\s*- /.test(l) && li <= indent) break
        if (li < indent && /^\s*[A-Za-z_-]+:/.test(l)) break
        // 同缩进的键行属于同一个 step（`if:` 与自身的 `run:` 缩进相同），必须留在窗口内
        if (/\bnpm run [A-Za-z0-9:_-]+/.test(l)) { hit = true; break }
      }
      if (hit) miss.push(`${f}:${i + 1} 的 \`if: false\` 关掉了承载 npm run 的 job/步骤 —— CI 不会执行它，「同集同序」在此恒真`)
    }
  }
  const chain = (name) => (scripts[name] || '').split('&&').map((s) => s.trim())
    .map((s) => (s.match(/^npm run ([A-Za-z0-9:_-]+)$/) || [])[1]).filter(Boolean)
  const ciLocal = chain('verify:ci')
  if (!scripts['verify:ci']) miss.push('package.json 缺少 verify:ci（与 CI 逐条对齐的一键）')
  else {
    const missing = ciSteps.filter((s) => !ciLocal.includes(s))
    const extra = ciLocal.filter((s) => !ciSteps.includes(s))
    if (missing.length) miss.push(`verify:ci 少了 CI 在跑的步骤：${missing.join('、')}`)
    if (extra.length) miss.push(`verify:ci 多了 CI 不跑的步骤：${extra.join('、')}`)
    if (!missing.length && !extra.length && ciLocal.join(',') !== ciSteps.join(',')) {
      miss.push(`verify:ci 与 CI 顺序不一致（构建必须先于依赖 dist 的判据）`)
    }
  }
  const allLocal = chain('verify:all')
  if (!scripts['verify:all']) miss.push('package.json 缺少 verify:all（本地快速一键）')
  else {
    const ghosts = allLocal.filter((s) => !ciLocal.includes(s))
    if (ghosts.length) miss.push(`verify:all 里有 CI 侧不存在的步骤：${ghosts.join('、')}`)
  }
  return {
    ok: miss.length === 0,
    detail: miss.length ? miss.slice(0, 4).join('；')
      : `${wf.length} 个工作流 · CI 侧 ${ciSteps.length} 个 npm 步骤 · verify:ci 同集同序 · verify:all 为 ${allLocal.length} 步子集`,
  }
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
