// 判据公共工具（仓库内自包含，**不 import 运行根的任何东西**）。
//
// 为什么要有它：审计运行根的 `lib/audit-assert.mjs` 里那套「未判定 / 关键跳过不得判通过」
// 的纪律，仓库内判据同样需要 —— 否则「过滤后集合为空 → 报通过」这条假通过路径会原样复发。
// 运行根不在仓库里（也不该被仓库脚本依赖），所以这里按同一语义重写一份最小实现。
//
// 语义（与 audit-assert.mjs 一致的部分，逐条对齐）：
//   · check(name, cond, detail)：cond 必须是布尔；传 undefined/null 视为**未判定**，不算通过。
//   · un(name, detail)：显式记一项未判定（样本缺失、环境前提不成立等）。
//   · skip(name, detail, {critical})：记一项跳过；critical 默认为 true（被跳过的检查意味着
//     覆盖面不完整，不能与「全部通过」混为一谈），只有确实与结论无关时才传 critical: false。
//   · report()：打印 `[OK] / [FAIL] / [SKIP]` 行 + 一行计数，并返回**退出码**：
//       0 全部通过；1 有失败或有关键跳过；2 只有未判定（含「一条已判定项都没有」）。
//     约定：0=通过、1=判据判负、2=未判定（与 check-third-party-notices.mjs 的既有约定一致）。
//
// 输出格式（下游变异体脚本按 `[FAIL] <名字>` 抽取翻转的断言名，名字请以稳定的 ID 开头）：
//   [OK]   N1 产物目录存在且非空 | 13 个文件
//   [FAIL] N2 产物文件名清单精确等于 13 个 | 缺失=[…] 多余=[…]
//   [SKIP] N3 web 传输面 gzip 合计 ≤ 96178 B | 未判定：…
//   检查项 16：通过 15，失败 1，未判定 0，跳过 0
export function makeChecker(title) {
  const rows = []
  let skipped = 0
  let criticalSkipped = 0

  return {
    check(name, cond, detail = '') {
      if (typeof cond !== 'boolean') {
        rows.push({ name, state: 'undecided', detail: String(detail || cond) })
        return
      }
      rows.push({ name, state: cond ? 'pass' : 'fail', detail })
    },
    un(name, detail = '') {
      rows.push({ name, state: 'undecided', detail })
    },
    skip(name, detail = '', { critical = true } = {}) {
      skipped++
      if (critical) criticalSkipped++
      rows.push({ name, state: 'skip', detail, critical })
    },
    get passed() { return rows.filter((r) => r.state === 'pass').length },
    get failed() { return rows.filter((r) => r.state === 'fail').length },
    get undecided() { return rows.filter((r) => r.state === 'undecided').length },
    get total() { return rows.length },

    report() {
      console.log('=== ' + title + ' ===')
      for (const r of rows) {
        const line = { pass: '[OK]  ', fail: '[FAIL]', skip: '[SKIP]', undecided: '[SKIP]' }[r.state]
        const tag = r.state === 'undecided' ? '未判定：' : r.state === 'skip' ? '跳过：' : ''
        console.log(`${line} ${r.name} | ${tag}${r.detail}`)
      }
      const decided = this.passed + this.failed
      console.log('')
      console.log(`检查项 ${this.total}：通过 ${this.passed}，失败 ${this.failed}，未判定 ${this.undecided}，跳过 ${skipped}`)
      // 防线一：一条已判定项都没有 → 什么都没验，不得判通过
      if (decided === 0) {
        console.log('⚠️ 未执行任何有效检查，不能判定为通过')
        return 2
      }
      // 防线二：关键检查被跳过 → 覆盖面不完整，不得判通过
      if (criticalSkipped > 0) {
        console.log(`❌ 有 ${criticalSkipped} 项关键检查被跳过，覆盖面不完整，不能判定为通过`)
        return 1
      }
      if (this.failed > 0) {
        console.log('❌ 存在未通过项')
        return 1
      }
      if (this.undecided > 0) {
        console.log('⚠️ 存在未判定项（按纪律不判通过）')
        return 2
      }
      console.log('✅ 全部通过')
      return 0
    },
  }
}
