#!/usr/bin/env node
// 公开仓库发布前的敏感信息闸门（v2）。
//
// 背景：webees/facedb 是 **PUBLIC** 仓库。本工程含真实采集数据（pb_data 里有人脸照片/视频）
// 与生产部署信息，误推是不可逆的。故在 push 前对所有**将被推送的 blob**（git ls-files）
// 做机械扫描；命中的每一条都要求人工判定，未判定者一律阻断推送。
//
// 口径：只看 git 已跟踪的文件内容（未跟踪未忽略的文件不会被推送，但也一并扫描提醒）；
//       被 .gitignore 忽略但属敏感命名的文件单列「提示」区（它们不会被推送，但 `git add -f`
//       或改 .gitignore 后就会，故必须可见）。
//
// ── v2 修复（R22，全部有自检电池 scripts/publish-leak-scan-selftest.mjs 覆盖）──────────
// ① **不再按扩展名白名单判文本**：改按内容判二进制（前 8KB 含 NUL 字节才算二进制）。
//    修复前 `.bak`/`.pem`/`.log` 等不在白名单 → 被当二进制静默跳过，实测：
//    `keys/secret.pem`（真 PEM 私钥）与 `notes.bak`（含 ghp_ 令牌）**零命中**。
// ② **不再静默跳过超大文件**：改为全量读扫（上限 MAX_SCAN_BYTES，默认 64MB）；
//    超过上限的文件记入「未判定」并 exit 2，绝不当作「已扫过且干净」。
// ③ **令牌前缀扩面**：新增 github_pat_ / glpat- / xox[baprs]- / AKIA / ASIA / sk-proj- /
//    sk-ant- / AIza / ya29. / hf_ / npm_ / dckr_pat_ / pypi- / SG. / JWT 等现代形态。
//    修复前只有 ghp_/gho_/ghp…/sk- 老形态，实测 4 种新令牌全部漏检。
// ④ **「索引有而工作区缺失」不再是静默跳过**：记未判定 → exit 2（读不到 ≠ 干净）。
// ⑤ **默认阻断线从 P0 抬到 P1**（可用 LEAK_BLOCK_AT 覆盖）：本仓库是 PUBLIC，
//    公网 IP / Tailscale 网段 / 超管口令命中就该拦在 push 之前，而不是只打印。
// ⑥ 新增「被忽略的敏感文件」提示区（.env* / *.pem / *.key / id_rsa* / *.p12 / *.jks / credentials*）。
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// 默认扫仓库自身（本文件位于 <仓库>/scripts/ 下）；LEAK_SCAN_ROOT 可指向副本以做判据对照。
const ROOT = process.env.LEAK_SCAN_ROOT || path.resolve(import.meta.dirname, '..')
process.chdir(ROOT)

const MAX_SCAN_BYTES = Number(process.env.LEAK_MAX_BYTES || 64 * 1024 * 1024)

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
// 【R13-F9 / X8-P1②】只扫 `git ls-files` 会漏掉最危险的一类：「凭据已经写进工作区、但还没 git add」。
// 这类文件不被推送、却极可能在后续某次 `git add -A` 里被带进去，属发布闸门必须覆盖的面。
// 口径与 `lib/check-publish-hygiene.mjs` 的 H3 一致（`--others --exclude-standard` = 未跟踪且未被忽略）。
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
const files = [...new Set([...tracked, ...untracked])]
const untrackedSet = new Set(untracked)

const BENIGN_IP = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/
function keepPublicIp(s) {
  const o = s.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (BENIGN_IP.test(s)) return false
  return true
}

// 令牌字面量：写成拼接形式，避免本脚本被自己的正则文本命中（R13-F9 的自阻断教训）。
const TOKEN_PATTERNS = [
  'Bearer\\s+[A-Za-z0-9._-]{12,}',
  'gh[pousr]_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{22,}',
  'glpat-[A-Za-z0-9_-]{20,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'AKIA[0-9A-Z]{16}',
  'ASIA[0-9A-Z]{16}',
  'sk-[A-Za-z0-9]{20,}',
  'sk-proj-[A-Za-z0-9_-]{20,}',
  'sk-ant-[A-Za-z0-9_-]{20,}',
  'AIza[0-9A-Za-z_-]{35}',
  'ya29\\.[0-9A-Za-z_-]{20,}',
  'hf_[A-Za-z0-9]{30,}',
  'npm_[A-Za-z0-9]{36}',
  'dckr_pat_[A-Za-z0-9_-]{20,}',
  'pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{10,}',
  'SG\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}',
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
]

