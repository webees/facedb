// R20-F7：第三方许可「随分发物提供」的判据（仓库内脚本）
//
// 为什么需要：Apache-2.0 的 MediaPipe 代码被打进 `dist/static/js/m.*.js`，而它的 npm 包内
// **不带** LICENSE/NOTICE 原文（实测只有 package.json / *.mjs / wasm/），Rsbuild 也没为那个
// chunk 生成 `.LICENSE.txt` 侧车。于是「分发物里有 Apache-2.0 代码、却没有任何许可原文」是
// 真实存在的合规缺口。处置：仓库根放 `THIRD-PARTY-NOTICES.md`（Apache-2.0 全文 + MIT 全文 +
// 随镜像分发的资源清单 + 由 lock 生成运行期闭包表），构建时由 `rsbuild.config.ts` 的
// `output.copy` 复制进 `dist/`，而 dist 就是 web 容器的静态根 → 随镜像分发。
//
// 本判据守的是这条**链**，不是文件存在与否：
//   N1 文件在仓库根
//   N2 Apache-2.0 全文完整（8 个标记，缺一即「只有声明没有原文」）
//   N3 MIT 全文完整（4 个标记）
//   N4 归属声明覆盖 MediaPipe 与 Vue，且随镜像分发的 5 个资源的大小逐条写出
//   N5 「运行期闭包」块与 package-lock.json 一致（本脚本自算，不调运行根生成器）
//   N6 rsbuild.config.ts 确实把它复制进 dist（否则前面几条全绿也没意义）
//   N7 dist 里的副本与仓库根逐字节相同（**dist 不存在 → 未判定 exit 2**，绝不判通过）
//   N8 反向断言：docs/THIRD-PARTY.md 引用了该文件，且旧标题「已知缺口：MediaPipe chunk 没有
//      许可侧车」已被替换（否则文档与处置互相矛盾）
//   N9 反向断言：文件里不得残留 `<!-- APACHE-2.0-TEXT -->` 之类的占位符
//   N10（仅 --live <url> 时）线上真能读到**这份**文件 —— 必须比内容，不能比状态码：
//      本服务的 SPA 回退会让不存在的路径也返回 200 + index.html（实测：容器静态根里没有
//      THIRD-PARTY-NOTICES.md，`GET /THIRD-PARTY-NOTICES.md` 仍是 200、content-type 是
//      text/html、正文就是 index.html）→ 按状态码判「可达」在本工程是假通过。
//
// 用法：node scripts/check-third-party-notices.mjs   （需先 npm run build，因为它要验 dist）
//      STD_ROOT=<其他仓库根> node scripts/check-third-party-notices.mjs   （变异自检用）
//      node scripts/check-third-party-notices.mjs --live http://localhost:3000
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.STD_ROOT ? path.resolve(process.env.STD_ROOT) : path.resolve(HERE, '..')
const R = (rel) => path.join(ROOT, rel)
const read = (rel) => readFileSync(R(rel), 'utf8')
const has = (rel) => existsSync(R(rel))
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const argv = process.argv.slice(2)
const liveIdx = argv.indexOf('--live')
const LIVE = liveIdx >= 0 ? (argv[liveIdx + 1] || '').replace(/\/+$/, '') : null

const lines = []
let pass = 0
let fail = 0
let undecided = 0
const log = (s) => lines.push(s)
const ck = (name, ok, detail = '') => {
  if (ok) pass++
  else fail++
  log(`${ok ? '[OK]  ' : '[FAIL]'} ${name} | ${detail}`)
}
const un = (name, detail) => {
  undecided++
  log(`[??]   ${name} | ${detail}`)
}

// ---- N1
const NOTICE = 'THIRD-PARTY-NOTICES.md'
if (!has(NOTICE)) {
  log(`[FAIL] N1 ${NOTICE} 存在于仓库根 | 文件缺失，后续检查无法进行`)
  console.log(lines.join('\n'))
  console.log(`\n检查项 10：通过 0，失败 1，未判定 0\n❌ 判据未通过`)
  process.exit(1)
}
const txt = read(NOTICE)
ck('N1 第三方声明文件存在于仓库根', true, `${NOTICE} · ${txt.length} 字符 · ${txt.split('\n').length} 行`)

// ---- N2 Apache-2.0 全文（标记逐条来自标准全文，不能只靠 "Apache" 三字）
const APACHE_MARKERS = [
  'Apache License',
  'Version 2.0, January 2004',
  'http://www.apache.org/licenses/',
  'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
  '1. Definitions',
  '4. Redistribution',
  '9. Accepting Warranty or Additional Liability',
  'END OF TERMS AND CONDITIONS',
  'APPENDIX: How to apply the Apache License to your work',
]
const apacheMissing = APACHE_MARKERS.filter((m) => !txt.includes(m))
ck('N2 Apache-2.0 全文完整（9 个标记）', apacheMissing.length === 0, apacheMissing.length ? `缺 ${apacheMissing.join(' / ')}` : `${APACHE_MARKERS.length} 个标记全部命中`)

