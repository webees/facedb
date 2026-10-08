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
//   A6（R25 新增）零样本纪律：A1/A2/A3/A5 的样本量各自为 0 时**不得判通过**，一律判「未判定」并 exit 2。
//      起因（W25-E 的 W25E-02，P2）：`.gitattributes` 只剩注释、`public/SHA256SUMS` 是 0 字节时，
//      四条断言全部退化成空真命题（`零命中 0 条均已标注`、`0 项全部一致`），整体 `通过 5，失败 0`、exit 0。
//      同时补上健壮性：读不到的配置（缺失 / 是目录 / 权限 000 / 超大文件）一律判未判定，不许裸栈崩。
//   A7（R25 新增）退出码三态：失败 → 1；有未判定 → 2；否则 0。原实现只有 `fail === 0 ? 0 : 1`，
//      结构上表达不了「这次没构成结论」。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件是仓库内版本（原版在审计运行根 lib/ 下）。移植时只改了根目录解析与 env 名：
//   HYG_ROOT=… 指向副本（变异自检用）；默认取脚本自身位置的上一级。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.HYG_ROOT ? path.resolve(process.env.HYG_ROOT) : path.resolve(HERE, '..')
let pass = 0, fail = 0, un = 0
const ck = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`)
  ok ? pass++ : fail++
}
// 未判定：样本为 0、或读不到被测文件（R25 新增，见文件头 A6/A7）。
const unk = (label, detail = '') => {
  console.log(`  ⚠️ ${label}${detail ? '  ' + detail : ''}`)
  un++
}
// 读文本：任何读不到的情形都返回 null（调用方判未判定），不抛栈。
const MAX_READ = 8 * 1024 * 1024
const readText = (abs) => {
  try {
    const st = statSync(abs)
    if (!st.isFile()) return null
    if (st.size > MAX_READ) return null
    return readFileSync(abs, 'utf8')
  } catch { return null }
}
const CK = process.env.CK_LOG
const lines = []
const log = (s) => { console.log(s); lines.push(s) }

const gitLs = spawnSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
const tracked = (gitLs.stdout || '').split('\n').filter(Boolean)
// 被测面本身取不到（不是 git 仓库 / git 不可执行 / 空仓库）⇒ A1/A2 无样本，判未判定而不是「全部零命中」。
const trackedOk = !gitLs.error && gitLs.status === 0 && tracked.length > 0
if (!trackedOk) {
  unk('被测面前提：能列出已跟踪文件（A1/A2 的样本来源）',
    gitLs.error ? `git 执行失败：${gitLs.error.message}` : `git ls-files 退出码=${gitLs.status}、文件数=${tracked.length}`)
}

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
const gaText = readText(gaPath)
const ga = (gaText ?? '').split('\n')
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
if (gaText === null) unk('A1 .gitattributes 零命中规则', `读不到 ${gaPath}（缺失 / 是目录 / 权限不足 / 超过 ${MAX_READ} 字节）`)
else if (!trackedOk) unk('A1 .gitattributes 零命中规则', '列不出已跟踪文件 —— 命中数无意义，本次不构成结论')
else if (gaRules.length === 0) unk('A1 .gitattributes 零命中规则', '规则数 0 —— 没有样本，本次不构成结论')
else ck(
  `.gitattributes 每条规则都命中 ≥1 个已跟踪文件或已标注「预留」（共 ${gaRules.length} 条规则）`,
  gaZero.length === 0,
  gaZero.length ? '零命中且未标注：' + gaZero.map((r) => `${r.pattern}(L${r.line})`).join('、') : `零命中 ${gaRules.filter((r) => r.n === 0).length} 条均已标注`,
)
for (const r of gaRules.filter((x) => x.n === 0)) log(`      [零命中] ${r.pattern}  L${r.line}  ${r.annotated ? '已标注' : '未标注'}`)

log('=== A2 .editorconfig 零命中段落 ===')
const ecPath = ROOT + '/.editorconfig'
const ecText = readText(ecPath)
const ec = (ecText ?? '').split('\n')
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
if (ecText === null) unk('A2 .editorconfig 零命中段落', `读不到 ${ecPath}`)
else if (!trackedOk) unk('A2 .editorconfig 零命中段落', '列不出已跟踪文件 —— 命中数无意义，本次不构成结论')
else if (sections.length === 0) unk('A2 .editorconfig 零命中段落', '段落数 0 —— 没有样本，本次不构成结论')
else ck(
  `.editorconfig 每段落都命中 ≥1 个已跟踪文件或已标注「预留」（共 ${sections.length} 段）`,
  ecZero.length === 0,
  ecZero.length ? '零命中且未标注：' + ecZero.map((s) => `${s.glob}(L${s.line})`).join('、') : `零命中 ${sections.filter((s) => s.n === 0).length} 段均已标注`,
)

log('=== A3 哈希登记的文本资产必须被 trim=false 覆盖 ===')
const sumsPath = ROOT + '/public/SHA256SUMS'
const sumsText = readText(sumsPath)
const sums = []
for (const line of (sumsText ?? '').split('\n')) {
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
if (sumsText === null) unk('A3 哈希登记的文本资产受保护', `读不到 ${sumsPath}`)
else if (textish.length === 0) unk('A3 哈希登记的文本资产受保护', `登记项 ${sums.length} 个、其中文本类 0 个 —— 没有样本，本次不构成结论`)
else ck(
  `哈希登记的文本资产都受 trim_trailing_whitespace=false 保护（${textish.length} 个文本资产 / 登记共 ${sums.length} 项）`,
  unprotected.length === 0,
  unprotected.length ? '未受保护：' + unprotected.join('、') : textish.map((s) => 'public/' + s.path).join('、'),
)

log('=== A4 行尾口径一致 ===')
const gaEol = gaRules.some((r) => r.attr === 'eol=lf')
const ecEol = ec.some((l) => /^end_of_line\s*=\s*lf/.test(l.trim()))
if (gaText === null || ecText === null) unk('A4 行尾口径一致', '两个配置文件之一读不到 —— 不许把「读不到」记成「没声明」')
else ck('.gitattributes 有 eol=lf 且 .editorconfig 有 end_of_line = lf', gaEol && ecEol, `gitattributes=${gaEol} editorconfig=${ecEol}`)

log('=== A5 哈希资产当前内容确实与登记值一致（不能被已发生的格式化改坏）===')
const mismatch = []
for (const s of sums) {
  const p = ROOT + '/public/' + s.path
  if (!existsSync(p)) { mismatch.push(`${s.path}(缺失)`); continue }
  const h = createHash('sha256').update(readFileSync(p)).digest('hex')
  if (h !== s.sha) mismatch.push(`${s.path}(${h.slice(0, 12)} != ${s.sha.slice(0, 12)})`)
}
ck('public/SHA256SUMS 登记的每项都与磁盘一致', mismatch.length === 0, mismatch.length ? mismatch.join('、') : `${sums.length} 项全部一致`)
if (sumsText === null) unk('A5 哈希资产内容与登记值一致', `读不到 ${sumsPath}`)
else if (sums.length === 0) unk('A5 哈希资产内容与登记值一致', '登记项 0 个 —— 没有样本，本次不构成结论')

log('')
log(`通过 ${pass}，失败 ${fail}，未判定 ${un}`)
if (un > 0) log(`⚠️ 有 ${un} 项未判定（样本为 0 或读不到被测文件）—— 覆盖面不完整，本次不构成通过（exit 2）`)
if (CK) writeFileSync(CK, lines.join('\n') + '\n')
process.exit(fail > 0 ? 1 : un > 0 ? 2 : 0)
