// 变异自检：仓库配置卫生判据（scripts/check-repo-config-hygiene.mjs）的零样本纪律与健壮性。
//
// 起因（W25-E 的 W25E-02/W25E-03/W25E-04，P2/P3）：判据的四条断言在**样本为 0** 时退化成空真命题
//    （`.gitattributes` 只剩注释 ⇒「零命中 0 条均已标注」✅；`public/SHA256SUMS` 0 字节 ⇒「0 项全部一致」✅），
//    整体 `通过 5，失败 0`、exit 0；且退出码只有 `fail === 0 ? 0 : 1`，结构上表达不了「本次没构成结论」。
//    另有健壮性：读不到的配置文件（缺失 / 是目录 / 权限 000）会裸栈崩。
//
// 本电池的做法与工程既有纪律一致：**每个场景建独立临时 git 仓库**（真 git init + git add），
//    把判据指向它（`HYG_ROOT`），断言退出码 + 关键行文本；并带一条**阴性对照**（把 HEAD 版判据喂进
//    同一批空样本 fixture，必须 exit 0 —— 证明「修复前确实假通过」而不是「场景本身不成立」）。
//
// 用法：node scripts/check-repo-config-hygiene-selftest.mjs
//   HYG_SCAN=<判据路径>  覆盖被测判据（成对读数用）
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = path.resolve(HERE, '..')
const SCANNER = process.env.HYG_SCAN ? path.resolve(process.env.HYG_SCAN) : path.join(HERE, 'check-repo-config-hygiene.mjs')

let pass = 0, fail = 0
const results = []
const rec = (ok, msg) => { ok ? pass++ : fail++; results.push(`${ok ? '✅' : '❌'} ${msg}`); console.log(`  ${ok ? '✅' : '❌'} ${msg}`) }

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

// 干净 fixture 的四件套（能同时满足 A1–A5）
const DATA = '{"a":1}\n'
const CLEAN = {
  '.gitattributes': '*.json text eol=lf\n',
  '.editorconfig': 'root = true\n\n[*]\nend_of_line = lf\ncharset = utf-8\n\n[public/*.json]\ntrim_trailing_whitespace = false\n',
  'public/data.json': DATA,
  'public/SHA256SUMS': `${sha256(DATA)}  ${Buffer.byteLength(DATA)}  data.json\n`,
}