// ---- N3 MIT 全文
const MIT_MARKERS = [
  'Permission is hereby granted, free of charge',
  'The above copyright notice and this permission notice shall be included',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE',
]
const mitMissing = MIT_MARKERS.filter((m) => !txt.includes(m))
ck('N3 MIT 全文完整（4 个标记）', mitMissing.length === 0, mitMissing.length ? `缺 ${mitMissing.join(' / ')}` : `${MIT_MARKERS.length} 个标记全部命中`)

// ---- N4 归属覆盖（含随镜像分发的 5 个资源的大小）
const ATTR = [
  ['@mediapipe/tasks-vision', 'MediaPipe 包名'],
  ['FaceLandmarker', '被打进 chunk 的符号'],
  ['Apache-2.0', '许可证标识'],
  ['323377', 'public/wasm/vision_wasm_internal.js'],
  ['11756954', 'public/wasm/vision_wasm_internal.wasm'],
  ['323180', 'public/wasm/vision_wasm_nosimd_internal.js'],
  ['10960242', 'public/wasm/vision_wasm_nosimd_internal.wasm'],
  ['3758596', 'public/face_landmarker.task'],
]
const attrMissing = ATTR.filter(([k]) => !txt.includes(k)).map(([k, why]) => `${k}（${why}）`)
ck('N4 归属声明覆盖 MediaPipe 与随镜像分发的 5 个资源', attrMissing.length === 0, attrMissing.length ? `缺 ${attrMissing.join('、')}` : '包名/符号/许可证/5 个资源大小全部命中')

// ---- N5 运行期闭包块与 lock 一致（自算；规则必须与 node 的解析一致）
const BEGIN = '<!-- BEGIN GENERATED: runtime-closure -->'
const END = '<!-- END GENERATED: runtime-closure -->'
let closureOk = false
let closureDetail = ''
try {
  const lock = JSON.parse(read('package-lock.json'))
  const pkgs = lock.packages || {}
  const rootDeps = Object.keys(pkgs['']?.dependencies || {})
  if (rootDeps.length === 0) throw new Error('lock 根依赖为空（零样本）')
  const resolveKey = (fromKey, name) => {
    const parts = fromKey ? fromKey.split('/node_modules/') : []
    for (let i = parts.length; i > 0; i--) {
      const k = parts.slice(0, i).join('/node_modules/') + '/node_modules/' + name
      if (pkgs[k]) return k
    }
    const top = 'node_modules/' + name
    return pkgs[top] ? top : null
  }
  const seen = new Map()
  const queue = rootDeps.map((n) => ({ key: resolveKey('', n), name: n })).filter((x) => x.key)
  while (queue.length) {
    const { key, name } = queue.pop()
    const e = pkgs[key]
    if (!e || !e.version) continue
    const id = `${name}@${e.version}`
    if (seen.has(id)) continue
    let license = e.license
    if (!license) {
      const pj = R(`node_modules/${name}/package.json`)
      if (existsSync(pj)) {
        try {
          const j = JSON.parse(readFileSync(pj, 'utf8'))
          license = typeof j.license === 'string' ? j.license : j.license?.type
        } catch {}
      }
    }
    seen.set(id, license || '(未声明)')
    for (const dep of [...Object.keys(e.dependencies || {}), ...Object.keys(e.optionalDependencies || {})]) {
      const k = resolveKey(key, dep)
      if (k) queue.push({ key: k, name: dep })
    }
  }
  const rows = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const bi = txt.indexOf(BEGIN)
  const ei = txt.indexOf(END)
  if (bi < 0 || ei < 0) throw new Error('声明文件缺少 BEGIN/END 生成块标记')
  const block = txt.slice(bi, ei + END.length)
  // 逐行核对：每个包的「名字 | 版本 | 许可证」三元组必须都在块里出现
  const missing = rows.filter(([id, lic]) => {
    const i = id.lastIndexOf('@')
    const name = id.slice(0, i)
    const version = id.slice(i + 1)
    return !block.includes(`| \`${name}\` | ${version} | ${lic} |`)
  })
  const extra = block
    .split('\n')
    .filter((l) => l.startsWith('| `'))
    .filter((l) => !rows.some(([id, lic]) => {
      const i = id.lastIndexOf('@')
      return l === `| \`${id.slice(0, i)}\` | ${id.slice(i + 1)} | ${lic} |`
    }))
  closureOk = missing.length === 0 && extra.length === 0
  closureDetail = closureOk
    ? `${rows.length} 个包逐条一致（根依赖：${rootDeps.join('、')}）`
    : `缺 ${missing.length} 条、多 ${extra.length} 条${missing.length ? `（缺：${missing.map(([id]) => id).join('、')}）` : ''}${extra.length ? `（多：${extra.join(' ')}）` : ''}`
} catch (e) {
  closureDetail = `无法判定：${e.message}`
  closureOk = false
}
ck('N5 运行期闭包块与 package-lock.json 一致', closureOk, closureDetail)

