// R20-F7 判据的变异自检（判别力验证）
//
// 目的：证明 `scripts/check-third-party-notices.mjs` 的 9 条断言**各自**都能被对应的缺陷判红，
// 且未变异的副本全绿、缺 dist 时判「未判定（exit 2）」而不是通过。
//
// 做法：不硬链、不改工程 —— 每个变异体在 /tmp 下建一棵**只含判据所需文件**的临时树
// （THIRD-PARTY-NOTICES.md / package-lock.json / rsbuild.config.ts / docs/THIRD-PARTY.md / dist/），
// 施加一处改动后用 STD_ROOT 指向它跑判据，比对 exit code 与翻转的断言名。
//
// 用法：node lib/r20-f7-notices-mutants.mjs
import { mkdirSync, mkdtempSync, rmSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const P = process.env.FACEDB_ROOT || path.resolve(HERE, '..')
const JUDGE = process.env.JUDGE || path.join(P, 'scripts/check-third-party-notices.mjs')
// 【R24 / W24-E-03】落点必须每次运行唯一：原先硬编码 `/tmp/r20-f7-notices-mutants`，两个实例并发跑时
// 互相删目录（实测并发 6 次里 5 次直接崩：ENOTEMPTY rmdir …/baseline、ENOENT open/copyfile 同目录），
// 还会打印误导性结论「判据的判别力不足或期望值写错」。
const TMP = mkdtempSync(path.join(tmpdir(), 'facedb-notices-mutants-'))

const FILES = [
  'THIRD-PARTY-NOTICES.md',
  'package-lock.json',
  'rsbuild.config.ts',
  'docs/THIRD-PARTY.md',
]

const variants = [
  ['baseline', null],
  ['m1-no-appendix', (t) => {
    // 只砍掉 Apache 的 APPENDIX 段（到 5.2 节标题为止），保留 MIT —— 否则会连带把 N3 也弄红，
    // 那就证明不了「N2 单点可判」。
    const i = t.indexOf('APPENDIX: How to apply the Apache License to your work')
    const j = t.indexOf('### 5.2 MIT License')
    return [t.slice(0, i) + t.slice(j), 'NOTICE']
  }],
  ['m2-closure-version', (t) => [t.replace(/\| `vue` \| ([0-9][^ ]*) \|/, '| `vue` | 9.9.9 |'), 'NOTICE']],
  ['m3-license-claim-only', (t) => {
    // 只留「Apache-2.0」声明、删掉正文：N2 必须红（证明 N2 不是「出现 Apache 二字即过」）
    const i = t.indexOf('<!-- Apache-2.0 官方全文')
    const j = t.indexOf('### 5.2 MIT License')
    return [t.slice(0, i) + '本项目使用 Apache-2.0 许可的组件。\n\n' + t.slice(j), 'NOTICE']
  }],
  ['m4-no-copy', (t) => [t.replace(/\s*copy: \[\{ from: 'THIRD-PARTY-NOTICES\.md'[^\]]*\],?/, ''), 'RSBUILD']],
  ['m5-doc-stale', (t) => [t.replace('### ✅ 已处置（R20-F7）', '### ⚠️ 已知缺口：MediaPipe chunk 没有许可侧车（**待法务确认，未解决**）'), 'DOC']],
  ['m6-placeholder', (t) => [t.replace('### 5.2 MIT License', '<!-- VUE-MIT-TEXT -->\n\n### 5.2 MIT License'), 'NOTICE']],
  ['m7-no-dist', null, { skipDist: true }],
  ['m8-dist-drift', null, { distMutate: (t) => t.replace('第三方软件声明', '第三方软件声明X') }],
]

let pass = 0
let fail = 0
const results = []
rmSync(TMP, { recursive: true, force: true })

for (const [name, mutate, opts = {}] of variants) {
  const dir = path.join(TMP, name)
  mkdirSync(path.join(dir, 'docs'), { recursive: true })
  for (const f of FILES) copyFileSync(path.join(P, f), path.join(dir, f))

  // NOTICE / RSBUILD / DOC 三类变异挑一（mutate 返回值第二项标明目标）
  if (mutate) {
    const notmods = mutate(readFileSync(path.join(dir, 'THIRD-PARTY-NOTICES.md'), 'utf8'))
    const [text, which = 'NOTICE'] = notmods
    const target = which === 'NOTICE' ? 'THIRD-PARTY-NOTICES.md' : which === 'RSBUILD' ? 'rsbuild.config.ts' : 'docs/THIRD-PARTY.md'
    // mutate 里对 rsbuild/config、docs 的替换需要各自原文：这里按目标重取一次
    if (which !== 'NOTICE') {
      const orig = readFileSync(path.join(dir, target), 'utf8')
      writeFileSync(path.join(dir, target), mutate(orig)[0])
    } else {
      writeFileSync(path.join(dir, target), text)
    }
  }

  // dist 副本（除 m7 外都存在，且默认与仓库根逐字节相同 = 一次真实构建的产物）
  if (!opts.skipDist) {
    mkdirSync(path.join(dir, 'dist'), { recursive: true })
    const notice = readFileSync(path.join(dir, 'THIRD-PARTY-NOTICES.md'), 'utf8')
    writeFileSync(path.join(dir, 'dist/THIRD-PARTY-NOTICES.md'), opts.distMutate ? opts.distMutate(notice) : notice)
  }

  const r = spawnSync('node', [JUDGE], { cwd: dir, env: { ...process.env, STD_ROOT: dir }, encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  const failedNames = [...out.matchAll(/\[FAIL\] (N\d)/g)].map((m) => m[1])
  const undecided = [...out.matchAll(/\[\?\?\]\s+(N\d)/g)].map((m) => m[1])
  results.push({ name, rc: r.status, failedNames: [...new Set(failedNames)], undecided: [...new Set(undecided)] })
}

// ---- 期望值：变异体必须让对应的断言红，且只在该处红
const EXPECT = {
  baseline: { rc: 0, fails: [] },
  'm1-no-appendix': { rc: 1, fails: ['N2'] },
  'm2-closure-version': { rc: 1, fails: ['N5'] },
  'm3-license-claim-only': { rc: 1, fails: ['N2'] },
  'm4-no-copy': { rc: 1, fails: ['N6'] },
  'm5-doc-stale': { rc: 1, fails: ['N8'] },
  'm6-placeholder': { rc: 1, fails: ['N9'] },
  'm7-no-dist': { rc: 2, fails: [], undecided: ['N7'] },
  'm8-dist-drift': { rc: 1, fails: ['N7'] },
}

console.log('=== R20-F7 判据变异自检 ===')
for (const r of results) {
  const e = EXPECT[r.name]
  const okRc = r.rc === e.rc
  const okFails = JSON.stringify(r.failedNames) === JSON.stringify(e.fails)
  const okUn = !e.undecided || JSON.stringify(r.undecided) === JSON.stringify(e.undecided)
  const ok = okRc && okFails && okUn
  if (ok) pass++
  else fail++
  console.log(
    `${ok ? '[OK]  ' : '[FAIL]'} ${r.name} | rc=${r.rc}（期望 ${e.rc}）失败断言=${r.failedNames.join(',') || '无'}（期望 ${e.fails.join(',') || '无'}）` +
      `未判定=${r.undecided.join(',') || '无'}${ok ? '' : ` ← 不符`}`,
  )
}

console.log(`\n变异体 ${results.length} 个：通过 ${pass}，失败 ${fail}`)
rmSync(TMP, { recursive: true, force: true })
if (fail > 0) {
  console.log('❌ 变异自检未通过（判据的判别力不足或期望值写错）')
  process.exit(1)
}
console.log('✅ 全部变异体都被对应断言抓到，且基线全绿、零样本判未判定')
