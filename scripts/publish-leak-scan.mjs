#!/usr/bin/env node
// 公开仓库发布前的敏感信息闸门。
//
// 背景：webees/facedb 是 **PUBLIC** 仓库。本工程含真实采集数据（pb_data 里有人脸照片/视频）
// 与生产部署信息，误推是不可逆的。故在 push 前对所有**将被推送的 blob**（git ls-files）
// 做机械扫描；命中的每一条都要求人工判定，未判定者一律阻断推送。
//
// 口径：只看 git 已跟踪的文件内容（未跟踪的文件不会被推送，但也会单独列出提醒）。
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// 默认扫仓库自身（本文件位于 <仓库>/scripts/ 下）；LEAK_SCAN_ROOT 可指向副本以做判据对照。
const ROOT = process.env.LEAK_SCAN_ROOT || path.resolve(import.meta.dirname, '..')
process.chdir(ROOT)

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

// 【R13-F9 / X8-P1①】零样本防线：扫描样本为 0 时「零命中」是恒真结论，不能当通过。
// 复现（X8）：副本里 `git rm -r --cached -q .` 清空索引后本脚本曾打印「✅ 无 P1 阻断项」并 exit 0。
if (files.length === 0) {
  console.log('  ❌ 没有可扫描的文件（已跟踪 0 个、未跟踪未忽略 0 个）—— 本次不构成结论')
  process.exit(2)
}

