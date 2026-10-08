// W21-A 体积判据的变异自检（判别力验证）
//
// 目的：证明 `scripts/check-dist-size-budget.mjs` 的各档**各自**都能被对应的坏状态判红，
// 且未变异的对照全绿、产物目录缺失时判「未判定（exit 2）」而不是通过。
//
// 做法：每个变异体在临时目录（fs.mkdtempSync）里用 `cp -R` **真复制**一份最小树
// （`dist/` + `public/SHA256SUMS`），施加一处改动后用 SIZE_ROOT 指向它跑判据，
// 逐条比对「退出码 + 翻转的断言名 + 未判定项」。
//
// 复制必须是真复制，**绝不能用硬链 `ln`**：本轮的体积复核轮里已发生过「用硬链建副本 →
// 变异体写副本把工程原件一起改了」的事故。所以这里有两道证明：
//   1. 复制后比 inode（副本 ≠ 原件）；
//   2. 全部变异体跑完后重算工程 `dist/` 的逐文件 sha256，必须与开跑前完全一致。
//
// 用法：npm run verify:size-selftest        （需先 npm run build）
//      SIZE_SRC_DIST=<其他产物目录> node scripts/check-dist-size-budget-mutants.mjs
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '..')
const JUDGE = path.join(HERE, 'check-dist-size-budget.mjs')
const SRC_DIST = process.env.SIZE_SRC_DIST ? path.resolve(process.env.SIZE_SRC_DIST) : path.join(REPO, 'dist')
const SRC_SUMS = path.join(REPO, 'public', 'SHA256SUMS')

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
function listFiles(dir) {
  const out = []
  const walk = (d, rel) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e)
      const r = rel ? rel + '/' + e : e
      if (statSync(p).isDirectory()) walk(p, r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}
// 与判据同源的「原始总字节」量法：目录下所有文件的字节和（目录项开销不计）
const rawTotal = (dir) => listFiles(dir).reduce((n, f) => n + statSync(path.join(dir, f)).size, 0)
// 与判据同源的量法：系统 `gzip -9 -c <文件>`，逐字节数长度
function gzipTotal(dir) {
  const files = ['index.html']
  for (const sub of ['static/css', 'static/js']) {
    const d = path.join(dir, sub)
    if (existsSync(d)) for (const e of readdirSync(d).sort()) files.push(`${sub}/${e}`)
  }
  let n = 0
  for (const f of files) {
    const r = spawnSync('gzip', ['-9', '-c', path.join(dir, f)], { maxBuffer: 1 << 24 })
    if (r.status !== 0) throw new Error(`gzip 失败：${f}`)
    n += r.stdout.length
  }
  return n
}

// ── 零样本纪律：没有可用的产物树时，本自检**未判定**（exit 2），不得报「全部抓到」 ──
if (!existsSync(SRC_DIST) || listFiles(SRC_DIST).length === 0) {
  console.error(`❌ 未判定：${SRC_DIST} 不存在或为空（先 npm run build）—— 没有样本，不构成任何结论`)
  process.exit(2)
}
if (!existsSync(SRC_SUMS)) {
  console.error(`❌ 未判定：${SRC_SUMS} 不存在 —— 判据的 SHA256SUMS 比对档没有样本`)
  process.exit(2)
}

const BEFORE = new Map(listFiles(SRC_DIST).map((f) => [f, sha256(path.join(SRC_DIST, f))]))
const BASE_GZIP = gzipTotal(SRC_DIST)

