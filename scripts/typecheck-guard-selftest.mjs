#!/usr/bin/env node
// 类型检查判据的自检电池（R25-INCIDENT-02）。
//
// 起因：`node_modules/vue-tsc/bin/vue-tsc.js` 被写成 17 字节的 `#!/bin/sh\nexit 0\n` 桩，
// 于是 `npx vue-tsc --noEmit` 恒 exit 0 零输出 —— `npm run typecheck` 与 CI 的类型检查步骤
// 整段时间空转。`verify:types` 的阳性对照当时正确地判出了「不构成结论」，但把两种不同的
// 故障混成一条：**二进制被换成桩** vs **检查器逻辑不判别**。本电池把这两支分别钉住。
//
// 装置纪律（踩过的坑）：
//   · 绝不在**真仓库**的 node_modules 里写桩 —— 那正是本事故的来源。每个场景建一棵
//     mkdtemp 临时树，`node_modules` 里的依赖逐个软链到真仓库，**只有 vue-tsc 是真拷贝**，
//     于是对桩的写入只落在临时树里。
//   · `npx vue-tsc` 靠 PATH 上的 `node_modules/.bin` 解析 ⇒ 必须把临时树的 `.bin` 放在
//     PATH 最前，否则会解析到真仓库的可执行文件，场景静默失效（判据假绿）。
//   · TCG_ROOT 指临时树（判据为此新增的覆盖通道）。
//   · **绝不要把临时树的 node_modules 做成指向真仓库的软链**：那样 `mkdir`/`symlinkSync`
//     会穿过去写到真仓库的 node_modules（本电池第一版就在真 `.bin/` 里尝试创建链接，
//     只因同名已存在才以 EEXIST 中止）—— 事故的成因正是「往共享依赖树里写东西」。
//     正确形态：临时树的 node_modules 是真目录，普通依赖逐个软链，只有 vue-tsc 是实体拷贝。
//
// 用法：node scripts/typecheck-guard-selftest.mjs
import { mkdtempSync, mkdirSync, rmSync, cpSync, symlinkSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = import.meta.dirname
const REPO = path.join(HERE, '..')
const GUARD = path.join(HERE, 'typecheck-guard.mjs')
const NODE_MODULES = path.join(REPO, 'node_modules')
const keep = process.env.TCG_SELFTEST_KEEP === '1'
const trees = []

const has = (p) => existsSync(p)

/** 建一棵可跑的临时仓库树：源码/配置是真拷贝，依赖软链，只有 vue-tsc 是真拷贝。 */
function makeTree(tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `facedb-tcg-selftest-${tag}-`))
  trees.push(dir)
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  cpSync(GUARD, path.join(dir, 'scripts', 'typecheck-guard.mjs'))
  for (const rel of ['tsconfig.json', 'env.d.ts', 'rsbuild.config.ts']) {
    if (has(path.join(REPO, rel))) cpSync(path.join(REPO, rel), path.join(dir, rel))
  }
  cpSync(path.join(REPO, 'src'), path.join(dir, 'src'), { recursive: true })
  const nm = path.join(dir, 'node_modules')
  mkdirSync(nm, { recursive: true })
  for (const name of readdirSync(NODE_MODULES)) {
    // `.bin` 单独处理（下面重建），vue-tsc 用实体拷贝 —— 其余逐个软链。
    if (name === 'vue-tsc' || name === '.bin') continue
    symlinkSync(path.join(NODE_MODULES, name), path.join(nm, name), 'dir')
  }
  // 只有 vue-tsc 是实体拷贝：桩只能落在临时树里。
  cpSync(path.join(NODE_MODULES, 'vue-tsc'), path.join(nm, 'vue-tsc'), { recursive: true })
  // .bin 逐项指向真依赖；vue-tsc 指向**本树**的实体拷贝（相对路径，随树走）。
  const bin = path.join(nm, '.bin')
  mkdirSync(bin, { recursive: true })
  for (const name of readdirSync(path.join(NODE_MODULES, '.bin'))) {
    const target = name === 'vue-tsc' ? '../vue-tsc/bin/vue-tsc.js' : path.join(NODE_MODULES, '.bin', name)
    symlinkSync(target, path.join(bin, name))
  }
  return dir
}

const VUE_TSC_BIN = (dir) => path.join(dir, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')

/** 跑临时树里的判据；PATH 必须把**临时树**的 .bin 放最前，否则 npx 会解析到真仓库。 */
function runGuard(dir, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'typecheck-guard.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 600000,
    env: {
      ...process.env,
      TCG_ROOT: dir,
      PATH: `${path.join(dir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}`,
      ...extraEnv,
    },
  })
  return { code: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.error }
}

const cases = []
const check = (tag, ok, detail) => cases.push({ tag, ok, detail })

