// R15：把运行根的判据 check-repo-standards.mjs（S1–S24）移植成**仓库内**脚本。
//
// 移植时必做三处适配（不照抄）：
//  1. 根目录改为「脚本自身位置的上两级」，并支持 STD_ROOT 覆盖（变异自检要用副本）。
//  2. S20（hints.ts 死导出）原先搜索范围含运行根 `RUN/lib/*.mjs`；仓库里没有运行根 →
//     搜 src/ 与 scripts/ 下所有模块，规则不变（必须被真的 import 过）。
//  3. S23 原先 spawn 运行根的 check-runmd-doc.mjs（D0–D19）→ 仓库内改为可独立机检的等价物：
//     RUN.md 里提到的每个文件路径必须真实存在（这是 D0–D19 里与「文档与源码一致」最相关、
//     且不依赖运行根的那部分；其余文本口径检查留在运行根）。
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.STD_ROOT ? path.resolve(process.env.STD_ROOT) : path.resolve(HERE, '..')
const R = (rel) => path.join(ROOT, rel)
const read = (rel) => readFileSync(R(rel), 'utf8')
const has = (rel) => existsSync(R(rel))
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts })
// R38-LEAD-02：spawn 自身失败（如环境里没有 ruby）必须与「内容缺陷」区分开，
// 否则 spawnSync 返回 { status: null, stderr: null } 会被报成『YAML 非法：null』。
const shErr = (r) => (r && r.error ? (r.error.code || r.error.message || 'spawn 失败') : null)
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
  // 【R25 / W25E-04（P3）】零样本纪律：README 里一个相对链接都没有时，`links.filter(...)` 恒为空
  // ⇒ 打出 `[OK] S1 | … | 0 个相对链接全部可达` 的空真命题（W25-E 实测）。与 S3 的写法一致：
  // 样本为 0 判**不通过**（本判据的 ck 只有两态，没有第三种「未判定」；口径见 S3 同一行）。
  if (links.length === 0) return { ok: false, detail: 'README 里没有任何相对链接 —— 没有样本，覆盖面不完整，不得判通过' }
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
  const envErr = shErr(r)
  // 前提不成立（找不到 ruby 等）不是内容缺陷：单独报，且点名是环境问题（R38-LEAD-02）
  if (envErr) return { premise: true, err: `前提不成立：无法执行 ruby（${envErr}）—— 解析 ${rel} 需要系统 ruby；这是环境问题，不是内容缺陷` }
  if (r.status !== 0) {
    const line = (r.stderr || '').split('\n').find((l) => l.includes('Error'))
    const fallback = (r.stderr || '').trim().split('\n').slice(-1)[0] || `ruby 退出码 ${r.status} 且无输出`
    return { err: 'YAML 非法：' + (line || fallback) }
  }
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
add({ id: 'S24', covers: [], name: '仓库根、.github、scripts、docs、pb-bin 下的每个受管文件都被本判据的某条断言覆盖（新文件没人查即红）', run() {
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

  const watched = [...onDisk('.github'), ...rootDocs, ...onDisk('scripts'), ...onDisk('docs'), ...onDisk('pb-bin')]
  // 只认【具体文件】的归属声明：通配会让「新加文件没人管」永远看不出来。
  const covered = new Set()
  for (const c of CHECKS) for (const v of c.covers || []) if (!v.includes('*')) covered.add(v)
  const missing = watched.filter((f) => !covered.has(f))
  // 定向归属：工作流文件的实质检查只可能在 S15，被别的断言（如「能解析」的 S22）覆盖不算数。
  const wfOwner = new Set((CHECKS.find((c) => c.id === 'S15')?.covers || []).filter((v) => !v.includes('*')))
  for (const f of watched) {
    if (/^\.github\/workflows\/.+\.ya?ml$/.test(f) && !wfOwner.has(f)) missing.push(`${f}（未被 S15 逐个检查，只是被别的断言覆盖）`)
  }
  // 【R25 / W25E-03（P2）】零样本纪律：三个受管来源全空时 `missing` 恒为空 ⇒ 打出
  // `[OK] S24 | … | 0 个受管文件全部有归属` 的空真命题（W25-E 实测：受管面为空 ⇒ 通过 5、失败 0、exit 0）。
  // 逐来源点名，避免「只有一个来源被掏空」也被算成有样本。
  const emptySources = [['.github', onDisk('.github')], ['根文档', rootDocs], ['scripts', onDisk('scripts')], ['docs', onDisk('docs')], ['pb-bin', onDisk('pb-bin')]]
    .filter(([, arr]) => arr.length === 0).map(([n]) => n)
  if (emptySources.length) {
    return { ok: false, detail: `受管来源为空：${emptySources.join('、')} —— 没有样本，覆盖面不完整，不得判通过` }
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
    // 【R23 第四次重锚】「产物是不是这份源码构建的」这条前提不许被摘掉 —— 摘掉就会回到
    // 「本地用陈旧 dist 重锚 ⇒ 本地 16/16 全绿、CI 一跑就红」（PR #27 实际发生过）。
    if (!/const SOURCE_FINGERPRINT = '(?:[a-f0-9]{64}|PLACEHOLDER_SOURCE_FINGERPRINT)'/.test(g))
      miss.push('判据没有 SOURCE_FINGERPRINT 常量（dist 与源码同源这一前提被摘掉了）')
    if (!/dist 与源码同源/.test(g)) miss.push('判据没有「dist 与源码同源」的 N0 前提块')
    // 注：写这个常量的重锚工具是审计运行根里的 lib/size-reanchor.mjs，**不在本仓库**（不属于产物
    // 的一部分），故这里不要求它存在。错锚的兜底是判据自己：源码指纹一对不上就判未判定，
    // 而 CI 必然在干净检出上跑（PR #27 就是这么抓到本地那次错锚的）。
  }
  const mut = has(MUT) ? read(MUT) : ''
  // 前提要有变异体守着：只测「源码漂移」不测「原样复制」无法排除复制本身触发（假阳性）；
  // 只测复制不测漂移则等于没测。
  for (const id of ['m8a-src-copied-control', 'm8b-src-drift']) if (!mut.includes(id)) miss.push(`变异体 ${id} 不存在（同源前提失去判别力证明）`)
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
    if (!/buf\.includes\(0\)/.test(g)) miss.push('闸门没有按内容判二进制（整份文件的 NUL 字节；只看前 8KB 会让「前半 ASCII 后半 UTF-16」整类漏检，W26E-03）')
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
    // 电池的覆盖面：18 阳性 + 3 阴性 + 未判定语义（读不到 / 扫描面为空）+ 提示区 + 自扫
    for (const k of ['m1 ', 'm5 ', 'm8 ', 'm13', 'm14', 'm15', 'm16', 'm17', 'm18', 'n1 ', 'n2 ', 'n3 ', 'u1 ', 'u2 ', 'i1 ', 'i2 ', 's1 自扫真实仓库']) {
      if (!m.includes(k)) miss.push(`电池缺场景 ${k.trim()}`)
    }
    // R28 W28D-05 附带：`git ls-files` 默认把非 ASCII 路径加引号转义（`"docs/\346…md"`）⇒ 闸门读不到，
    // 把真实存在的文件记成「索引有而文件不在」→ voided → exit 2 假未判定。
    // 两条断言：① 闸门必须用 `-z`（NUL 分隔的原始路径）；② 不许再出现「无 -z 的 ls-files 读法」。
    if (!/function gitZ\(args\)/.test(g)) miss.push('闸门没有 gitZ 助手（非 ASCII 路径会被 quotePath 转义 ⇒ 假未判定）')
    if (!/args\.concat\(\['-z'\]\)/.test(g)) miss.push('闸门的 gitZ 没有追加 -z（路径仍是转义形态）')
    // 反向断言：所有 ls-files 读法都必须走 gitZ（漏一处就还会转义）。
    // 用行锚定匹配「execFileSync('git', ['ls-files' …」，允许 `--others` 等选项但不允许直接 split('\n')。
    const rawLsFiles = (g.match(/execFileSync\('git',\s*\['ls-files'/g) || []).length
    if (rawLsFiles !== 0) miss.push(`闸门里还有 ${rawLsFiles} 处裸 \`git ls-files\` 读法（必须全部走 gitZ）`)
    if (!/非 ASCII|quotePath/.test(g)) miss.push('闸门源码里没有说明 quotePath / 非 ASCII 路径的注释（后人会把它改回去）')
    // R25 / W25E-01（P1）：二进制**不许整份跳过** —— 旧形态「前 8KB 有 NUL 就 continue」实测放行含 ghp_ 的文件。
    // R26 / W26E-01…E-09（P1/P2）：v2 的形态是「只扫了一种解读」（只加了一个 UTF-16LE 视图，且要
    // 前 8KB 的 NUL 密度够高、按字节 0 对齐、不解压）。下面这些断言把 v3 的**每一块机制**钉住：
    // 少任何一块，对应的漏检形态就会回来（电池的 m19–m31 是行为侧的证据，这里是结构侧）。
    if (!/const \{ views, archiveError \} = viewsFor\(buf\)/.test(g)) miss.push('主扫描循环没有走 viewsFor（多解读视图）—— 会退回「只扫一种解读」的 v2 形态')
    if (!/if \(isBinary && !view\.decoded && !BINARY_RULES\.has\(r\.id\)\) continue/.test(g)) miss.push('规则适用面没有按**视图**判（定位类规则会退回「对整份二进制一律不跑」，UTF-16 里的公网 IP 会漏；或反过来对逐字节 latin1 视图跑，带来假红）')
    if (!/const BINARY_RULES = new Set\(/.test(g)) miss.push('闸门缺 BINARY_RULES（二进制适用规则集）—— 二进制内容会退回整份跳过')
    if (!/function decodeUtf16be\(/.test(g)) miss.push('闸门缺手写 UTF-16BE 解码（`Buffer` 不认 utf16be，会退回只认 UTF-16LE）')
    if (!/function decodeUtf32\(b, be\)/.test(g)) miss.push('闸门缺手写 UTF-32 解码（`Buffer` 不认 utf32le，直接用会抛 ERR_UNKNOWN_ENCODING 把闸门整份崩掉）')
    if (/toString\('utf32le'\)|toString\('utf16be'\)/.test(g)) miss.push('闸门把 utf32le/utf16be 当成了 Buffer 支持的编码（Node 只支持 utf16le，这样写会崩）')
    if (!/for \(const off of \[0, 1\]\)/.test(g)) miss.push('闸门没有试两种字节对齐（奇数长度前缀会让整段视图错位，W26E-04）')
    if (!/nulCount \* 4 >= head\.length/.test(g)) miss.push('闸门缺「NUL 占比极高才试 UTF-32」的门控（会在普通文本上做无谓解码）')
    if (!/function tryView\(/.test(g) || !/function plausibleText\(/.test(g)) miss.push('闸门缺视图解码的容错/文本性判定（单个视图解码失败不许让整份闸门崩掉，也不许把乱码视图当文本）')
    if (!/function normalizeText\(/.test(g) || !/normalize\('NFKC'\)/.test(g)) miss.push('闸门缺归一化（CR 行尾 / 零宽字符 / 全角同形，W26E-06/07/08）')
    if (!/\\u200B-\\u200D/.test(g)) miss.push('归一化没有剥零宽字符（令牌中间插 U+200B 会整类失配，W26E-06）')
    if (!/function archiveViews\(buf\)/.test(g) || !/gunzipSync/.test(g) || !/inflateRawSync/.test(g)) miss.push('闸门缺按魔数解压（gzip / zip(deflate) 里的凭据整类漏检，W26E-05）')
    if (!/archiveError/.test(g) || !/按魔数识别为压缩内容但解不开/.test(g)) miss.push('闸门对「识别出压缩魔数却解不开」没有判未判定（读不到 ≠ 干净）')
    if (!/MAX_INFLATED_BYTES/.test(g)) miss.push('闸门缺解压输出上限（zip bomb 会把闸门拖死）')
    // R26REV-2-02：zip 必须校验压缩方法与加密位 —— 「解不开」要判未判定，绝不能当「已扫描且干净」。
    if (!/zip 条目用了未支持的压缩方法/.test(g)) miss.push('zip 解压没校验压缩方法（method≠0/8 的载荷会被 raw inflate 解出并被当成已扫描，R26REV-2-02）')
    if (!/flags & 0x0001/.test(g)) miss.push('zip 解压没查加密标志位（general purpose bit 0）')
    if (!/u4 zip 条目用了未支持的压缩方法/.test(m)) miss.push('电池缺 u4（method=99 AES ⇒ exit 2 未判定）')
    // 行为探针的读数解析必须抓**正式报告行**（R26REV-2-01/05：原先「第一行含 BEARER + 不校验格式」，
    // 补一行普通日志就能把它骗成假绿/假红）。它读的正是本文件 ⇒ 断言串必须**运行时拼装**，
    // 直接写完整字面量会被这一行自己满足（本项目已复现六次的同类坑）。
    const self = has('scripts/check-repo-standards.mjs') ? read('scripts/check-repo-standards.mjs') : ''
    const probeNeedle = ['/', '^\\s*[', '\u2705', '\u274c', '] P', '\\d BEARER'].join('')
    if (!self.includes(probeNeedle)) miss.push('行为探针必须用「正式报告行」正则解析命中数（不许退回模糊查找，R26REV-2-01）')
    const fuzzyNeedle = ['out.split(', "'\\n')", '.find((l) => l.includes(', "'BEARER'", '))'].join('')
    if (self.includes(fuzzyNeedle)) miss.push('行为探针退回模糊查找（第一行含 BEARER 就取命中数）—— 两端都能被一行普通日志欺骗')
    if (!/isValidUtf8\(buf\)/.test(g) || !/legacy:\$\{enc\}/.test(g) || !/'gbk', 'shift_jis', 'big5'/.test(g)) miss.push('闸门缺传统 CJK 编码视图（GBK/Shift-JIS/Big5 里的全角令牌整类漏检，W26E-07）')
    if (!/跨行/.test(g) || !/new RegExp\(r\.re\.source\)\.test\(cm\[0\]\.split\('\\n'\)\[0\]\)/.test(g)) miss.push('闸门缺「令牌被换行拆开」的跨行扫描（或缺「单行部分已构成命中就不重复计数」的守卫，W26E-09）')
    // 断言必须钉在**报告行那个表达式**上：只查「文件里有没有这句话」会被 BINARY_RULES 上方那段说明注释满足
    //（M47 实测：把报告里的括号说明删掉，S27 照样绿 —— 又是「注释满足断言」那一族，本轮第 5 次）。
    if (!/binaryScanned \+ ' 个（凭据类规则照扫；定位类规则只在真实解码视图上跑，逐字节 latin1 视图不跑）/.test(g)) miss.push('闸门的扫描面报告没有写明「二进制里凭据类规则照扫、定位类规则只在真实解码视图上跑」—— 读者会把干净误读成全规则扫过')
    if (/if \(isBinary\) \{\s*\n\s*skippedBinary\+\+/.test(g)) miss.push('闸门退回「二进制整份跳过」的旧形态（W25E-01）')
    if (!/process\.exit\(1\)/.test(m)) miss.push('电池失败时不 exit 1（会把失败读成通过）')
    if (!/view: view\.name/.test(g)) miss.push('命中记录没有带上视图名（无法分辨命中来自哪种解读）')
    // 电池的覆盖面必须跟着机制走：v3 的每个机制至少要有**一个行为场景**（m19–m31 + n4 + u3）
    for (const k of ['m19', 'm20', 'm21', 'm22', 'm23', 'm24', 'm25', 'm26', 'm27', 'm28', 'm29', 'm30', 'm31', 'n4 ', 'u3 ']) {
      if (!m.includes(k)) miss.push(`电池缺 v3 场景 ${k.trim()}（机制有断言但行为无证据）`)
    }
    // 汇总行必须**现算**分类数：写死数字会在加场景时悄悄过期，而它是 CI 的读数来源（R26）
    if (!/const positives = CASES\.filter/.test(m)) miss.push('电池的汇总行写死了场景数（加场景就会说过期的话）')
    // LEAK_SCAN 覆盖通道：把旧版闸门喂进同一套电池，才能证明 m19–m31 有判别力（R26 的成对读数就靠它）
    if (!/process\.env\.LEAK_SCAN \|\|/.test(m)) miss.push('电池缺 LEAK_SCAN 覆盖通道（无法把旧版闸门喂进同一套用例做成对读数）')
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
    // ── 行为探针（R26 / W26-E 的 B 族：只靠「文本在位」的结构断言挡不住机制被摘掉）──────
    // 上面所有断言都是读源码文本。这里真造一个临时 git 仓库 + 两个文件（UTF-16BE 保存的 .env、
    // gzip 里的 .env），跑一遍**真闸门**，要求 exit 1 且 BEARER 恰好命中 2 处。
    // 机制被摘掉时（比如 UTF-16 视图整块不再生成、解压后不再复扫），它们的代码可能仍然都在、
    // 结构断言全绿 —— 只有这一条会红。这正是 W26E-10…E-13 指出的那条缺口。
    const probeDir = mkdtempSync(path.join(tmpdir(), 'facedb-s27-probe-'))
    try {
      const tok = 'token=' + 'ghp_' + 'A'.repeat(30) + '\n'
      writeFileSync(path.join(probeDir, 'u16be.env'), Buffer.from(tok, 'utf16le').swap16()) // 字节序翻成 BE
      writeFileSync(path.join(probeDir, 'gz.env.gz'), gzipSync(Buffer.from(tok, 'utf8'), { level: 9 }))
      sh('git', ['init', '-q'], { cwd: probeDir })
      sh('git', ['add', '-A'], { cwd: probeDir })
      const r = spawnSync('node', [path.join(ROOT, GATE)], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LEAK_SCAN_ROOT: probeDir } })
      const out = (r.stdout || '') + (r.stderr || '')
      const bearerLine = (out.match(/^\s*[✅❌] P\d BEARER\s.*?命中 (\d+) 处.*$/m) || [])[0] || ''
      const hits = Number((bearerLine.match(/命中 (\d+) 处/) || [])[1] || 0)
      if (r.status !== 1 || hits !== 2) miss.push(`行为探针不成立：UTF-16BE 与 gzip 里的 ghp_ 令牌应各命中 1 处、共 2 处，实得 exit=${r.status} 命中 ${hits} 处（报告行 ${bearerLine ? '「' + bearerLine.trim() + '」' : '缺失'}）—— 多解读视图 / 压缩解压这条机制实际没工作，哪怕它的代码还写着`)
    } catch (e) {
      miss.push(`行为探针没跑起来（${e.message}）—— 本次不构成「闸门能抓 UTF-16 / 压缩凭据」的结论`)
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
    }
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : '2 个文件 · 内容判二进制（整份文件 NUL）且**二进制里凭据类规则照扫**（禁扩展名白名单回退 / 禁整份跳过）· 多解读视图全套（UTF-16LE/BE × 对齐、UTF-32 门控、手写解码、容错、传统 CJK、压缩解压 + 未判定、归一化、跨行扫描去重）· 未判定 exit 2（读不到 / 扫描面为空 / 压缩内容解不开）· 阻断线默认 P1 · 15 个令牌前缀 · 提示区（被忽略的敏感命名文件 + 被忽略的整块路径）· 电池 32 阳性 / 4 阴性 / 4 未判定（含 zip 方法）/ 2 提示区（v3 场景 m19–m31、u3/u4、i2、m16 逐个在位，汇总行现算）· gitZ 路径读法（`-z`，防 quotePath 把非 ASCII 路径转义成「工作区缺失」）· **行为探针（UTF-16BE 令牌真跑一遍闸门）** · npm/CI 接线 · 文档口径一致' }
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
    // 【R26 / W26E-17…E-18】只验「变异体的声明行在不在」挡不住「原子被掏空」：把 M12–M15 的
    // `mutate: () => put(...)` 改成 `mutate: () => {}` 之后声明行还在、S28 照样 [OK]。
    // 所以逐条要求：① 该原子的体里真有一次 `put(`（真的改文件）；② 改的是**它要改的那个文件**。
    for (const [m, target] of [['M12', 'index.html'], ['M13', 'src/components/CaptureView.vue'], ['M14', 'index.html'], ['M15', 'src/style.css']]) {
      const seg = v.split(`name: '${m} `)[1]
      const block = seg ? seg.split("{ name: 'M")[0] : ''
      if (!block) { miss.push(`变异体 ${m} 的定义块定位不到（原子结构被改写）`); continue }
      if (!/mutate: \(\) => put\(/.test(block)) miss.push(`变异体 ${m} 的体里没有真正的文件写入（mutate 被掏空 ⇒ 该原子不再产生缺陷）`)
      if (!block.includes(`'${target}'`)) miss.push(`变异体 ${m} 改的不是 ${target}（改了别的文件等于没造出缺陷）`)
    }
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
// 而 CI 实际跑 18 个 npm 步骤（job1 12 + job2 7，`build` 重复一次；另有 `npm ci` ×2 与
// `docker compose config -q` 两个非 npm 步骤 —— R37 实测订正，原注释写 16 步）。于是「本地 `verify:all` 全绿」
// 与「CI 全绿」之间隔着一大片没人跑的面 —— 这与 R22-21（本地绿、CI 红）同族：
// **假通过的来源可以是「本地那条捷径本身不完整」**，而不是任何一条断言写错。
// 守两件事：
//  ① 存在 `verify:ci`，其 npm 步骤序列与工作流里出现的 `npm run X` 步骤**同集同序**；
//  ② `verify:all` 的步骤集合必须是 `verify:ci` 的子集（允许存在更小的本地捷径，但不许凭空多步骤）。
// 为什么要求「同序」：构建必须先于一切依赖 dist 的判据（体积/许可/自检电池），顺序错了会判未判定。
add({ id: 'S30', covers: ['package.json', '.github/workflows/ci.yml'], name: '本地一键与 CI 步骤逐条对齐（verify:ci 同集同序含非 npm 步骤，verify:all 为其子集）', run() {
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
  // 【R37】非 npm 步骤同样必须在集内：原先 S30 只把 `npm run X` 收进集，
  // CI 里新增任何**别的命令**（`curl …`、`docker push …`）都不进集，
  // 于是「同集同序」对它恒真（W37-A M1 实测：加一条 `- run: curl …` 后 judge 仍 exit 0）。
  // 两个方向都守：多一条未登记命令 ⇒ 报红；少一条已登记命令 ⇒ 也报红（删步骤不许静默）。
  const NON_NPM_ALLOWED = ['npm ci', 'docker compose config -q']
  const seenNonNpm = new Set()
  const strayNonNpm = []
  for (const f of wf) {
    if (!has(f)) continue
    for (const body of ciRunBodies(read(f))) {
      const one = body.trim()
      if (!one) continue
      if (/^npm run [A-Za-z0-9:_-]+$/.test(one)) continue
      seenNonNpm.add(one)
      if (!NON_NPM_ALLOWED.includes(one)) strayNonNpm.push(one.slice(0, 60))
    }
  }
  if (strayNonNpm.length) miss.push(`CI 有未登记的 run 命令（非 npm run）：${[...new Set(strayNonNpm)].join('、')}`)
  const goneNonNpm = NON_NPM_ALLOWED.filter((s) => !seenNonNpm.has(s))
  if (goneNonNpm.length) miss.push(`CI 少了已登记的非 npm 步骤：${goneNonNpm.join('、')}`)
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
      : `${wf.length} 个工作流 · CI 侧 ${ciSteps.length} 个 npm 步骤 + ${seenNonNpm.size} 个非 npm 步骤（已登记 ${NON_NPM_ALLOWED.length}） · verify:ci 同集同序 · verify:all 为 ${allLocal.length} 步子集`,
  }
} })

// ── S31 判据自检的副本 worktree 必须「清理可观测 + 被打断后自愈」（R24-01） ────────
// 背景（R24 实测）：`cleanup()` 忽略 `git worktree remove` 的退出码 ⇒ 失败静默；
// 进程被 SIGINT/SIGTERM 打断时完全不清理 ⇒ 副本目录与 worktree 注册双双留在主仓库里
// （实测 143/130 + 残留 1/1）；而只加 JS 信号处理器不算兜底（阻塞在 spawnSync 时信号被推迟，
// 末尾 process.exit 又不排队 ⇒ 处理器可能永不执行）。真正的兜底是下次运行开局的 sweepStale()。
add({ id: 'S31', covers: ['scripts/verify-standards-selftest.mjs'], name: '判据自检的副本 worktree 清理可观测，且历史残留能在下次运行开局自愈', run() {
  const f = 'scripts/verify-standards-selftest.mjs'
  if (!has(f)) return { ok: false, detail: '缺 ' + f }
  const raw = read(f)
  // 【R24-01 二次修复】S31 原先用 `g.includes('sweepStale()')` / `includes('const cleanOk = cleanup()')`，
  // 结果**被这个文件自己的变异体定义行满足**（M37/M38 的 `apply:` 里就写着这两个字面量），
  // 删掉真实调用/判定也照样绿 —— 与 R13-F9/R22/R23 同族的「断言文本自匹配」。
  // 修法两条并用：① 先剥掉 `const M = [ … ]` 变异体数组，只审代码；
  //              ② 断言改**行锚定正则**（调用行、判定式整行），不再用「随便哪里出现」的子串。
  const g = raw.replace(/^const M = \[[\s\S]*?^\]$/m, '// <变异体数组已剥离>\n')
  const stripped = g.length < raw.length
  const need = [
    ['开局清扫历史残留（必须是调用行，不能只留函数定义）', /^sweepStale\(\)$/m],
    ['清扫紧挨着 cleanup()（顺序：先清扫历史、再清理本次）', /^sweepStale\(\)\ncleanup\(\)$/m],
    ['按 pid 判存活（不许误删并发实例的副本）', /^const pidAlive = \(pid\) => \{$/m],
    ['清扫要用 pidAlive 而不是无条件删', /^    if \(pidAlive\(pid\)\) continue/m],
    ['清扫只认本脚本的副本命名前缀（正向）', /^    if \(!base\.startsWith\(WT_PREFIX\)\) continue$/m],
    ['清扫只认本脚本的副本命名前缀', /WT_PREFIX = 'facedb-standards-selftest-'/],
    ['worktree remove 失败要回退 prune', /'worktree', 'prune'/],
    ['清理结果必须进判定（不许静默）', /^const cleanOk = cleanup\(\)$/m],
    ['判定式必须同时要求清理干净', /const ok = caught === M\.length && neg\.code === 0 && cleanOk/],
    ['目录残留检查', /existsSync\(WT\)/],
    ['注册残留检查', /'worktree', 'list'/],
    ['清理失败要打印告警', /⚠️ 副本清理未完成/],
    ['汇总行如实报告清理结果', /副本已清理/],
    ['保留信号处理器（但注释已写明不是兜底）', /process\.on\(sig/],
  ]
  const miss = need.filter(([, re]) => !re.test(g)).map(([n]) => n)
  if (!stripped) miss.push('变异体数组剥离失败（S31 审的是整份文件，断言文本可能自匹配）')
  // 反向断言：不许把「残留」当成通过 —— 判定必须同时要求 caught 全中、阴性对照绿、清理干净。
  if (!/caught === M\.length && neg\.code === 0 && cleanOk/.test(g)) miss.push('判定式必须同时要求清理干净（caught && neg.code===0 && cleanOk）')
  return {
    ok: miss.length === 0,
    detail: miss.length ? '缺：' + miss.join('、') : '清扫（pid 存活判定）+ remove 退出码 + prune 回退 + 清理结果进判定 + 告警与汇总行 + 信号处理器非兜底注释 全部在位',
  }
} })

// ── S32 判据的运行落点与采样必须并发安全（R24 / W24-E-01·03·05·06） ────────────
// 背景（W24-E 实测）：三处判据把临时落点写死在共享路径上，或在不同时刻各读一次同一份文件。
// 并发一跑就出事：`verify-repo --self-check` 的 `.verify-selfcheck`（并发 6 次里 4 次 exit=1，
// EINVAL/ENOTEMPTY/ENOENT 齐全，A 崩溃时 B 仍可能判「30/30 符合预期」）、
// 第三方许可变异自检的 `/tmp/r20-f7-notices-mutants`（6 次里 5 次崩）、
// 以及 size 判据「N4 实测 17771418 B 判 OK」+「N9 sha 不符判 FAIL」的单轮自相矛盾。
add({ id: 'S32', covers: ['scripts/verify-repo.mjs', 'scripts/check-dist-size-budget.mjs', 'scripts/check-third-party-notices-mutants.mjs'], name: '判据的运行落点按次唯一，且一次运行的采样自洽（不许固定 /tmp 路径、不许同一文件分次读）', run() {
  const miss = []
  const text = (rel) => (has(rel) ? read(rel) : null)

  const vr = text('scripts/verify-repo.mjs')
  if (vr === null) miss.push('缺 scripts/verify-repo.mjs')
  else {
    if (!/mkdtempSync\(join\(tmpdir\(\), 'facedb-verify-selfcheck-'\)\)/.test(vr)) miss.push('verify-repo 自检副本改 mkdtemp（每次运行唯一）')
    if (vr.includes("'.verify-selfcheck'")) miss.push('verify-repo 仍把自检副本落在仓库内固定路径 .verify-selfcheck')
    if (!/const READ_CACHE = new Map\(\)/.test(vr) || !/function readStable\(/.test(vr)) miss.push('verify-repo 缺 readStable 快照缓存')
    if (!/const read = \(rel\) => readStable\(/.test(vr)) miss.push('verify-repo 的 read() 必须走 readStable')
    if (!/const src = readStable\(p\)/.test(vr)) miss.push('verify-repo 的 scanFile 必须走 readStable（否则与 checkCsp 读到两个版本）')
    if (!/本次采样不自洽，不构成结论/.test(vr)) miss.push('verify-repo 缺「运行期文件被改动」的自洽守卫')
  }

  const nm = text('scripts/check-third-party-notices-mutants.mjs')
  if (nm === null) miss.push('缺 scripts/check-third-party-notices-mutants.mjs')
  else {
    if (!/mkdtempSync\(path\.join\(tmpdir\(\), 'facedb-notices-mutants-'\)\)/.test(nm)) miss.push('许可变异自检改 mkdtemp')
    if (nm.includes("'/tmp/r20-f7-notices-mutants'")) miss.push('许可变异自检仍硬编码 /tmp/r20-f7-notices-mutants')
  }

  const sz = text('scripts/check-dist-size-budget.mjs')
  if (sz === null) miss.push('缺 scripts/check-dist-size-budget.mjs')
  else {
    if (!/const SNAP = new Map\(\)/.test(sz)) miss.push('体积判据缺一次采样快照 SNAP')
    if (!/const snapDigest = \(f\) =>/.test(sz)) miss.push('体积判据缺 snapDigest')
    if (/raw \+= statSync\(path\.join\(DIST, f\)\)\.size/.test(sz)) miss.push('体积判据 N4 仍在断言里单独 statSync')
    if (/const got = sha256\(p\)/.test(sz)) miss.push('体积判据 sha 断言仍在断言里单独读盘')
    // 【R24 复核席修正】原断言只看「短语在某处出现」——而注释里也写着同一短语，
    // 于是「把守卫从代码里摘掉、注释留着」仍绿（M41 因此漏检）。改为**代码锚定**：
    // 必须存在真实的 `c.check('N0 环境前提：一次采样自洽…` 与 `c.un('N0 环境前提：一次采样自洽…` 调用。
    if (!/c\.check\('N0 环境前提：一次采样自洽/.test(sz)) miss.push('体积判据缺采样自洽守卫的 check 分支（注释不算）')
    if (!/c\.un\(\s*'N0 环境前提：一次采样自洽/s.test(sz)) miss.push('体积判据缺采样自洽守卫的 un 分支（注释不算）')
  }
  return {
    ok: miss.length === 0,
    detail: miss.length ? '缺：' + miss.join('、') : '三处落点均按次唯一（mkdtemp / 快照）+ 采样自洽守卫在位（verify-repo 的 .verify-selfcheck、许可自检的 /tmp 固定路径、体积判据的 N4 单独 statSync 都不会再回来）',
  }
} })

add({ id: 'S33', covers: ['scripts/check-repo-config-hygiene.mjs', 'scripts/check-repo-config-hygiene-selftest.mjs', 'scripts/fixtures/check-repo-config-hygiene.prefix-v1.mjs', 'package.json', '.github/workflows/ci.yml'], name: '配置卫生判据不许退化成空真命题（零样本判未判定、退出码三态、读不到不裸栈），且自检接进 CI', run() {
  const miss = []
  const hy = has('scripts/check-repo-config-hygiene.mjs') ? read('scripts/check-repo-config-hygiene.mjs') : null
  const st = has('scripts/check-repo-config-hygiene-selftest.mjs') ? read('scripts/check-repo-config-hygiene-selftest.mjs') : null
  if (hy === null) miss.push('缺 scripts/check-repo-config-hygiene.mjs')
  else {
    // 零样本：四条断言各自都要有「样本为 0 ⇒ unk」的分支，不许只剩 ck(ok=true)
    if (!/const unk = \(label, detail = ''\) => \{/.test(hy)) miss.push('缺未判定计数器 unk()')
    if (!/else if \(gaRules\.length === 0\) unk\('A1/.test(hy)) miss.push('A1 缺「规则数 0 ⇒ 未判定」分支')
    if (!/else if \(sections\.length === 0\) unk\('A2/.test(hy)) miss.push('A2 缺「段落数 0 ⇒ 未判定」分支')
    if (!/else if \(textish\.length === 0\) unk\('A3/.test(hy)) miss.push('A3 缺「文本类 0 个 ⇒ 未判定」分支')
    if (!/sums\.length === 0\)[\s\S]{0,40}unk\('A5/.test(hy)) miss.push('A5 缺「登记项 0 个 ⇒ 未判定」分支')
    if (!/const trackedOk = /.test(hy)) miss.push('缺 trackedOk 前提（列不出已跟踪文件时 A1/A2 不许判「全部零命中」）')
    // 健壮性：读文本要经守卫，不许裸 readFileSync 配置
    if (!/const readText = \(abs\) => \{/.test(hy)) miss.push('缺 readText 守卫')
    if (/readFileSync\(gaPath|readFileSync\(ecPath|readFileSync\(sumsPath/.test(hy)) miss.push('配置文件仍被裸 readFileSync 读')
    // 退出码三态 + 汇总行
    if (!/process\.exit\(fail > 0 \? 1 : un > 0 \? 2 : 0\)/.test(hy)) miss.push('退出码不是三态（失败 1 / 未判定 2 / 通过 0）')
    if (!/未判定 \$\{un\}/.test(hy)) miss.push('汇总行未打印未判定数')
    // R25REV-N2（P3）：A5 原先**无条件** ck（先 ✅ 再 ⚠️）—— 零样本/读不到时同一断言行两种结论并存，
    // 通过计数被垫高。要求 ck 落在 else 分支里（三态互斥）。
    if (!/\} else \{\s*\n\s*ck\('public\/SHA256SUMS 登记的每项都与磁盘一致'/.test(hy)) miss.push('A5 的 ck 不在 else 分支里（零样本时同一行会同时出现 ✅ 与 ⚠️，R25REV-N2 回归）')
  }
  if (st === null) miss.push('缺 scripts/check-repo-config-hygiene-selftest.mjs')
  else {
    if (!/mkdtempSync\(path\.join\(tmpdir\(\), 'facedb-hyg-selftest-'\)\)/.test(st)) miss.push('电池必须为每个场景建独立临时仓库')
    if (!/HYG_SCAN/.test(st)) miss.push('电池缺 HYG_SCAN 覆盖通道（成对读数用）')
    // 【R25 收口发现，P2】阴性对照的基线**不许锚在 HEAD、也不许现取 git 历史**：
    //   · 锚 HEAD：修复提交一落地 HEAD 就变成「已经修好的树」⇒ 对照崩塌（R14 / R21 / R25 三次同型）；
    //   · 现取历史（`git show <ref>:`）：CI 的 checkout 默认是浅克隆（fetch-depth 1），历史提交不在
    //     本地 ⇒ 取不到、对照被跳过、自检以 exit 2 收尾（R25 PR #29 首跑实测）。
    // ⇒ 修复前版本冻结成 `scripts/fixtures/` 下的快照，对克隆深度 / 网络 / 历史改写全部免疫。
    if (/'show', 'HEAD:scripts\/check-repo-config-hygiene\.mjs'/.test(st)) miss.push('阴性对照的基线不许锚在 HEAD（它会随修复提交移动）')
    if (/HYG_BASE_REF/.test(st)) miss.push('电池不许再依赖 git 历史取基线（浅克隆下取不到 ⇒ 对照被跳过）')
    if (!/fixtures', 'check-repo-config-hygiene\.prefix-v1\.mjs'/.test(st)) miss.push('电池必须读冻结基线快照（scripts/fixtures/check-repo-config-hygiene.prefix-v1.mjs）')
    if (!/process\.env\.HYG_BASELINE/.test(st)) miss.push('冻结基线必须可用 HYG_BASELINE 覆盖（成对读数用）')
    if (!/已经含有本轮修复/.test(st)) miss.push('缺「基线里已含修复 ⇒ 判未判定」的装置前提（否则锚错会被误报成修复无效）')
    if (!/noStack/.test(st)) miss.push('电池缺「不许裸栈」断言')
    if (!/notHas: \['✅ public\/SHA256SUMS 登记的每项都与磁盘一致'\]/.test(st)) miss.push('电池缺 A5 的「零样本时不许出现 ✅ 行」断言（R25REV-N2 回归）')
    if (!/process\.exit\(fail > 0 \? 1 : skipped > 0 \? 2 : 0\)/.test(st)) miss.push('电池退出码必须是三态：失败 1 / 有跳过项 2（未判定） / 0')
    // 冻结基线快照本身也要守：它必须存在、必须是「修复前」的形态、必须带 provenance 头。
    // 少了第一条 ⇒ 阴性对照整条被跳过；少了第二条 ⇒ 对照变成「两侧都成立」的恒真。
    const FX = 'scripts/fixtures/check-repo-config-hygiene.prefix-v1.mjs'
    if (!has(FX)) miss.push('冻结基线快照不存在（阴性对照会整条被跳过）')
    else {
      const fx = read(FX)
      if (/trackedOk|function unk\(/.test(fx)) miss.push('冻结基线里出现了修复版标记 —— 它已不是「修复前」的形态，阴性对照失去意义')
      if (!/provenance/.test(fx)) miss.push('冻结基线缺 provenance 头（无法复核它取自哪个提交）')
    }
  }
  const ci = has('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : ''
  if (ci === '') miss.push('缺 .github/workflows/ci.yml')
  else if (!ciHasStep(ci, 'verify:hygiene-selftest')) miss.push('CI 缺 verify:hygiene-selftest 独立步骤')
  // 【R25 / W25E-03、W25E-04（P2/P3）】本判据自己的两条空真命题守卫：S1（README 里 0 个相对链接）
  // 与 S24（受管来源为空）在样本为 0 时都曾打出 ✅。守卫必须留在源码里，否则修复会被静默回退。
  const rs = read('scripts/check-repo-standards.mjs')
  if (!/if \(links\.length === 0\) return \{ ok: false/.test(rs)) miss.push('S1 缺「没有相对链接 ⇒ 不得判通过」守卫')
  if (!/if \(emptySources\.length\)/.test(rs)) miss.push('S24 缺「受管来源为空 ⇒ 不得判通过」守卫')
  const pkg = has('package.json') ? read('package.json') : ''
  if (!/"verify:hygiene-selftest": "node scripts\/check-repo-config-hygiene-selftest\.mjs"/.test(pkg)) miss.push('package.json 缺 verify:hygiene-selftest')
  if (!/verify:publish-selftest && npm run verify:hygiene-selftest"/.test(pkg)) miss.push('verify:ci 未包含 verify:hygiene-selftest')
  if (/verify:all[^"]*verify:hygiene-selftest/.test(pkg)) miss.push('verify:hygiene-selftest 不许塞进 verify:all（本地捷径只跑非 dist 子集）')
  return { ok: miss.length === 0, detail: miss.length ? '缺：' + miss.join('、') : '零样本四分支 + 前提 + 读文本守卫 + 三态退出码 + 电池（独立临时仓库/覆盖通道/阴性对照/裸栈断言）+ npm script + CI 独立步骤 全部在位' }
} })

// 【R25-INCIDENT-02（P1）】共享 node_modules 里的 `vue-tsc` 入口曾被写成 17 字节的
// `#!/bin/sh\nexit 0\n` 桩 ⇒ `npx vue-tsc --noEmit` 恒 exit 0 零输出，`npm run typecheck`
// 与 CI 的类型检查步骤整段空转。`verify:types` 的阳性对照当时判出了「不构成结论」，但把
// 「二进制被换成桩」与「检查器逻辑不判别」混成一条结论 —— 这里把该支钉住：判据必须有
// 可执行文件真实性前提（静态 + `--version` 行为），自检电池必须把两支分别验到。
add({ id: 'S34', covers: ['scripts/typecheck-guard.mjs', 'scripts/typecheck-guard-selftest.mjs', 'package.json', '.github/workflows/ci.yml'], name: '类型检查判据能识别「可执行文件被桩替换」（与「不判别」分开判），且自检电池与接线在位', run() {
  const miss = []
  const g = has('scripts/typecheck-guard.mjs') ? read('scripts/typecheck-guard.mjs') : null
  const b = has('scripts/typecheck-guard-selftest.mjs') ? read('scripts/typecheck-guard-selftest.mjs') : null
  if (g === null) miss.push('缺 scripts/typecheck-guard.mjs')
  else {
    if (!/process\.env\.TCG_ROOT \|\|/.test(g)) miss.push('判据缺 TCG_ROOT 覆盖通道（自检电池靠它造桩现场）')
    // 下限必须很小：真 vue-tsc 的入口本身就是 50 字节的转发壳，阈值放到 200 会把真件判成桩。
    if (!/const MIN_BIN_BYTES = Number\(process\.env\.TCG_MIN_BIN_BYTES \|\| 24\)/.test(g)) miss.push('缺可执行文件真实性下限（且必须是小值：真入口只有 50 字节）')
    if (!/vue-tsc', 'package\.json'/.test(g)) miss.push('可执行文件入口必须按 vue-tsc 自己的 package.json bin 声明解析')
    if (!/可执行文件被桩替换/.test(g)) miss.push('缺「可执行文件被桩替换」这一支的结论行')
    if (!/没有给出可用的版本号/.test(g)) miss.push('缺 `vue-tsc --version` 行为前提（能报版本才算装上）')
    if (!/可执行文件真实性：/.test(g)) miss.push('缺成立时的可执行文件真实性读数行')
    if (!/shellish/.test(g) || !/isJs/.test(g)) miss.push('缺「shell shebang / 不是 JS」两条静态判据')
    // R26 / W26E-14：入口解析不出来时必须判未判定，不许静默跳过（删掉一个 package.json 就能让整段护栏消失）。
    if (!/无法解析 vue-tsc 的入口/.test(g)) miss.push('入口解析失败这一支必须明确判「无法验证」（不许静默跳过真实性检查）')
    if (!/本轮无法验证/.test(g)) miss.push('入口解析失败时缺「本轮无法验证 ⇒ 不构成结论」的口径行')
  }
  if (b === null) miss.push('缺 scripts/typecheck-guard-selftest.mjs')
  else {
    for (const s of ['s1 真 vue-tsc', 's2 shell 桩', 's3 node 空转桩', 's4 像真件但不判别', 's6 入口读不到', 's7 真仓库的 vue-tsc 本体未被本电池改动']) {
      if (!b.includes(s)) miss.push(`自检电池缺场景：${s}`)
    }
    if (!/mkdtempSync\(path\.join\(tmpdir\(\)/.test(b)) miss.push('自检电池必须每场景用 mkdtemp 建独立临时树')
    // 临时树的 node_modules 必须是真目录：做成整目录软链会让桩写穿到真仓库（事故成因）。
    if (!/name === 'vue-tsc' \|\| name === '\.bin'\) continue/.test(b)) miss.push('自检电池不许把整个 node_modules 软链过去（会写穿到真仓库）')
    if (!/path\.delimiter/.test(b) || !/node_modules', '\.bin'/.test(b)) miss.push('自检电池必须把临时树的 .bin 放 PATH 最前（否则 npx 解析到真仓库，场景静默失效）')
    if (!/process\.exit\(ok \? 0 : 1\)/.test(b)) miss.push('自检电池失败必须 exit 1')
  }
  const ci = has('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : ''
  if (ci === '') miss.push('缺 .github/workflows/ci.yml')
  else if (!ciHasStep(ci, 'verify:types-selftest')) miss.push('CI 缺 verify:types-selftest 独立步骤')
  const pkg = has('package.json') ? read('package.json') : ''
  if (!/"verify:types-selftest": "node scripts\/typecheck-guard-selftest\.mjs"/.test(pkg)) miss.push('package.json 缺 verify:types-selftest')
  if (!/verify:types && npm run verify:types-selftest && npm run typecheck/.test(pkg)) miss.push('verify:ci 里 verify:types-selftest 必须紧挨 verify:types（与 CI 同集同序）')
  if (/verify:all[^"]*verify:types-selftest/.test(pkg)) miss.push('verify:types-selftest 不许塞进 verify:all（本地捷径只跑非 dist 子集）')
  return { ok: miss.length === 0, detail: miss.length ? '缺：' + miss.join('、') : '真实性前提（静态 shell/JS + --version 行为 + bin 声明解析）+ TCG_ROOT 覆盖 + 电池 6 场景（含入口读不到）+ 临时树隔离（不软链整个 node_modules / PATH 指向本树）+ npm script + CI 独立步骤 全部在位' }
} })

add({ id: 'S35', covers: ['scripts/verify-repo.mjs'], name: '迁移语法检查把「node --check 跑不起来」判未判定，不许记成迁移的语法错误（且判据自检里有对应的反向断言）', run() {
  const miss = []
  const v = has('scripts/verify-repo.mjs') ? read('scripts/verify-repo.mjs') : null
  if (v === null) miss.push('缺 scripts/verify-repo.mjs')
  else {
    // 前提探针：证明 --check 本身可用（tmpdir 里的已知合法文件）。
    if (!/facedb-nodecheck-probe-/.test(v)) miss.push('缺前提探针（对已知合法文件跑 node --check）')
    // 逐文件失败要分类：Invalid package config 是环境/配置问题，不是迁移的语法错误。
    // 断言锚在**代码行**而不是短语：本文件上方注释里也写着这句话（裸 includes 会被注释满足 ——
    // 本项目已复现五次的「断言被自己文件里的说明文字满足」，M57 首次跑就是这么漏的）。
    if (!/if \(\/Invalid package config\/i\.test\(err\)\) \{ envBad\+\+/.test(v)) miss.push('缺 Invalid package config 分类（package.json 非法 JSON 会让每个迁移都被记成语法错误）')
    if (!/个迁移的 node --check 因环境\/配置失败（不是迁移的语法错误）/.test(v)) miss.push('缺「因环境/配置失败」的未判定文案')
    if (!/notExecuted\('全部迁移可被 node 解析'/.test(v)) miss.push('跑不起来时必须走 notExecuted（判未判定），不许 check(false)')
    // 反向断言：自检里必须有 M29 且带 expectAbsent（只查「该红的红了」看不见多出来的假红）。
    if (!/M29 package\.json 是非法 JSON/.test(v)) miss.push('自检缺 M29 场景（非法 package.json）')
    if (!/expectAbsent: \['全部迁移可被 node 解析'\]/.test(v)) miss.push('M29 缺 expectAbsent 反向断言（不许把环境问题记成被测缺陷）')
    if (!/const absentOk = absent\.every/.test(v)) miss.push('自检 harness 缺 expectAbsent 判定')
    // R26 / W26E-15、E-16：只钉「调用点在」挡不住「机制被掏空」—— 把 notExecuted 体内的计数或
    // 「样本为 0 ⇒ 不构成通过」的映射摘掉，调用点那行字面量照样在，S35 原先仍判 [OK]。
    if (!/if \(byDesign\) skippedByDesign\+\+\n\s*else undetermined\+\+/.test(v)) miss.push('notExecuted 体内必须把「样本为 0」计入 undetermined（与环境所限分开计数）')
    if (!/results\.push\(\{ name, ok: null, detail: why, byDesign \}\)/.test(v)) miss.push('未执行项必须以 ok: null 入表（不许记成 true）')
    if (!/if \(undetermined > 0\) \{/.test(v)) miss.push('缺「有样本为 0 的未执行项 ⇒ 不构成通过」的判定分支')
    if (!/覆盖面不完整，本次不构成通过/.test(v)) miss.push('缺「覆盖面不完整，本次不构成通过」的收口文案')
  }
  return { ok: miss.length === 0, detail: miss.length ? '缺：' + miss.join('、') : '前提探针 + Invalid package config 分类 + 未判定文案 + notExecuted 路径与体内计数（样本为 0 ⇒ 不构成通过）+ 自检 M29 与 expectAbsent 反向断言 全部在位' }
} })


// R34（W34-A 实测）：Node 版本原先四处互不同（engines ">=22" / ci.yml 两处 22 / Dockerfile node:22-slim@digest / 本机 v26），
// 且 .nvmrc 不存在 ⇒ 没有任何单一事实源；S1–S35 对 engines|node-version 全部 0 命中。
add({ id: 'S36', covers: ['.nvmrc', 'package.json', '.github/workflows/ci.yml', 'Dockerfile'], name: '运行时 Node 版本有单一事实源：.nvmrc 与 CI 两处 node-version、Dockerfile 基础镜像同 major，且 engines 覆盖该 major', run() {
  const miss = []
  if (!has('.nvmrc')) miss.push('缺 .nvmrc（本地开发没有单一事实源，CI 与 Dockerfile 各写一份）')
  const nvm = has('.nvmrc') ? read('.nvmrc').trim() : ''
  const nvmOk = /^\d+$/.test(nvm)
  if (nvm !== '' && !nvmOk) miss.push('.nvmrc 必须是裸 major 版本号，实际：' + JSON.stringify(nvm))
  const ci = has('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : ''
  const ciVers = [...ci.matchAll(/node-version:\s*(\S+)/g)].map((m) => m[1].replace(/['"]/g, ''))
  if (ciVers.length === 0) miss.push('CI 里没有 node-version（没有可对拍的读数）')
  for (const v of ciVers) if (nvmOk && v !== nvm) miss.push(`CI 的 node-version=${v} 与 .nvmrc=${nvm} 不一致`)
  const dk = has('Dockerfile') ? read('Dockerfile') : ''
  const froms = [...dk.matchAll(/FROM\s+node:(\d+)[^\s@]*/g)].map((m) => m[1])
  if (froms.length === 0) miss.push('Dockerfile 里没有 node:<major>-slim 基础镜像（没有可对拍的读数）')
  for (const f of froms) if (nvmOk && f !== nvm) miss.push(`Dockerfile 基础镜像 node:${f}-slim 与 .nvmrc=${nvm} 不一致`)
  const pkg = read('package.json')
  const eng = (pkg.match(/"node":\s*"([^"]+)"/) || [])[1]
  if (!eng) miss.push('package.json 没有 engines.node（安装期没有下限声明）')
  else {
    const m = eng.match(/>=\s*(\d+)/)
    if (!m) miss.push('engines.node 不是可解析的下限范围：' + eng)
    else if (nvmOk && Number(m[1]) > Number(nvm)) miss.push(`engines.node=${eng} 的下限高于 CI 实际使用的 ${nvm}`)
  }
  return { ok: miss.length === 0, detail: miss.length ? '缺：' + miss.join('、') : `.nvmrc=${nvm} · CI ${ciVers.length} 处 [${ciVers.join(',')}] · Dockerfile [${froms.join(',')}] · engines.node=${eng}` }
} })

// R34（W34-A 实测）：浏览器目标全仓零声明，实际生效的是 @rsbuild/core 硬编码的默认基线；
// 而分发代码里带 ES2023 的 Array.prototype.toSorted（Vue 3.5.43）⇒ 实际最低浏览器高于默认基线。
// 这条断言守「生效基线与文档必须同源」：声明了就要求文档写清声明，没声明就要求文档复述依赖里的默认值 + 实际最低版本。
add({ id: 'S37', covers: ['package.json', 'rsbuild.config.ts', 'README.md', 'RUN.md'], name: '浏览器目标：要么显式声明且文档同步，要么沿用 rsbuild 默认并把「生效基线 + 实际最低版本」写进文档', run() {
  const miss = []
  const pkg = read('package.json')
  const rs = has('rsbuild.config.ts') ? read('rsbuild.config.ts') : ''
  const declared = []
  if (/"browserslist"\s*:/.test(pkg)) declared.push('package.json.browserslist')
  // 用目录枚举判断（S29 要求「读取点的字面量必须被 git 跟踪」，而 .browserslistrc 合法地不存在）
  if (readdirSync(ROOT).includes('.browserslistrc')) declared.push('.browserslistrc')
  if (/overrideBrowserslist/.test(rs)) declared.push('rsbuild.config.ts.overrideBrowserslist')
  const docs = read('README.md') + '\n' + (has('RUN.md') ? read('RUN.md') : '')
  for (const n of ['chrome >= 107', 'es2017', 'Chrome 110', 'Safari 16.4']) {
    if (!docs.includes(n)) miss.push(`文档缺浏览器基线读数「${n}」`)
  }
  if (declared.length > 0 && !/browserslist/i.test(docs)) {
    miss.push(`已声明浏览器目标（${declared.join('、')}）但文档没有任何 browserslist 说明 —— 声明的支持范围与文档会各自漂移`)
  }
  // 默认基线是**依赖里的字面量**：m.js 只 import 该常量（正则抓不到），所以直接扫 dist 顶层 bundle。
  // 扫不到只记「未探测」，不判红 —— 判红的是「文档与依赖不一致」，不是「依赖不在」（后者由 npm ci 保证）。
  const distDir = R('node_modules/@rsbuild/core/dist')
  let probe = '未探测（缺 node_modules/@rsbuild/core/dist）'
  const want = ['chrome >= 107', 'edge >= 107', 'firefox >= 104', 'safari >= 16']
  if (existsSync(distDir)) {
    const js = readdirSync(distDir).filter((f) => f.endsWith('.js')).slice(0, 40)
    const hit = []
    for (const f of js) {
      const t = readFileSync(path.join(distDir, f), 'utf8')
      for (const w of want) if (t.includes(w) && !hit.includes(w)) hit.push(w)
    }
    probe = hit.length ? `${hit.join(' · ')}（命中 ${hit.length}/${want.length}，来自 @rsbuild/core dist bundle）` : '未探测（dist bundle 里找不到默认基线字面量）'
    if (hit.length > 0 && declared.length === 0) for (const v of hit) if (!docs.includes(v)) miss.push(`文档缺 rsbuild 默认基线项「${v}」（实际生效值藏在依赖里，文档必须复述）`)
  }
  return { ok: miss.length === 0, detail: miss.length ? miss.join('、') : `${declared.length ? '显式声明：' + declared.join('、') : '未声明，沿用 @rsbuild/core 默认'} · 依赖默认基线：${probe} · 文档已写明生效基线与实际最低版本` }
} })

// ── S38 变异自检电池的账目单一声源（R35） ─────────────────────────────────
// 「有多少条变异体」在电池源码里声明（EXPECTED_VARIANTS）、在 CI 的步骤名里复述一次。
// 两处都是手写的，各自漂移时谁也发现不了（W35-B 实测：自检 33 vs 实际 36、许可 9 vs 实际 13）。
// 这里只做机械对拍：电池声明的条数 必须等于 CI 步骤名里写的数字。
// 覆盖面说明：配置卫生自检的步骤名写的是「9 场景 + 2 阴性对照」（两个数字相加才是总数），
// 形态不同故不纳入本断言 —— 它由自己的 9 场景电池守。
add({ id: 'S38', covers: ['.github/workflows/ci.yml', 'scripts/verify-standards-selftest.mjs', 'scripts/verify-repo.mjs', 'scripts/check-third-party-notices-mutants.mjs', 'scripts/check-dist-size-budget-mutants.mjs', 'scripts/publish-leak-scan-selftest.mjs'], name: '变异自检电池的条数有单一事实源：电池里的 EXPECTED_VARIANTS 与 CI 步骤名里的数字逐一对拍', run() {
  const miss = []
  if (!has('.github/workflows/ci.yml')) return { ok: false, detail: '缺 .github/workflows/ci.yml（没有可对拍的 CI 文本）' }
  const ci = read('.github/workflows/ci.yml')
  // 取「npm run <script>」步骤的步骤名：name 行与它后面的 run 行（含 block scalar）配对。
  const stepName = (script) => {
    const ls = ci.split('\n')
    let cur = null
    for (let i = 0; i < ls.length; i++) {
      const nm = ls[i].match(/^\s*-\s*name:\s*(.+?)\s*$/)
      if (nm) { cur = nm[1]; continue }
      const rn = ls[i].match(/^\s*(?:-\s*)?run:\s*(.*)$/)
      if (!rn) continue
      let body = rn[1].trim()
      if (/^[|>]/.test(body)) {
        const indent = ls[i].match(/^\s*/)[0].length
        const acc = []
        for (let j = i + 1; j < ls.length; j++) {
          const ll = ls[j]
          if (!ll.trim()) continue
          if (ll.match(/^\s*/)[0].length <= indent) break
          acc.push(ll.trim())
        }
        body = acc.join(' ')
      }
      if (body.includes(`npm run ${script}`)) return cur
    }
    return null
  }
  const BATTERIES = [
    { script: 'verify:standards-selftest', file: 'scripts/verify-standards-selftest.mjs', claim: /(\d+)\s*个变异体/ },
    { script: 'verify:selfcheck', file: 'scripts/verify-repo.mjs', claim: /(\d+)\s*个变异体/ },
    { script: 'verify:notices-selftest', file: 'scripts/check-third-party-notices-mutants.mjs', claim: /(\d+)\s*个变异体/ },
    { script: 'verify:size-selftest', file: 'scripts/check-dist-size-budget-mutants.mjs', claim: /(\d+)\s*个变异体/ },
    { script: 'verify:publish-selftest', file: 'scripts/publish-leak-scan-selftest.mjs', claim: /变异自检\s*(\d+)\s*\/\s*(\d+)/, pair: true },
  ]
  const rows = []
  const wants = new Map()
  for (const b of BATTERIES) {
    if (!has(b.file)) { miss.push(`电池文件不存在：${b.file}`); continue }
    // 必须行锚定：变异体的 apply 里也含 'EXPECTED_VARIANTS = NN' 字面量（裸搜索会读到它）。
    const decl = read(b.file).match(/^\s*const EXPECTED_VARIANTS\s*=\s*(\d+)/m)
    if (!decl) { miss.push(`${b.file} 没有 EXPECTED_VARIANTS 声明（条数没有事实源，只能靠人手同步 CI 文本）`); continue }
    const want = Number(decl[1])
    wants.set(b.script, want)
    const name = stepName(b.script)
    if (!name) { miss.push(`CI 里找不到 npm run ${b.script} 的步骤名（数字无人对拍）`); continue }
    const claimed = [...name.matchAll(new RegExp(b.claim.source, 'g'))].flatMap((m) => m.slice(1).filter(Boolean).map(Number))
    if (claimed.length === 0) { miss.push(`CI 步骤「${name}」里没有可对拍的数字（${b.claim.source}）`); continue }
    const okNums = claimed.every((n) => n === want)
    const pairOk = !b.pair || new Set(claimed).size === 1
    if (!okNums) miss.push(`${b.script}：电池声明 ${want} 条，CI 步骤名里写的是 ${claimed.join(' / ')}`)
    if (!pairOk) miss.push(`${b.script}：CI 步骤名里两个数字不一致（${claimed.join(' / ')}）`)
    rows.push(`${b.script}=${want}${okNums && pairOk ? ' ✓' : ' ✗'}（CI 写 ${claimed.join('/')}）`)
  }
  // ② 文档里的同一数字也必须对拍（R36 实测：CONTRIBUTING 写 86 而电池已 90、RUN.md 写 9 而电池已 13）。
  //    文档不在 CI 步骤名的覆盖内，此前只能靠人手同步 —— 漂移了就没人发现。
  const DOC_CLAIMS = [
    { file: 'CONTRIBUTING.md', script: 'verify:standards-selftest', re: /（(\d+)\s*个变异体必须全部被抓到）/ },
    { file: 'RUN.md', script: 'verify:notices-selftest', re: /#\s*(\d+)\s*个变异体，必须\s*\d+\s*\/\s*\d+\s*被抓/ },
    // 分项式提法：总数与「1 个阴性对照 + M 个变异体 + 4 个零样本前提对照」必须自洽
    { file: 'RUN.md', script: 'verify:selfcheck', re: /（(\d+)\s*条用例\s*=\s*1\s*个阴性对照\s*\+\s*(\d+)\s*个变异体\s*\+\s*4\s*个零样本前提对照）/, breakdown: true },
    // 本判据自己的条目数（R36 实测 CONTRIBUTING 写 37 而实际已 40）：数字来源 = 本文件里 `add({ id: 'S<n>'` 的声明数
    { file: 'CONTRIBUTING.md', script: 'verify:standards', re: /npm run verify:standards\s+#\s*(\d+)\s*项/, stdCount: true },
  ]
  // 本判据声明的 S 条目（静态清点；运行期 CHECKS.length 在 S38 之后还会增长，不能用）
  const stdDecls = [...read('scripts/check-repo-standards.mjs').matchAll(/^add\(\{ id: '(S\d+)'/gm)].map((m) => m[1])
  const stdIds = new Set(stdDecls)
  for (const d of DOC_CLAIMS) {
    let want = wants.get(d.script)
    if (d.stdCount) {
      if (stdDecls.length === 0) { miss.push('数不出本判据声明的 S 条目（零样本 ⇒ 不判通过）'); continue }
      if (stdIds.size !== stdDecls.length) miss.push(`本判据有重复的 S id：${stdDecls.filter((x, i) => stdDecls.indexOf(x) !== i).join('、')}`)
      want = stdIds.size
    }
    if (want === undefined) { miss.push(`${d.file} 的对拍缺少电池声明：${d.script}`); continue }
    if (!has(d.file)) { miss.push(`缺 ${d.file}（文档里的条数无人对拍）`); continue }
    const hits = [...read(d.file).matchAll(new RegExp(d.re.source, 'g'))]
    if (hits.length === 0) { miss.push(`${d.file} 里找不到可对拍的数字（${d.re.source}）—— 别把声明删了当通过`); continue }
    for (const h of hits) {
      const nums = h.slice(1).map(Number)
      if (nums[0] !== want) miss.push(`${d.file} 写 ${nums[0]}，而 ${d.script} 声明 ${want}`)
      if (d.breakdown) {
        const sum = 1 + nums[1] + 4
        if (sum !== nums[0]) miss.push(`${d.file} 的分项不自洽：1 + ${nums[1]} + 4 = ${sum} ≠ 总数 ${nums[0]}`)
        if (nums[1] !== want - 5) miss.push(`${d.file} 的分项与电池不符：变异体 ${nums[1]} 条，电池 ${want} 条应当拆成 ${want - 5} 条变异体`)
      }
    }
    rows.push(`${d.file}:${d.script}=${want}`)
  }
  return { ok: miss.length === 0, detail: miss.length ? miss.join('、') : `${rows.length}/${BATTERIES.length + DOC_CLAIMS.length} 处提法与电池声明一致：${rows.join(' · ')}` }
} })

// ── S39 双架构二进制清单的单一事实源（R35） ────────────────────────────────
// 汉化二进制不入库（.gitignore: pb-bin/pocketbase-zh-linux-*），但它的**指纹清单**入库：
// pb-bin/SHA256SUMS（允许清单）与 pb-bin/Dockerfile 的分架构常量。三者（含磁盘字节）一旦
// 各自漂移，构建期断言与人工读数就会指向不同的东西（R35 实测：README 表已脱节）。
// 这里只做可机械判定的部分：
//   ① SHA256SUMS 必须同时登记两个架构，且 sha256 与 Dockerfile 的同架构常量逐字符相同；
//   ② Dockerfile 的 TARGETARCH 分支必须两架构都在、且对未知架构 REFUSED；
//   ③ 两条 FROM 必须按 index digest 固定且指同一个 digest（R19 遗留项）；
//   ④ 二进制本体在场时，再加「sha256/size/md5/e_machine 与常量逐项一致」——不在场判未判定
//      （判据不因「本地没放二进制」而报红，也不因缺样本而判通过）。
add({ id: 'S39', covers: ['pb-bin/SHA256SUMS', 'pb-bin/Dockerfile', 'pb-bin/pocketbase-zh-linux-arm64', 'pb-bin/pocketbase-zh-linux-amd64'], name: '双架构二进制清单有单一事实源：SHA256SUMS 的登记与 Dockerfile 的分架构常量逐项一致（本体在场时再加磁盘字节断言）', run() {
  const miss = []
  const unj = []
  const ARCHES = ['arm64', 'amd64']
  if (!has('pb-bin/SHA256SUMS')) return { ok: false, detail: '缺 pb-bin/SHA256SUMS（允许清单不在，构建期白名单没有事实源）' }
  if (!has('pb-bin/Dockerfile')) return { ok: false, detail: '缺 pb-bin/Dockerfile（分架构常量不在）' }
  const sums = new Map()
  for (const l of read('pb-bin/SHA256SUMS').split('\n')) {
    const m = l.trim().match(/^([0-9a-f]{64})\s+(\S+)$/)
    if (m) sums.set(m[2], m[1])
  }
  const df = read('pb-bin/Dockerfile')
  const consts = new Map()
  for (const m of df.matchAll(/^\s*(arm64|amd64)\)\s*want_machine=(\d+);\s*want_size=(\d+);\s*want_md5=([0-9a-f]+);\s*want_sha256=([0-9a-f]+)/gm)) {
    consts.set(m[1], { machine: Number(m[2]), size: Number(m[3]), md5: m[4], sha256: m[5] })
  }
  for (const a of ARCHES) {
    const name = `pocketbase-zh-linux-${a}`
    if (!sums.has(name)) miss.push(`SHA256SUMS 没有登记 ${name}（该架构的构建期白名单会直接 REFUSED）`)
    if (!consts.has(a)) { miss.push(`Dockerfile 缺 ${a} 的 want_* 常量块（TARGETARCH=${a} 会走 REFUSED 分支）`); continue }
    if (sums.has(name) && sums.get(name) !== consts.get(a).sha256) {
      miss.push(`${name}：SHA256SUMS 登记 ${sums.get(name).slice(0, 12)}… ≠ Dockerfile 常量 ${consts.get(a).sha256.slice(0, 12)}…`)
    }
  }
  if (!/^\s*\*\)\s*echo "REFUSED: unknown arch/m.test(df)) miss.push('Dockerfile 的 TARGETARCH 分支没有对未知架构 REFUSED（未登记的架构会被静默放行）')
  const froms = [...df.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1])
  if (froms.length === 0) miss.push('Dockerfile 没有 FROM 行（没有可对拍的基座）')
  for (const f of froms) if (!/@sha256:[0-9a-f]{64}$/.test(f)) miss.push(`FROM ${f} 未按 index digest 固定（标签可被上游改指，同一份 Dockerfile 会构建出不同镜像）`)
  if (new Set(froms).size > 1) miss.push(`两条 FROM 的基座不一致：${[...new Set(froms)].join(' vs ')}`)
  // ④ 本体在场时的磁盘层
  const probe = []
  for (const a of ARCHES) {
    const rel = `pb-bin/pocketbase-zh-linux-${a}`
    if (!has(rel)) { unj.push(`${a} 本体不在树里`); continue }
    const buf = readFileSync(R(rel))
    const c = consts.get(a)
    if (!c) continue
    const sha = createHash('sha256').update(buf).digest('hex')
    const md5 = createHash('md5').update(buf).digest('hex')
    const machine = buf.readUInt16LE(18)
    if (sha !== c.sha256) miss.push(`${rel}：磁盘 sha256 ${sha.slice(0, 12)}… ≠ 常量 ${c.sha256.slice(0, 12)}…`)
    if (md5 !== c.md5) miss.push(`${rel}：磁盘 md5 ${md5.slice(0, 12)}… ≠ 常量 ${c.md5.slice(0, 12)}…`)
    if (buf.length !== c.size) miss.push(`${rel}：磁盘 size ${buf.length} ≠ 常量 ${c.size}`)
    if (machine !== c.machine) miss.push(`${rel}：ELF e_machine ${machine} ≠ 常量 ${c.machine}`)
    probe.push(`${a}:${buf.length}B/${sha.slice(0, 8)}…/e_machine=${machine}`)
  }
  const detail = miss.length
    ? miss.join('、')
    : `两架构登记与常量逐项一致 · FROM 按 digest 固定（${[...new Set(froms)].length} 个）· 未知架构 REFUSED` +
      (probe.length ? ` · 磁盘核对：${probe.join(' · ')}` : ` · 磁盘核对：未判定（${unj.join('、')}）`)
  return { ok: miss.length === 0, detail }
} })

// ── S40 构建入口唯一且与调用方式无关（R36） ────────────────────────────────
// R36 实测（W36-A-03）：给 rsbuild 传**绝对** `--root` 会让产物变样 —— 27,434,029 B / 摘要
// `d8b74185…`（对照 `npm run build` 的 27,434,032 B / `5931b106…`）：index chunk 43,392→43,391 B、
// lib-vue 66,026→66,024 B，且 `m.` 前缀的 chunk 变成 `v.`；**相对** `--root` 与 `npm run build` 一致。
// 而体积判据把 13 个文件名、4 个 chunk 名与字节数都钉死了 ⇒ 一旦有人改用绝对 `--root` 取产物，
// 判据会报红，人却容易读成「产物漂移/重锚需求」。这里把「入口唯一」变成机械断言：
//   ① package.json 的 scripts.build 必须是 `rsbuild build`（不带 --root、不经 npx/包装器）；
//   ② CI 的每个构建步骤与 Dockerfile 的每个构建 RUN 都必须写 `npm run build`；
//   ③ 三处都不许给 rsbuild 传绝对路径的 `--root`。
// 零样本纪律：三处都找不到构建步骤时判失败（不能因「找不到」而通过）。
add({ id: 'S40', covers: ['package.json', '.github/workflows/ci.yml', 'Dockerfile'], name: '构建入口唯一：package.json/CI/Dockerfile 三处都走 `npm run build`，且没有用绝对路径给 rsbuild 传 --root（绝对 --root 会改产物字节）', run() {
  const miss = []
  if (!has('package.json')) return { ok: false, detail: '缺 package.json（构建入口没有事实源）' }
  let pkg
  try { pkg = JSON.parse(read('package.json')) } catch (e) { return { ok: false, detail: 'package.json 不是合法 JSON：' + e.message } }
  const build = String((pkg.scripts || {}).build ?? '')
  if (build !== 'rsbuild build') miss.push(`package.json 的 scripts.build 是 \`${build || '(缺失)'}\`，期望 \`rsbuild build\`（改入口就等于换产物）`)
  const BUILDISH = /\brsbuild\b|\bnpm run build\b/
  const collect = (text, re) => [...text.matchAll(re)].map((m) => m[1].trim()).filter((l) => BUILDISH.test(l))
  let ciBuilds = []
  if (!has('.github/workflows/ci.yml')) miss.push('缺 .github/workflows/ci.yml（CI 的构建入口无人对拍）')
  else {
    ciBuilds = collect(read('.github/workflows/ci.yml'), /^\s*(?:-\s*)?run:\s*(.+)$/gm)
    if (ciBuilds.length === 0) miss.push('CI 里没有任何构建步骤（零样本 ⇒ 不判通过）')
    for (const l of ciBuilds) if (l !== 'npm run build') miss.push(`CI 的构建步骤不是 \`npm run build\`：\`${l}\``)
  }
  let dfBuilds = []
  if (!has('Dockerfile')) miss.push('缺 Dockerfile（镜像的构建入口无人对拍）')
  else {
    dfBuilds = collect(read('Dockerfile'), /^RUN\s+(.+)$/gm)
    if (dfBuilds.length === 0) miss.push('Dockerfile 里没有任何构建 RUN（零样本 ⇒ 不判通过）')
    for (const l of dfBuilds) if (l !== 'npm run build') miss.push(`Dockerfile 的构建 RUN 不是 \`npm run build\`：\`${l}\``)
  }
  const absRoot = []
  for (const rel of ['package.json', '.github/workflows/ci.yml', 'Dockerfile']) {
    if (!has(rel)) continue
    read(rel).split('\n').forEach((line, i) => {
      if (/rsbuild/.test(line) && /--root[= ]\s*['"]?\//.test(line)) absRoot.push(`${rel}:${i + 1}`)
    })
  }
  if (absRoot.length) miss.push(`用绝对路径给 rsbuild 传 --root（R36 实测会改产物字节与 chunk 名）：${absRoot.join('、')}`)
  const detail = miss.length
    ? miss.join('、')
    : `package.json build=\`rsbuild build\` · CI 构建步骤 ${ciBuilds.length} 处全为 \`npm run build\` · Dockerfile 构建 RUN ${dfBuilds.length} 处全为 \`npm run build\` · 绝对 --root 0 处`
  return { ok: miss.length === 0, detail }
} })

// ── S41 构建可复现性判据在场且被接线（R36）────────────────────────────
// 为什么必须单独一条：R36 实测「同一源码两次构建产物不同」此前**没有任何判据能判**——
// CI 每个 job 只构建一次；体积判据只锁 4 个 chunk 的 sha256，而 dist/index.html 的内容
// 在农村全绿的情况下可以被改一个字节（长度不变 ⇒ gzip 与总字节都不动）。
add({ id: 'S41', covers: ['scripts/verify-build-reproducible.mjs', 'scripts/verify-build-reproducible-selftest.mjs', 'scripts/lib/build-index.mjs', 'package.json', '.github/workflows/ci.yml'], name: '构建可复现性判据在场且被接线：脚本真做两次独立构建并比对产物名册，判据自检与 CI 步骤都在', run() {
  const miss = []
  const VER = 'scripts/verify-build-reproducible.mjs'
  const SEL = 'scripts/verify-build-reproducible-selftest.mjs'
  const IDX = 'scripts/lib/build-index.mjs'
  for (const rel of [VER, SEL, IDX]) if (!has(rel)) miss.push(`缺 ${rel}（没有判据/没有自检就没有判别力）`)
  if (!has('package.json')) miss.push('缺 package.json')
  else {
    let pkg = null
    try { pkg = JSON.parse(read('package.json')) } catch (e) { miss.push('package.json 不是合法 JSON：' + e.message) }
    const scripts = ((pkg || {}).scripts || {})
    const want = { 'verify:repro': `node ${VER}`, 'verify:repro-selftest': `node ${SEL}` }
    for (const [k, v] of Object.entries(want)) {
      const got = String(scripts[k] ?? '')
      if (got !== v) miss.push(`package.json 的 scripts['${k}'] 是 \`${got || '(缺失)'}\`，期望 \`${v}\``)
    }
  }
  const ciRel = '.github/workflows/ci.yml'
  if (!has(ciRel)) miss.push(`缺 ${ciRel}（接线面无人对拍）`)
  else {
    const runs = [...read(ciRel).matchAll(/^\s*(?:-\s*)?run:\s*(.+)$/gm)].map((m) => m[1].trim())
    for (const s of ['verify:repro', 'verify:repro-selftest']) {
      const n = runs.filter((r) => r === `npm run ${s}`).length
      if (n === 0) miss.push(`CI 里没有 \`npm run ${s}\` 步骤（零样本 ⇒ 不判通过：判据存在但从不跑）`)
      if (n > 1) miss.push(`CI 里 \`npm run ${s}\` 出现 ${n} 次（应恰 1 次）`)
    }
  }
  if (has(VER)) {
    const t = read(VER)
    const buildCalls = [...t.matchAll(/\bbuild\(/g)].length
    if (buildCalls < 2) miss.push(`判据只调用了 ${buildCalls} 次构建（两次独立构建是这条断言的全部意义）`)
    if (!/A\.rosterHash === B\.rosterHash|A\.rosterHash !== B\.rosterHash/.test(t)) miss.push('判据里没有「两臂名册相等」的比较表达式')
    if (!/diffRosters/.test(t)) miss.push('判据没有按文件点出差异（只报一个总哈希无法定位）')
  }
  if (has(SEL)) {
    const s = read(SEL)
    for (const [re, why] of [[/EXPECTED_SCENES\s*=\s*\d+/, '自检没有场景条数声明（条数被改小就无声退化）'], [/exit=/, '自检不打印每臂读数'], [/REPRO_TAMPER/, '自检没有内容漂移臂'], [/REPRO_ARM_B/, '自检没有绝对检出路径臂']]) {
      if (!re.test(s)) miss.push(`判据自检缺「${why}」`)
    }
  }
  const detail = miss.length
    ? miss.join('、')
    : `判据 ${VER} + 自检 ${SEL} + 名册模块 ${IDX} 在场 · package.json 有 verify:repro 与 verify:repro-selftest · CI 各有 1 步跑它们 · 判据调用构建 2 次并比对名册与逐文件差异`
  return { ok: miss.length === 0, detail }
} })

// ── S42 可复现性判据的装置纪律与空样本分支（R36）──────────────────────
// 判据本身也会假绿：R24/R32 的教训是「固定 /tmp 落点」「软链 node_modules」都会让读数不可采信。
add({ id: 'S42', covers: ['scripts/verify-build-reproducible.mjs'], name: '可复现性判据的装置前提与零样本分支在场：按次唯一落点、拒绝软链 node_modules、空产物判未判定、缺前提判未判定', run() {
  const VER = 'scripts/verify-build-reproducible.mjs'
  if (!has(VER)) return { ok: false, detail: `缺 ${VER}（没有判据可查）` }
  const t = read(VER)
  const miss = []
  const need = [
    [/mkdtempSync\s*\(/, '按次唯一的临时落点（固定路径会被并发互删）'],
    [/rmSync\(dest/, '临时副本必须清理'],
    [/cp['"],\s*\['-al'/, 'node_modules 必须用硬链目录复制（软链会改 chunk 名，R23-25）'],
    [/isSymbolicLink\(\)/, '必须显式拒绝软链 node_modules（否则结论不可采信）'],
    [/零样本/, '空产物必须有零样本分支（否则空跑也算通过）'],
    [/exit 2/, '前提不成立必须 exit 2（与「通过」可区分）'],
    [/diffRosters/, '必须按文件点差异'],
    [/index\.html/, '必须单独点出产物入口的内容哈希（原体积判据只锁 4 个 chunk）'],
  ]
  for (const [re, why] of need) if (!re.test(t)) miss.push(`缺「${why}」`)
  const premiseUndecided = [...t.matchAll(/undecided\(/g)].length
  if (premiseUndecided < 5) miss.push(`只找到 ${premiseUndecided} 处未判定出口（缺 package.json / src / node_modules / 软链 / 空产物 至少 5 条前提）`)
  // R36REV-RL-02/RL-03：上面的字符串断言能被「保留文本、架空语义」绕过（把守卫写成 `if (false && …)` 仍是全绿）。
  // 真正抓住这种事的是**行为臂**：自检电池里必须有软链臂、缺 node_modules 臂、缺 src 臂各自独立，
  // 且每条前提臂都要断言**末行点名了缺的那个前提**（否则「标签写的分支」与「真实走的分支」可以不一致）。
  const self = has('scripts/verify-build-reproducible-selftest.mjs') ? read('scripts/verify-build-reproducible-selftest.mjs') : ''
  if (!self) miss.push('缺 scripts/verify-build-reproducible-selftest.mjs（没有行为臂，装置纪律只能靠文本检查）')
  else {
    if (!/^\s*const EXPECTED_SCENES = 6\s*$/m.test(self)) miss.push('自检电池的 EXPECTED_SCENES 必须声明为 6（干净 / 内容漂移 / 绝对路径 / 缺 node_modules / 软链 node_modules / 缺 src）')
    // 臂计数按**臂号集合**判，不按出现次数判：次数判会被「同一臂号写两次」补平（R36-LEAD-18）。
    const armIds = [...new Set([...self.matchAll(/run\('臂(\d)/g)].map((m) => m[1]))].sort()
    const missingArms = ['1', '2', '3', '4', '5', '6'].filter((n) => !armIds.includes(n))
    if (missingArms.length) miss.push(`自检电池缺臂 ${missingArms.join('、')}（现有序号：${armIds.join('、')}；两处前提必须各有各的臂）`)
    for (const [s, why] of [['没有 node_modules', '缺 node_modules 臂必须点名缺的是 node_modules'], ['软链', '必须有软链 node_modules 臂（R23-25：软链树没有判别力）'], ['没有 src', '缺 src 臂必须与缺 node_modules 臂分开']]) {
      if (!self.includes(s)) miss.push(`自检电池缺「${why}」`)
    }
    if (!/tailOk/.test(self)) miss.push('前提臂必须校验末行点名的前提（否则标签与真实分支可以不一致）')
    // R36-LEAD-17：臂3（绝对 --root 改产物）是**平台相关**的 —— GitHub Linux runner 上两次构建逐字节相同。
    // 故它改成「前提臂」：现象不出现判未判定。这条豁免必须①留痕（打出「前提不成立」）、②有封顶（EXPECTED_PREMISE_MAX），
    // 否则「前提豁免」会变成新的静默通过通道；同时判据侧的绝对 --root 开关必须在场，否则臂3 永远收不到现象。
    if (!/^\s*const EXPECTED_PREMISE_MAX = 1\s*$/m.test(self)) miss.push('前提豁免必须有封顶常量 EXPECTED_PREMISE_MAX = 1（不然前提豁免会把断言一条条吃掉）')
    if (!self.includes('前提不成立')) miss.push('前提臂现象不出现时必须打出「前提不成立」一行（不许静默）')
    if (!/premise: true/.test(self)) miss.push('前提臂的读数必须带 premise 标记（否则封顶判据读不到）')
    if (!/REPRO_ARM_B: 'absolute'/.test(self)) miss.push('必须有臂真用绝对 --root 调判据（否则平台现象无从出现）')
    // 断言**那一行常量本身**：只测 /REPRO_ARM_B/ 会被文件头注释里的同名字符串满足，
    // 于是「把常量退回 'relative'」这种让开关失效的改动能整条溜过（R36-LEAD-18）。
    if (!/^\s*const ARM_B = process\.env\.REPRO_ARM_B \|\| 'relative'\s*$/m.test(t)) miss.push("判据自身的绝对 --root 开关必须写成 `const ARM_B = process.env.REPRO_ARM_B || 'relative'`（行锚定；否则开关可被架空而 S42 看不见）")
    if (!/ARM_B === 'absolute'/.test(t)) miss.push("判据必须按 ARM_B === 'absolute' 真的给 B 臂加 --root")
  }
  // 变异体必须真打在 S41/S42 上，否则这两条断言会退化成「文案在位即通过」
  const mut = has('scripts/verify-standards-selftest.mjs') ? read('scripts/verify-standards-selftest.mjs') : ''
  for (const id of ['S41', 'S42']) {
    const n = [...mut.matchAll(new RegExp(`expect: '${id}'`, 'g'))].length
    if (n === 0) miss.push(`变异电池里没有以 ${id} 为期望的变异体（断言无法被证明有判别力）`)
  }
  const detail = miss.length
    ? miss.join('、')
    : `装置纪律在位（mkdtemp 落点 · 清理 · cp -al 硬链 · 拒绝软链）· 未判定出口 ${premiseUndecided} 处 · 零样本分支在位 · 产物入口内容哈希被点名 · 行为臂 6 条（含软链臂与两处前提臂，且逐臂校验末行点名的前提）· 前提豁免封顶 EXPECTED_PREMISE_MAX = 1 且留痕 · 判据侧绝对 --root 开关在位 · 变异电池覆盖 S41/S42`
  return { ok: miss.length === 0, detail }
} })

// ── S43 研究报告防清空（R38 / W38C-02：整份清空后 9 条判据全绿） ──────────────
// 为什么单独立一条：docs/ 不在 S24 的来源枚举里，该文档又是纯正文、无任何判据读它 ——
// 「把它删光」在今天的判据面上完全不可见。这条只守**结构与规模**（防清空、防大段删除），
// 不冒充语义正确性：结论是否仍成立仍需人读。
add({ id: 'S43', covers: ['docs/face-ui-research.md'], name: '研究报告的结构与规模被看住（防整份清空或大段删除）', run() {
  const rel = 'docs/face-ui-research.md'
  if (!has(rel)) return { ok: false, detail: `${rel} 不存在（它是 README 与 RUN.md 引用的调研底稿）` }
  const t = read(rel)
  const miss = []
  const lines = t.split('\n').length
  if (lines < 500) miss.push(`正文只有 ${lines} 行（下限 500）—— 疑似被清空或大段删除`)
  for (const h of ['## 1. GitHub 项目清单', '## 2. 具体实现方案', '## 3. 验收清单']) {
    if (!t.includes(h)) miss.push(`缺一级章节：${h}`)
  }
  const h3 = (t.match(/^### /gm) || []).length
  if (h3 < 15) miss.push(`三级小标题只有 ${h3} 个（下限 15）`)
  const rows = (t.match(/^\|/gm) || []).length
  if (rows < 10) miss.push(`表格行只有 ${rows} 行（下限 10）`)
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${lines} 行 · ${h3} 个三级小标题 · ${rows} 行表格 · 三个一级章节在场` }
} })

// ── S44 pb-bin 重建说明防清空（R38 / W38C-03：只留指纹表时 6 条判据全绿） ─────
// 指纹表由 check-pbbin-fingerprint 深查，但「重建步骤整段被删」此前无人看。
add({ id: 'S44', covers: ['pb-bin/README.md'], name: 'pb-bin 重建说明的正文被看住（防只剩指纹表）', run() {
  const rel = 'pb-bin/README.md'
  if (!has(rel)) return { ok: false, detail: `${rel} 不存在` }
  const t = read(rel)
  const miss = []
  const bodyLines = t.split('\n').filter((l) => !l.startsWith('|')).filter((l) => l.trim() !== '').length
  if (bodyLines < 30) miss.push(`非表格正文只有 ${bodyLines} 行（下限 30）—— 疑似只剩指纹表`)
  for (const [what, s] of [['arm64 二进制名', 'pocketbase-zh-linux-arm64'], ['amd64 二进制名', 'pocketbase-zh-linux-amd64'], ['摘要清单引用', 'SHA256SUMS']]) {
    if (!t.includes(s)) miss.push(`缺${what}：${s}`)
  }
  if (!/docker build/.test(t)) miss.push('缺重建命令（docker build）')
  const rows = (t.match(/^\|/gm) || []).length
  if (rows < 6) miss.push(`指纹表只有 ${rows} 行（下限 6）`)
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${bodyLines} 行正文 · ${rows} 行指纹表 · 两架构名与清单引用在场` }
} })

// ── S45 文档引用的产物 chunk 名必须与体积判据锁定值一致（R38 / W38C-05） ──────
// 为什么单独立一条：docs/THIRD-PARTY.md 写的是**现在时断言**（「同目录下只有 lib-vue.<hash>.js.LICENSE.txt」），
// 而权威值在 scripts/check-dist-size-budget.mjs 的 HASHED_CHUNKS 里；两边漂移时没有任何判据看得见
// （W38-C 实测：文档写 8351304052、判据锁 0518959aef，改坏这一句零判据变红）。
// RUN.md 里同类字样是编年叙事（带「当时」类措辞），故本条只守文档、不守 RUN.md。
add({ id: 'S45', covers: ['docs/THIRD-PARTY.md'], name: '文档引用的产物 chunk 名与体积判据锁定值一致（防文档自称断言漂移）', run() {
  const jrel = 'scripts/check-dist-size-budget.mjs'
  if (!has(jrel)) return { ok: false, detail: `${jrel} 不存在，取不到权威 chunk 名单` }
  const jt = read(jrel)
  const jsBlock = (jt.match(/const HASHED_CHUNKS = \{([\s\S]*?)\n\}/) || [])[1] || ''
  const cssBlock = (jt.match(/const LOCKED_SHA256 = \{([\s\S]*?)\n\}/) || [])[1] || ''
  const locked = new Set([...jsBlock.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1].split('/').pop()))
  for (const m of cssBlock.matchAll(/'([^']+\.css)'\s*:/g)) locked.add(m[1].split('/').pop())
  if (locked.size === 0) return { ok: false, detail: '没能从体积判据里解析出锁定 chunk 名单（判据被改形 ⇒ 本条失去前提，未判定而非通过）' }
  const rel = 'docs/THIRD-PARTY.md'
  if (!has(rel)) return { ok: false, detail: `${rel} 不存在` }
  const t = read(rel)
  const miss = []
  let hits = 0
  for (const line of t.split('\n')) {
    for (const name of line.match(/[A-Za-z][\w-]*\.[0-9a-f]{10}\.(?:js|css)/g) || []) {
      hits += 1
      if (!locked.has(name)) miss.push(`${rel}：${name} 不在体积判据锁定名单里（判据锁的是 ${[...locked].join('、')}）`)
    }
  }
  if (hits === 0) miss.push(`${rel} 里没有一处可核对的 chunk 名（把整句删掉就没得比，故要求至少一处）`)
  return { ok: miss.length === 0, detail: miss.length ? miss.join('；') : `${hits} 处 chunk 名与体积判据锁定值一致` }
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
