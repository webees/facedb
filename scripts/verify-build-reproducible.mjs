// R36：产物可复现性判据 —— 同一份源码在**两棵独立副本**里各构建一次，逐字节比对产物名册。
//
// 为什么不能只靠 scripts/check-dist-size-budget.mjs：那 17 项里
//   · 只有 4 个 chunk 的 sha256 被锁；dist/index.html 的内容没有任何断言（R36 实测：改一个字节、长度不变 ⇒ 17/17 全绿）；
//   · 「原始总字节」是 +2% 上限（余量 548 KB），吃不下内容漂移；
//   · 它的源码指纹集（index.html + package.json + src/**）不含任何构建配置（rsbuild.config.ts 等）。
// 本判据只做一件事并且做成：**两次独立构建必须逐字节相同**。名册算式见 scripts/lib/build-index.mjs。
//
// 退出码：0 = 名册一致；1 = 不一致（点出差异文件）；2 = 前提不成立/零样本（绝不判通过）。
// 自检钩子（仅供自检与轮次实验，正常 CI 不设）：
//   REPRO_TAMPER=A|B   在两臂之一构建完成后翻转 dist/index.html 的一个字节（必须被抓到 ⇒ exit 1）
//   REPRO_ARM_B=absolute  B 臂改用绝对 --root 调用（已知会改产物 ⇒ 必须 exit 1，见 R36-LEAD-07）
//   REPRO_KEEP=1       保留临时副本目录（默认删除）
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildIndex, diffRosters } from './lib/build-index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(process.env.REPRO_ROOT || join(HERE, '..'))
const TAMPER = process.env.REPRO_TAMPER || 'none'
const ARM_B = process.env.REPRO_ARM_B || 'relative'
const KEEP = process.env.REPRO_KEEP === '1'

const ok = (name, detail) => console.log(`[OK]   N ${name} | ${detail}`)
const bad = (name, detail) => console.log(`[FAIL] N ${name} | ${detail}`)
const info = (s) => console.log(`[INFO] ${s}`)
const undecided = (why) => { console.log(`⛔ 未判定（exit 2）：${why}`); process.exit(2) }

const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

// ---- 前提（任一不成立 ⇒ 未判定，不判通过）----
if (!existsSync(join(ROOT, 'package.json'))) undecided(`根里没有 package.json（实测根 ROOT=${ROOT}）`)
if (!existsSync(join(ROOT, 'src'))) undecided(`根里没有 src/（实测根 ROOT=${ROOT}）`)
const nm = join(ROOT, 'node_modules')
if (!existsSync(nm)) undecided('根里没有 node_modules（先 npm ci）')
if (lstatSync(nm).isSymbolicLink()) undecided('node_modules 是软链：软链会改变 chunk 名（R23-25），本判据在这种树上没有判别力')
if (run('which', ['npm'], ROOT).status !== 0) undecided('找不到 npm')

const build = (cwd, label) => {
  const extra = label === 'B' && ARM_B === 'absolute' ? ['--root', cwd] : []
  const r = extra.length ? run('npx', ['rsbuild', 'build', ...extra], cwd) : run('npm', ['run', 'build'], cwd)
  if (r.status !== 0) undecided(`${label} 臂构建失败（exit ${r.status}）：${String(r.stderr || r.stdout || '').split('\n').slice(-3).join(' ')}`)
}
const tamper = (distDir, label) => {
  if (TAMPER !== label) return
  const p = join(distDir, 'index.html')
  const b = readFileSync(p)
  b[b.length - 2] = b[b.length - 2] === 0x20 ? 0x21 : 0x20
  writeFileSync(p, b)
  info(`自检钩子：已翻转 ${label} 臂 dist/index.html 的 1 个字节（必须被抓到）`)
}

// ---- A 臂：直接在实测根里构建 ----
info(`ROOT=${ROOT}（A 臂 = npm run build；B 臂 = 独立副本 + npm run ${ARM_B === 'absolute' ? 'npx rsbuild build --root' : 'build'}）`)
build(ROOT, 'A')
tamper(join(ROOT, 'dist'), 'A')
const A = buildIndex(ROOT)
if (A.zeroSample) undecided('A 臂产物为空（零样本 ⇒ 不判通过）')

