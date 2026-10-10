// R36：可复现性判据自己的自检电池 —— 证明 scripts/verify-build-reproducible.mjs 真的有判别力。
//
// 为什么需要它：S41/S42 只能看到「判据在场且被接线」（结构面）。若判据本身退化成恒真命题
// （比如两臂都跑同一个目录、或不再逐字节比对），结构断言照样全绿。这里用**成对臂**证明：
//   臂1 干净            ⇒ 0（同一源码两次独立构建逐字节相同）
//   臂2 篡改 A 臂产物一个字节（长度不变）⇒ 1（内容漂移必须被抓到，且比对必须按内容而不是按长度）
//   臂3 B 臂用绝对 --root ⇒ 1（R36-LEAD-07：绝对检出路径会改产物，判据必须看得见）
//   臂4 合成树缺 node_modules ⇒ 2（前提不成立必须与「通过」可区分）
// 退出码：0 = 四臂全部符合预期；1 = 有臂不符；2 = 前提不成立/零样本（本机没有 node_modules 时）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.REPRO_SELFTEST_ROOT || dirname(HERE)
const JUDGE = join(HERE, 'verify-build-reproducible.mjs')
const EXPECTED_SCENES = 4

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

// 臂4 的装置：一棵只有 package.json/index.html、没有 node_modules 的合成树
const bare = mkdtempSync(join(tmpdir(), 'facedb-repro-bare-'))
made.push(bare)
writeFileSync(join(bare, 'package.json'), '{"name":"bare","private":true}\n')
writeFileSync(join(bare, 'index.html'), '<html></html>\n')

const run = (name, env, expect, why) => {
  const started = Date.now()
  const r = spawnSync(process.execPath, [JUDGE], { cwd: ROOT, encoding: 'utf8', timeout: 400000, env: { ...process.env, ...env } })
  const code = r.status
  const ok = code === expect
  const tail = String(r.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] || String(r.stderr || '').trim().split('\n').slice(-1)[0] || ''
  log(`${ok ? '✅' : '❌'} ${name} | exit=${code}（期望 ${expect}）${ok ? '' : ` ← ${tail}`} | ${Date.now() - started}ms`)
  if (!ok) log(`   原因要求：${why}`)
  return { name, code, expect, ok, tail }
}

info('[INFO] ' + '可复现性判据自检：4 臂成对对照（干净 / 内容漂移 / 绝对检出路径 / 前提缺失）')
const results = [
  run('臂1 干净两臂', {}, 0, '同一源码两次独立构建必须逐字节相同'),
  run('臂2 篡改 A 臂产物一个字节（长度不变）', { REPRO_TAMPER: 'A' }, 1, '长度不变的内容漂移也必须被抓到'),
  run('臂3 B 臂用绝对 --root', { REPRO_ARM_B: 'absolute' }, 1, '绝对检出路径会改产物（R36-LEAD-07）'),
  run('臂4 合成树缺 node_modules', { REPRO_ROOT: bare }, 2, '前提不成立必须 exit 2'),
]

if (results.length !== EXPECTED_SCENES) {
  log(`⛔ 未判定（exit 2）：场景声明 ${EXPECTED_SCENES} 个，实际 ${results.length} 个`)
  process.exit(2)
}
const pass = results.filter((r) => r.ok).length
const undetermined = results.filter((r) => r.code === null || r.code === 2).length
log('')
if (pass === results.length) {
  log(`判据自检通过：${results.length} 臂全部符合预期（干净 0 · 内容漂移 1 · 绝对路径 1 · 前提缺失 2）`)
  process.exit(0)
}
if (undetermined > 0 && pass + undetermined === results.length) {
  log(`⛔ 未判定（exit 2）：${undetermined} 臂未能给出读数（装置异常，非缺陷判定）`)
  process.exit(2)
}
log(`判据自检不通过：${results.length} 臂中 ${pass} 臂符合预期`)
process.exit(1)