const variants = [
  {
    id: 'm0-control',
    desc: '未变异的对照（必须 exit 0）',
    expect: { rc: 0, fails: [], undecided: [] },
    mutate: () => ['未施加任何变异'],
  },
  {
    id: 'm1-drop-wasm',
    desc: '删掉 wasm/vision_wasm_nosimd_internal.wasm',
    expect: { rc: 1, fails: ['N2', 'N11'], undecided: [] },
    mutate: (dir) => {
      const p = path.join(dir, 'dist/wasm/vision_wasm_nosimd_internal.wasm')
      const size = statSync(p).size
      rmSync(p)
      return [
        `被删文件变异前 ${size} B、存在；变异后 existsSync=${existsSync(p)}`,
        `产物文件数 13 → ${listFiles(path.join(dir, 'dist')).length}`,
      ]
    },
  },
  {
    id: 'm2-same-size-wasm',
    desc: '把 wasm/vision_wasm_internal.wasm 换成同字节数的随机内容（专打「只锁大小」）',
    expect: { rc: 1, fails: ['N9'], undecided: [] },
    mutate: (dir) => {
      const p = path.join(dir, 'dist/wasm/vision_wasm_internal.wasm')
      const before = sha256(p)
      const size = statSync(p).size
      const buf = Buffer.alloc(size)
      for (let off = 0; off < size; off += 65536) randomBytes(Math.min(65536, size - off)).copy(buf, off)
      writeFileSync(p, buf)
      return [
        `原始字节 ${size} → ${statSync(p).size}（未变）；sha256 ${before.slice(0, 12)}… → ${sha256(p).slice(0, 12)}…（已变）`,
      ]
    },
  },
  {
    id: 'm3-web-inflate',
    desc: 'web 传输面注入约 5.5 KB 不可压缩内容（css 里追加合法注释）',
    expect: { rc: 1, fails: ['N3', 'N15'], undecided: [] },
    mutate: (dir) => {
      const p = path.join(dir, 'dist/static/css/index.d05fa997d9.css')
      const before = statSync(p).size
      // 随机 base64：gzip 压不动，保证 gzip 档真的会被顶穿（可压缩的文本注释会被 gzip 抹平）
      writeFileSync(p, readFileSync(p) + `\n/* W21-A 变异体（仅存在于临时树）：${randomBytes(4096).toString('base64')} */\n`)
      const g = gzipTotal(path.join(dir, 'dist'))
      return [
        `css 原始字节 ${before} → ${statSync(p).size}（+${statSync(p).size - before}）`,
        `web 传输面 gzip ${BASE_GZIP} → ${g}（+${g - BASE_GZIP}，上限 ${BASE_GZIP + Math.floor(BASE_GZIP * 0.005)}）`,
      ]
    },
  },
  {
    id: 'm4-sums-drift',
    desc: '把 dist/SHA256SUMS 改一个字节（与 public/SHA256SUMS 不再逐字节相同）',
    expect: { rc: 1, fails: ['N5', 'N16'], undecided: [] },
    mutate: (dir) => {
      const p = path.join(dir, 'dist/SHA256SUMS')
      const before = sha256(p)
      const buf = readFileSync(p)
      const len = buf.length
      buf[0] = buf[0] === 0x65 ? 0x66 : 0x65 // 'e' ↔ 'f'：长度不变，内容变了
      writeFileSync(p, buf)
      return [`字节数 ${len} → ${statSync(p).size}（未变）；sha256 ${before.slice(0, 12)}… → ${sha256(p).slice(0, 12)}…（已变）`]
    },
  },
  {
    id: 'm5-no-dist',
    desc: '删掉整个 dist/（必须 exit 2 未判定，不得 exit 0）',
    expect: { rc: 2, fails: [], undecided: ['N1'] },
    mutate: (dir) => {
      rmSync(path.join(dir, 'dist'), { recursive: true, force: true })
      return [`dist 存在 = ${existsSync(path.join(dir, 'dist'))}`]
    },
  },
  {
    id: 'm6-symlink-nm',
    desc: '把 node_modules 做成符号链接（R23 实测：软链会改变 chunk 名）→ 必须 exit 2 未判定',
    expect: { rc: 2, fails: [], undecided: ['N0'] },
    mutate: (dir) => {
      const nm = path.join(dir, 'node_modules')
      // 悬空软链即可：判据只 lstat 它是不是链接，不解析内容
      symlinkSync(path.join(os.tmpdir(), 'facedb-deps-not-real'), nm)
      return [`node_modules 是符号链接 = ${lstatSync(nm).isSymbolicLink()}（指向不存在的目标也算）`]
    },
  },
  {
    id: 'm7-raw-inflate',
    // R23REV-N10：本轮之前**没有任何变异体打过「原始总字节 +2%」这条上限档** ——
    // 复核席自己的草案算式算出负值（RangeError）后放弃了，于是这道「防 wasm/模型整体变胖」的闸
    // 整轮没被真变异验证过。这里补上：往非 web-gzip 面的 wasm 追加 600KB 不可压缩内容 ⇒
    // 原始总字节顶穿上限（2% = 548612 B），而 web gzip 面（只看 6 个 web 文件）不动。
    desc: '往 dist/wasm 追加 600 KB 不可压缩内容：原始总字节顶穿 +2% 上限，web 传输面不受影响',
    // 期望同时翻 N9（该 wasm 的 sha256 锁）—— 这是**正确**行为：追加字节既顶穿总量上限、
    // 又改变被锁文件的内容哈希。本变异体的靶子是 N4（此前没有任何变异体打过这条档），
    // 顺带证明「体积档」与「内容哈希档」是两条独立的防线（与 m2 的附加断言互补）。
    expect: { rc: 1, fails: ['N4', 'N9'], undecided: [] },
    mutate: (dir) => {
      const p = path.join(dir, 'dist/wasm/vision_wasm_internal.wasm')
      const before = statSync(p).size
      const rawBefore = rawTotal(path.join(dir, 'dist'))
      writeFileSync(p, Buffer.concat([readFileSync(p), randomBytes(600 * 1024)]))
      const after = statSync(p).size
      const rawAfter = rawTotal(path.join(dir, 'dist'))
      return [
        `${path.basename(p)} 原始字节 ${before} → ${after}（+${after - before}）`,
        `原始总字节 ${rawBefore} → ${rawAfter}（+${rawAfter - rawBefore}，上限 = 基线 + 2% = ${Math.ceil(rawTotal(SRC_DIST) * 1.02)}）`,
      ]
    },
  },
  {
    // R23（PR #27 的 CI 抓到）：判据此前只钉「产物长什么样」，不钉「产物是不是这份源码构建的」——
    // 我用一份陈旧 dist 重锚，本地 16/16 全绿、CI 一跑就红（干净检出重建得另一个入口 chunk 名）。
    // 补上源码同源前提后，这一对变异体证明它真的会响：m8a 把 src/ 原样复制（不适用→适用且必须仍绿），
    // m8b 在复制的 src/ 里改一行（源码动了、产物没重建）⇒ 必须 exit 2 未判定。
    // 两者成对：只测 m8b 无法排除「复制本身就触发」这种假阳性。
    id: 'm8a-src-copied-control',
    desc: '把 src/ + index.html + package.json 原样复制进树（阴性对照：复制本身不得触发同源前提）',
    expect: { rc: 0, fails: [], undecided: [] },
    mutate: (dir) => copySourceInputs(dir),
  },
  {
    id: 'm8b-src-drift',
    desc: '复制的 src/ 里改一行（源码与产物不同源）→ 必须 exit 2 未判定',
    expect: { rc: 2, fails: [], undecided: ['N0'] },
    mutate: (dir) => {
      const proof = copySourceInputs(dir)
      const p = path.join(dir, 'src/main.ts')
      const before = readFileSync(p, 'utf8')
      writeFileSync(p, before + '\n// R23 同源前提的变异体：这一行让源码指纹改变\n')
      return [...proof, `src/main.ts 字节 ${before.length} → ${statSync(p).size}（追加一行注释）`]
    },
  },
]

