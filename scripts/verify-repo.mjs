#!/usr/bin/env node
// 仓库自检：不依赖任何第三方包，可在 CI 与本地直接运行。
//
// 设计纪律（与本项目的审计约定一致）：
//   1. 每一项检查都必须真实执行样本；样本为 0 时报「未执行」并非零退出，绝不判通过。
//   2. 断言读取真实来源（源码、清单、迁移文件本身），不在本脚本里复刻一份实现。
//   3. 任何一项失败即整体失败（退出码 1），并打印可复核的差异。
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = process.env.VERIFY_REPO_ROOT
  ? resolve(process.env.VERIFY_REPO_ROOT)
  : join(import.meta.dirname, '..')
const results = []
let executed = 0
let skippedByDesign = 0 // 环境所限（例如二进制按设计不入库）：只提示，不计入失败
let undetermined = 0 // 样本为 0：覆盖面不完整，不得判通过

// 每组「尝试」了多少条断言（check 与 notExecuted 各算一次）。
// 用「尝试」而不是「通过」：样本为 0 时有意跳过不算被掏空。
let attempted = 0
let currentSection = null
const sectionChecks = {}
function bump() {
  attempted++
  if (currentSection) sectionChecks[currentSection] = (sectionChecks[currentSection] ?? 0) + 1
}

function check(name, ok, detail = '') {
  bump()
  executed++
  results.push({ name, ok, detail })
  const mark = ok ? '✅' : '❌'
  console.log(`${mark} ${name}${detail ? '  —— ' + detail : ''}`)
}

function notExecuted(name, why, byDesign = false) {
  // 未执行分两类，语义不同：
  //   · 样本为 0（目录里没有可检对象、清单为空…）→ 覆盖面不完整 → 整体 exit 2，绝不判通过
  //   · 环境所限（二进制按设计不入库、node_modules 未安装…）→ 只提示，不影响退出码
  bump()
  if (byDesign) skippedByDesign++
  else undetermined++
  results.push({ name, ok: null, detail: why, byDesign })
  console.log(`⚠️  未执行（${byDesign ? '环境所限，不计入失败' : '样本为 0，覆盖面不完整'}）：${name}  —— ${why}`)
}

// 每个检查组单独隔离：任何一项抛异常（来源文件缺失、解析失败…）都记成一条失败项，
// 而不是让进程崩掉 —— 崩掉会吞掉汇总行，且崩溃点之后的检查组会静默不执行。
const ranSections = []
function section(name, fn) {
  ranSections.push(name)
  currentSection = name
  sectionChecks[name] = 0
  try {
    fn()
  } catch (e) {
    check(`${name} 执行未抛异常`, false, `抛出 ${e.constructor.name}: ${e.message}`)
  } finally {
    currentSection = null
  }
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ── 1. public/ 资源指纹 ───────────────────────────────────────────────────────
function checkPublicIntegrity() {
  console.log('\n=== public/ 资源指纹 ===')
  const manifestRel = 'public/SHA256SUMS'
  if (!existsSync(join(ROOT, manifestRel))) {
    check('public/SHA256SUMS 存在', false, '清单缺失，后续检查无法进行')
    return
  }
  const lines = read(manifestRel)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  // 形态：sha256  空格对齐  size  空格对齐  path
  const entries = lines
    .map((l) => l.match(/^([0-9a-f]{64})\s+(\d+)\s+(\S.*)$/))
    .filter(Boolean)
    .map((m) => ({ sha: m[1], size: Number(m[2]), rel: m[3].trim() }))
  check('清单条目可解析（sha256 / size / path 三列）', entries.length > 0 && entries.length === lines.length,
    `解析 ${entries.length} / 文本行 ${lines.length}`)

  let bad = 0
  for (const e of entries) {
    const abs = join(ROOT, 'public', e.rel)
    if (!existsSync(abs)) { bad++; console.log(`   ❌ 登记的文件不存在：${e.rel}`); continue }
    const buf = readFileSync(abs)
    if (sha256(buf) !== e.sha) { bad++; console.log(`   ❌ 指纹不符：${e.rel} 期望 ${e.sha.slice(0, 16)} 实得 ${sha256(buf).slice(0, 16)}`) }
    if (buf.length !== e.size) { bad++; console.log(`   ❌ 尺寸不符：${e.rel} 期望 ${e.size} 实得 ${buf.length}`) }
  }
  check('登记文件的 SHA-256 与尺寸全部一致', entries.length > 0 && bad === 0,
    `比对 ${entries.length} 个，失败 ${bad}`)

  // 反向断言：目录下的资源必须在清单里（否则删掉一条登记即等于不再校验）
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === 'SHA256SUMS') return []
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
  const onDisk = walk(join(ROOT, 'public')).map((p) => relative(join(ROOT, 'public'), p))
  const listed = new Set(entries.map((e) => e.rel))
  const unlisted = onDisk.filter((p) => !listed.has(p))
  check('目录下资源全部已登记（反向断言）', unlisted.length === 0,
    `目录 ${onDisk.length} 个，未登记 ${unlisted.length}${unlisted.length ? '：' + unlisted.join(', ') : ''}`)
}