const makeRepo = (over) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'facedb-hyg-selftest-'))
  const files = { ...CLEAN, ...over }
  for (const [rel, val] of Object.entries(files)) {
    if (rel.startsWith('__')) continue // 控制键（__noGit 等），不是文件
    if (val === null) continue
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    if (val === 'DIR') mkdirSync(abs, { recursive: true })
    else writeFileSync(abs, val)
  }
  if (files.__noGit !== true) {
    spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' })
    spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' })
  }
  return dir
}
const run = (root, scanner = SCANNER) => {
  const r = spawnSync(process.execPath, [scanner], { encoding: 'utf8', env: { ...process.env, HYG_ROOT: root, CK_LOG: '' } })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.stderr || '' }
}
const check = (s, r) => {
  const missing = (s.expect.has || []).filter((t) => !r.out.includes(t))
  const present = (s.expect.notHas || []).filter((t) => r.out.includes(t))
  const codeOk = s.expect.codeIn ? s.expect.codeIn.includes(r.code) : r.code === s.expect.code
  const stack = s.expect.noStack ? /at (Object\.)?readFileSync|at.*node:fs/.test(r.err) : false
  const ok = codeOk && missing.length === 0 && present.length === 0 && !stack
  const want = s.expect.codeIn ? `exit∈{${s.expect.codeIn.join(',')}}` : `exit=${s.expect.code}`
  rec(ok, `${s.name}｜期望 ${want} 实得 ${r.code}${missing.length ? `｜缺文本：${missing.join(' / ')}` : ''}${present.length ? `｜不该出现：${present.join(' / ')}` : ''}${stack ? '｜出现裸栈' : ''}`)
}
const cleanup = (dirs) => {
  for (const d of dirs) {
    if (!d) continue
    try { chmodSync(path.join(d, '.gitattributes'), 0o644) } catch {}
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
}

// 场景：每个 = { name, over, expect: { code, has: [...] } }
const SCENARIOS = [
  {
    name: 'h1 空真命题 A1（.gitattributes 只剩注释）',
    over: { '.gitattributes': '# 全是注释，没有任何规则\n' },
    // A1 无样本时 A4（要求某条规则带 eol=lf）必然同时红 ⇒ 退出码 1 也算正确，
    // 关键是 A1 不再打印「✅ 每条规则都命中…」这种空真命题。
    expect: { codeIn: [1, 2], has: ['⚠️ A1 .gitattributes 零命中规则', '规则数 0'], notHas: ['✅ .gitattributes 每条规则都命中'] },
  },
  {
    name: 'h2 空真命题 A2（.editorconfig 无段落）',
    over: { '.editorconfig': '# 只有注释\n' },
    expect: { codeIn: [1, 2], has: ['⚠️ A2 .editorconfig 零命中段落', '段落数 0'], notHas: ['✅ .editorconfig 每段落都命中'] },
  },
  {
    name: 'h3 空真命题 A3/A5（public/SHA256SUMS 0 字节）',
    over: { 'public/SHA256SUMS': '' },
    expect: { code: 2, has: ['A3 哈希登记的文本资产受保护', '文本类 0 个', 'A5 哈希资产内容与登记值一致', '登记项 0 个'] },
  },
  {
    name: 'h4 读不到：.gitattributes 缺失',
    over: { '.gitattributes': null },
    expect: { code: 2, has: ['A1 .gitattributes 零命中规则', '读不到'] },
  },
  {
    name: 'h5 读不到：.gitattributes 是目录',
    over: { '.gitattributes': 'DIR' },
    expect: { code: 2, has: ['读不到'], noStack: true },
  },
  {
    name: 'h6 读不到：.gitattributes 权限 000',
    over: { '.gitattributes': '*.json text eol=lf\n' },
    chmod: { '.gitattributes': 0o000 },
    skipIfRoot: true,
    expect: { code: 2, has: ['读不到'], noStack: true },
  },
  {
    name: 'h7 前提不成立：不是 git 仓库',
    over: { __noGit: true },
    expect: { codeIn: [1, 2], has: ['能列出已跟踪文件'] },
  },
  {
    name: 'h8 真缺陷仍必须被抓（零命中且未标注 ⇒ exit 1，不是 2）',
    over: { '.gitattributes': '*.json text eol=lf\n*.png binary\n' },
    expect: { code: 1, has: ['零命中且未标注：*.png'] },
  },
  {
    name: 'h9 干净控制组（exit 0，未判定 0）',
    over: {},
    expect: { code: 0, has: ['通过 5，失败 0，未判定 0'] },
  },
]

console.log(`被测判据：${SCANNER}`)
const dirs = []
let skipped = 0
for (const s of SCENARIOS) {
  if (s.skipIfRoot && typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log(`  ⏭ ${s.name}（以 root 运行，权限位不生效 —— 本场景不构成结论）`)
    skipped++
    continue
  }
  const dir = makeRepo(s.over)
  dirs.push(dir)
  if (s.chmod) for (const [rel, mode] of Object.entries(s.chmod)) chmodSync(path.join(dir, rel), mode)
  check(s, run(dir))
}

// 阴性对照：同一批空样本 fixture 喂给 HEAD 版判据，必须 exit 0（证明修复前是假通过）
const headSrc = spawnSync('git', ['-C', PROJ, 'show', 'HEAD:scripts/check-repo-config-hygiene.mjs'], { encoding: 'utf8' })
if (headSrc.status !== 0 || !headSrc.stdout) {
  console.log('  ⏭ 阴性对照（取不到 HEAD 版判据 —— 本次不构成结论）')
  skipped++
} else {
  const headFile = path.join(mkdtempSync(path.join(tmpdir(), 'facedb-hyg-head-')), 'check-repo-config-hygiene.mjs')
  writeFileSync(headFile, headSrc.stdout)
  dirs.push(path.dirname(headFile))
  // A1 空样本：HEAD 版仍打印空真命题的 ✅ 行（这才是缺陷本体）；整体退出码同时被 A4 连带成 1
  // —— W25-E 报的「A1 情形整体通过 5 失败 0 exit 0」在本工程实测不成立，故这里分开断言两件事。
  const dA1 = makeRepo({ '.gitattributes': '# 注释\n' })
  dirs.push(dA1)
  const rA1 = run(dA1, headFile)
  rec(/✅ .gitattributes 每条规则都命中/.test(rA1.out) && rA1.code === 1,
    `n1 阴性对照（HEAD 版判据 + A1 空样本 ⇒ 仍打印空真命题的 ✅ 行）｜实得 exit=${rA1.code}、含空真命题行=${/✅ .gitattributes 每条规则都命中/.test(rA1.out)}`)
  // A3 空样本：HEAD 版整体 exit 0（真正的假通过）
  const dA3 = makeRepo({ 'public/SHA256SUMS': '' })
  dirs.push(dA3)
  const rA3 = run(dA3, headFile)
  rec(rA3.code === 0 && /通过 \d+，失败 0/.test(rA3.out) && /0 项全部一致/.test(rA3.out),
    `n1 阴性对照（HEAD 版判据 + A3 空样本 ⇒ 修复前假通过 exit 0）｜实得 exit=${rA3.code}、含「0 项全部一致」=${/0 项全部一致/.test(rA3.out)}`)
}

cleanup(dirs)
console.log('')
console.log(`${SCENARIOS.length - skipped} 个场景 + 阴性对照 —— 通过 ${pass}，失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