// 判定一个 IPv4 字面量是否「可全局路由」（即发布出去有实际风险）。
// 排除：回环 127/8、未指定 0.0.0.0、私网 10/8 与 192.168/16 与 172.16-31/12、
//       链路本地 169.254/16、组播 224/4、保留 240/4、文档网段 192.0.2/198.51.100/203.0.113、
//       以及 255.255.255.255。
const BENIGN_IP = /^(?:127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|2(?:2[4-9]|3\d)\.|24\d\.|25[0-5]\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/
function keepPublicIp(s) {
  const o = s.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  if (BENIGN_IP.test(s)) return false
  return true
}

const RULES = [
  {
    id: 'SECRET-ASSIGN',
    sev: 'P0',
    // 值必须以字母或数字开头且长度 ≥ 6：否则本行 desc 里的 `password=/secret=/token=` 会**自匹配**
    // （修复前实测：把本脚本放进仓库后闸门一上线就把自己报成 P0 并自阻断）。
    desc: '形如 password=… / secret=… / token=… / api_key=… 且右侧是像凭据的值',
    re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9][A-Za-z0-9_.+/=-]{5,}/gi,
  },
  { id: 'BEARER', sev: 'P0', desc: 'Bearer/ghp_/gho_/sk- 一类令牌字面量', re: /\b(Bearer\s+[A-Za-z0-9._-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/g },
  { id: 'PRIVATEKEY', sev: 'P0', desc: 'PEM 私钥头', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'SUPERUSER-PW', sev: 'P1', desc: '疑似超管口令（含 Pass/pwd 且与邮箱同现）', re: /\b\S+@\S+\.\S+\b[^\n]{0,40}\b[A-Za-z]*[Pp]ass[A-Za-z0-9]{2,}/g },
  { id: 'LOCAL-PATH', sev: 'P2', desc: '作者本机绝对路径 /Users/<name>/', re: /\/Users\/[A-Za-z0-9_.-]+\//g },
  // 【第一版漏检】原 PRIVATE-IP 只匹配 3 段（10.x.y），于是 package-lock.json:1009 的版本串
  // 「10.13.0」被当成私网地址报假阳性；更要命的是它**只认私网段**，
  // 而真正的发布风险是**可全局路由**的地址 —— pb-bin/README.md 里那台目标机的公网 IPv4
  // 因此从未被任何规则看见。现按 4 段匹配，并显式排除回环/私网/链路本地/组播/文档网段。
  { id: 'PUBLIC-IP', sev: 'P1', desc: '可全局路由的 IPv4 字面量（回环/私网/链路本地/组播/文档网段除外）', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, keep: keepPublicIp },
  { id: 'PRIVATE-IP', sev: 'P2', desc: '内网/回环之外的可路由私网地址', re: /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'TAILNET', sev: 'P1', desc: 'Tailscale 100.x 网段', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g },
  { id: 'DOMAIN', sev: 'P2', desc: '生产域名', re: /\b[a-z0-9-]+\.itok\.io\b/g },
  { id: 'EMAIL', sev: 'P2', desc: '邮箱地址', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: 'MEDIA', sev: 'P0', desc: '被跟踪的图片/视频文件（人脸数据风险）', re: /.*/, fileOnly: /\.(jpe?g|png|webp|heic|gif|mp4|webm|mov|avi|mkv|wav|mp3)$/i },
]

const TEXT_EXT = /\.(md|txt|json|json5|js|mjs|cjs|ts|tsx|vue|css|scss|html|yml|yaml|sh|dart|go|py|toml|ini|conf|env|example|mjs|xml|svg)$/i
const hits = {}
let scanned = 0
let skippedBinary = 0
let skippedMissing = 0

for (const f of files) {
  // 纯大小写敏感的文件名（如 .env）也当文本扫
  const isText = TEXT_EXT.test(f) || /(^|\/)\.(env|gitignore|dockerignore)/.test(f) || !f.includes('.')
  if (!isText) {
    skippedBinary++
    // 二进制仍需按文件名规则检查
    for (const r of RULES) {
      if (r.fileOnly && r.fileOnly.test(f)) {
        ;(hits[r.id] = hits[r.id] || []).push({ file: f, line: 0, text: '(文件名命中 ' + r.id + ')' })
      }
    }
    continue
  }
  let st
  try {
    st = statSync(f)
  } catch {
    // 索引里有、工作区已删（`git rm` 未提交等）：读不到内容，跳过并计数，不让闸门崩掉。
    skippedMissing++
    continue
  }
  if (st.size > 2 * 1024 * 1024) {
    skippedBinary++
    continue
  }
  const src = readFileSync(f, 'utf8')
  scanned++
  const lines = src.split('\n')
  for (const r of RULES) {
    if (r.fileOnly) {
      if (r.fileOnly.test(f)) hits[r.id] = (hits[r.id] || []).concat([{ file: f, line: 0, text: '(文件名命中)' }])
      continue
    }
    r.re.lastIndex = 0
    for (let i = 0; i < lines.length; i++) {
      r.re.lastIndex = 0
      const m = r.re.exec(lines[i])
      if (m && (!r.keep || r.keep(m[0]))) {
        ;(hits[r.id] = hits[r.id] || []).push({ file: f, line: i + 1, text: m[0].slice(0, 90) })
      }
    }
  }
}

console.log('  === 公开仓库发布前敏感信息扫描 ===')
console.log('  仓库：webees/facedb（PUBLIC）')
console.log('  跟踪文件 ' + tracked.length + ' 个 + 未跟踪未忽略 ' + untracked.length + ' 个 = ' + files.length + ' 个：扫描文本 ' + scanned + ' 个，跳过二进制/超大 ' + skippedBinary + ' 个，索引有而工作区缺失 ' + skippedMissing + ' 个')
console.log()

const ORDER = ['P0', 'P1', 'P2']
for (const sev of ORDER) {
  const rs = RULES.filter((r) => r.sev === sev)
  for (const r of rs) {
    const h = hits[r.id] || []
    const label = (h.length ? '❌ ' : '✅ ') + sev + ' ' + r.id + '  ' + r.desc
    console.log('  ' + label + '  命中 ' + h.length + ' 处')
    for (const x of h.slice(0, 25)) {
      console.log('      ' + x.file + (x.line ? ':' + x.line : '') + (untrackedSet.has(x.file) ? '（未跟踪，尚未 git add）' : '') + '  ' + x.text)
    }
    if (h.length > 25) console.log('      … 另有 ' + (h.length - 25) + ' 处')
  }
}

const p0 = RULES.filter((r) => r.sev === 'P0').reduce((n, r) => n + (hits[r.id] || []).length, 0)
const p1 = RULES.filter((r) => r.sev === 'P1').reduce((n, r) => n + (hits[r.id] || []).length, 0)
// 阻断线可用 LEAK_BLOCK_AT 抬高到 P1/P2 —— 默认 P0（凭据/私钥/媒体）才阻断推送；
// 但修复器需要一个**有灵敏度的验证命令**：默认口径下「P1 命中 2 处」仍 exit 0，
// 拿它当 verify 就会出现「修没修都通过」的弱断言（本工程反复踩过的假通过）。
const BLOCK_AT = (process.env.LEAK_BLOCK_AT || 'P0').toUpperCase()
const blocked = RULES.filter((r) => ORDER.indexOf(r.sev) <= ORDER.indexOf(BLOCK_AT)).reduce(
  (n, r) => n + (hits[r.id] || []).length,
  0,
)
console.log()
console.log('  P0 命中 ' + p0 + ' 处，P1 命中 ' + p1 + ' 处')
console.log('  阻断线 ' + BLOCK_AT + '：命中 ' + blocked + ' 处')
console.log('  ' + (blocked === 0 ? '✅ 无 ' + BLOCK_AT + ' 阻断项' : '❌ 存在 ' + BLOCK_AT + ' 阻断项，禁止推送'))
process.exit(blocked === 0 ? 0 : 1)