// ── 2. pb_migrations 可解析性与约束不变量 ────────────────────────────────────
function checkMigrations() {
  console.log('\n=== pb_migrations ===')
  const dir = join(ROOT, 'pb_migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort()
  if (files.length === 0) { notExecuted('迁移不变量', 'pb_migrations/ 下没有迁移文件'); return }

  // 2.1 每个文件都能被 node 解析（语法错误在离线文本检查里看不见）
  let syntaxBad = 0
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', join(dir, f)], { encoding: 'utf8' })
    if (r.status !== 0) { syntaxBad++; console.log(`   ❌ 语法错误：${f}\n${(r.stderr || '').trim().split('\n').slice(0, 3).join('\n')}`) }
  }
  check('全部迁移可被 node 解析', syntaxBad === 0, `检查 ${files.length} 个，失败 ${syntaxBad}`)

  // 2.2 文件名唯一且以时间戳开头
  const nameOk = files.every((f) => /^\d+_[\w.-]+\.js$/.test(f))
  check('文件名以时间戳开头且唯一', nameOk && new Set(files).size === files.length, `${files.length} 个`)

  // 2.3 不得出现历史从未生效过的 cascadeDelete=true
  const cascade = files.filter((f) => /"cascadeDelete"\s*:\s*true/.test(read(join('pb_migrations', f))))
  check('没有迁移把 cascadeDelete 置为 true', cascade.length === 0, cascade.join(', ') || '0 处')

  // 2.4 session_id 的终态 pattern 必须同时挡住空白、Unicode 分隔符与控制符
  const setters = files.filter((f) => /pattern\s*[:=]/.test(read(join('pb_migrations', f))))
  if (setters.length === 0) {
    notExecuted('session_id 终态 pattern', '没有任何迁移设置 pattern')
  } else {
    const last = setters[setters.length - 1]
    const src = read(join('pb_migrations', last))
    const pats = [...src.matchAll(/pattern\s*[:=]\s*(['"`])(.+?)\1/gs)].map((m) => m[2])
    const pat = pats[0] || ''
    const hasAll = ['\\s', '\\p{Z}', '\\p{Cc}'].every((s) => pat.includes(s))
    const hasLegacy = /\[\\x00-\\x1F\\x7F\]/.test(pat)
    const hasLen = pat.includes('{0,198}')
    check(`终态 pattern 覆盖空白/分隔符/控制符（${last}）`, pats.length > 0 && hasAll && !hasLegacy && hasLen,
      pats.length === 0 ? '未取到 pattern 字面量' : `含 \\s=${pat.includes('\\s')} \\p{Z}=${pat.includes('\\p{Z}')} \\p{Cc}=${pat.includes('\\p{Cc}')} 旧式控制符类=${hasLegacy} 长度上界=${hasLen}`)

    // 2.5 设置过 pattern 的迁移，其 down 也要把 pattern 清掉，否则回退会留下约束
    let downMissing = 0
    for (const f of setters) {
      const src = read(join('pb_migrations', f))
      const downIdx = src.lastIndexOf('}, (app) => {')
      const down = downIdx >= 0 ? src.slice(downIdx) : ''
      if (!/pattern\s*[:=]/.test(down)) { downMissing++; console.log(`   ❌ down 未处理 pattern：${f}`) }
    }
    check('设置 pattern 的迁移其 down 也处理 pattern', downMissing === 0,
      `涉及 ${setters.length} 个，未处理 ${downMissing}`)
  }

  // 2.6 down 重建 auth 集合时不得写入 PB 内建的**英文**邮件模板
  //     （R18-15/R22：zh 镜像内建 init 产出的是中文模板，down 若写英文，
  //      回退后模板中英不一致 —— 实测两支 deleted_* 各 13 个字段值错。
  //      这里只锁「不得再出现英文内建串」，取值正确性由容器级逐步归因复核。）
  const EN_TPL = [
    'Login from a new location',
    'Verify your {APP_NAME} email',
    'Reset your {APP_NAME} password',
    'Confirm your {APP_NAME} new email address',
    'OTP for {APP_NAME}',
    '<p>Hello,</p>',
  ]
  const enHits = []
  for (const f of files) {
    const src = read(join('pb_migrations', f))
    for (const s of EN_TPL) if (src.includes(s)) enHits.push(`${f}: ${s}`)
  }
  check('迁移里没有 PB 内建的英文邮件模板（zh 版应为中文）', enHits.length === 0,
    enHits.length ? enHits.join(' | ') : `扫描 ${files.length} 个文件，0 处`)
}

// ── 3. i18n 文案键对称 ───────────────────────────────────────────────────────
function checkI18n() {
  console.log('\n=== i18n 文案键 ===')
  const src = read('src/lib/i18n.ts')
  const section = (name, next) => {
    const i = src.indexOf(`  ${name}: {`)
    const j = next ? src.indexOf(`  ${next}: {`) : src.length
    return i < 0 || j < 0 ? '' : src.slice(i, j)
  }
  const keys = (body) => [...body.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1])
  const zh = keys(section('zh', 'en'))
  const en = keys(section('en', null))
  if (zh.length === 0 || en.length === 0) {
    check('zh / en 键集合可解析', false, `解析到 zh=${zh.length} en=${en.length}（源文件存在却解析不出键，按失败处理）`)
    return
  }
  const dup = (list) => list.filter((k, i) => list.indexOf(k) !== i)
  const onlyZh = zh.filter((k) => !en.includes(k))
  const onlyEn = en.filter((k) => !zh.includes(k))
  check('zh / en 键集合一致且无重复键',
    onlyZh.length === 0 && onlyEn.length === 0 && dup(zh).length === 0 && dup(en).length === 0,
    `zh=${zh.length} en=${en.length} 仅 zh=${onlyZh.join(',') || '-'} 仅 en=${onlyEn.join(',') || '-'} 重复=${dup(zh).join(',') || '-'}`)
}

// ── 4. PocketBase 本地化二进制指纹（清单 / Dockerfile / README 三处一致）──────
function checkPbbin() {
  console.log('\n=== pb-bin 指纹登记一致性 ===')
  const sums = read('pb-bin/SHA256SUMS')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.match(/^([0-9a-f]{64})\s{2}(.+)$/)).filter(Boolean)
    .map((m) => ({ sha: m[1], file: m[2] }))
  const docker = read('pb-bin/Dockerfile')
  const readme = read('pb-bin/README.md')
  const want = [...docker.matchAll(/want_sha256=([0-9a-f]{64})/g)].map((m) => m[1])
  if (sums.length === 0 || want.length === 0) {
    notExecuted('pb-bin 指纹三处一致', `清单条目 ${sums.length}、Dockerfile 常量 ${want.length}`); return
  }
  const missingInDocker = sums.filter((s) => !want.includes(s.sha))
  const missingInSums = want.filter((w) => !sums.some((s) => s.sha === w))
  check('SHA256SUMS 与 Dockerfile 期望常量双向一致',
    missingInDocker.length === 0 && missingInSums.length === 0,
    `清单 ${sums.length} 条 / Dockerfile ${want.length} 条；清单独有 ${missingInDocker.length}，Dockerfile 独有 ${missingInSums.length}`)
  const missingInReadme = sums.filter((s) => !readme.includes(s.sha))
  check('README 表格登记了清单中的全部指纹', missingInReadme.length === 0,
    `README 缺失 ${missingInReadme.length} 条${missingInReadme.length ? '：' + missingInReadme.map((s) => s.file).join(', ') : ''}`)

  // 二进制本体不入库，检出时通常不存在 —— 明确记为未执行，而不是静默通过
  const present = sums.filter((s) => existsSync(join(ROOT, 'pb-bin', s.file)))
  if (present.length === 0) {
    notExecuted('二进制本体的 SHA-256 比对', '二进制按设计不入库（请在本机构建时用 pb-bin 的构建流程校验）', true)
  } else {
    // 口径：二进制按设计不入库。若本机另行重建过，本地文件与清单不符 —— 那是本地构建产物与
    // 登记不符，不是「仓库内容自洽性」的问题（CI 里根本没有这些文件，此项必然未执行）。
    // 因此入库者按失败判，未入库者只提示并打印实得指纹，供人工比对。
    const isTracked = (f) =>
      spawnSync('git', ['ls-files', '--error-unmatch', '--', `pb-bin/${f}`], { cwd: ROOT, stdio: 'ignore' }).status === 0
    let bad = 0
    let untrackedMismatch = 0
    for (const p of present) {
      const got = sha256(readFileSync(join(ROOT, 'pb-bin', p.file)))
      if (got === p.sha) continue
      if (isTracked(p.file)) {
        bad++
        console.log(`   ❌ ${p.file} 期望 ${p.sha.slice(0, 16)} 实得 ${got.slice(0, 16)}（该文件已入库）`)
      } else {
        untrackedMismatch++
        console.log(`   ⚠️  ${p.file} 登记 ${p.sha.slice(0, 16)} 本地实得 ${got.slice(0, 16)}（未入库：本地另行构建过，只提示）`)
      }
    }
    check('在场二进制的 SHA-256 与清单一致（已入库者必须一致）', bad === 0,
      `比对 ${present.length} 个，已入库不符 ${bad}，未入库不符 ${untrackedMismatch}`)
  }
}

// ── 5. 运行手册里的关键常量与源码对应 ───────────────────────────────────────
// 只对**必须被运行手册记述**的常量做断言（阈值、窗口、预算这类会直接影响行为的取值）；
// 其余常量仅列出，不做断言 —— 否则会把「文档没写内部实现常量」误判成缺陷。
const DOCUMENTED_CONSTANTS = [
  'MIN_FACE_RATIO', 'MIN_BLUR', 'MIN_BRIGHT', 'MAX_BRIGHT', 'MAX_YAW', 'MAX_PITCH', 'MAX_ROLL',
  'STABLE_FRAMES', 'HINT_BUF', 'HINT_NEED', 'MAX_FAILS', 'UPLOAD_BUDGET_MS', 'POSE_MAX_MS', 'BURST_GAP_MS',
]

function checkRunmdConstants() {
  console.log('\n=== RUN.md 与源码常量 ===')
  const doc = read('RUN.md')
  // R13-F11：提示表决的 HINT_BUF/HINT_NEED 随实现移到了 src/lib/hints.ts，来源清单必须同步 ——
  // 否则「常量仍存在于源码」这项会因找不到而报红（断言读真实来源，不是把清单当摆设）。
  const files = ['src/lib/quality.ts', 'src/lib/capture.ts', 'src/components/CaptureView.vue', 'src/lib/pb.ts', 'src/lib/hints.ts']
  const defined = new Set()
  const absent = []
  for (const f of files) {
    if (!existsSync(join(ROOT, f))) { absent.push(f); continue }
    for (const m of read(f).matchAll(/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*[-\d]/gm)) defined.add(m[1])
  }
  check('常量来源文件齐备', absent.length === 0, absent.length ? '缺失：' + absent.join(', ') : `${files.length} 个文件`)
  if (defined.size === 0) { notExecuted('RUN.md 关键常量对应', '源码中未解析到常量'); return }

  // 断言的常量必须真的存在于源码，否则等于断言失效
  const vanished = DOCUMENTED_CONSTANTS.filter((n) => !defined.has(n))
  check('待记述常量仍存在于源码（防止断言失效）', vanished.length === 0,
    `清单 ${DOCUMENTED_CONSTANTS.length} 个，源码中找不到 ${vanished.length}${vanished.length ? '：' + vanished.join(', ') : ''}`)

  const missing = DOCUMENTED_CONSTANTS.filter((n) => !doc.includes(n))
  check('关键常量在 RUN.md 中均有记述', missing.length === 0,
    `关键常量 ${DOCUMENTED_CONSTANTS.length} 个，文档未提及 ${missing.length}${missing.length ? '：' + missing.join(', ') : ''}`)

  const others = [...defined].filter((n) => !DOCUMENTED_CONSTANTS.includes(n) && !doc.includes(n)).sort()
  console.log(`ℹ️  其余源码常量未在 RUN.md 提及（不作断言）：${others.join(', ') || '无'}`)
}

// ── 6. CSP 的覆盖范围与已知敞口（R22/R17-X7） ────────────────────────────────
// 为什么单独立一条：JS 侧的两层防线只 patch 主线程的 fetch/XHR/sendBeacon，
// 图片通道（`new Image().src`）、`<script src>`、`<link rel=stylesheet>`、`<iframe src>`
// 完全绕开它们 —— 唯一的防线就是这条 CSP。R17-X7 实测：三层齐备页与生产页上
// img 通道确实出网（服务器侧有命中）。因此：
//   · img-src 必须在（这是可零风险关闭的一条：界面不渲染任何 <img>）；
//   · default-src 必须不在（它会接管 script-src，可能拦掉内联防线与 wasm 加载）；
//   · 仍敞开的三条通道必须在文档里写明，不许「以为已经全堵住了」。
function checkCsp() {
  console.log('\n=== CSP 覆盖范围 ===')
  if (!existsSync(join(ROOT, 'index.html'))) {
    check('index.html 存在', false, '文档缺失，CSP 无从检查')
    return
  }
  const html = read('index.html')
  const m = html.match(/http-equiv="Content-Security-Policy"[\s\S]{0,400}?content="([^"]+)"/)
  if (!m) {
    check('index.html 声明了 CSP', false, '找不到 Content-Security-Policy meta')
    return
  }
  const csp = m[1]
  check('CSP 声明了 connect-src', /\bconnect-src\b/.test(csp), csp.slice(0, 80))
  check('CSP 声明了 img-src（图片通道唯一防线）', /\bimg-src\b/.test(csp),
    /\bimg-src\b/.test(csp) ? csp.match(/img-src[^;]*/)[0] : '缺失：new Image().src 可绕过 JS 两层防线出网')
  // 光有 img-src 这个词不够 —— 取值必须是收紧集合。R22REV 实测：把 img-src 改成
  // `*` 或 `*:*` 后，只验「词存在」的断言仍然 exit 0（整条收紧被无声改回全开）。
  const imgVal = ((csp.match(/(?:^|;)\s*img-src\s+([^;]*)/) || [])[1] || '').trim()
  const imgToks = imgVal.split(/\s+/).filter(Boolean)
  const imgLoose = imgToks.filter((t) => t === '*' || t === '*:*' || /^(https?|ws|wss):$/.test(t))
  check('CSP 的 img-src 取值落回收紧集合（不得裸 * / *:* / 宽泛 scheme）',
    imgVal.length > 0 && imgLoose.length === 0 && imgToks.includes("'self'"),
    imgVal.length === 0 ? 'img-src 没有取值'
      : imgLoose.length ? `出现宽泛取值：${imgLoose.join(' ')}`
        : imgToks.includes("'self'") ? imgVal : `缺少 'self'：${imgVal}`)
  check('CSP 没有 default-src（否则会接管 script-src）', !/\bdefault-src\b/.test(csp),
    /\bdefault-src\b/.test(csp) ? '出现 default-src —— 可能拦掉内联防线与 wasm 加载' : '无 default-src')

  // 前提锁：界面不渲染 <img> 是「img-src 可以收紧到 self/data/blob/:8090」的前提。
  // 若将来真的加了 <img>（尤其是跨源图片），这条会红，提示维护者同步 CSP 与文档。
  // R22REV 实测的四条漏检（已全部覆盖）：根 index.html 里的 <img>、.css/.vue 样式里的
  // 跨源 background-image url()、大写 <IMG SRC=、跨行 <img\n src=。
  const imgTags = []
  const styleUrls = []
  const SCAN_EXT = /\.(vue|ts|js|mjs|cjs|html|css)$/
  const scanFile = (p) => {
    const rel = relative(ROOT, p)
    const src = readFileSync(p, 'utf8')
    // 注释里的字面量不算（R22 自己踩过：index.html 的说明文字里写了「界面不渲染 <img>」，
    // 按行直扫会把注释判成标签 —— 断言必须锚在语义位置，不能锚在「文件里有没有这个词」）。
    const masked = src
      .replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '))
      .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (s) => s.replace(/[^\n]/g, ' '))
    masked.split('\n').forEach((line, i) => {
      if (/<img[\s/>]/i.test(line)) imgTags.push(`${rel}:${i + 1}: ${line.trim().slice(0, 60)}`)
      if (/\.(css|vue)$/.test(rel) && /url\(\s*['"]?(?:https?:)?\/\//i.test(line)) {
        styleUrls.push(`${rel}:${i + 1}: ${line.trim().slice(0, 60)}`)
      }
    })
  }
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (!/^(node_modules|dist|\.git|pb_data)$/.test(e.name)) walk(p) }
      else if (SCAN_EXT.test(e.name)) scanFile(p)
    }
  }
  for (const rel of ['src', 'public', 'docs', 'index.html']) {
    const p = join(ROOT, rel)
    if (!existsSync(p)) continue
    if (statSync(p).isDirectory()) walk(p)
    else scanFile(p)
  }
  check('前提：源码里没有任何 <img> 标签（img-src 收紧不损伤功能）', imgTags.length === 0,
    imgTags.length ? `发现 ${imgTags.length} 处，需同步 CSP 与 RUN.md：${imgTags.slice(0, 3).join(' ｜ ')}` : '0 处')
  check('前提：样式里没有跨源 url() 图片引用（img-src 同样管它）', styleUrls.length === 0,
    styleUrls.length ? `发现 ${styleUrls.length} 处：${styleUrls.slice(0, 3).join(' ｜ ')}` : '0 处')

  // 文档一致性：仍敞开的三条通道与 img-src 必须写进 RUN.md
  const doc = read('RUN.md')
  const missing = []
  for (const k of ['img-src', 'script src', 'stylesheet', 'iframe src']) if (!doc.includes(k)) missing.push(k)
  check('RUN.md 写明 img-src 与仍敞开的三条通道', missing.length === 0,
    missing.length ? `RUN.md 未提及：${missing.join(', ')}` : '4 处口径齐备')
}