const RULES = [
  {
    id: 'SECRET-ASSIGN',
    sev: 'P0',
    // 值必须以字母或数字开头且长度 ≥ 6：否则本行 desc 里的 `password=/secret=/token=` 会**自匹配**
    // （修复前实测：把本脚本放进仓库后闸门一上线就把自己报成 P0 并自阻断）。
    desc: '形如 password=… / secret=… / token=… / api_key=… 且右侧是像凭据的值',
    re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9][A-Za-z0-9_.+/=-]{5,}/gi,
  },
  { id: 'BEARER', sev: 'P0', desc: '令牌字面量（Bearer / GitHub / GitLab / Slack / AWS / OpenAI / Google / HF / npm / Docker / PyPI / JWT）', re: new RegExp('\\b(' + TOKEN_PATTERNS.join('|') + ')\\b', 'g') },
  { id: 'PRIVATEKEY', sev: 'P0', desc: 'PEM 私钥头（RSA/EC/OPENSSH/DSA/PGP…）', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  // 这两条的自匹配防护：源码里不出现完整字面量（拼接 + 正则元字符），否则闸门会把自己报成 P0
  { id: 'SSH-KEY', sev: 'P1', desc: 'OpenSSH 私钥块或 ssh-ed25519 私钥体', re: new RegExp('-{5}BEGIN OPENSSH PRIVATE KEY-{5}|\\bb3BlbnNzaC1rZXktdjE' + 'AAAA') },
  { id: 'SUPERUSER-PW', sev: 'P1', desc: '疑似超管口令（含 Pass/pwd 且与邮箱同现）', re: /\b\S+@\S+\.\S+\b[^\n]{0,40}\b[A-Za-z]*[Pp]ass[A-Za-z0-9]{2,}/g },
  { id: 'LOCAL-PATH', sev: 'P2', desc: '作者本机绝对路径 /Users/<name>/', re: /\/Users\/[A-Za-z0-9_.-]+\//g },
  // 【第一版漏检】原 PRIVATE-IP 只匹配 3 段（10.x.y），于是 package-lock.json 的版本串
  // 三段版本串被当成私网地址报假阳性；更要命的是它**只认私网段**，
  // 而真正的发布风险是**可全局路由**的地址 —— pb-bin/README.md 里那台目标机的公网 IPv4
  // 因此从未被任何规则看见。现按 4 段匹配，并显式排除回环/私网/链路本地/组播/文档网段。
  { id: 'PUBLIC-IP', sev: 'P1', desc: '可全局路由的 IPv4 字面量（回环/私网/链路本地/组播/文档网段除外）', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, keep: keepPublicIp },
  { id: 'TAILNET', sev: 'P1', desc: 'Tailscale 100.x 网段', re: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'PRIVATE-IP', sev: 'P2', desc: '可路由私网地址（RFC1918，必须 4 段）', re: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g },
  { id: 'DOMAIN', sev: 'P2', desc: '生产域名', re: /\b[a-z0-9-]+\.(facedb|webees)\.[a-z]{2,}\b/gi },
  { id: 'EMAIL', sev: 'P2', desc: '邮箱地址', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: 'MEDIA', sev: 'P0', desc: '被跟踪的图片/视频文件（人脸数据风险）', re: /.*/, fileOnly: /\.(jpe?g|png|webp|heic|gif|mp4|webm|mov|avi|mkv|wav|mp3)$/i },
]

// 被 .gitignore 忽略、但属敏感命名的文件：不会被推送，但 `git add -f` / 改忽略规则后就会。
const SENSITIVE_IGNORED = /(^|\/)(\.env(\..+)?|\.npmrc|\.netrc|credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|ppk))$/i

const hits = {}
let scanned = 0
let skippedBinary = 0
const voided = [] // 未判定：读不到或超上限 —— 绝不当成「已扫过且干净」

