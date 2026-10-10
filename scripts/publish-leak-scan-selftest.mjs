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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, unlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { gzipSync, deflateRawSync } from 'node:zlib'
import path from 'node:path'

/** UTF-16BE 编码（Node 的 Buffer 不认 `'utf16be'`，只认 `utf16le`）。 */
function toUtf16be(s) {
  const b = Buffer.alloc(s.length * 2)
  for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2)
  return b
}

/** 造一个只含一个条目的 zip（stored 或 deflate）—— 用于「压缩内容必须解压后复扫」的场景。 */
function zipOne(name, data, { store = false } = {}) {
  const nm = Buffer.from(name, 'utf8')
  const raw = Buffer.from(data)
  const body = store ? raw : deflateRawSync(raw)
  const lfh = Buffer.alloc(30)
  lfh.writeUInt32LE(0x04034b50, 0)
  lfh.writeUInt16LE(20, 4)
  lfh.writeUInt16LE(store ? 0 : 8, 8) // method：0 = stored，8 = deflate
  lfh.writeUInt32LE(body.length, 18)
  lfh.writeUInt32LE(raw.length, 22)
  lfh.writeUInt16LE(nm.length, 26)
  return Buffer.concat([lfh, nm, body])
}

const HERE = path.resolve(import.meta.dirname)
// LEAK_SCAN 覆盖：把「旧版闸门」喂进同一套电池，就能证明每个变异体有判别力（R25 的 m16/m17 就是这么证的：
// `git show HEAD:scripts/publish-leak-scan.mjs > /tmp/old.mjs` + `LEAK_SCAN=/tmp/old.mjs npm run verify:publish-selftest`
// ⇒ 两个二进制旁路形态必须报红）。
const SCANNER = process.env.LEAK_SCAN || path.join(HERE, 'publish-leak-scan.mjs')
const WORK = mkdtempSync(path.join(tmpdir(), 'leak-selftest-'))