// ---- B 臂：独立副本（排除 dist/.git，node_modules 用硬链目录，绝不用软链）----
const dest = mkdtempSync(join(tmpdir(), 'facedb-repro-'))
const cleanup = () => { if (!KEEP) rmSync(dest, { recursive: true, force: true }) }
try {
  cpSync(ROOT, dest, {
    recursive: true, dereference: false,
    filter: (src) => {
      const rel = src.slice(ROOT.length + 1)
      // 排除与 web 构建无关的大目录：dist（本次要重建）、.git、node_modules（单独硬链）、pb_data（生产数据卷）
      if (/^(dist|\.git|node_modules|pb_data)(\/|$)/.test(rel)) return false
      return true
    },
  })
  const r = run('cp', ['-al', nm, join(dest, 'node_modules')], dest)
  if (r.status !== 0) undecided(`B 臂 node_modules 硬链目录创建失败（cp -al，exit ${r.status}）：${String(r.stderr || '').trim()}`)
  if (lstatSync(join(dest, 'node_modules')).isSymbolicLink()) undecided('B 臂 node_modules 是软链（装置不成立）')
  build(dest, 'B')
  tamper(join(dest, 'dist'), 'B')
  const B = buildIndex(dest)
  if (B.zeroSample) undecided('B 臂产物为空（零样本 ⇒ 不判通过）')

  info(`A 名册 ${A.rosterHash} · ${A.files.length} 文件 · 源码指纹 ${A.source.hash?.slice(0, 12)} · 配置指纹 ${A.config.hash?.slice(0, 12)}`)
  info(`B 名册 ${B.rosterHash} · ${B.files.length} 文件 · 源码指纹 ${B.source.hash?.slice(0, 12)} · 配置指纹 ${B.config.hash?.slice(0, 12)}`)

  // 前提对照：两棵树的源码/配置指纹必须相同，否则「产物不同」不能归因到构建过程
  const sameSource = A.source.hash === B.source.hash
  const sameConfig = A.config.hash === B.config.hash
  if (!sameSource) bad('N1 前提：两棵树的源码指纹相同', `A ${A.source.hash?.slice(0, 12)} ≠ B ${B.source.hash?.slice(0, 12)}（副本没复制全 ⇒ 本判据结论不可用）`)
  else ok('N1 前提：两棵树的源码指纹相同', `源码指纹 ${A.source.hash.slice(0, 16)}（${A.source.inputs.length} 个输入）`)
  if (!sameConfig) bad('N2 前提：两棵树的构建配置指纹相同', `A ${A.config.hash?.slice(0, 12)} ≠ B ${B.config.hash?.slice(0, 12)}`)
  else ok('N2 前提：两棵树的构建配置指纹相同', `配置指纹 ${A.config.hash.slice(0, 16)}（${A.config.inputs.length} 个输入；原体积判据完全不覆盖这一组）`)

  // 主张：两次独立构建逐字节相同
  const d = diffRosters(A, B)
  if (A.rosterHash === B.rosterHash) ok('N3 两次独立构建的产物名册逐字节相同', `名册 ${A.rosterHash.slice(0, 16)}（${A.files.length} 文件，含 dist/index.html ${A.files.find((f) => f.rel === 'index.html')?.sha256.slice(0, 12) ?? '缺失'}）`)
  else { bad('N3 两次独立构建的产物名册逐字节相同', `A ${A.rosterHash} ≠ B ${B.rosterHash}；差异 ${d.length} 个文件：${d.slice(0, 6).map((x) => `${x.rel}（${x.why}）`).join(' · ')}`) }

  const hi = A.files.find((f) => f.rel === 'index.html')
  if (hi) ok('N4 产物入口内容被内容哈希锁定（不再只靠体积上限）', `dist/index.html ${hi.size} B / ${hi.sha256.slice(0, 16)}（长度不变的内容漂移也会让 N3 报红）`)
  else bad('N4 产物入口内容被内容哈希锁定', 'A 臂产物里没有 index.html')

  const failed = !sameSource || !sameConfig || A.rosterHash !== B.rosterHash || !hi
  console.log(failed ? '判据不通过：两次构建的产物不一致（或前提对照不成立）' : '判据通过：两棵独立树的两次构建产物逐字节相同')
  cleanup()
  process.exit(failed ? 1 : 0)
} catch (e) {
  cleanup()
  undecided(`装置异常：${String(e && e.message || e)}`)
}
