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
const MIN_ARG = process.argv.find((a) => a.startsWith('--min=')) || '--min=10'
const MIN_FILES = Number(MIN_ARG.slice(6))
// NaN 参与比较恒为 false —— 不校验就等于没有下限。
if (!Number.isInteger(MIN_FILES) || MIN_FILES < 1) {
  console.log(`  ❌ --min 取值非法：${MIN_ARG}（需为 ≥1 的整数）—— 本次不构成结论`)
  process.exit(2)
}

// 临时目录必须唯一：固定路径会让并发两次互相踩（一次 EEXIST 崩、一次拿到别人残留的目录
// 而误报「类型检查器无判别力」）。进程退出时无条件清理，失败路径也不留垃圾。
const TMP = path.join(tmpdir(), `facedb-typecheck-guard-${process.pid}-${Date.now().toString(36)}`)
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))

// 没有依赖时 vue-tsc 报的是「找不到模块」，不能诊断成「仓库本体有类型错误」。
const NODE_MODULES = path.join(ROOT, 'node_modules')
if (!statSync(NODE_MODULES, { throwIfNoEntry: false })) {
  console.log('  ❌ 未安装依赖（node_modules 不存在）—— 类型检查无法执行，本次不构成结论')
  process.exit(2)
}

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
// 候选集 = 工程里全部 .ts/.vue + 两个根文件，但**只有被 include 命中的才算样本**。
// 之前这里与 include 无关，于是 include 改成 [] 仍报「有效样本 13 个」——「有样本」这项形同虚设。
const all = []
for (const rel of ['env.d.ts', 'rsbuild.config.ts']) {
  if (statSync(path.join(ROOT, rel), { throwIfNoEntry: false })) all.push(rel)
}
for (const p of walk(path.join(ROOT, 'src'))) {
  const rel = path.relative(ROOT, p)
  if (/\.(ts|vue)$/.test(rel)) all.push(rel)
}

// 极简 glob → 正则：支持 `**` 与 `*`，只用于判定「哪些文件在 include 覆盖面内」
const globToRe = (pat) => new RegExp('^' + pat.replace(/^\.\//, '')
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\//g, '\u0000')
  .replace(/\*/g, '[^/]*')
  .replace(/\u0000/g, '(?:.*/)?') + '$')
const res = inc.map(globToRe)
const cand = all.filter((rel) => res.some((re) => re.test(rel)))
const dead = inc.filter((pat, i) => !all.some((rel) => res[i].test(rel)))
const tooSmall = cand.filter((rel) => statSync(path.join(ROOT, rel)).size < 40)
const samples = cand.length - tooSmall.length
console.log('=== 类型检查零样本防线 ===')
console.log(`  tsconfig include：${JSON.stringify(inc)}（${inc.length} 条模式，命中文件 ${cand.length} 个）`)
console.log(`  可检查文件：${cand.length} 个，其中 <40 字节的空壳 ${tooSmall.length} 个 → 有效样本 ${samples} 个（下限 ${MIN_FILES}）`)
if (inc.length === 0) {
  console.log('  ❌ tsconfig include 为空 —— 没有任何文件会被检查，本次不构成结论')
  process.exit(2)
}
if (dead.length) {
  console.log(`  ❌ include 有 ${dead.length} 条模式匹配不到任何文件：${dead.join(', ')} —— 覆盖面与预期不符`)
  process.exit(2)
}
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
if (!realOk) {
  console.log(real.out.split('\n').slice(-8).join('\n'))
  console.log('  ❌ 类型检查失败（仓库本体有类型错误）—— 阳性对照不再执行')
  process.exit(1)
}

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
symlinkSync(NODE_MODULES, path.join(TMP, 'node_modules'), 'dir')

const cleanCopy = runTsc(TMP)
console.log(`  ${cleanCopy.code === 0 ? '✅' : '❌'} 未注入错误的副本 exit=${cleanCopy.code}（副本本身应干净，否则对照不成立）`)
if (cleanCopy.code !== 0) {
  // 副本本身就不干净时，「注入的错误被抓到」与「副本本来就有错」无法区分 —— 阳性对照不成立。
  console.log('  ❌ 阳性对照的副本自身就有类型错误 —— 对照不成立，本次不构成结论')
  console.log(cleanCopy.out.split('\n').slice(-8).join('\n'))
  process.exit(2)
}

writeFileSync(path.join(TMP, 'src/__tc_probe.ts'), 'export const probe: number = "这不是数字"\n')
const injected = runTsc(TMP)
const caught = injected.code !== 0 && /__tc_probe\.ts/.test(injected.out)
console.log(`  ${caught ? '✅' : '❌'} 注入类型错误后 exit=${injected.code}，报错指向 __tc_probe.ts：${caught ? '是' : '否'}`)
if (!caught) console.log(injected.out.split('\n').slice(-8).join('\n'))

rmSync(TMP, { recursive: true, force: true })

console.log()
// 仓库本体有错的情况已在 ② 之后立刻 exit 1 —— 不能等到这里，
// 否则副本阳性对照的「对照不成立 exit 2」会先于它触发，把真错误诊断成未判定。
if (!caught) {
  console.log('  ❌ 类型检查器无判别力（注入错误也不报红）—— 本次不构成结论')
  process.exit(2)
}
console.log(`  ✅ 类型检查成立：有效样本 ${samples} 个（include ${inc.length} 条模式）、仓库 exit 0、阳性对照捕获注入错误`)
process.exit(0)
