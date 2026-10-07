// 判据：仓库配置文件（.gitattributes / .editorconfig）的「零命中规则」与「哈希资产保护」。
//
// 起因（R14-B 的 3 条 P3）：这两个文件里的规则**没有任何机制检查它们是否还在生效**。
//   · .gitattributes 里 13 条二进制规则，11 条命中 0 个已跟踪文件（*.png/*.jpg/... 全为 0）
//   · .editorconfig 的 [Makefile] 段落 —— 仓库里根本没有 Makefile
//   · 更危险的一条：public/wasm/*.js 被 sha256 登记在 public/SHA256SUMS 里（public-integrity 判据按它比对），
//     而 .editorconfig 全局 trim_trailing_whitespace=true —— 实测这两个文件各有 16 行带行尾空格，
//     任何遵循 editorconfig 的编辑器/格式化钩子一旦保存它们，哈希就会变 → 判据红、实际运行的文件与登记值不符。
//
// 断言：
//   A1 .gitattributes 的每条规则模式，必须命中 ≥1 个已跟踪文件，或标注「预留」
//   A2 .editorconfig 的每个段落 glob，必须命中 ≥1 个已跟踪文件，或标注「预留」
//   A3 public/SHA256SUMS 登记的每个文本类（.js/.json/.css/.md/.txt）资源，必须被某条
//      trim_trailing_whitespace=false 的 editorconfig 段落覆盖
//   A4 行尾口径一致：.gitattributes 的 `eol=lf` 与 .editorconfig 的 `end_of_line = lf` 同时存在
//   A5 反向断言：被 editorconfig 覆盖的哈希资产，其当前内容与 public/SHA256SUMS 一致（不能被已发生的格式化改坏）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件是仓库内版本（原版在审计运行根 lib/ 下）。移植时只改了根目录解析与 env 名：
//   HYG_ROOT=… 指向副本（变异自检用）；默认取脚本自身位置的上一级。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.HYG_ROOT ? path.resolve(process.env.HYG_ROOT) : path.resolve(HERE, '..')
let pass = 0, fail = 0
const ck = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)
  ok ? pass++ : fail++
}
const CK = process.env.CK_LOG
const lines = []
const log = (s) => { console.log(s); lines.push(s) }

const tracked = spawnSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)

// glob → 正则（够用即可：*、**、{a,b}、?、[abc]、无斜杠者按 basename 任意深度匹配）
const globToRe = (glob) => {
  const anchored = glob.includes('/')
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ }
      else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      const alts = glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      re += '(?:' + alts.join('|') + ')'
      i = end
    } else if ('.[]()+^$|\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return anchored ? new RegExp('^' + re + '$') : new RegExp('(^|/)' + re + '$')
}
const hits = (glob) => {
  const re = globToRe(glob)
  return tracked.filter((f) => re.test(f))
}

log('=== A1 .gitattributes 零命中规则 ===')
const gaPath = ROOT + '/.gitattributes'
const ga = readFileSync(gaPath, 'utf8').split('\n')
const gaRules = []
// .gitattributes 不支持行尾注释（属性之后的任何东西都会被当成属性），所以「预留」只能靠
// 上方注释块标注；这里按「空行结束一个块、块内出现『预留』则整块视为已标注」来解析。
let reserved = false
for (let i = 0; i < ga.length; i++) {
  const t = ga[i].trim()
  if (!t) { reserved = false; continue }
  if (t.startsWith('#')) { if (/预留|当前 0 命中/.test(t)) reserved = true; continue }
  const parts = t.split(/\s+/)
  gaRules.push({ pattern: parts[0], attr: parts[parts.length - 1], annotated: reserved, n: hits(parts[0]).length, line: i + 1 })
}
const gaZero = gaRules.filter((r) => r.n === 0 && !r.annotated)
ck(
  `.gitattributes 每条规则都命中 ≥1 个已跟踪文件或已标注「预留」（共 ${gaRules.length} 条规则）`,
  gaZero.length === 0,
  gaZero.length ? '零命中且未标注：' + gaZero.map((r) => `${r.pattern}(L${r.line})`).join('、') : `零命中 ${gaRules.filter((r) => r.n === 0).length} 条均已标注`,
)
for (const r of gaRules.filter((x) => x.n === 0)) log(`      [零命中] ${r.pattern}  L${r.line}  ${r.annotated ? '已标注' : '未标注'}`)

