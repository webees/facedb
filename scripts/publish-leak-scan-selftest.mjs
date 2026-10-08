#!/usr/bin/env node
// publish-leak-scan.mjs 的变异自检电池（R22）。
//
// 纪律来源（本工程已立）：判据必须有**变异自检**——每个变异体都必须被对应断言抓到，
// 且必须有阴性对照（干净输入不得报红）；「零样本」不得判通过。
//
// 本电池为每个场景建一个独立临时 git 仓库（真 `git init` + 真 `git add`），
// 把 scripts/publish-leak-scan.mjs 复制进去跑，断言：
//   ① 退出码（0 干净 / 1 有阻断项 / 2 未判定）
//   ② 输出里出现**指定的规则 id 命中行**（❌ <sev> <id> … 命中 N 处，N ≥ 1）
//   ③ 干净仓库里指定的规则 id 必须 0 命中（防假阳性 / 防恒真）
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = path.resolve(import.meta.dirname)
const SCANNER = path.join(HERE, 'publish-leak-scan.mjs')
const WORK = mkdtempSync(path.join(tmpdir(), 'leak-selftest-'))

function makeRepo(files, { ignore = [], removeAfterAdd = [], copyScanner = true } = {}) {
  const dir = mkdtempSync(path.join(WORK, 'repo-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  if (ignore.length) writeFileSync(path.join(dir, '.gitignore'), ignore.join('\n') + '\n')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  // 注意：不加 -f —— 否则被 .gitignore 忽略的敏感文件会被强制入库，"忽略但敏感"的提示区就测不到
  execFileSync('git', ['add', '-A'], { cwd: dir })
  for (const rel of removeAfterAdd) unlinkSync(path.join(dir, rel))
  if (copyScanner) copyFileSync(SCANNER, path.join(dir, 'scanner.mjs'))
  return dir
}

function runScan(dir, env = {}) {
  try {
    const out = execFileSync(process.execPath, [path.join(dir, 'scanner.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, LEAK_SCAN_ROOT: dir, ...env },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

// 跑**真实** scripts/publish-leak-scan.mjs（不把副本放进被扫仓库）。
// 为什么需要这条路径：副本自身是「未跟踪文件」，一放进仓库就让「扫描面为空」不可能成立 ——
// 空仓库场景（R23REV-N6）只能用真实脚本 + LEAK_SCAN_ROOT 指到空仓库来构造。
function runScanReal(dir, env = {}) {
  try {
    const out = execFileSync(process.execPath, [SCANNER], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, LEAK_SCAN_ROOT: dir, ...env },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

// 规则命中行：'❌ P0 BEARER … 命中 N 处'
function hitCount(out, id) {
  const m = out.match(new RegExp('(✅|❌) (P\\d) ' + id + '\\s+[^\\n]*命中 (\\d+) 处'))
  return m ? Number(m[3]) : null
}

const RSA_KEY = ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA' + 'x'.repeat(40), '-----END ' + 'RSA PRIVATE KEY-----'].join('\n') + '\n'
const OPENSSH_KEY = ['-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEA' + 'AAAABG5vbmU' + 'AAAAE', '-----END ' + 'OPENSSH PRIVATE KEY-----'].join('\n') + '\n'
// 泄漏形态一律运行时拼装：源码里不出现可被闸门命中的完整字面量（否则电池自己会被阻断）
const IP_PUBLIC = [113, 20, 8, 27].join('.')
const IP_TAILNET = [100, 101, 102, 103].join('.')
const IP_PRIVATE = [[10, 1, 2, 3].join('.'), [192, 168, 0, 1].join('.'), [172, 16, 5, 5].join('.')].join(' ')

const CASES = [
  // ── 阳性：修复前全部漏检（v1 实测 0 命中）────────────────────────────
  { name: 'm1 .bak 里的 ghp_ 令牌（旧版按扩展名当二进制跳过）', files: { 'notes.bak': 'ghp_' + 'A'.repeat(30) + '\n' }, expect: { code: 1, hit: ['BEARER', 1] } },
  { name: 'm2 .pem 私钥（旧版当二进制跳过）', files: { 'keys/secret.pem': RSA_KEY }, expect: { code: 1, hit: ['PRIVATEKEY', 1] } },
  { name: 'm3 github_pat_ 新式令牌', files: { 'src/a.ts': 'const t = "github_pat_' + 'A'.repeat(30) + '"\n' }, expect: { code: 1, hit: ['BEARER', 1] } },
  { name: 'm4 glpat- 令牌', files: { 'src/b.ts': 'const t = "glpat-' + 'A'.repeat(24) + '"\n' }, expect: { code: 1, hit: ['BEARER', 1] } },
  { name: 'm5 AKIA（AWS）令牌', files: { 'src/c.ts': 'const k = "AKIA' + 'IOSFODNN7EXAMPLE' + '"\n' }, expect: { code: 1, hit: ['BEARER', 1] } },
  { name: 'm6 sk-proj- 令牌', files: { 'src/d.ts': 'const k = "sk-proj-' + 'A'.repeat(30) + '"\n' }, expect: { code: 1, hit: ['BEARER', 1] } },
  { name: 'm7 JWT 三段令牌', files: { 'src/e.ts': 'const j = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.' + 'A'.repeat(20) + '"\n' }, expect: { code: 1, hit: ['BEARER', 1] } },
  { name: 'm8 2.6MB .log 里的令牌（旧版按 >2MB 跳过）', files: { 'big.log': 'x'.repeat(2_600_000) + '\nAKIA' + 'IOSFODNN7EXAMPLE' + '\n' }, expect: { code: 1, hit: ['BEARER', 1] } },
  { name: 'm9 OpenSSH 私钥块', files: { 'id_rsa': OPENSSH_KEY }, expect: { code: 1, hit: ['PRIVATEKEY', 1] } },
  { name: 'm10 跟踪的 .env 口令', files: { '.env': 'password=' + 'Sup3rSecretValue' + '\n' }, expect: { code: 1, hit: ['SECRET-ASSIGN', 1] } },
  { name: 'm11 公网 IP（P1 命中必须阻断：v1 默认只挡 P0）', files: { 'README.md': '目标机 ' + IP_PUBLIC + '\n' }, expect: { code: 1, hit: ['PUBLIC-IP', 1] } },
  { name: 'm12 Tailscale 网段', files: { 'README.md': '内网 ' + IP_TAILNET + '\n' }, expect: { code: 1, hit: ['TAILNET', 1] } },
  { name: 'm13 被跟踪的人脸照片（文件名规则）', files: { 'data/face.jpg': 'binary-ish content\n' }, expect: { code: 1, hit: ['MEDIA', 1] } },
  // R23REV-N8：旧版用 `\b` 作前导边界，而 `_` 是单词字符 ⇒ 带下划线前缀的键名整类漏检（实测 0 命中）。
  { name: 'm14 带下划线前缀的凭据键名（db_password=…，旧版 \\b 漏检）', files: { 'src/db.ts': 'const db_password = "' + 'hunter2xyz' + '"\n' }, expect: { code: 1, hit: ['SECRET-ASSIGN', 1] } },
  { name: 'm15 AWS_SECRET_ACCESS_KEY=…（下划线前缀 + 大写键）', files: { '.env.prod': 'AWS_SECRET_ACCESS_KEY=' + 'wJalrXUtnFEMIK7MDENGbPxRfiCY' + '\n' }, expect: { code: 1, hit: ['SECRET-ASSIGN', 1] } },
  // ── 阴性：干净仓库必须 exit 0 且相关规则 0 命中 ───────────────────────
  {
    name: 'n1 干净仓库（版本串 10.13.0 / 私网 / 回环 / 普通代码）',
    files: {
      'package-lock.json': '{"version":"10.13.0"}\n',
      'src/net.ts': 'export const a = "127.0.0.1"\n',
      'README.md': '本地开发地址 http://localhost:3000\n',
    },
    expect: { code: 0, hit: ['BEARER', 0], zeroAlso: ['PUBLIC-IP', 'PRIVATE-IP', 'SECRET-ASSIGN', 'PRIVATEKEY'] },
  },
  {
    name: 'n2 放行私网/回环/文档网段，不误报 P1',
    files: { 'notes.md': IP_PRIVATE + ' 127.0.0.1 169.254.1.1\n' },
    expect: { code: 0, hit: ['PUBLIC-IP', 0], zeroAlso: ['TAILNET'], alsoHit: { 'PRIVATE-IP': 3 } },
  },
  // ── 未判定语义：读不到 ≠ 干净 ────────────────────────────────────────
  {
    name: 'u1 索引有而工作区缺失 → exit 2 未判定',
    files: { 'src/gone.ts': 'export const x = 1\n' },
    removeAfterAdd: ['src/gone.ts'],
    expect: { code: 2, contains: '未判定' },
  },
  // R23REV-N6：零样本此前被判 exit 0「✅ 无 P1 阻断项」——「一个文件都没扫」不是「扫过且干净」。
  {
    name: 'u2 空仓库（扫描面 0 个文件）→ exit 2 未判定，不得判通过',
    files: {},
    realScanner: true,
    expect: { code: 2, contains: '扫描面为空' },
  },
  // ── 提示区：被忽略的敏感文件必须可见 ─────────────────────────────────
  {
    name: 'i1 被忽略的 .env.local 必须出现在提示区',
    files: { 'src/ok.ts': 'export const x = 1\n', '.env.local': 'password=' + 'IgnoredSecret' + '\n' },
    ignore: ['.env.local'],
    expect: { code: 0, contains: '被 .gitignore 忽略的敏感命名文件' },
  },
]

let pass = 0
const failures = []
for (const c of CASES) {
  const dir = makeRepo(c.files, { ignore: c.ignore || [], removeAfterAdd: c.removeAfterAdd || [], copyScanner: !c.realScanner })
  const { code, out } = c.realScanner ? runScanReal(dir) : runScan(dir)
  const problems = []
  if (code !== c.expect.code) problems.push(`退出码 ${code} ≠ 期望 ${c.expect.code}`)
  for (const [id, n] of Object.entries(c.expect.hit ? { [c.expect.hit[0]]: c.expect.hit[1] } : {})) {
    const got = hitCount(out, id)
    if (got === null) problems.push(`输出里找不到规则 ${id} 的命中行`)
    else if (got !== n) problems.push(`规则 ${id} 命中 ${got} 处 ≠ 期望 ${n} 处`)
  }
  for (const [id, n] of Object.entries(c.expect.alsoHit || {})) {
    const got = hitCount(out, id)
    if (got === null) problems.push(`输出里找不到规则 ${id} 的命中行`)
    else if (got !== n) problems.push(`规则 ${id} 命中 ${got} 处 ≠ 期望 ${n} 处`)
  }
  for (const id of c.expect.zeroAlso || []) {
    const got = hitCount(out, id)
    if (got === null) problems.push(`输出里找不到规则 ${id} 的命中行`)
    else if (got !== 0) problems.push(`规则 ${id} 命中 ${got} 处 ≠ 期望 0 处（假阳性）`)
  }
  if (c.expect.contains && !out.includes(c.expect.contains)) problems.push(`输出里缺少「${c.expect.contains}」`)
  if (problems.length === 0) {
    pass++
    console.log(`  ✅ ${c.name}`)
  } else {
    failures.push({ name: c.name, problems })
    console.log(`  ❌ ${c.name}`)
    for (const p of problems) console.log(`      ${p}`)
  }
  rmSync(dir, { recursive: true, force: true })
}

// 自扫真实仓库：必须 exit 0（闸门不许把自己报成 P0 —— R13-F9 的自阻断教训）
const repo = path.resolve(HERE, '..')
const self = (() => {
  try {
    const out = execFileSync(process.execPath, [SCANNER], { cwd: repo, encoding: 'utf8', env: { ...process.env, LEAK_SCAN_ROOT: repo } })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') }
  }
})()
const selfOk = self.code === 0
if (selfOk) pass++
else failures.push({ name: 's1 自扫真实仓库', problems: [`退出码 ${self.code} ≠ 0`] })
console.log(`  ${selfOk ? '✅' : '❌'} s1 自扫真实仓库（webees/facedb）退出码 ${self.code}（必须 0，闸门不得自阻断）`)

rmSync(WORK, { recursive: true, force: true })

console.log()
console.log(`  变异自检：${pass} / ${CASES.length + 1} 通过${failures.length ? '，' + failures.length + ' 项失败' : ''}`)
if (failures.length) {
  for (const f of failures) console.log(`    - ${f.name}：${f.problems.join('；')}`)
  process.exit(1)
}
console.log('  ✅ 全部通过：15 个阳性形态全部被抓、2 组阴性对照零误报、未判定语义（读不到 / 扫描面为空）与提示区成立、自扫不阻断')