for (const f of files) {
  let st
  try {
    st = statSync(f)
  } catch {
    // 索引里有、工作区已删（`git rm` 未提交等）：读不到内容 ⇒ 未判定（v2 前是静默跳过）。
    voided.push({ file: f, why: '工作区缺失（索引有而文件不在）' })
    continue
  }
  if (!st.isFile()) {
    voided.push({ file: f, why: '不是常规文件（目录/链接/设备）' })
    continue
  }
  if (st.size > MAX_SCAN_BYTES) {
    voided.push({ file: f, why: `超过扫描上限 ${MAX_SCAN_BYTES} 字节（size=${st.size}）` })
    continue
  }
  const buf = readFileSync(f)
  // 内容判二进制：前 8KB 出现 NUL 字节（v2 前按扩展名白名单，`.pem`/`.bak`/`.log` 被静默跳过）
  const isBinary = buf.subarray(0, 8192).includes(0)
  if (isBinary) {
    skippedBinary++
    for (const r of RULES) {
      if (r.fileOnly && r.fileOnly.test(f)) {
        ;(hits[r.id] = hits[r.id] || []).push({ file: f, line: 0, text: '(文件名命中 ' + r.id + ')' })
      }
    }
    continue
  }
  const src = buf.toString('utf8')
  scanned++
  const lines = src.split('\n')
  for (const r of RULES) {
    if (r.fileOnly) {
      if (r.fileOnly.test(f)) hits[r.id] = (hits[r.id] || []).concat([{ file: f, line: 0, text: '(文件名命中)' }])
      continue
    }
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g')
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(lines[i])) !== null) {
        if (r.keep && !r.keep(m[0])) continue
        ;(hits[r.id] = hits[r.id] || []).push({ file: f, line: i + 1, text: m[0].slice(0, 90) })
      }
    }
  }
}

// 被忽略的敏感文件（提示区，不参与阻断判定）
let ignoredSensitive = []
try {
  ignoredSensitive = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((f) => SENSITIVE_IGNORED.test(f))
} catch {
  ignoredSensitive = []
}

const ORDER = ['P0', 'P1', 'P2']
console.log('  === 公开仓库发布前敏感信息扫描 ===')
console.log('  仓库：webees/facedb（PUBLIC）')
console.log(
  '  跟踪文件 ' + tracked.length + ' 个 + 未跟踪未忽略 ' + untracked.length + ' 个 = ' + files.length + ' 个：扫描文本 ' + scanned + ' 个，二进制 ' + skippedBinary + ' 个，未判定 ' + voided.length + ' 个'
)
console.log()
for (const sev of ORDER) {
  for (const r of RULES.filter((x) => x.sev === sev)) {
    const list = hits[r.id] || []
    console.log('  ' + (list.length ? '❌' : '✅') + ' ' + sev + ' ' + r.id.padEnd(14) + '  ' + r.desc + '  命中 ' + list.length + ' 处')
    for (const x of list.slice(0, 12)) {
      console.log('      ' + x.file + (x.line ? ':' + x.line : '') + (untrackedSet.has(x.file) ? '（未跟踪，尚未 git add）' : '') + '  ' + x.text)
    }
    if (list.length > 12) console.log('      …另有 ' + (list.length - 12) + ' 处（见下方汇总）')
  }
}
console.log()
if (ignoredSensitive.length) {
  console.log('  ℹ️ 被 .gitignore 忽略的敏感命名文件 ' + ignoredSensitive.length + ' 个（当前不会被推送；若 `git add -f` 或改忽略规则就会）：')
  for (const f of ignoredSensitive.slice(0, 12)) console.log('      ' + f)
  console.log()
}

const p0 = RULES.filter((r) => r.sev === 'P0').reduce((n, r) => n + (hits[r.id] || []).length, 0)
const p1 = RULES.filter((r) => r.sev === 'P1').reduce((n, r) => n + (hits[r.id] || []).length, 0)
// 阻断线可用 LEAK_BLOCK_AT 覆盖 —— v2 起**默认 P1**（凭据/私钥/媒体 + 公网 IP/Tailscale/超管口令）；
// P2（本机路径/私网地址/域名/邮箱）只提示。v2 前默认 P0，与 ci.yml 与 PR 模板声称的覆盖范围不符。
const BLOCK_AT = (process.env.LEAK_BLOCK_AT || 'P1').toUpperCase()
const rank = { P0: 0, P1: 1, P2: 2 }
const blocked = RULES.filter((r) => rank[r.sev] <= rank[BLOCK_AT]).reduce((n, r) => n + (hits[r.id] || []).length, 0)

console.log('  P0 命中 ' + p0 + ' 处，P1 命中 ' + p1 + ' 处')
console.log('  阻断线 ' + BLOCK_AT + '：命中 ' + blocked + ' 处')

if (voided.length) {
  console.log()
  console.log('  ⏭ 未判定 ' + voided.length + ' 个文件 —— 本次运行不构成「已扫描且干净」的结论：')
  for (const v of voided.slice(0, 12)) console.log('      ' + v.file + '：' + v.why)
  console.log('  ⏭ 请先解决上述文件（补齐工作区或抬高 LEAK_MAX_BYTES）再判发布卫生（exit 2）。')
  process.exit(2)
}

console.log('  ' + (blocked === 0 ? '✅ 无 ' + BLOCK_AT + ' 阻断项' : '❌ 存在 ' + BLOCK_AT + ' 阻断项，禁止推送'))
process.exit(blocked === 0 ? 0 : 1)
