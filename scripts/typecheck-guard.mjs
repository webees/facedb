#!/usr/bin/env node
// 类型检查的零样本防线。
//
// 起因（R13-X8 复核席实测）：`vue-tsc --noEmit` 在**没有任何可检查内容**时同样 exit 0。
// 于是「类型检查通过」这条 CI 断言可能在什么都没检查的情况下变绿 —— 这正是本项目
// 反复踩过的「零样本判通过」（见 RUN.md「证据与判定规范」）。
//
// 类型检查器有没有真的在检查，只能靠三件事一起证明：
//   ① 有样本：tsconfig 真实解析面（files ∪ include − exclude，含 extends 继承）命中的
//      可检查文件数必须 ≥ 下限（默认 10），且都不是空壳；
//   ② 真跑：对仓库本体跑 `vue-tsc --noEmit`，要求 exit 0；
//   ③ 有判别力（阳性对照）：在临时副本里注入一个类型错误，要求 exit ≠ 0 且报错指向该文件。
// 三者缺一 → 本项判「未执行」（exit 2），绝不判通过。
//
// 另有一条误诊防线（R22-05）：「类型检查器根本没跑起来」与「仓库本体有类型错误」是两个结论。
// 命中 TS18003（没有输入）/ ERR_PACKAGE_PATH_NOT_EXPORTED / ERR_MODULE_NOT_FOUND /
// 命令不可执行（command not found、exit 127）/ spawn 失败（ENOENT、EACCES）时一律判
// **未判定 exit 2**，并在输出里写明分类 —— 详见 classifyInfra()。
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

// ── tsconfig 的真实解析面（R22-05b）──────────────────────────────────────────
// 旧实现把候选集固定成「src/ + env.d.ts + rsbuild.config.ts」，再拿 include 去筛 —— 于是：
//   · include 指向仓库内真实存在的其它目录（如 tools/**/*.ts）被判成「匹配不到任何文件」exit 2；
//   · exclude / files / extends 完全没被尊重，判据自报的样本数与类型检查器真正读入的文件表脱钩。
// 现在样本口径 = tsconfig 的解析面本身：files ∪ (include − exclude)，extends 逐层继承。
// 去注释必须**逐字符扫描并跳过字符串字面量** —— 直接上 `/\*\*?…/` 类的正则会吃掉 glob：
// `"src/**/*.ts"` 里的 `/**/` 会被当成块注释删掉，样本口径随之静默缩水（本席实测踩到）。
const stripJsonComments = (s) => {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      out += c
      if (c === '\\') { out += s[i + 1] ?? ''; i++ } else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue }
    out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1') // 尾随逗号
}
const readTsconfig = (file, seen = []) => {
  const abs = path.resolve(file)
  if (seen.includes(abs)) throw new Error(`tsconfig extends 成环：${[...seen, abs].join(' → ')}`)
  if (!statSync(abs, { throwIfNoEntry: false })) return { file: abs, dir: path.dirname(abs), missing: true, extendsChain: [] }
  const cfg = JSON.parse(stripJsonComments(readFileSync(abs, 'utf8')))
  const dir = path.dirname(abs)
  const parents = cfg.extends === undefined ? [] : (Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends])
  // TS 语义：只有 compilerOptions 逐键合并；顶层 files / include / exclude 是**整体覆盖**。
  let base = { files: undefined, include: undefined, exclude: undefined, compilerOptions: {}, extendsChain: [] }
  for (const p of parents) {
    const b = readTsconfig(path.resolve(dir, p), [...seen, abs])
    base = {
      files: b.files ?? base.files,
      include: b.include ?? base.include,
      exclude: b.exclude ?? base.exclude,
      compilerOptions: { ...base.compilerOptions, ...b.compilerOptions },
      extendsChain: [...b.extendsChain],
    }
  }
  return {
    file: abs,
    dir,
    files: cfg.files ?? base.files,
    include: cfg.include ?? base.include,
    exclude: cfg.exclude ?? base.exclude,
    compilerOptions: { ...base.compilerOptions, ...(cfg.compilerOptions || {}) },
    extendsChain: [...parents.map((p) => path.resolve(dir, p)), ...base.extendsChain],
  }
}

