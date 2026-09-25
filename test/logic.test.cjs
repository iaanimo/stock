// test/logic.test.cjs —— 业务逻辑自测（不依赖浏览器，node 直接跑）
// 用法： node test/logic.test.cjs
// 后缀是 .cjs 不是 .js：上层目录有 "type":"module" 的 package.json，.js 会被当 ESM
//
// logic.js 是纯函数，所以能脱离浏览器测。db.js 用了 IndexedDB，测不了，
// 这里手工造一份和 db.js 里一样的种子流水。

const fs = require('fs')
const path = require('path')

// 把 logic.js 当函数体加载，取出里面的 Logic
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'logic.js'), 'utf8')
const Logic = new Function(src + '; return Logic;')()

// —— 和 db.js 的种子保持一致 ——
const moves = []
let n = 0
const add = (itemId, locationId, qty) =>
  moves.push({ id: 'm' + (++n), type: 'init', itemId, locationId, qty })

add('it_6204', 'A-2-1', 50)
add('it_6204', 'A-2-2', 30)
add('it_6205', 'A-2-2', 20)
add('it_6205', 'B-1-1', 26)
add('it_6308', 'C-3-1', 30)

const locations = []
;['A', 'B', 'C'].forEach(z => {
  for (let r = 1; r <= 4; r++) {
    for (let l = 1; l <= 3; l++) {
      locations.push({ id: `${z}-${r}-${l}`, code: `${z}-${r}-${l}`, label: `${z}区${r}排${l}层`, zone: z, row: r, layer: l })
    }
  }
})

const items = [
  { id: 'it_6204', sku: '6204', name: '轴承 6204', spec: '内径20 外径47', unit: '个' },
  { id: 'it_6205', sku: '6205', name: '轴承 6205', spec: '内径25 外径52', unit: '个' },
  { id: 'it_6308', sku: '6308', name: '轴承 6308', spec: '内径40 外径90', unit: '个' }
]

// —— 迷你测试框架 ——
let pass = 0, fail = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + '\n       得到 ' + g + '\n       应为 ' + w) }
}

console.log('\n库存计算')
eq('6204 总库存', Logic.totalOf('it_6204', moves), 80)
eq('6205 总库存', Logic.totalOf('it_6205', moves), 46)
eq('三种轴承合计（跨三个货位的汇总）',
  items.reduce((a, i) => a + Logic.totalOf(i.id, moves), 0), 156)
eq('6204 在 A-2-1 的数量', Logic.qtyAt('it_6204', 'A-2-1', moves), 50)
eq('6204 分布',
  [...Logic.distOf('it_6204', moves)].sort(), [['A-2-1', 50], ['A-2-2', 30]])

console.log('\n搜索')
eq('搜「轴承」按库存降序',
  Logic.search('轴承', items, moves).map(r => [r.item.sku, r.total]),
  [['6204', 80], ['6205', 46], ['6308', 30]])
eq('搜编码 6205', Logic.search('6205', items, moves).map(r => r.item.sku), ['6205'])

console.log('\n收货上架：货位推荐')
// 已有货位的商品 → 回原处（A-2-1 存量 50 > A-2-2 的 30）
eq('老商品放回存量最多的货位',
  Logic.suggestLocation('it_6204', moves, locations).id, 'A-2-1')
// 全新商品 → 第一个空货位（A-1-1 没有任何库存）
eq('新商品找空货位',
  Logic.suggestLocation('it_brand_new', moves, locations).id, 'A-1-1')

console.log('\n出库拣货：顺序')
eq('6204 拣货顺序（存量多的先去）',
  Logic.pickPlan('it_6204', moves, locations).map(p => [p.loc.label, p.qty]),
  [['A区2排1层', 50], ['A区2排2层', 30]])

console.log('\n盘点')
eq('全仓位点数', Logic.countSheet('ALL', moves, locations, items).length, 5)
eq('A 区位点数', Logic.countSheet('A', moves, locations, items).length, 3)
eq('盘点行按货位排序',
  Logic.countSheet('ALL', moves, locations, items).map(r => r.loc.code),
  ['A-2-1', 'A-2-2', 'A-2-2', 'B-1-1', 'C-3-1'])

console.log('\n导出差异表')
const csv = Logic.toCSV(
  [{ itemId: 'it_6204', locId: 'A-2-1', item: items[0], system: 50, actual: 47 }],
  locations)
eq('带 BOM（Excel 打开中文不乱码）', csv.charCodeAt(0), 0xFEFF)
eq('差异算得对', csv.split('\r\n')[1].split(',').slice(-3), ['50', '47', '-3'])

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : '') + '\n')
process.exit(fail ? 1 : 0)