// ── 变异自检：证明上面每一项断言真的有判别力 ─────────────────────────────────
// 造一个最小可过的仓库副本，再逐个注入缺陷，确认「该红的红、干净的绿」。
// 变异体自身若没生效（文本未变化），会明确报「本次不构成结论」而不是记成漏检。
function runSelfCheck() {
  const tmp = join(ROOT, '.verify-selfcheck')
  rmSync(tmp, { recursive: true, force: true })
  const put = (rel, body) => {
    const abs = join(tmp, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  const asset = Buffer.from('fixture-asset-bytes\n')
  const assetSha = sha256(asset)
  const pristine = () => {
    rmSync(tmp, { recursive: true, force: true })
    put('public/asset.bin', asset)
    put('public/SHA256SUMS', `# 说明\n${assetSha}     ${asset.length}  asset.bin\n`)
    put('pb_migrations/1759600000_created.js', [
      'migrate((app) => {',
      '  const c = new Collection({ name: "x" })',
      '  c.fields.add(new TextField({ name: "session_id", pattern: "^[^\\s\\p{Z}\\p{Cc}](?:[^\\p{Cc}]{0,198}[^\\s\\p{Z}\\p{Cc}])?$" }))',
      '}, (app) => {',
      '  const c = app.findCollectionByNameOrId("x")',
      '  c.fields.getByName("session_id").pattern = ""',
      '  app.save(c)',
      '})',
      '',
    ].join('\n'))
    put('src/lib/i18n.ts', "const M = {\n  zh: {\n    a: '甲',\n  },\n  en: {\n    a: 'A',\n  },\n}\n")
    put('src/lib/quality.ts', DOCUMENTED_CONSTANTS.map((n) => `export const ${n} = 1`).join('\n') + '\n')
    put('src/lib/capture.ts', 'export const POSE_MAX_MS = 1\n')
    put('src/lib/pb.ts', 'export const UPLOAD_BUDGET_MS = 1\n')
    put('src/components/CaptureView.vue', 'const HINT_BUF = 1\n')
    // R13-F11：HINT_BUF / HINT_NEED 已移到 src/lib/hints.ts —— fixture 必须跟着走，
    // 否则「常量来源文件都存在」这项在阴性对照里就恒红，自检失去意义。
    put('src/lib/hints.ts', 'export const HINT_BUF = 1\nexport const HINT_NEED = 1\n')
    put('RUN.md', '# 手册\n' + DOCUMENTED_CONSTANTS.map((n) => `- ${n}`).join('\n') + '\nimg-src script src stylesheet iframe src\n')
    // R22：CSP 检查组要求 index.html 存在且声明 connect-src + img-src、且不含 default-src。
    // 阴性对照里这几条必须成立，否则「该红的红」与「副本本来就不行」分不清。
    put('index.html', '<!doctype html>\n<meta http-equiv="Content-Security-Policy" content="connect-src \'self\' *:8090 ws://*:8090 wss://*:8090; img-src \'self\' data: blob: *:8090" />\n')
    const bsha = 'b'.repeat(64)
    put('pb-bin/SHA256SUMS', `${bsha}  pocketbase-zh-linux-arm64\n`)
    put('pb-bin/Dockerfile', `case "\${TARGETARCH}" in\n  arm64) want_sha256=${bsha} ;;\nesac\n`)
    put('pb-bin/README.md', `| arm64 | \`${bsha}\` |\n`)
  }
  const parse = (r) => {
    const failed = (r.stdout.match(/^❌ (.+)$/gm) || []).map((l) => l.replace(/^❌ /, '').split('  ——')[0])
    const undet = Number((r.stdout.match(/未执行（样本为 0，覆盖面不完整）/) || []).length)
    return { code: r.status, failed, undet, out: r.stdout }
  }
  const run = () => parse(spawnSync(process.execPath, [join(ROOT, 'scripts/verify-repo.mjs')], {
    encoding: 'utf8', env: { ...process.env, VERIFY_REPO_ROOT: tmp },
  }))
  // 脚本级变异：把被测脚本本身复制到临时目录改一处再跑（用于验证「结构类」断言）。
  const runMutantScript = (mutateSrc) => {
    const src = readFileSync(join(ROOT, 'scripts/verify-repo.mjs'), 'utf8')
    const out = mutateSrc(src)
    if (out === src) throw new Error('变异未生效（脚本文本未变化）—— 本次不构成结论')
    const p = join(tmp, 'verify-repo-mutant.mjs')
    writeFileSync(p, out)
    return parse(spawnSync(process.execPath, [p], { encoding: 'utf8', env: { ...process.env, VERIFY_REPO_ROOT: tmp } }))
  }

  const cases = [
    { name: 'NEG 阴性对照（原始副本）', expectFail: [], mutate: () => {} },
    { name: 'M1 资源指纹被改一位', expectFail: ['登记文件的 SHA-256 与尺寸全部一致'], mutate: () => put('public/SHA256SUMS', `# 说明\n${'0'.repeat(63)}1     ${asset.length}  asset.bin\n`) },
    { name: 'M2 清单删掉一条（文件仍在）', expectFail: ['目录下资源全部已登记（反向断言）'], mutate: () => put('public/SHA256SUMS', '# 说明\n') },
    { name: 'M3 迁移引入 cascadeDelete=true', expectFail: ['没有迁移把 cascadeDelete 置为 true'], mutate: () => put('pb_migrations/1799900000_bad.js', 'migrate((app) => {\n  const o = { "cascadeDelete": true }\n}, (app) => {\n  const p = 1\n})\n') },
    { name: 'M4 英文侧键名与中文不一致', expectFail: ['zh / en 键集合一致且无重复键'], mutate: () => put('src/lib/i18n.ts', "const M = {\n  zh: {\n    a: '甲',\n  },\n  en: {\n    b: 'A',\n  },\n}\n") },
    { name: 'M5 RUN.md 漏掉一个关键常量', expectFail: ['关键常量在 RUN.md 中均有记述'], mutate: () => put('RUN.md', '# 手册\nimg-src script src stylesheet iframe src\n' + DOCUMENTED_CONSTANTS.slice(1).map((n) => `- ${n}`).join('\n') + '\n') },
    // R22：CSP 检查组的判别力（img-src 被摘掉 / default-src 被引入 / src 里新出现 <img>）
    { name: 'M8 CSP 里的 img-src 被摘掉', expectFail: ['CSP 声明了 img-src（图片通道唯一防线）'],
      mutate: () => put('index.html', '<!doctype html>\n<meta http-equiv="Content-Security-Policy" content="connect-src \'self\' *:8090" />\n') },
    { name: 'M9 CSP 里引入了 default-src', expectFail: ['CSP 没有 default-src（否则会接管 script-src）'],
      mutate: () => put('index.html', '<!doctype html>\n<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\' *:8090; img-src \'self\' data: blob: *:8090" />\n') },
    { name: 'M10 src/ 里新出现 <img> 标签（前提失效）', expectFail: ['前提：源码里没有任何 <img> 标签（img-src 收紧不损伤功能）'],
      mutate: () => put('src/components/CaptureView.vue', 'const HINT_BUF = 1\n<img src="https://cdn.example.com/x.png" />\n') },
    { name: 'M11 迁移里写回英文内建邮件模板', expectFail: ['迁移里没有 PB 内建的英文邮件模板（zh 版应为中文）'],
      mutate: () => put('pb_migrations/1799900001_en_tpl.js', 'migrate((app) => {\n  const c = { "subject": "Login from a new location" }\n}, (app) => {\n  const p = 1\n})\n') },
    // R22REV 实测的四条漏检（当时断言全绿 exit 0）→ 补成变异体，锁住不再回退。
    { name: 'M12 img-src 被放开成裸 *（收紧被无声改回全开）', expectFail: ['CSP 的 img-src 取值落回收紧集合（不得裸 * / *:* / 宽泛 scheme）'],
      mutate: () => put('index.html', '<!doctype html>\n<meta http-equiv="Content-Security-Policy" content="connect-src \'self\' *:8090; img-src *" />\n') },
    { name: 'M13 大写 <IMG SRC=> 注入 .vue', expectFail: ['前提：源码里没有任何 <img> 标签（img-src 收紧不损伤功能）'],
      mutate: () => put('src/components/CaptureView.vue', 'const HINT_BUF = 1\n<IMG SRC="https://cdn.example.com/x.png" />\n') },
    { name: 'M14 根 index.html 里注入 <img>（原先只扫 src/）', expectFail: ['前提：源码里没有任何 <img> 标签（img-src 收紧不损伤功能）'],
      mutate: () => put('index.html', '<!doctype html>\n<meta http-equiv="Content-Security-Policy" content="connect-src \'self\' *:8090; img-src \'self\' data: blob: *:8090" />\n<img src="https://cdn.example.com/x.png" />\n') },
    { name: 'M15 样式里注入跨源 background-image url()', expectFail: ['前提：样式里没有跨源 url() 图片引用（img-src 同样管它）'],
      mutate: () => put('src/style.css', '.a { background-image: url("https://cdn.example.com/a.png"); }\n') },
    // 零样本与崩溃面（R14-C 报的 P1/P2）—— 这些场景过去一律 exit 0
    { name: 'ZS1 迁移目录为空 → 样本为 0 判未判定', expectCode: 2, expectFail: [], mutate: () => rmSync(join(tmp, 'pb_migrations/1759600000_created.js'), { force: true }) },
    { name: 'ZS2 pb-bin/SHA256SUMS 为空 → 样本为 0 判未判定', expectCode: 2, expectFail: [], mutate: () => put('pb-bin/SHA256SUMS', '# 空清单\n') },
    { name: 'ZS3 源码常量来源文件缺失 → 记失败项而非崩溃', expectCode: 1, expectFail: ['常量来源文件齐备'], mutate: () => rmSync(join(tmp, 'src/lib/hints.ts'), { force: true }) },
    { name: 'ZS4 public/SHA256SUMS 缺失 → 记失败项而非崩溃', expectCode: 1, expectFail: ['public/SHA256SUMS 存在'], mutate: () => rmSync(join(tmp, 'public/SHA256SUMS'), { force: true }) },
    { name: 'M6 二进制定位指纹与清单不一致', expectFail: ['SHA256SUMS 与 Dockerfile 期望常量双向一致'], mutate: () => put('pb-bin/Dockerfile', `case "\${TARGETARCH}" in\n  arm64) want_sha256=${'c'.repeat(64)} ;;\nesac\n`) },
    // 结构类断言：删掉一个 section(...) 调用 —— 以前 executed 只会变小，没人发现。
    { name: 'M7 检查组整体漏调（删掉 section 调用）', scriptMutate: (s) => s.replace("  section('i18n', checkI18n)\n", ''), expectCode: 2, expectFail: ['所有检查组都被调用'] },
  ]

  console.log('=== 变异自检（验证每一项断言有判别力）===')
  let bad = 0
  for (const c of cases) {
    pristine()
    c.mutate?.()
    const { code, failed, out } = c.scriptMutate ? runMutantScript(c.scriptMutate) : run()
    // 三态：expectCode 缺省时按「无 expectFail 即 exit 0、有 expectFail 即 exit 1」推断
    const wantCode = c.expectCode ?? (c.expectFail.length === 0 ? 0 : 1)
    const asExpected = code === wantCode && c.expectFail.every((f) => failed.includes(f))
    console.log(`${asExpected ? '✅' : '❌'} ${c.name}  —— exit=${code}（期望 ${wantCode}）失败项=${failed.length}${failed.length ? '：' + failed.join(' | ') : ''}`)
    if (!asExpected) {
      bad++
      console.log('   ── 子进程输出 ──')
      console.log(out.split('\n').map((l) => '   ' + l).join('\n'))
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n变异自检：${cases.length - bad}/${cases.length} 符合预期`)
  process.exit(bad ? 1 : 0)
}

// 前向防线：每个检查组都必须在下面被真的调用一次。
// 漏调一个 section 时 `executed` 只会变小、不会变成 0，所以单看 `executed === 0`
// 发现不了「整段检查消失」（复核席 P3 实测：空 ROOT 仍执行 1 项）。
const EXPECTED_SECTIONS = ['public/ 资源指纹', 'pb_migrations', 'i18n', 'pb-bin 指纹', 'RUN.md 常量', 'CSP 覆盖范围']
// 每个检查组至少要**尝试**这么多条断言（硬编码字面量：故意不写成「取当前值」或从数组推导）。
// 掏空某个组的函数体 → 该组尝试条数掉到 0 → 下面立刻报红。
const SECTION_MIN_CHECKS = {
  'public/ 资源指纹': 3,
  'pb_migrations': 6,
  'i18n': 1,
  'pb-bin 指纹': 3,
  'RUN.md 常量': 3,
  'CSP 覆盖范围': 7,
}
// 全局下限：新增/删除检查必须显式改这个字面量（改它是一次可被 review 的改动）
const MIN_TOTAL_CHECKS = 23

if (process.argv.includes('--self-check')) {
  runSelfCheck()
} else {
  section('public/ 资源指纹', checkPublicIntegrity)
  section('pb_migrations', checkMigrations)
  section('i18n', checkI18n)
  section('pb-bin 指纹', checkPbbin)
  section('RUN.md 常量', checkRunmdConstants)
  section('CSP 覆盖范围', checkCsp)

  // 条数类断言：不依赖 ranSections / EXPECTED_SECTIONS 的一致性，
  // 所以「把调用和清单一起删」也躲不过它。
  const countsText = Object.keys(SECTION_MIN_CHECKS).map((n) => `${n}=${sectionChecks[n] ?? 0}`).join(' ')
  if (undetermined > 0) {
    notExecuted('每个检查组都跑了足够多的断言', '存在样本为 0 的检查组，条数不足以判定覆盖完整性')
    notExecuted('断言总数不低于硬编码下限', '同上')
  } else {
    const thin = Object.entries(SECTION_MIN_CHECKS).filter(([n, min]) => (sectionChecks[n] ?? 0) < min)
    check(
      '每个检查组都跑了足够多的断言',
      thin.length === 0,
      thin.length === 0
        ? `各组尝试条数 ${countsText}`
        : `断言条数不足：${thin.map(([n, min]) => `${n} 只有 ${sectionChecks[n] ?? 0} 条（至少 ${min}）`).join('；')}；各组尝试条数 ${countsText}`,
    )
    check(
      '断言总数不低于硬编码下限',
      attempted >= MIN_TOTAL_CHECKS,
      `实际尝试 ${attempted} 条，下限 ${MIN_TOTAL_CHECKS} 条`,
    )
  }

  const missingSections = EXPECTED_SECTIONS.filter((n) => !ranSections.includes(n))
  const extraSections = ranSections.filter((n) => !EXPECTED_SECTIONS.includes(n))
  const sectionsOk = missingSections.length === 0 && extraSections.length === 0
  check('所有检查组都被调用', sectionsOk,
    sectionsOk
      ? `已执行 ${ranSections.length} 个检查组`
      : `缺少 ${missingSections.join('、') || '无'}；多出 ${extraSections.join('、') || '无'}`)
  if (!sectionsOk) {
    console.log('❌ 检查组调用不齐 —— 有整段检查没有运行，本次不构成结论')
    process.exit(2)
  }

  const failed = results.filter((r) => r.ok === false)
  console.log(`\n=== 汇总 ===`)
  console.log(`执行 ${executed} 项，通过 ${executed - failed.length}，失败 ${failed.length}；`
    + `未执行 ${undetermined + skippedByDesign} 项（样本为 0 的 ${undetermined} 项、环境所限的 ${skippedByDesign} 项）`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  ❌ ${f.name}  —— ${f.detail}`)
  }
  // 兜底：上面的「所有检查组都被调用」已经覆盖「整段消失」，这一条只在
  // 连一个检查项都没注册时才可能命中（例如有人在 section 里提前 return）。
  if (executed === 0) {
    console.log('❌ 没有任何检查被真正执行 —— 本次不构成结论')
    process.exit(2)
  }
  if (failed.length) process.exit(1)
  // 样本为 0 时整节断言会消失，此时「没失败」不代表「没问题」——必须判未判定。
  if (undetermined > 0) {
    console.log(`❌ 有 ${undetermined} 项因样本为 0 未执行 —— 覆盖面不完整，本次不构成通过`)
    process.exit(2)
  }
  process.exit(0)
}
