#!/usr/bin/env node
// 类型检查的零样本防线。
//
// 起因（R13-X8 复核席实测）：`vue-tsc --noEmit` 在**没有任何可检查内容**时同样 exit 0。
// 于是「类型检查通过」这条 CI 断言可能在什么都没检查的情况下变绿 —— 这正是本项目
// 反复踩过的「零样本判通过」（见 RUN.md「证据与判定规范」）。
//
// 类型检查器有没有真的在检查，只能靠三件事一起证明：
//   ① 有样本：tsconfig include 命中的可检查文件数必须 ≥ 下限（默认 10），且都不是空壳；
//   ② 真跑：对仓库本体跑 `vue-tsc --noEmit`，要求 exit 0；
//   ③ 有判别力（阳性对照）：在临时副本里注入一个类型错误，要求 exit ≠ 0 且报错指向该文件。
// 三者缺一 → 本项判「未执行」（exit 2），绝不判通过。
//
// 用法：node scripts/typecheck-guard.mjs [--min=10]
import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const MIN_FILES = Number((process.argv.find((a) => a.startsWith('--min=')) || '--min=10').slice(6))
const TMP = path.join(tmpdir(), 'facedb-typecheck-guard')

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// ── ① 有样本 ──
const tsconfig = readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')
const inc = JSON.parse(tsconfig.replace(/\/\/[^\n]*/g, '')).include || []
const cand = []
for (const rel of ['env.d.ts', 'rsbuild.config.ts']) {
  if (statSync(path.join(ROOT, rel), { throwIfNoEntry: false })) cand.push(rel)
}
for (const p of walk(path.join(ROOT, 'src'))) {
  const rel = path.relative(ROOT, p)
  if (/\.(ts|vue)$/.test(rel)) cand.push(rel)
}
const tooSmall = cand.filter((rel) => statSync(path.join(ROOT, rel)).size < 40)
const samples = cand.length - tooSmall.length
console.log('=== 类型检查零样本防线 ===')
console.log(`  tsconfig include：${JSON.stringify(inc)}`)
console.log(`  可检查文件：${cand.length} 个，其中 <40 字节的空壳 ${tooSmall.length} 个 → 有效样本 ${samples} 个（下限 ${MIN_FILES}）`)
if (samples < MIN_FILES) {
  console.log(`  ❌ 有效样本 ${samples} < 下限 ${MIN_FILES} —— 本次不构成结论（零样本不得判通过）`)
  process.exit(2)
}

const runTsc = (cwd) => {
  const r = spawnSync('npx', ['vue-tsc', '--noEmit'], { cwd, encoding: 'utf8', timeout: 240000 })
  return { code: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// ── ② 真跑仓库本体 ──
const real = runTsc(ROOT)
const realOk = real.code === 0
console.log(`  ${realOk ? '✅' : '❌'} 仓库本体 vue-tsc --noEmit exit=${real.code}`)
if (!realOk) console.log(real.out.split('\n').slice(-8).join('\n'))

// ── ③ 阳性对照：临时副本 + 注入类型错误必须报红 ──
rmSync(TMP, { recursive: true, force: true })
mkdirSync(path.join(TMP, 'src'), { recursive: true })
for (const rel of ['env.d.ts', 'rsbuild.config.ts', 'tsconfig.json']) {
  if (statSync(path.join(ROOT, rel), { throwIfNoEntry: false })) copyFileSync(path.join(ROOT, rel), path.join(TMP, rel))
}
for (const p of walk(path.join(ROOT, 'src'))) {
  const dst = path.join(TMP, path.relative(ROOT, p))
  mkdirSync(path.dirname(dst), { recursive: true })
  copyFileSync(p, dst)
}
symlinkSync(path.join(ROOT, 'node_modules'), path.join(TMP, 'node_modules'), 'dir')

const cleanCopy = runTsc(TMP)
console.log(`  ${cleanCopy.code === 0 ? '✅' : '❌'} 未注入错误的副本 exit=${cleanCopy.code}（副本本身应干净，否则对照不成立）`)

writeFileSync(path.join(TMP, 'src/__tc_probe.ts'), 'export const probe: number = "这不是数字"\n')
const injected = runTsc(TMP)
const caught = injected.code !== 0 && /__tc_probe\.ts/.test(injected.out)
console.log(`  ${caught ? '✅' : '❌'} 注入类型错误后 exit=${injected.code}，报错指向 __tc_probe.ts：${caught ? '是' : '否'}`)
if (!caught) console.log(injected.out.split('\n').slice(-8).join('\n'))

rmSync(TMP, { recursive: true, force: true })

console.log()
if (!realOk) {
  console.log('  ❌ 类型检查失败（仓库本体有类型错误）')
  process.exit(1)
}
if (!caught) {
  console.log('  ❌ 类型检查器无判别力（注入错误也不报红）—— 本次不构成结论')
  process.exit(2)
}
console.log(`  ✅ 类型检查成立：有效样本 ${samples} 个、仓库 exit 0、阳性对照捕获注入错误`)
process.exit(0)