log('=== A2 .editorconfig 零命中段落 ===')
const ecPath = ROOT + '/.editorconfig'
const ec = readFileSync(ecPath, 'utf8').split('\n')
const sections = []
let cur = null
for (let i = 0; i < ec.length; i++) {
  const t = ec[i].trim()
  if (t.startsWith('[') && t.endsWith(']')) {
    cur = { glob: t.slice(1, -1), line: i + 1, keys: [], annotated: false }
    sections.push(cur)
  } else if (cur) {
    if (/预留|当前 0 命中/.test(t)) cur.annotated = true
    if (t && !t.startsWith('#')) cur.keys.push(t)
  }
}
for (const s of sections) s.n = hits(s.glob).length
const ecZero = sections.filter((s) => s.n === 0 && !s.annotated)
ck(
  `.editorconfig 每段落都命中 ≥1 个已跟踪文件或已标注「预留」（共 ${sections.length} 段）`,
  ecZero.length === 0,
  ecZero.length ? '零命中且未标注：' + ecZero.map((s) => `${s.glob}(L${s.line})`).join('、') : `零命中 ${sections.filter((s) => s.n === 0).length} 段均已标注`,
)

log('=== A3 哈希登记的文本资产必须被 trim=false 覆盖 ===')
const sumsPath = ROOT + '/public/SHA256SUMS'
const sums = []
for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
  const m = line.match(/^([0-9a-f]{64})\s+(\d+)\s+(\S+)\s*$/)
  if (m) sums.push({ sha: m[1], size: Number(m[2]), path: m[3] })
}
const textish = sums.filter((s) => /\.(js|json|css|md|txt)$/.test(s.path))
const unprotected = []
for (const s of textish) {
  const full = 'public/' + s.path
  const trimmed = sections.some(
    (sec) => sec.keys.some((k) => /trim_trailing_whitespace\s*=\s*false/.test(k)) && hits(sec.glob).includes(full),
  )
  if (!trimmed) unprotected.push(full)
}
ck(
  `哈希登记的文本资产都受 trim_trailing_whitespace=false 保护（${textish.length} 个文本资产 / 登记共 ${sums.length} 项）`,
  unprotected.length === 0,
  unprotected.length ? '未受保护：' + unprotected.join('、') : textish.map((s) => 'public/' + s.path).join('、'),
)

log('=== A4 行尾口径一致 ===')
const gaEol = gaRules.some((r) => r.attr === 'eol=lf')
const ecEol = ec.some((l) => /^end_of_line\s*=\s*lf/.test(l.trim()))
ck('.gitattributes 有 eol=lf 且 .editorconfig 有 end_of_line = lf', gaEol && ecEol, `gitattributes=${gaEol} editorconfig=${ecEol}`)

log('=== A5 哈希资产当前内容确实与登记值一致（不能被已发生的格式化改坏）===')
const mismatch = []
for (const s of sums) {
  const p = ROOT + '/public/' + s.path
  if (!existsSync(p)) { mismatch.push(`${s.path}(缺失)`); continue }
  const h = createHash('sha256').update(readFileSync(p)).digest('hex')
  if (h !== s.sha) mismatch.push(`${s.path}(${h.slice(0, 12)} != ${s.sha.slice(0, 12)})`)
}
ck('public/SHA256SUMS 登记的每项都与磁盘一致', mismatch.length === 0, mismatch.length ? mismatch.join('、') : `${sums.length} 项全部一致`)

log('')
log(`通过 ${pass}，失败 ${fail}`)
if (CK) writeFileSync(CK, lines.join('\n') + '\n')
process.exit(fail === 0 ? 0 : 1)
