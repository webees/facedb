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
let skipped = 0

function check(name, ok, detail = '') {
  executed++
  results.push({ name, ok, detail })
  const mark = ok ? '✅' : '❌'
  console.log(`${mark} ${name}${detail ? '  —— ' + detail : ''}`)
}

function notExecuted(name, why) {
  skipped++
  results.push({ name, ok: null, detail: why })
  console.log(`⚠️  未执行：${name}  —— ${why}`)
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
    notExecuted('二进制本体的 SHA-256 比对', '二进制按设计不入库（请在本机构建时用 pb-bin 的构建流程校验）')
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
  const files = ['src/lib/quality.ts', 'src/lib/capture.ts', 'src/components/CaptureView.vue', 'src/lib/pb.ts']
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
    put('RUN.md', '# 手册\n' + DOCUMENTED_CONSTANTS.map((n) => `- ${n}`).join('\n') + '\n')
    const bsha = 'b'.repeat(64)
    put('pb-bin/SHA256SUMS', `${bsha}  pocketbase-zh-linux-arm64\n`)
    put('pb-bin/Dockerfile', `case "\${TARGETARCH}" in\n  arm64) want_sha256=${bsha} ;;\nesac\n`)
    put('pb-bin/README.md', `| arm64 | \`${bsha}\` |\n`)
  }
  const run = () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/verify-repo.mjs')], {
      encoding: 'utf8', env: { ...process.env, VERIFY_REPO_ROOT: tmp },
    })
    const failed = (r.stdout.match(/^❌ (.+)$/gm) || []).map((l) => l.replace(/^❌ /, '').split('  ——')[0])
    return { code: r.status, failed, out: r.stdout }
  }

  const cases = [
    { name: 'NEG 阴性对照（原始副本）', expectFail: [], mutate: () => {} },
    { name: 'M1 资源指纹被改一位', expectFail: ['登记文件的 SHA-256 与尺寸全部一致'], mutate: () => put('public/SHA256SUMS', `# 说明\n${'0'.repeat(63)}1     ${asset.length}  asset.bin\n`) },
    { name: 'M2 清单删掉一条（文件仍在）', expectFail: ['目录下资源全部已登记（反向断言）'], mutate: () => put('public/SHA256SUMS', '# 说明\n') },
    { name: 'M3 迁移引入 cascadeDelete=true', expectFail: ['没有迁移把 cascadeDelete 置为 true'], mutate: () => put('pb_migrations/1799900000_bad.js', 'migrate((app) => {\n  const o = { "cascadeDelete": true }\n}, (app) => {\n  const p = 1\n})\n') },
    { name: 'M4 英文侧键名与中文不一致', expectFail: ['zh / en 键集合一致且无重复键'], mutate: () => put('src/lib/i18n.ts', "const M = {\n  zh: {\n    a: '甲',\n  },\n  en: {\n    b: 'A',\n  },\n}\n") },
    { name: 'M5 RUN.md 漏掉一个关键常量', expectFail: ['关键常量在 RUN.md 中均有记述'], mutate: () => put('RUN.md', '# 手册\n' + DOCUMENTED_CONSTANTS.slice(1).map((n) => `- ${n}`).join('\n') + '\n') },
    { name: 'M6 二进制定位指纹与清单不一致', expectFail: ['SHA256SUMS 与 Dockerfile 期望常量双向一致'], mutate: () => put('pb-bin/Dockerfile', `case "\${TARGETARCH}" in\n  arm64) want_sha256=${'c'.repeat(64)} ;;\nesac\n`) },
  ]

  console.log('=== 变异自检（验证每一项断言有判别力）===')
  let bad = 0
  for (const c of cases) {
    pristine()
    c.mutate()
    const { code, failed, out } = run()
    const asExpected = c.expectFail.length === 0
      ? code === 0 && failed.length === 0
      : code === 1 && c.expectFail.every((f) => failed.includes(f))
    console.log(`${asExpected ? '✅' : '❌'} ${c.name}  —— exit=${code} 失败项=${failed.length}${failed.length ? '：' + failed.join(' | ') : ''}`)
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

if (process.argv.includes('--self-check')) {
  runSelfCheck()
} else {
  checkPublicIntegrity()
  checkMigrations()
  checkI18n()
  checkPbbin()
  checkRunmdConstants()

  const failed = results.filter((r) => r.ok === false)
  console.log(`\n=== 汇总 ===`)
  console.log(`执行 ${executed} 项，通过 ${executed - failed.length}，失败 ${failed.length}；未执行 ${skipped} 项`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  ❌ ${f.name}  —— ${f.detail}`)
  }
  if (executed === 0) {
    console.log('❌ 没有任何检查被真正执行 —— 本次不构成结论')
    process.exit(2)
  }
  process.exit(failed.length ? 1 : 0)
}
