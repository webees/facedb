// R36：可复现性判据自己的自检电池 —— 证明 scripts/verify-build-reproducible.mjs 真的有判别力。
//
// 为什么需要它：S41/S42 只能看到「判据在场且被接线」（结构面）。若判据本身退化成恒真命题
// （比如两臂都跑同一个目录、或不再逐字节比对），结构断言照样全绿。这里用**成对臂**证明：
//   臂1 干净                  ⇒ 0（同一源码两次独立构建逐字节相同）
//   臂2 篡改 A 臂产物一个字节（长度不变）⇒ 1（内容漂移必须被抓到，且比对必须按内容而不是按长度）
//   臂3 B 臂用绝对 --root      ⇒ 1（R36-LEAD-07：绝对检出路径会改产物，判据必须看得见）
//   臂4 合成树缺 node_modules  ⇒ 2（前提缺失必须与「通过」可区分，且必须点名缺的是 node_modules）
//   臂5 合成树 node_modules 是软链 ⇒ 2（R23-25：软链会改 chunk 名 ⇒ 判据必须拒绝在这类树上给结论）
//   臂6 合成树缺 src/          ⇒ 2（与臂4 分开：两处前提各有各的臂，标签必须与真实分支一致 —— R36REV-RL-03）
// 退出码：0 = 六臂全部符合预期；1 = 有臂不符；2 = 前提不成立/零样本（本机没有 node_modules 时）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.REPRO_SELFTEST_ROOT || dirname(HERE)
const JUDGE = join(HERE, 'verify-build-reproducible.mjs')
const EXPECTED_SCENES = 6

const info = (s) => console.log(s)
const log = (s) => console.log(s)

if (!existsSync(JUDGE)) {
  log(`⛔ 未判定（exit 2）：找不到判据 ${JUDGE}`)
  process.exit(2)
}
if (!existsSync(join(ROOT, 'node_modules'))) {
  log(`⛔ 未判定（exit 2）：${ROOT} 里没有 node_modules（先 npm ci）—— 零样本不判通过`)
  process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'facedb-repro-selftest-'))
const made = []
const cleanup = () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} } try { rmSync(tmp, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)

// 合成树 1（臂4）：有 package.json / index.html / src/，但没有 node_modules
const bareNoNm = join(tmp, 'bare-no-node-modules')
made.push(bareNoNm)
mkdirSync(join(bareNoNm, 'src'), { recursive: true })
writeFileSync(join(bareNoNm, 'package.json'), '{"name":"bare-no-node-modules","private":true}\n')
writeFileSync(join(bareNoNm, 'index.html'), '<html></html>\n')
writeFileSync(join(bareNoNm, 'src', 'main.ts'), 'export const x = 1\n')

// 合成树 2（臂5）：前置齐备，但 node_modules 是指向真实依赖树的**软链**
const bareSymlink = join(tmp, 'bare-symlink-node-modules')
made.push(bareSymlink)
mkdirSync(join(bareSymlink, 'src'), { recursive: true })
writeFileSync(join(bareSymlink, 'package.json'), '{"name":"bare-symlink","private":true}\n')
writeFileSync(join(bareSymlink, 'index.html'), '<html></html>\n')
writeFileSync(join(bareSymlink, 'src', 'main.ts'), 'export const x = 1\n')
symlinkSync(join(ROOT, 'node_modules'), join(bareSymlink, 'node_modules'), 'dir')

// 合成树 3（臂6）：有 package.json / index.html / node_modules（软链即可，前提判定按顺序应先撞 src），但没有 src/
const bareNoSrc = join(tmp, 'bare-no-src')
made.push(bareNoSrc)
mkdirSync(bareNoSrc, { recursive: true })
writeFileSync(join(bareNoSrc, 'package.json'), '{"name":"bare-no-src","private":true}\n')
writeFileSync(join(bareNoSrc, 'index.html'), '<html></html>\n')
symlinkSync(join(ROOT, 'node_modules'), join(bareNoSrc, 'node_modules'), 'dir')

const run = (name, env, expect, why, expectTail) => {
  const started = Date.now()
  const r = spawnSync(process.execPath, [JUDGE], { cwd: ROOT, encoding: 'utf8', timeout: 400000, env: { ...process.env, ...env } })
  const code = r.status
  const tail = String(r.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] || String(r.stderr || '').trim().split('\n').slice(-1)[0] || ''
  // exit 码对了还不够：前提缺失臂必须点名**缺的那一个**前提，否则「标签写的分支」与「真实走的分支」可以不一致（R36REV-RL-03）
  const tailOk = !expectTail || tail.includes(expectTail)
  const ok = code === expect && tailOk
  log(`${ok ? '✅' : '❌'} ${name} | exit=${code}（期望 ${expect}）${tailOk ? '' : ` ← 末行未包含「${expectTail}」`}${ok ? '' : ` | 末行：${tail}`} | ${Date.now() - started}ms`)
  if (!ok) log(`   原因要求：${why}`)
  return { name, code, expect, ok, tail }
}

info('[INFO] ' + '可复现性判据自检：6 臂成对对照（干净 / 内容漂移 / 绝对检出路径 / 缺 node_modules / 软链 node_modules / 缺 src）')
const results = [
  run('臂1 干净两臂', {}, 0, '同一源码两次独立构建必须逐字节相同'),
  run('臂2 篡改 A 臂产物一个字节（长度不变）', { REPRO_TAMPER: 'A' }, 1, '长度不变的内容漂移也必须被抓到'),
  run('臂3 B 臂用绝对 --root', { REPRO_ARM_B: 'absolute' }, 1, '绝对检出路径会改产物（R36-LEAD-07）'),
  run('臂4 合成树缺 node_modules', { REPRO_ROOT: bareNoNm }, 2, '前提不成立必须 exit 2', '没有 node_modules'),
  run('臂5 合成树 node_modules 是软链', { REPRO_ROOT: bareSymlink }, 2, '软链树没有判别力，必须拒绝给结论', '软链'),
  run('臂6 合成树缺 src/', { REPRO_ROOT: bareNoSrc }, 2, '前提不成立必须 exit 2', '没有 src'),
]

if (results.length !== EXPECTED_SCENES) {
  log(`⛔ 未判定（exit 2）：场景声明 ${EXPECTED_SCENES} 个，实际 ${results.length} 个`)
  process.exit(2)
}
const pass = results.filter((r) => r.ok).length
const undetermined = results.filter((r) => r.code === null || r.code === 2).length
log('')
if (pass === results.length) {
  log(`判据自检通过：${results.length} 臂全部符合预期（干净 0 · 内容漂移 1 · 绝对路径 1 · 缺 node_modules 2 · 软链 node_modules 2 · 缺 src 2）`)
  process.exit(0)
}
if (undetermined > 0 && pass + undetermined === results.length) {
  log(`⛔ 未判定（exit 2）：${undetermined} 臂未能给出读数（装置异常，非缺陷判定）`)
  process.exit(2)
}
log(`判据自检不通过：${results.length} 臂中 ${pass} 臂符合预期`)
process.exit(1)