// ---- N6 构建配置确实复制（否则 dist 里不会有它）
const RSBUILD = 'rsbuild.config.ts'
let copyOk = false
let copyDetail = ''
if (!has(RSBUILD)) {
  copyDetail = `${RSBUILD} 不存在`
} else {
  const cfg = read(RSBUILD)
  const m = cfg.match(/copy:\s*\[([\s\S]*?)\]/)
  copyOk = !!m && /from:\s*'THIRD-PARTY-NOTICES\.md'/.test(m[1]) && /to:\s*'THIRD-PARTY-NOTICES\.md'/.test(m[1])
  copyDetail = copyOk ? "output.copy 含 {from:'THIRD-PARTY-NOTICES.md', to:'THIRD-PARTY-NOTICES.md'}" : 'output.copy 里没有该文件的复制项'
}
ck('N6 rsbuild 构建配置把它复制进 dist', copyOk, copyDetail)

// ---- N7 dist 里的副本（dist 不在 → 未判定）
const DIST = 'dist/THIRD-PARTY-NOTICES.md'
if (!has(DIST)) {
  un('N7 dist 副本与仓库根逐字节相同', 'dist/THIRD-PARTY-NOTICES.md 不存在（先 npm run build）→ 未判定，不判通过')
} else {
  const a = readFileSync(R(NOTICE))
  const b = readFileSync(R(DIST))
  ck('N7 dist 副本与仓库根逐字节相同', a.equals(b), a.equals(b) ? `${b.length} 字节相同` : `根 ${a.length} B ≠ dist ${b.length} B`)
}

// ---- N8 反向断言：文档引用了它，且旧标题已被替换
const DOC = 'docs/THIRD-PARTY.md'
let docOk = false
let docDetail = ''
if (!has(DOC)) {
  docDetail = `${DOC} 不存在`
} else {
  const doc = read(DOC)
  const cites = doc.includes('THIRD-PARTY-NOTICES.md')
  const stale = doc.includes('已知缺口：MediaPipe chunk 没有许可侧车')
  docOk = cites && !stale
  docDetail = docOk
    ? '引用该文件，且旧「已知缺口」标题已移除'
    : `${cites ? '' : '未引用该文件；'}${stale ? '仍保留旧「已知缺口」标题' : ''}`
}
ck('N8 反向断言：docs/THIRD-PARTY.md 已引用且不再声称未解决', docOk, docDetail)

// ---- N9 反向断言：不得残留占位符
const PLACEHOLDERS = ['<!-- APACHE-2.0-TEXT -->', '<!-- VUE-MIT-TEXT -->']
const left = PLACEHOLDERS.filter((p) => txt.includes(p))
ck('N9 反向断言：无未替换的许可证占位符', left.length === 0, left.length ? `残留 ${left.join('、')}` : `${PLACEHOLDERS.length} 个占位符均不存在`)

// ---- N10 线上可达（可选）：比内容，不比状态码
if (LIVE) {
  const url = `${LIVE}/THIRD-PARTY-NOTICES.md`
  try {
    const res = await fetch(url, { redirect: 'follow' })
    const ct = res.headers.get('content-type') || ''
    const buf = Buffer.from(await res.arrayBuffer())
    const local = readFileSync(R(NOTICE))
    const same = sha256(buf) === sha256(local)
    // SPA 回退的识别：content-type 是 html，或正文与本地 index.html 相同
    const isSpaFallback = ct.includes('text/html') || (has('dist/index.html') && sha256(buf) === sha256(readFileSync(R('dist/index.html'))))
    ck(
      'N10（--live）线上该路径返回的正是这份文件（比 sha256，不比状态码）',
      res.ok && same,
      `HTTP ${res.status} · content-type=${ct || '(无)'} · 正文 ${buf.length} B · sha256 ${sha256(buf).slice(0, 16)}… vs 本地 ${sha256(local).slice(0, 16)}…` +
        (isSpaFallback ? ' ← 这是 SPA 回退（返回的是 index.html），不是声明文件；镜像需重建' : ''),
    )
  } catch (e) {
    ck('N10（--live）线上该路径返回的正是这份文件（比 sha256，不比状态码）', false, `请求失败：${e.message}`)
  }
}

// ---- 汇总
console.log(lines.join('\n'))
console.log(`\n检查项 ${pass + fail + undecided}：通过 ${pass}，失败 ${fail}，未判定 ${undecided}`)
if (fail > 0) {
  console.log('❌ 判据未通过')
  process.exit(1)
}
if (undecided > 0) {
  console.log('⚠️  存在未判定项（按纪律不判通过）')
  process.exit(2)
}
console.log('✅ 全部通过')
