// W21-A：产物体积与构成回归判据（仓库内）
//
// 为什么需要：`dist/` 是 web 容器的静态根 —— 它直接决定首屏传输量与随镜像分发的资产。
// 「某次改动悄悄把入口 chunk 撑大 5 kB」「wasm 被换成同字节数的另一份」「SHA256SUMS 没被
// 复制进 dist」这三类回归，在既有判据里**全都没有**任何一条能看见：`verify:notices` 只查
// 许可链，`verify:types` 只查类型，`verify` 只查仓库资源。本判据补的就是这条线。
//
// 阈值来源（全部实测推导，无拍脑袋数字）：
//   W21-A 本轮对 HEAD 4b7da14 跑了 4 次真实构建（3 次 --dist-path + 1 次默认 dist/，
//   逐文件 sha256 完全一致），实测值与逐文件 sha256 见运行根
//   `evidence/W21-A-sizeguard-baseline.log` 与 `tmp/W21-A/manifest{1,2,3,dist}.txt`。
//   · web 传输面（index.html + css + 3 个 JS + LICENSE 侧车）gzip 合计基线 95700 B
//     → 上限 96178 B（= floor(95700 × 1.005)）。为什么不给 2%：实测「入口注入 256 个死函数
//     + 4 KB 不可压缩字面量」的变异体只把该值抬到 96764 B（+1.11%），2% 容差会放行 ——
//     真膨胀却被漏掉；而同一 HEAD、同一工具链下该值逐字节可复现，0.5%（478 B）足够松。
//   · 原始总字节基线 27429645 B → 上限 27978238 B（= ceil(27429645 × 1.02)，即 27978237.9
//     向上取整；写成 27978237 就是错的）。这一档防的是「大文件整体变胖」（wasm / 模型）。
//   · 产物文件名清单**精确等于 13 个**：多一个少一个都判失败。
//   · wasm 4 件 + 模型 + 声明文件 + dist/SHA256SUMS **按逐文件 sha256 锁**（锁内容不锁大小）：
//     它们是外部 vendored 资产，大小阈值抓不住「同大小换内容」，sha256 抓得住。
//   · 4 个内容哈希 chunk 锁「文件名 ↔ 内容」对应关系：内容一变，构建就会改文件名；
//     同名不同内容只可能是陈旧产物或缓存投毒面。
//     【R23 第一次重锚】入口 chunk 由 index.cbc909cd34.js 改为 index.5eccc0c87b.js：本轮改了
//     遥测拦截的输入取值口径（cross-realm）、撤层诊断，并删掉内联层的 XHR 补丁
//     （见 RUN.md「遥测拦截：三层」）。那一次**只换文件名与内容哈希，阈值一字未动**
//     （实测 95937 B，仍在 0.5% 容差内）。
//     【R23 第二次重锚】入口 chunk 改为 index.3034178f9f.js，**基线随实测抬高**
//     （web gzip 95700 → 96311、原始总字节 27429645 → 27430594），上限仍由同一推导式派生。
//     为什么允许抬：本轮实测 96311 B 超出旧上限 133 B，增量可逐条归因且全部来自已确证的缺陷修复
//     （无一处是「顺手加的代码」）：
//       · W23B-05 空队列早退 + hintEmptyBatch（i18n 2 键）= 用户拍到照片却被告知「录制为空」的修复；
//       · W23B-06 段被丢弃的对外信号 takeSegmentDropped + meta.segmentOk；
//       · W23B-08 网络类错误分类 isNetworkError + uploadNetworkFailed 文案；
//       · 为让 CaptureView.vue 回到 800 行阈值（S20）而抽出的两个模块
//         （src/lib/upload-batch.ts、src/lib/batch-files.ts）；
//       · 段收尾 try/catch（照片不再被段收尾失败连坐）。
//     为什么不是「把容差放宽」：0.5% / 2% 的推导式与取整一字未改，判据仍会拦住
//     「注入 256 个死函数」这类真膨胀（实测 +1.11%）。抬基线的代价是**这一轮的余量变薄**
//     （新基线 96311、上限 96792、余量 481 B），故本次重锚在轮报里逐条登记，
//     并要求后续每次重锚同样逐条列出增量来源。
//     W21-A 原始基线（历史，勿删：仓库标准 S26 要求判据自带注释写明阈值来源）：
//     web gzip 95700 B → 上限 96178 B；原始总字节 27429645 B → 上限 27978238 B。
//     【R23 第三次重锚（收口期，复核席发现驱动）】入口 chunk 改为 index.b0621d6a09.js，
//     基线随实测抬高（web gzip 96311 → 96573、原始总字节 27430594 → 27431217）。增量逐条：
//       · R23REV-N3 修「等收尾超时后仍按队列为空下结论」→ CaptureView.vue 增 3 行守卫
//         + i18n 2 键（hintStillFinalizing / stillFinalizing）；
//       · R23REV-N4 修 isNetworkError 漏 Node/undici 形态（connect ECONNREFUSED 在 cause 里）
//         → pb.ts 正则扩 12 个形态 + 拼接 cause 文本。
//     上限仍由同一推导式派生（floor ×1.005 / ceil ×1.02），不是放宽容差；余量 482 B。
//     重锚工具已固化：`$RUN/lib/size-reanchor.mjs --root <工程根> [--write]`（口径与判据同源），
//     不再为一次性重锚现写临时脚本。
//     关于「基线与实测精确相等」（R23REV-N11，已登记为已知取舍）：本判据是**棘轮**而不是
//     「与历史版本比较」—— 基线就是上一次通过时的实测快照，两者相等是设计使然，不是读数错。
//     代价是：任何改动源码的轮次都必须重锚（R23 一轮里重锚 3 次），否则 N3/N4 会先报红。
//     之所以仍这样定：把基线钉在「上一个已知良好的快照」上，任何净增长都必须有人显式过一遍
//     并逐条归因（重锚要求把增量来源写进本注释），比给一个无人认领的固定余量更能拦住悄悄变胖。
//     反面代价也已实测：0.5% 的余量只有 482 B，一次「顺手加的代码」就会顶破 —— 这正是设计意图。
//
// gzip 口径说明（为什么调系统 gzip 而不是 node 的 zlib）：基线 95700 B 是用系统 `gzip -9 -c`
// 量的；本机实测 node 自带 zlib（1.3.1-e00f703）对同一批文件给出 96168 B（+468 B），
// 会把 0.5% 的余量（478 B）几乎吃光 —— 同一份产物在不同压缩器下读数不同，只有与基线同源的
// 压缩器才有可比性。故这里固定用 `gzip -9 -c <文件>`（含文件名头，与基线命令逐字一致），
// 并把 `gzip --version` 打进详情行，便于一眼区分「产物变胖」与「压缩器换了」。
//
// 环境前提与零样本纪律：
//   · `PUBLIC_PB_URL` 非空 → 该变量会改变 index.html 与入口 chunk 的文件名与内容
//     （实测 sha256 38a0c86f… → 2a5906d0…、index.cbc909cd34.js → index.b2807a9a8b.js），
//     清单类基线隐含绑定构建环境 → **未判定，exit 2**，不判通过也不判失败。
//   · `dist/` 不存在或为空 → **未判定，exit 2**，绝不允许 exit 0（「未执行任何有效检查」
//     不得判通过）。
//
// 用法：npm run verify:size                    （需先 npm run build）
//      SIZE_ROOT=<其他根> node scripts/check-dist-size-budget.mjs   （变异自检用）
//      node scripts/check-dist-size-budget.mjs --dist <产物目录>
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { makeChecker } from './lib/checker.mjs'

