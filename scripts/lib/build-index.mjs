// 产物名册与双指纹的单一事实源（R36）。
//
// 为什么需要它：R36 取证实测「同一份源码，两次构建的产物必须逐字节相同」此前**没有任何判据能判**——
// 体积判据只锁 4 个 chunk 的 sha256、原始总字节只是 +2% 上限（余量 548 KB），
// 而把 dist/index.html 改一个字节（长度不变）时 17 项判据全绿。
//
// 两条纪律（都是踩出来的）：
//  ① 名册哈希只吃「相对路径 + 大小 + 内容 sha256」，**不吃 chunk 名里的 hash 之外的易变字面量**
//     （绝不写死 `index.ae3be28eb6.js`、`97700` 这类会随重锚变动的值，否则每次重锚都要改判据）；
//  ② 指纹与名册必须**同源生成**：产物名册由本模块现场从 dist 算，输入指纹由本模块现场从源码算，
//     不许在别处手抄一份（R36 实测：`SOURCE_FINGERPRINT` 的 18 个输入不含任何构建配置，
//     改 rsbuild.config.ts 后 dist/index.html 变了而判据仍 exit 0）。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

export const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// 构建配置输入：现判据的指纹集（index.html + package.json + src/**）一个都不覆盖它们。
export const CONFIG_INPUTS = ['rsbuild.config.ts', 'postcss.config.mjs', 'tsconfig.json', 'package.json', 'package-lock.json']
// 源码输入：与 scripts/check-dist-size-budget.mjs 的 SOURCE_FINGERPRINT 同集（口径单一化在外部在途文件里，见轮报 §10）。
export const SOURCE_INPUTS_EXTRA = ['index.html', 'package.json']

export function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, base, out)
    else if (e.isFile()) out.push(relative(base, p).split(sep).join(posix.sep))
  }
  return out
}

export function fingerprintOf(root, inputs) {
  const present = inputs.filter((rel) => existsSync(join(root, rel)))
  const missing = inputs.filter((rel) => !existsSync(join(root, rel)))
  if (present.length === 0) return { hash: null, inputs: [], missing, zeroSample: true }
  const h = createHash('sha256')
  for (const rel of present) h.update(rel + '\0' + sha256(join(root, rel)) + '\n')
  return { hash: h.digest('hex'), inputs: present, missing, zeroSample: false }
}

export function sourceFingerprint(root) {
  const srcDir = join(root, 'src')
  const srcFiles = existsSync(srcDir) ? walk(srcDir).map((f) => `src/${f}`) : []
  return fingerprintOf(root, [...SOURCE_INPUTS_EXTRA, ...srcFiles].sort())
}

export function configDigest(root) {
  return fingerprintOf(root, CONFIG_INPUTS)
}

// 产物名册：{ files:[{rel,size,sha256}], rosterHash }
export function distRoster(distDir) {
  if (!existsSync(distDir)) return { files: [], rosterHash: null, zeroSample: true }
  const files = walk(distDir).map((rel) => {
    const p = join(distDir, rel)
    return { rel, size: statSync(p).size, sha256: sha256(p) }
  })
  if (files.length === 0) return { files, rosterHash: null, zeroSample: true }
  const h = createHash('sha256')
  for (const f of files) h.update(f.rel + '\0' + f.size + '\0' + f.sha256 + '\n')
  return { files, rosterHash: h.digest('hex'), zeroSample: false }
}

export function buildIndex(root, distDir = join(root, 'dist')) {
  const roster = distRoster(distDir)
  return { root, distDir, rosterHash: roster.rosterHash, files: roster.files, source: sourceFingerprint(root), config: configDigest(root), zeroSample: roster.zeroSample }
}

// 逐文件差异（两侧都存在时按内容比；缺失/多出都点名）
export function diffRosters(a, b) {
  const m = new Map(b.files.map((f) => [f.rel, f]))
  const out = []
  for (const f of a.files) {
    const g = m.get(f.rel)
    if (!g) out.push({ rel: f.rel, why: '只在 A 侧存在' })
    else if (g.sha256 !== f.sha256 || g.size !== f.size) out.push({ rel: f.rel, why: `内容不同（size ${f.size} vs ${g.size}）`, a: f.sha256.slice(0, 12), b: g.sha256.slice(0, 12) })
    m.delete(f.rel)
  }
  for (const rel of m.keys()) out.push({ rel, why: '只在 B 侧存在' })
  return out
}