function makeRepo(files, { ignore = [], removeAfterAdd = [], chmodAfterAdd = {}, copyScanner = true } = {}) {
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
  // 【R37】必须在 `git add` **之后**再改权限：先 chmod 000 的话 git 读不到内容，夹具根本建不起来。
  for (const [rel, mode] of Object.entries(chmodAfterAdd)) chmodSync(path.join(dir, rel), mode)
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
// 运行时拼装的假 GitHub 令牌：源码里不出现完整字面量，否则闸门会把电池自己报成 P0（自阻断，已踩三次）。
const GH = 'ghp_' + 'A'.repeat(30)
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
  // ── R25 / W25E-01（P1）：二进制旁路。旧形态「前 8KB 有 NUL 就整份跳过」实测 exit 0 放行。
  {
    name: 'm16 首字节 NUL 的文件里的令牌（旧版整份跳过 ⇒ 放行）',
    files: { 'keys/b3.env.tmp': Buffer.concat([Buffer.from([0]), Buffer.from('token=' + GH + '\n')]) },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm17 第 100 字节 NUL、令牌在第 9000 字节之后（旧版整份跳过 ⇒ 放行）',
    files: {
      'keys/b2.txt': (() => {
        const b = Buffer.alloc(9048, 0x61) // 'a' 填充
        b[100] = 0
        Buffer.from('token=' + GH + '\n').copy(b, 9000)
        return b
      })(),
    },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  // R25REV-N1（P2）：UTF-16LE 保存的凭据文件 —— 每个字符后跟 NUL，latin1 视图下凭据正则匹配不到。
  // 「只按内容判二进制」的新形态同样漏检（实测 exit 0 放行）；补 UTF-16LE 视图后必须命中。
  {
    name: 'm18 UTF-16LE 保存的 .env 里的令牌（latin1 视图漏检 ⇒ 放行）',
    files: { 'keys/u16.env': Buffer.from('token=' + GH + '\n', 'utf16le') },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  // ── R26 / W26E-01…E-09（P1/P2）：**「只扫了一种解读」**这一族漏检形态 ────────────────────
  // 每个场景都用「同载荷以另一种编码保存」构造：修复前整类 exit 0 放行（W26-E 有原始读数）。
  {
    name: 'm19 UTF-16BE 保存的 .env（v2 只加 UTF-16LE 视图 ⇒ 整类漏检）',
    files: { 'keys/u16be.env': toUtf16be('token=' + GH + '\n') },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm20 UTF-32LE 保存的 .env（v2 不认识 UTF-32）',
    files: {
      'keys/u32le.env': (() => {
        const s = 'token=' + GH + '\n'
        const b = Buffer.alloc(s.length * 4)
        for (let i = 0; i < s.length; i++) b.writeUInt32LE(s.codePointAt(i), i * 4)
        return b
      })(),
    },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm21 UTF-32BE 保存的 .env（v2 不认识 UTF-32）',
    files: {
      'keys/u32be.env': (() => {
        const s = 'token=' + GH + '\n'
        const b = Buffer.alloc(s.length * 4)
        for (let i = 0; i < s.length; i++) b.writeUInt32BE(s.codePointAt(i), i * 4)
        return b
      })(),
    },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm22 前 8KB 全 ASCII、令牌在 UTF-16 段（v2 只看前 8KB 的 NUL 密度 ⇒ 不生成视图）',
    files: {
      'keys/window.env': Buffer.concat([Buffer.from('# 说明\n'.repeat(600)), Buffer.from('token=' + GH + '\n', 'utf16le')]),
    },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm23 奇数长度前缀的 UTF-16LE（v2 按字节 0 对齐 ⇒ 整段错位漏检）',
    files: { 'keys/odd.env': Buffer.concat([Buffer.from('X'), Buffer.from('token=' + GH + '\n', 'utf16le')]) },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm24 gzip 里的 .env（v2 不解压 ⇒ 整类漏检）',
    files: { 'keys/gz.bin': gzipSync(Buffer.from('token=' + GH + '\n')) },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm25 zip(deflate) 里的 .env（v2 不解压 ⇒ 整类漏检）',
    files: { 'keys/z.zip': zipOne('keys/inner.env', 'token=' + GH + '\n') },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm26 令牌被换行拆成两行（逐行扫必然漏检）',
    files: { 'keys/split.env': 'token=ghp_\n' + 'A'.repeat(30) + '\n' },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm27 零宽字符插在令牌中间（v2 不剥零宽 ⇒ 整类失配）',
    files: { 'keys/zwsp.env': 'token=ghp_' + '\u200B' + 'A'.repeat(30) + '\n' },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm28 全角同形令牌（v2 不做 NFKC 归一化 ⇒ 漏检）',
    files: { 'keys/fullwidth.env': 'token=' + '\uFF47\uFF48\uFF50\uFF3F' + 'A'.repeat(30) + '\n' },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm29 GBK 双字节里的全角令牌（非 UTF-8 ⇒ 必须试传统编码视图 + NFKC）',
    files: {
      'keys/gbk.env': Buffer.concat([
        // GBK 双字节的「ｇｈｐ＿」（0xA3E7 0xA3E8 0xA3F0 0xA3DF）——latin1 视图下是乱码，整类漏检
        Buffer.from([0xa3, 0xe7, 0xa3, 0xe8, 0xa3, 0xf0, 0xa3, 0xdf]),
        Buffer.from('A'.repeat(30) + '\n', 'latin1'),
      ]),
    },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    // 这条不是 v2 的漏检形态（v2 也能抓到），作用是**保持型**：归一化把裸 CR 也当换行后，
    // `token=…` 这类规则在老 Mac 换行的文件里仍然成立。
    name: 'm30 裸 CR 行尾（归一化必须把 \\r 也当换行；保持型场景）',
    files: { 'keys/cr.env': 'token=' + GH + '\r' },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
  {
    name: 'm31 UTF-16LE 里的公网 IP（定位类规则必须跟着真实解码视图跑）',
    files: { 'keys/u16ip.env': Buffer.from('host=' + [113, 20, 8, 27].join('.') + '\n', 'utf16le') },
    expect: { code: 1, hit: ['PUBLIC-IP', 1] },
  },
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
  // n3（R25）：二进制内容**不是**「不扫」，但定位类规则对二进制不适用 —— 这是刻意的精度取舍，
  // 用断言把它钉住：将来若有人对二进制打开定位类规则，这条会红，提醒同步报告口径与文档。
  {
    name: 'n3 二进制（含 NUL 与像 IP/本机路径的字节）无令牌 ⇒ exit 0，且定位类规则不适用',
    files: {
      'assets/blob.bin': (() => {
        const b = Buffer.alloc(4096, 0x61)
        b[3] = 0
        Buffer.from(' ' + IP_PRIVATE + ' /Users/' + 'someuser' + '/x\n').copy(b, 100)
        return b
      })(),
    },
    expect: { code: 0, hit: ['BEARER', 0], zeroAlso: ['SECRET-ASSIGN', 'PUBLIC-IP', 'PRIVATE-IP', 'LOCAL-PATH'] },
  },
  // n4（R26）：多视图解码**不许**带来假红。UTF-16 里的普通文本（含像路径/像版本号的内容）
  // 与「合法但无凭据」的 gzip 都必须 exit 0 —— 这条钉住「多解读 ≠ 见谁报谁」。
  {
    name: 'n4 UTF-16LE 的普通文本 + 合法 gzip（无凭据）⇒ exit 0，不得假红',
    files: {
      'docs/u16.md': Buffer.from('部署说明：监听 127.0.0.1:3000，版本 10.13.0\n', 'utf16le'),
      'assets/plain.gz': gzipSync(Buffer.from('版本 10.13.0\n私网 ' + IP_PRIVATE + '\n')),
    },
    expect: { code: 0, hit: ['BEARER', 0], zeroAlso: ['SECRET-ASSIGN', 'PUBLIC-IP', 'PRIVATEKEY'] },
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
  // u3（R26）：识别出压缩魔数却解不开（流式写入的 zip / 截断的 gzip）⇒ 未判定 exit 2。
  // 「读不到 ≠ 干净」在多视图这一层同样成立：不能因为解不开就当这个文件没问题。
  {
    name: 'u3 有 zip 魔数但条目不可解（流式写入）→ exit 2 未判定',
    files: {
      'assets/stream.zip': (() => {
        const nm = Buffer.from('inner.env', 'utf8')
        const lfh = Buffer.alloc(30)
        lfh.writeUInt32LE(0x04034b50, 0)
        lfh.writeUInt16LE(20, 4)
        lfh.writeUInt16LE(8, 8)
        lfh.writeUInt32LE(0, 18) // compSize = 0（真流式 zip 靠 data descriptor 补长度）
        lfh.writeUInt16LE(nm.length, 26)
        return Buffer.concat([lfh, nm, deflateRawSync(Buffer.from('token=' + GH + '\n'))])
      })(),
    },
    expect: { code: 2, contains: '未判定' },
  },
  // u4（R26REV-2-02）：zip 里出现未支持的压缩方法（method=99 = WinZip AES）⇒ 不得当「已扫描且干净」。
  // 修复前 v3 会拿 AES 载荷去 raw inflate，解出来就记成「扫过了、没问题」并把 exit 判成 1/0。
  {
    name: 'u4 zip 条目用了未支持的压缩方法（method=99 AES）→ exit 2 未判定',
    files: {
      'assets/aes.zip': (() => {
        const nm = Buffer.from('inner.env', 'utf8')
        const body = deflateRawSync(Buffer.from('token=' + GH + '\n'))
        const lfh = Buffer.alloc(30)
        lfh.writeUInt32LE(0x04034b50, 0)
        lfh.writeUInt16LE(20, 4)
        lfh.writeUInt16LE(99, 8) // method = 99（AES）
        lfh.writeUInt32LE(body.length, 18)
        lfh.writeUInt32LE(body.length, 22)
        lfh.writeUInt16LE(nm.length, 26)
        return Buffer.concat([lfh, nm, body])
      })(),
    },
    expect: { code: 2, contains: '未判定' },
  },
  // u5（R37 / W37C-01）：文件**在索引里、statSync 也成功**，只是内容读不到（权限 000）。
  // 修复前这里是未捕获的 EACCES 裸栈 ⇒ exit 1、无汇总行，与「真有违规」分不开；
  // 修复后必须与 u1（工作区缺失）同路：记未判定、打印汇总、exit 2。
  {
    name: 'u5 已入库但读不到（权限 000）→ exit 2 未判定，不得抛裸栈',
    files: { 'src/locked.env': 'TOKEN=ghp_' + 'A'.repeat(36) + '\n' },
    chmodAfterAdd: { 'src/locked.env': 0o000 },
    expect: { code: 2, contains: '未判定', containsAll: ['src/locked.env：读不到（EACCES）'], absent: ['at Object.readFileSync', 'Node.js v'] },
  },
  // ── 提示区：被忽略的敏感文件必须可见 ─────────────────────────────────
  {
    name: 'i1 被忽略的 .env.local 必须出现在提示区',
    files: { 'src/ok.ts': 'export const x = 1\n', '.env.local': 'password=' + 'IgnoredSecret' + '\n' },
    ignore: ['.env.local'],
    expect: { code: 0, contains: '被 .gitignore 忽略的敏感命名文件' },
  },
  // ── 提示区（R28 W28D-05）：整块被忽略的路径必须可见 ────────────────────
  // 场景里 `pb_data/` 是**被忽略的目录**，里面放一个带 ghp_ 令牌的「照片」：
  // 它不在扫描面内（被忽略的东西不会被推送），所以退出码必须是 0 —— 这正是本条要钉的语义；
  // 但闸门**必须**把这条路径列进「闸门没看的地方」，否则「沉默」会被读成「干净」。
  {
    name: 'i2 被忽略的整块目录（pb_data/ 里的照片）必须出现在「闸门没看的地方」清单里',
    files: {
      'src/ok.ts': 'export const x = 1\n',
      'pb_data/storage/abc123/photo.jpg': 'ghp_' + 'B'.repeat(30) + '\n',
    },
    ignore: ['pb_data'],
    expect: { code: 0, containsAll: ['被 .gitignore 忽略的条目', 'pb_data/', '未扫描内容'] },
  },
  // ── 非 ASCII 路径（R28 W28D-05 附带）：`git ls-files` 默认会把这类路径加引号并转义 ─────
  // 修复前：闸门拿到的是 `"docs/\346\263\204…md"` 这种**转义后的字面量**，读文件必失败 ⇒
  // 把工作区里真实存在的文件记成「索引有而文件不在」⇒ voided ⇒ exit 2（假未判定）。
  // 这条用「中文名 + 真令牌」双向钉住：既要扫得到（exit 1 + BEARER 1），又不能因路径被转义而 voided。
  {
    name: 'm16 非 ASCII 文件名里的令牌必须被抓（git quotePath 不得让它变成「工作区缺失」）',
    files: { ['docs/' + '\u6cc4\u9732\u8bf4\u660e.md']: 'ghp_' + 'C'.repeat(30) + '\n' },
    expect: { code: 1, hit: ['BEARER', 1] },
  },
]

let pass = 0
const failures = []
for (const c of CASES) {
  const dir = makeRepo(c.files, { ignore: c.ignore || [], removeAfterAdd: c.removeAfterAdd || [], chmodAfterAdd: c.chmodAfterAdd || {}, copyScanner: !c.realScanner })
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
  // containsAll：一条场景要同时钉住多处文案时用（比只钉一处更防「只改了半句」）
  for (const s of c.expect.containsAll || []) if (!out.includes(s)) problems.push(`输出里缺少「${s}」`)
  // 【R37】absent：反向断言（输出里**不许**出现某段文本）。只断言 exit 2 不足以证明修复：
  // 权限拒绝的旧形态是「exit 1 + 裸栈」，两种退出码都是红叉，必须同时钉住「没有裸栈、有汇总行」。
  for (const s of c.expect.absent || []) if (out.includes(s)) problems.push(`输出里不该出现「${s}」`)
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
// R35-S38：条数声明（S38 对拍；改条数必须同时改这里与 CI 步骤名）
const EXPECTED_VARIANTS = 44 // = CASES 43 个场景（R37 新增 u5「已入库但读不到」）+ 本仓库自扫 1
if (CASES.length + 1 !== EXPECTED_VARIANTS) {
  console.log(`⛔ 未判定（exit 2）：场景声明 ${EXPECTED_VARIANTS} 条，实际 ${CASES.length + 1} 条`)
  process.exit(2)
}
console.log(`  变异自检：${pass} / ${CASES.length + 1} 通过${failures.length ? '，' + failures.length + ' 项失败' : ''}`)
if (failures.length) {
  for (const f of failures) console.log(`    - ${f.name}：${f.problems.join('；')}`)
  process.exit(1)
}
// 汇总行按场景名首字母**现算**分类数（R26）：写死数字会在加场景时悄悄过期，
// 而这里是 CI 的读数来源，读错就等于把覆盖面说错。
const positives = CASES.filter((c) => /^m\d/.test(c.name)).length
const negatives = CASES.filter((c) => /^n\d/.test(c.name)).length
const undecidedCases = CASES.filter((c) => /^u\d/.test(c.name)).length
const hints = CASES.filter((c) => /^i\d/.test(c.name)).length
console.log(
  `  ✅ 全部通过：${positives} 个阳性形态全部被抓（含 R25 的二进制旁路、R26 的 UTF-16BE/UTF-32/窗口/对齐/gzip/zip/零宽/NFKC/GBK/折行）、` +
    `${negatives} 组阴性对照零误报、未判定语义（读不到 / 权限拒绝 / 扫描面为空 / 压缩内容解不开 / 不支持的压缩方法）${undecidedCases} 个场景（共 ${CASES.length} 个）、提示区 ${hints} 个场景、自扫不阻断`
)