// TS 的 glob 语义（只实现本判据需要的那部分）：`**/` 跨目录（含 0 层）、`*` 不跨 `/`、
// 不以文件后缀结尾且不含通配符的模式按目录处理（`"src"` ≡ `"src/**/*"`）。
const expandPattern = (pat) => {
  const p = pat.replace(/^\.\//, '').replace(/\/+$/, '')
  return !/[*?]/.test(p) && !/\.[A-Za-z0-9]+$/.test(p) ? `${p}/**/*` : p
}
const globToRe = (pat) => {
  const p = expandPattern(pat)
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'pb_data', '.verify-selfcheck'])
const walkAll = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkAll(p, out)
    else out.push(p)
  }
  return out
}

const ts = readTsconfig(path.join(ROOT, 'tsconfig.json'))
if (ts.missing) {
  console.log('  ❌ tsconfig.json 不存在 —— 输入面无从确定，本次不构成结论')
  process.exit(2)
}
const TS_DIR = ts.dir
// TS 语义：include 缺省 = files 存在时 []，否则 ['**/*']；exclude 缺省只排除依赖目录（walk 里已按名跳过）。
const filesList = (ts.files ?? []).map((f) => f.replace(/^\.\//, ''))
const incList = ts.include ?? (ts.files ? [] : ['**/*'])
const excList = ts.exclude ?? []
const allowJs = ts.compilerOptions?.allowJs === true
const SUPPORTED = allowJs ? /\.(ts|tsx|mts|cts|vue|js|jsx|mjs|cjs)$/ : /\.(ts|tsx|mts|cts|vue)$/

// ── ① 有样本 ──
const allRel = walkAll(TS_DIR).map((p) => path.relative(TS_DIR, p).split(path.sep).join('/'))
const fileSet = new Set(filesList)
const incRe = incList.map(globToRe)
const excRe = excList.map(globToRe)
const cand = allRel.filter((rel) => fileSet.has(rel)
  || (SUPPORTED.test(rel) && incRe.some((re) => re.test(rel)) && !excRe.some((re) => re.test(rel))))
const dead = incList.filter((pat, i) => !allRel.some((rel) => incRe[i].test(rel)))
const tooSmall = cand.filter((rel) => statSync(path.join(TS_DIR, rel)).size < 40)
const samples = cand.length - tooSmall.length
console.log('=== 类型检查零样本防线 ===')
console.log(`  tsconfig：${path.relative(ROOT, ts.file) || 'tsconfig.json'}（extends ${ts.extendsChain.length} 层）`
  + `files ${filesList.length} 条 / include ${incList.length} 条 / exclude ${excList.length} 条`)
console.log(`  样本来源：tsconfig 真实解析面 files ∪ (include − exclude)；仓库内文件 ${allRel.length} 个`)
console.log(`  可检查文件：${cand.length} 个，其中 <40 字节的空壳 ${tooSmall.length} 个 → 有效样本 ${samples} 个（下限 ${MIN_FILES}）`)
if (cand.length > 0 && cand.length <= 30) console.log(`  样本文件：${cand.join(', ')}`)
if (filesList.length === 0 && incList.length === 0) {
  console.log('  ❌ tsconfig 既没有 files 也没有 include —— 没有任何文件会被检查，本次不构成结论')
  process.exit(2)
}
if (dead.length) {
  console.log(`  ❌ include 有 ${dead.length} 条模式匹配不到仓库内任何文件：${dead.join(', ')} —— 覆盖面与预期不符`)
  process.exit(2)
}
if (samples < MIN_FILES) {
  console.log(`  ❌ 有效样本 ${samples} < 下限 ${MIN_FILES} —— 本次不构成结论（零样本不得判通过）`)
  if (cand.length === 0 && excList.length) {
    console.log(`     （exclude ${JSON.stringify(excList)} 把 include 命中的文件全部排除 —— TS18003「No inputs were found」语义：判未判定，不判类型错误）`)
  }
  process.exit(2)
}

const runTsc = (cwd) => {
  const r = spawnSync('npx', ['vue-tsc', '--noEmit'], { cwd, encoding: 'utf8', timeout: 240000 })
  return { code: r.status === null ? -1 : r.status, status: r.status, error: r.error, out: (r.stdout || '') + (r.stderr || '') }
}

// ── 错误分类（R22-05）：先分清「检查器没跑起来」与「仓库本体有类型错误」──
// 旧实现把 ② 的任何非 0 退出都写成「类型检查失败（仓库本体有类型错误）」并 exit 1 ——
// 实测把 TS18003（没有输入）、ERR_PACKAGE_PATH_NOT_EXPORTED、`command not found`/exit 127
// 三种基础设施故障都误诊成仓库代码有问题。分类命中即 exit 2（未判定）。
const INFRA_PATTERNS = [
  { kind: 'TS18003（没有输入：No inputs were found in config file）', re: /error TS18003\b/ },
  { kind: 'ERR_PACKAGE_PATH_NOT_EXPORTED（依赖包导出面不匹配）', re: /ERR_PACKAGE_PATH_NOT_EXPORTED/ },
  { kind: 'ERR_MODULE_NOT_FOUND（依赖缺失）', re: /ERR_MODULE_NOT_FOUND/ },
  { kind: '命令不可执行（vue-tsc / npx 不在 PATH：command not found）', re: /command not found|不是内部或外部命令|is not recognized as an internal or external command/i },
  { kind: 'spawn 失败（ENOENT / EACCES）', re: /\bENOENT\b|\bEACCES\b/ },
]
const classifyInfra = (r) => {
  if (r.error) return `spawn 失败（${r.error.code || r.error.message}）`
  if (r.status === null) return '子进程没有正常退出（超时或被杀）'
  if (r.status === 127) return '命令不可执行（exit 127：vue-tsc / npx 不在 PATH）'
  for (const p of INFRA_PATTERNS) if (p.re.test(r.out)) return p.kind
  return null
}
const reportInfra = (r, why) => {
  const kind = classifyInfra(r)
  console.log(`  ⚠️  ${why}：${kind}（exit=${r.status === null ? 'null' : r.status}）`)
  console.log(r.out.split('\n').slice(-8).join('\n'))
  console.log('  ❌ 类型检查器没有跑起来 —— 本次不构成结论（不得诊断成「仓库本体有类型错误」）')
  return kind
}

// ── ② 真跑仓库本体 ──
const real = runTsc(ROOT)
if (classifyInfra(real)) {
  reportInfra(real, '仓库本体 vue-tsc --noEmit 未构成类型结论')
  process.exit(2)
}
const realOk = real.code === 0
console.log(`  ${realOk ? '✅' : '❌'} 仓库本体 vue-tsc --noEmit exit=${real.code}`)
if (!realOk) {
  // 到这里的才是「真跑起来了、且报出类型错误」—— 只有这种情况判 exit 1。
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
// R22-05b 附带：副本必须带上 tsconfig 的 extends 基座，否则副本的输入面与本体不一致。
for (const base of ts.extendsChain) {
  const rel = path.relative(TS_DIR, base)
  if (!rel.startsWith('..') && statSync(base, { throwIfNoEntry: false })) {
    mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true })
    copyFileSync(base, path.join(TMP, rel))
  }
}
// 副本里要复制的源文件 = 本体解析面里的样本（含仓库内任意目录，不再假设只有 src/）。
for (const rel of cand) {
  const src = path.join(TS_DIR, rel)
  if (!statSync(src, { throwIfNoEntry: false })) continue
  const dst = path.join(TMP, rel)
  mkdirSync(path.dirname(dst), { recursive: true })
  copyFileSync(src, dst)
}
symlinkSync(NODE_MODULES, path.join(TMP, 'node_modules'), 'dir')

const cleanCopy = runTsc(TMP)
if (classifyInfra(cleanCopy)) {
  reportInfra(cleanCopy, '阳性对照的副本未能跑起来')
  process.exit(2)
}
console.log(`  ${cleanCopy.code === 0 ? '✅' : '❌'} 未注入错误的副本 exit=${cleanCopy.code}（副本本身应干净，否则对照不成立）`)
if (cleanCopy.code !== 0) {
  // 副本本身就不干净时，「注入的错误被抓到」与「副本本来就有错」无法区分 —— 阳性对照不成立。
  console.log('  ❌ 阳性对照的副本自身就有类型错误 —— 对照不成立，本次不构成结论')
  console.log(cleanCopy.out.split('\n').slice(-8).join('\n'))
  process.exit(2)
}

writeFileSync(path.join(TMP, 'src/__tc_probe.ts'), 'export const probe: number = "这不是数字"\n')
const injected = runTsc(TMP)
if (classifyInfra(injected)) {
  reportInfra(injected, '注入类型错误后的阳性对照运行未构成结论')
  process.exit(2)
}
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
console.log(`  ✅ 类型检查成立：有效样本 ${samples} 个（tsconfig ${path.relative(ROOT, ts.file) || 'tsconfig.json'} 解析面）、仓库 exit 0、阳性对照捕获注入错误`)
process.exit(0)