// ── s1 干净树（真 vue-tsc）⇒ 必须成立 ──────────────────────────────────────
{
  const dir = makeTree('clean')
  const r = runGuard(dir)
  check('s1 真 vue-tsc ⇒ 成立', r.code === 0 && /✅ 类型检查成立/.test(r.out) && /✅ 可执行文件真实性/.test(r.out), `exit=${r.code}`)
}

// ── s2 shell 桩（事故原形：17 字节 `#!/bin/sh\nexit 0\n`）⇒ 必须判「可执行文件被桩替换」──
{
  const dir = makeTree('shellstub')
  writeFileSync(VUE_TSC_BIN(dir), '#!/bin/sh\nexit 0\n')
  const r = runGuard(dir)
  // 输出把桩内容 JSON.stringify 在一行里 ⇒ 不能用 `^#!/bin/sh` 锚行首。
  const hit = /可执行文件被桩替换/.test(r.out) && /bin\/sh/.test(r.out)
  const wrong = /无判别力/.test(r.out)
  check('s2 shell 桩 ⇒ 判「可执行文件被桩替换」且不混成「无判别力」', r.code === 2 && hit && !wrong, `exit=${r.code} 命中=${hit} 混口径=${wrong}`)
}

// ── s3 node 空转桩（大小够、是 JS，但无 require/import、不产出版本）⇒ 必须判桩 ──
{
  const dir = makeTree('noopstub')
  writeFileSync(VUE_TSC_BIN(dir), '#!/usr/bin/env node\nprocess.exit(0)\n// 空转桩：什么都不检查\n')
  const r = runGuard(dir)
  const hit = /不像是 vue-tsc 本体|没有给出可用的版本号/.test(r.out) && !/✅ 类型检查成立/.test(r.out)
  check('s3 node 空转桩 ⇒ 判「类型检查器不在」', r.code === 2 && hit, `exit=${r.code} 命中=${hit}`)
}

// ── s4 阴性对照（能报版本、看着像真件，但检查不报错）⇒ 必须落在「无判别力」而不是「被桩替换」──
{
  const dir = makeTree('nodiscrim')
  writeFileSync(
    VUE_TSC_BIN(dir),
    "#!/usr/bin/env node\nrequire('fs') // 看着像转发壳\nif (process.argv.includes('--version')) { console.log('Version 5.9.3'); process.exit(0) }\nprocess.exit(0)\n",
  )
  const r = runGuard(dir)
  const hit = /无判别力/.test(r.out) && !/可执行文件被桩替换/.test(r.out)
  check('s4 像真件但不判别 ⇒ 判「无判别力」（两支不混）', r.code === 2 && hit, `exit=${r.code} 命中=${hit}`)
}

// ── s6 入口解析不出来（`node_modules/vue-tsc/package.json` 读不到）⇒ 判「无法验证」且 exit 2 ──
// R26 / W26E-14：修复前这一段是**静默跳过**的（`if (vueTscBin) { … }`，没有 else），
// 于是删掉一个 package.json 就能让「可执行文件真实性」整段护栏消失。零样本不得判通过。
{
  const dir = makeTree('noentry')
  rmSync(path.join(dir, 'node_modules', 'vue-tsc', 'package.json'), { force: true })
  const r = runGuard(dir)
  const hit = /无法解析 vue-tsc 的入口/.test(r.out) && /无法验证/.test(r.out)
  const noStack = !/^\s+at .*\(.*:\d+:\d+\)$/m.test(r.out)
  check('s6 入口读不到 ⇒ 判「无法验证」且 exit 2（不许静默跳过）', r.code === 2 && hit && noStack, `exit=${r.code} 命中=${hit} 裸栈=${!noStack}`)
}

// ── s7 阴性对照：临时树必须没碰真仓库的 vue-tsc ────────────────────────────
{
  const real = readFileSync(path.join(NODE_MODULES, 'vue-tsc', 'bin', 'vue-tsc.js'), 'utf8')
  const intact = /require\(/.test(real) && !/^#!\/bin\/sh/.test(real) && real.length > 30
  check('s7 真仓库的 vue-tsc 本体未被本电池改动', intact, `字节=${real.length}`)
}

if (!keep) for (const d of trees) rmSync(d, { recursive: true, force: true })

let pass = 0
for (const c of cases) {
  console.log(`${c.ok ? '✅' : '❌'} ${c.tag}（${c.detail}）`)
  if (c.ok) pass++
}
const ok = pass === cases.length
console.log(`\n${ok ? '✅' : '❌'} 类型检查判据自检：通过 ${pass}，失败 ${cases.length - pass}（共 ${cases.length} 项）`)
if (!ok) console.log('  上面每条 ❌ 都带实测读数；判据不成立时不得当作通过。')
process.exit(ok ? 0 : 1)