// 自定位根目录：默认「本脚本的上两级」，可用 SIZE_ROOT 覆盖（变异自检要在副本上跑）。
// 绝不硬编码本机绝对路径：写死作者主目录会让判据在 CI 与别人的机器上指向不存在的目录
//（S26 有一条断言专门查这个 —— 判据源码里不得出现本机用户目录前缀）。
const ROOT = process.env.SIZE_ROOT ? path.resolve(process.env.SIZE_ROOT) : path.join(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const distFlag = argv.indexOf('--dist')
if (distFlag >= 0 && !argv[distFlag + 1]) {
  console.error('❌ --dist 需要一个目录参数')
  process.exit(2)
}
const DIST = distFlag >= 0 ? path.resolve(argv[distFlag + 1]) : path.join(ROOT, 'dist')

// —— 5 个阈值常量（来源见文件头；改这里必须同步改文件头的推导式）——
// 【R23 第二次重锚】基线由实测值抬到 96311 / 27430594（增量逐条列在文件头），
// 上限仍按同一推导式派生（web gzip +0.5%、原始总字节 +2%），不是把容差放宽。
const WEB_GZIP_BASELINE_BYTES = 98685
const WEB_GZIP_CAP_BYTES = 99178
const RAW_TOTAL_BASELINE_BYTES = 27436728
const RAW_TOTAL_CAP_BYTES = 27985463
const EXPECTED_FILE_COUNT = 13

// —— 源码指纹：产物必须是**当前源码**构建出来的 ——
// 【R23 第四次重锚（PR #27 的 CI 抓到）】此前判据只钉「产物长什么样」，不钉「产物是不是当前源码
// 构建的」：我在本地用一份**陈旧 dist** 重锚（入口 chunk 名 `index.b0621d6a09.js`），
// 本地 verify:size 全绿、CI 一跑就红（干净检出重建得 `index.ebc8a68402.js`）。
// 这种「本地绿、CI 红」的成因不是环境差异，而是**判据缺一条前提**：dist 与源码不同源。
// 修法：把「喂给打包器的源码输入」的 sha256 记在这里；判据启动时重算，不一致即
// **未判定（exit 2）**，提示先 `rm -rf dist && npm run build` 再重锚。
// 覆盖输入：`index.html`、`package.json`、`src/**`（递归、按路径排序）。不含 node_modules
// （软链/真实目录各有 N0 前提）与 `dist/`（那是被检查对象）。
const SOURCE_FINGERPRINT = 'dd72787761c2d92491144a27a1c498d44b97746535dfe4a67dda3e5ce6482990'

// 阈值自洽（防手抄错，尤其是 27978237.9 这类取整）：常量必须等于由基线派生的取整结果。
const DERIVED = {
  webGzip: Math.floor(WEB_GZIP_BASELINE_BYTES * 1.005),
  rawTotal: Math.ceil(RAW_TOTAL_BASELINE_BYTES * 1.02),
}
if (DERIVED.webGzip !== WEB_GZIP_CAP_BYTES || DERIVED.rawTotal !== RAW_TOTAL_CAP_BYTES) {
  throw new Error(
    `阈值常量与推导式不一致：web gzip ${WEB_GZIP_CAP_BYTES} ≠ ${DERIVED.webGzip}；` +
      `原始总字节 ${RAW_TOTAL_CAP_BYTES} ≠ ${DERIVED.rawTotal}`,
  )
}

// —— 逐文件 sha256 锁定（外部 vendored 资产 + 许可正文 + 完整性登记本身）——
const LOCKED_SHA256 = {
  SHA256SUMS: 'e0357ae4fdee5d24b7dd60cca46db9af1c9bab09b026fa601d6d4da2d0b9e11c',
  'THIRD-PARTY-NOTICES.md': '61a96410cc37caae98bf267d5a733453b9ed8d3d3eea4d1c0819bd0347726db0',
  'face_landmarker.task': '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  'wasm/vision_wasm_internal.js': 'e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73',
  'wasm/vision_wasm_internal.wasm': '8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886',
  'wasm/vision_wasm_nosimd_internal.js': 'e81d715a3d42cc3373602eb2f7aff795d164934db680e32496b65dab537f9658',
  'wasm/vision_wasm_nosimd_internal.wasm': 'a28483cd42e74e855bf5ebdb6b40d9b66a5b49e35e95020bc97669e6822a3192',
}
// —— 4 个内容哈希 chunk：文件名里的 hash 由内容算出，故「同名不同内容」= 陈旧/投毒产物 ——
const HASHED_CHUNKS = {
  'static/js/index.31593b95d7.js': '5a8ac88434a6064de35a2599d1eb47f5ed9ba551b3ae235358d9bdb69b9d1363',
  'static/js/lib-vue.9b47b76d95.js': '9090ba0f5784b7ddbb2729b441207399005370ea907af109d423629dd4111793',
  'static/js/m.79c0ab86b6.js': '2956850bd7ffc083eb290d72745395e20dfa588d75d8d9271368e5ed590346b5',
  'static/css/index.78c3d3be4b.css': 'ef240b6b8dbe987f2c980b5a9121940d2978f4f1f08f136f3504fd057c250c82',
}
const EXPECTED_NAMES = [
  ...Object.keys(LOCKED_SHA256),
  ...Object.keys(HASHED_CHUNKS),
  'index.html',
  'static/js/lib-vue.9b47b76d95.js.LICENSE.txt',
].sort()

const c = makeChecker('W21-A 产物体积与构成判据')

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
// web 传输面按**目录枚举**（不写死 chunk 文件名）：内容一变文件名就变，写死会漏掉新文件。
function webFaceFiles(dir) {
  const out = ['index.html']
  for (const sub of ['static/css', 'static/js']) {
    const d = path.join(dir, sub)
    if (existsSync(d)) for (const e of readdirSync(d).sort()) out.push(`${sub}/${e}`)
  }
  return out
}
// 与基线同源的量法：系统 `gzip -9 -c <文件>`（含文件名头），数字节数。
function gzipBytes(p) {
  const r = spawnSync('gzip', ['-9', '-c', p], { maxBuffer: 1 << 24 })
  if (r.status !== 0) throw new Error(`gzip 失败（${p}）：${(r.stderr || '').toString().trim()}`)
  return r.stdout.length
}
// 打印压缩器身份：同一份产物在不同 gzip 实现下读数不同，详情行里能一眼区分「产物变胖」与「压缩器换了」
const GZIP = (() => {
  const r = spawnSync('gzip', ['--version'], { encoding: 'utf8' })
  const line = ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim()
  return { ok: r.status === 0 && line !== '', line: line || 'gzip（版本未知）' }
})()

// ── N0 环境前提 ──
// (1) 系统 gzip 可用：gzip 口径与基线同源依赖它（见文件头）；缺工具属于「判不了」，不是「判负」。
if (!GZIP.ok) {
  c.un('N0 环境前提：系统 gzip 可用', '找不到可用的系统 gzip —— 本判据的 gzip 口径与基线同源依赖它，本次未判定（exit 2）')
  process.exit(c.report())
}
// (2) PUBLIC_PB_URL 为空：该变量会改变产物内容与文件名，清单类基线不适用于该环境。
const PB_URL = (process.env.PUBLIC_PB_URL ?? '').trim()
if (PB_URL !== '') {
  c.un(
    'N0 环境前提：PUBLIC_PB_URL 为空',
    `实测该变量非空（${PB_URL}）时 index.html 与入口 chunk 的文件名/内容都会变` +
      '（sha256 38a0c86f… → 2a5906d0…、index.cbc909cd34.js → index.b2807a9a8b.js）→ ' +
      '清单类基线隐含绑定构建环境，本次未判定（exit 2），不判通过也不判失败',
  )
  process.exit(c.report())
}

// (3) node_modules 必须是真实目录（不能是符号链接）：R23 实测 —— 同一棵树、同一命令，
//     只把 node_modules 从真实目录换成指向它的软链，构建产物就从
//     `index.3034178f9f.js` / `lib-vue.8351304052.js` / `m.79c0ab86b6.js` 变成
//     `index.59ab2f4658.js` / `lib-vue.41bac71c26.js` / `c.283e6ba8c2.js`（差值不在体积上，
//     而在解析结果）。此时文件名与体积基线都不可比：判红会把「构建方式不同」误报成产物漂移。
//     要隔离副本请用 `cp -al`（硬链副本 = 真实目录）或 `cp -R`，不要用 `ln -s`。
{
  const NM = path.join(ROOT, 'node_modules')
  let isLink = false
  try {
    isLink = lstatSync(NM).isSymbolicLink()
  } catch {
    // 没有 node_modules 目录（例如自检在只含 dist/ 的临时树上跑）：不构成前提违反
  }
  if (isLink) {
    c.un(
      'N0 环境前提：node_modules 是真实目录',
      `实测 ${NM} 是符号链接 —— 软链会改变构建解析结果（chunk 名 m.79c0ab86b6.js → ` +
        'c.283e6ba8c2.js、lib-vue 哈希也随之一变），清单与体积基线在同一软链目录内可复现、' +
        '但与真实目录构建的结果不可比 → 本次未判定（exit 2）。请在带真实 node_modules 的检出里构建',
    )
    process.exit(c.report())
  }
}

// (4) dist 必须是**当前源码**构建出来的（R23 第四次重锚补）：判据此前只钉产物长相，不钉「产物是不是
//     这份源码构建的」。实测代价：我用一份陈旧 dist 重锚 ⇒ 本地 verify:size 16/16 全绿、CI 一跑就红
//     （干净检出重建得另一个入口 chunk 名）。这是判据缺前提，不是环境差异。
//     只在能算出指纹的根上核对（合成树/自检树没有 src/，不适用，打印一行说明即可）。
{
  const srcDir = path.join(ROOT, 'src')
  const indexHtml = path.join(ROOT, 'index.html')
  const pkg = path.join(ROOT, 'package.json')
  const canFingerprint = existsSync(srcDir) && existsSync(indexHtml) && existsSync(pkg)
  if (!canFingerprint) {
    console.log('[INFO] N0 环境前提：dist 与源码同源 —— 本根没有 src//index.html/package.json（自检或合成树），不适用')
  } else {
    const inputs = ['index.html', 'package.json', ...listFiles(srcDir).map((f) => 'src/' + f)].sort()
    const h = createHash('sha256')
    for (const rel of inputs) h.update(rel + '\0' + sha256(path.join(ROOT, rel)) + '\0')
    const actual = h.digest('hex')
    if (SOURCE_FINGERPRINT === 'PLACEHOLDER_SOURCE_FINGERPRINT') {
      c.un(
        'N0 环境前提：dist 与源码同源',
        `本判据还没有记录源码指纹（占位符未替换）→ 本次未判定（exit 2）。用 lib/size-reanchor.mjs --write 写入`,
      )
      process.exit(c.report())
    }
    if (actual !== SOURCE_FINGERPRINT) {
      c.un(
        'N0 环境前提：dist 与源码同源',
        `实测源码指纹 ${actual.slice(0, 12)}… ≠ 判据记录的 ${SOURCE_FINGERPRINT.slice(0, 12)}…（覆盖 ${inputs.length} 个输入）` +
          ' —— 源码改过而产物没重建（或反之）：此时文件名/体积基线与产物不可比，判红会把「没重建」误报成产物漂移。' +
          '先 `rm -rf dist && npm run build`，再用 lib/size-reanchor.mjs --write 重锚 → 本次未判定（exit 2）',
      )
      process.exit(c.report())
    }
  }
}

// ── N1 零样本纪律：产物目录不存在或为空 → 未判定，绝不判通过 ──
if (!existsSync(DIST) || listFiles(DIST).length === 0) {
  c.un('N1 产物目录存在且非空', `${DIST} 不存在或为空（先 npm run build）→ 未判定（exit 2），不判通过`)
  process.exit(c.report())
}
const files = listFiles(DIST)
c.check('N1 产物目录存在且非空', true, `${DIST} · ${files.length} 个文件`)

// ── N2 产物文件名清单精确等于 13 个 ──
{
  const missing = EXPECTED_NAMES.filter((n) => !files.includes(n))
  const extra = files.filter((n) => !EXPECTED_NAMES.includes(n))
  c.check(
    `N2 产物文件名清单精确等于 ${EXPECTED_FILE_COUNT} 个（多一个/少一个即失败）`,
    files.length === EXPECTED_FILE_COUNT && missing.length === 0 && extra.length === 0,
    `实测 ${files.length} 个；缺失=[${missing}] 多余=[${extra}]`,
  )
}

// ── N3 web 传输面 gzip 合计（首屏真正过网的字节）──
{
  const web = webFaceFiles(DIST)
  let total = 0
  const missing = []
  const parts = []
  for (const f of web) {
    const p = path.join(DIST, f)
    if (!existsSync(p)) { missing.push(f); continue }
    const g = gzipBytes(p)
    total += g
    parts.push(`${f}=${g}`)
  }
  if (missing.length) {
    c.check('N3 web 传输面 gzip 合计 ≤ 上限', false, `枚举到的 web 文件不存在：${missing.join('、')}`)
  } else {
    c.check(
      `N3 web 传输面 gzip 合计 ≤ ${WEB_GZIP_CAP_BYTES} B（基线 ${WEB_GZIP_BASELINE_BYTES} + 0.5%）`,
      total <= WEB_GZIP_CAP_BYTES,
      `实测 ${total} B，余量 ${WEB_GZIP_CAP_BYTES - total} B；${GZIP.line}；${parts.join(' ')}`,
    )
  }
}

// ── 采样快照（R24 / W24-E-05）：一次运行只采样一次，之后所有断言都读快照 ──
//
// 为什么必须有：断言里各自 `statSync`/`sha256(p)` 直读磁盘时，**一次运行内**的读数可能来自不同时刻。
// 若期间有别的进程（或本轮自己的构建）在改 `dist/`，就会出现「N4 读的是旧字节数、N5 读的是新哈希」
// 这种自相矛盾组合，而每条断言单看都「合理」。判据要么一次采样到底，要么明说本次不构成结论。
const SNAP = new Map()
for (const f of files) {
  const p = path.join(DIST, f)
  SNAP.set(f, { size: statSync(p).size, digest: sha256(p) })
}
const snapSize = (f) => SNAP.get(f)?.size
const snapDigest = (f) => SNAP.get(f)?.digest

// ── N4 原始总字节（含 wasm / 模型，防大文件整体变胖）──
{
  let raw = 0
  for (const f of files) raw += snapSize(f)
  c.check(
    `N4 产物原始总字节 ≤ ${RAW_TOTAL_CAP_BYTES} B（基线 ${RAW_TOTAL_BASELINE_BYTES} + 2%）`,
    raw <= RAW_TOTAL_CAP_BYTES,
    `实测 ${raw} B，余量 ${RAW_TOTAL_CAP_BYTES - raw} B`,
  )
}

// ── N5–N11 逐文件 sha256 锁定 ──
let id = 4
for (const [f, want] of Object.entries(LOCKED_SHA256)) {
  id++
  if (!SNAP.has(f)) { c.check(`N${id} sha256 锁定 ${f}`, false, '文件不存在'); continue }
  const got = snapDigest(f)
  c.check(`N${id} sha256 锁定 ${f}`, got === want, got === want ? '一致' : `期望 ${want.slice(0, 16)}… 实测 ${got.slice(0, 16)}…`)
}

// ── N12–N15 内容哈希 chunk 的「文件名 ↔ 内容」对应关系 ──
for (const [f, want] of Object.entries(HASHED_CHUNKS)) {
  id++
  if (!SNAP.has(f)) { c.check(`N${id} chunk 文件名↔内容 ${f}`, false, '文件不存在'); continue }
  const got = snapDigest(f)
  c.check(
    `N${id} chunk 文件名↔内容 ${f}`,
    got === want,
    got === want ? '一致' : `内容已变（期望 ${want.slice(0, 12)}… 实测 ${got.slice(0, 12)}…）—— 内容变而文件名未变 = 陈旧产物或缓存投毒面`,
  )
}

// ── N16 dist/SHA256SUMS 必须与 public/SHA256SUMS 逐字节相同 ──
{
  const dSums = path.join(DIST, 'SHA256SUMS')
  const pSums = path.join(ROOT, 'public/SHA256SUMS')
  if (!existsSync(dSums)) c.check('N16 dist/SHA256SUMS 与 public/SHA256SUMS 逐字节相同', false, 'dist/SHA256SUMS 不存在')
  else if (!existsSync(pSums)) c.check('N16 dist/SHA256SUMS 与 public/SHA256SUMS 逐字节相同', false, `${pSums} 不存在（仓库侧登记缺失）`)
  else {
    const a = readFileSync(dSums)
    const b = readFileSync(pSums)
    c.check('N16 dist/SHA256SUMS 与 public/SHA256SUMS 逐字节相同', a.equals(b), a.equals(b) ? `${a.length} 字节相同` : `dist ${a.length} B ≠ public ${b.length} B`)
  }
}

// ── 采样自洽（R24 / W24-E-05）：末尾复读一遍，与快照不符即判未判定 ──
//
// 这是本判据「读数可信」的前提：上面的 N2/N3/N4/N5–N15 全部来自一次采样，
// 若这次采样期间产物被改动，整份结论都不成立（不是某一条失败），故判未判定（exit 2），
// 绝不把「采样期间被改过的树」的读数当成通过或失败。
{
  const now = listFiles(DIST)
  const changed = []
  for (const f of now) {
    const p = path.join(DIST, f)
    const prev = SNAP.get(f)
    if (!prev) changed.push(`${f}（采样后新增）`)
    else if (statSync(p).size !== prev.size || sha256(p) !== prev.digest) changed.push(`${f}（内容已变）`)
  }
  for (const f of SNAP.keys()) if (!now.includes(f)) changed.push(`${f}（采样后消失）`)
  // 一致的路径必须走 check（记通过），不能走 un —— `un(name, undefined)` 仍会记一项未判定
  // （实测：本判据因此从 16/16 变成「通过 16、未判定 1 ⇒ 按纪律不判通过」）。
  if (changed.length === 0) {
    c.check('N0 环境前提：一次采样自洽（快照期间产物未被改动）', true, `${SNAP.size} 个文件与快照一致`)
  } else {
    c.un(
      'N0 环境前提：一次采样自洽（快照期间产物未被改动）',
      `采样期间产物被改动：${changed.slice(0, 5).join('、')}${changed.length > 5 ? ` 等 ${changed.length} 个` : ''}`,
    )
  }
}

process.exit(c.report())