// 把「喂给打包器的源码输入」从工程复制进临时树（m8a/m8b 共用）。
// 刻意只复制 index.html / package.json / src/ —— 判据的源码指纹覆盖的就是这三者。
function copySourceInputs(dir) {
  const cp = spawnSync('cp', ['-R', path.join(REPO, 'src'), path.join(dir, 'src')], { encoding: 'utf8' })
  if (cp.status !== 0) throw new Error(`cp -R src 失败：${(cp.stderr || '').trim()}`)
  for (const f of ['index.html', 'package.json']) copyFileSync(path.join(REPO, f), path.join(dir, f))
  const n = listFiles(path.join(dir, 'src')).length
  return [`复制 src/ ${n} 个文件 + index.html + package.json（复制后尚未改动）`]
}

const TMP = mkdtempSync(path.join(os.tmpdir(), 'facedb-size-mutants-'))
const results = []
try {
  for (const v of variants) {
    const dir = path.join(TMP, v.id)
    mkdirSync(path.join(dir, 'public'), { recursive: true })
    // 真复制（cp -R），绝不用硬链
    const cp = spawnSync('cp', ['-R', SRC_DIST, path.join(dir, 'dist')], { encoding: 'utf8' })
    if (cp.status !== 0) throw new Error(`cp -R 失败：${(cp.stderr || '').trim()}`)
    copyFileSync(SRC_SUMS, path.join(dir, 'public/SHA256SUMS'))

    // 证明①：副本与原件不是同一个 inode（硬链会相等）
    const probe = 'wasm/vision_wasm_internal.wasm'
    const inoSrc = statSync(path.join(SRC_DIST, probe)).ino
    const inoCopy = statSync(path.join(dir, 'dist', probe)).ino
    if (inoSrc === inoCopy) throw new Error(`副本与原件是同一个 inode（硬链）：${probe} —— 立即停止，避免改到工程原件`)

    const proof = v.mutate(dir)
    const r = spawnSync(process.execPath, [JUDGE], {
      // PUBLIC_PB_URL 置空：本自检跑的是默认环境下的清单基线（那是判据 N0 的前提）
      env: { ...process.env, SIZE_ROOT: dir, PUBLIC_PB_URL: '' },
      encoding: 'utf8',
      timeout: 300000,
    })
    const out = (r.stdout || '') + (r.stderr || '')
    const fails = [...new Set([...out.matchAll(/^\[FAIL\] (N\d+)/gm)].map((m) => m[1]))]
    const undecided = [...new Set([...out.matchAll(/^\[SKIP\] (N\d+)/gm)].map((m) => m[1]))]
    const rawLine = (out.split('\n').find((l) => l.includes(`N4 产物原始总字节`)) || '').trim()
    results.push({ ...v, dir, rc: r.status, fails, undecided, out, proof, rawLine, inoOk: inoSrc !== inoCopy })
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

// ── 期望值比对：退出码 + 翻转的断言名 + 未判定项，三者都要逐项相等 ──
let pass = 0
let fail = 0
console.log('=== W21-A 产物体积判据 · 变异自检 ===')
console.log(`样本：${SRC_DIST}（${BEFORE.size} 个文件，web 传输面 gzip 基线 ${BASE_GZIP} B）`)
console.log(`临时树：真复制（cp -R），跑完删除；inode 逐一核对：${results.every((r) => r.inoOk) ? '副本 ≠ 原件' : '有硬链！'}`)
console.log('')
for (const r of results) {
  const e = r.expect
  const okRc = r.rc === e.rc
  const okFails = JSON.stringify(r.fails) === JSON.stringify(e.fails)
  const okUn = JSON.stringify(r.undecided) === JSON.stringify(e.undecided)
  const ok = okRc && okFails && okUn
  if (ok) pass++
  else fail++
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${r.id} | ${r.desc}`)
  console.log(`       变异生效：${r.proof.join('；')}`)
  console.log(
    `       exit=${r.rc}（期望 ${e.rc}）翻转断言=[${r.fails}]（期望 [${e.fails}]）未判定=[${r.undecided}]（期望 [${e.undecided}]）${ok ? '' : ' ← 不符'}`,
  )
  if (r.rawLine) console.log(`       ${r.rawLine}`)
}
// m2 的额外要求：证明「只锁大小」不够 —— 原始总字节档必须仍然通过
const m2 = results.find((r) => r.id === 'm2-same-size-wasm')
const m2SizeStillOk = /^\[OK\]/.test(m2.rawLine)
console.log('')
console.log(`m2 附加断言：同字节数换内容后「N4 原始总字节」档仍为 ${m2SizeStillOk ? '通过（证明大小阈值抓不住同大小换内容，sha256 档是必需的）' : '失败（与本变异体设计的「只翻 sha256 档」不符）'}`)
if (!m2SizeStillOk) fail++
else pass++

// 证明②：工程 dist/ 一个字节都没被改动（若发生硬链事故，这里必红）
const AFTER = new Map(listFiles(SRC_DIST).map((f) => [f, sha256(path.join(SRC_DIST, f))]))
const drifted = [...BEFORE].filter(([f, h]) => AFTER.get(f) !== h).map(([f]) => f)
const sameSet = BEFORE.size === AFTER.size
const srcIntact = drifted.length === 0 && sameSet
console.log(`工程原件未被改动：${srcIntact ? `✅ ${BEFORE.size} 个文件 sha256 全部与开跑前一致` : `❌ 漂移=[${drifted}] 文件数 ${BEFORE.size}→${AFTER.size}`}`)
if (!srcIntact) fail++
else pass++

console.log('')
console.log(`变异体 ${results.length} 个（另有 m2 附加断言与原件完整性各 1 项）：通过 ${pass}，失败 ${fail}`)
if (fail > 0) {
  console.log('❌ 变异自检未通过（判据判别力不足，或期望值写错）')
  process.exit(1)
}
console.log('✅ 全部变异体都被对应断言抓到，对照绿，零样本判未判定（exit 2），工程原件零改动')
