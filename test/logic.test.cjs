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
// ts 必须带上：App 自己的 DB.makeMove 永远会写 ts，而备份校验现在要求它有效
// （呆滞岗算天数、异常岗逐笔滚算、日报按天汇总全靠它；缺了会被当成 1970 年）。
const add = (itemId, locationId, qty) =>
  moves.push({
    id: 'm' + (++n), type: 'init', itemId, locationId, qty,
    ts: new Date('2026-09-01T08:00:00').getTime() + n * 1000
  })

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

console.log('\nAI 问答：本地兜底（纯规则、只读）')
const data = { items, moves, locations }
eq('工具箱恰好五个只读工具',
  Object.keys(Logic.toolbox(data)).sort(),
  ['get_dist', 'get_total', 'list_recent_moves', 'search_items', 'today_summary'])
eq('get_total(6204)', Logic.toolbox(data).get_total({ sku: '6204' }).total, 80)
eq('search_items(轴承) 三种按库存降序',
  Logic.toolbox(data).search_items({ keyword: '轴承' }).map(r => r.sku),
  ['6204', '6205', '6308'])

const q1 = Logic.askLocal('轴承还剩多少', data)
eq('问「轴承还剩多少」→ 合计 156', /156/.test(q1.answer), true)
eq('问「轴承」→ 三种都列出来', /6204/.test(q1.answer) && /6205/.test(q1.answer) && /6308/.test(q1.answer), true)

const q2 = Logic.askLocal('6204 在哪个货位', data)
eq('问「6204 在哪」→ 只回 6204 不串别的', /6205/.test(q2.answer), false)
eq('问「6204 在哪」→ 带货位分布', /A区2排1层 50/.test(q2.answer), true)

const q3 = Logic.askLocal('今天出了多少货', data)
eq('问「今天」→ 走 today_summary', q3.trace[0].tool, 'today_summary')
const q4 = Logic.askLocal('最近的流水', data)
eq('问「最近流水」→ 走 list_recent_moves', q4.trace[0].tool, 'list_recent_moves')
const q5 = Logic.askLocal('潜水艇', data)
eq('问未知商品 → 提示而不是瞎答', /没查到/.test(q5.answer), true)

console.log('\n备份导出/导入')
const bk = Logic.toBackup(data)
const rt = Logic.parseBackup(bk)
eq('往返数据量一致', [rt.items.length, rt.locations.length, rt.moves.length],
  [items.length, locations.length, moves.length])
eq('往返流水 id 不变', rt.moves.map(m => m.id), moves.map(m => m.id))
let err1 = null
try { Logic.parseBackup('{"app":"other"}') } catch (e) { err1 = e.message }
eq('拒绝非本应用备份', /不是 stock-web/.test(err1), true)
let err2 = null
try { Logic.parseBackup('这不是 JSON') } catch (e) { err2 = e.message }
eq('拒绝坏 JSON', /JSON/.test(err2), true)
let err3 = null
try { Logic.parseBackup(JSON.stringify({ app: 'stock-web', items: [], locations: [], moves: [{ id: 1 }] })) } catch (e) { err3 = e.message }
eq('拒绝损坏流水', /流水记录损坏/.test(err3), true)

// —— 备份校验加固（2026-09-27）。这些都是**实测原来能通过**的坏数据。
//    背景：导入是唯一能把外部数据写进库的入口。写坏的后果很重 —— 比如 items 里
//    混进 null，首页渲染就抛异常，而导航和「重置数据」按钮都在首页里，
//    页面一片空白、App 内再也救不回来，只能去浏览器手删 IndexedDB。
function rejects(name, obj) {
  let e = null
  try { Logic.parseBackup(JSON.stringify(obj)) } catch (ex) { e = ex.message }
  eq(name, typeof e === 'string' && e.length > 0, true)
}
const B = (patch) => Object.assign({ app: 'stock-web', items: [], locations: [], moves: [] }, patch)

rejects('拒绝 items 里混进 null（会把首页打崩）', B({ items: [null] }))
rejects('拒绝 items 里空对象', B({ items: [{}] }))
rejects('拒绝 locations 里混进 null', B({ locations: [null] }))
rejects('拒绝缺 ts 的流水', B({ moves: [{ id: 'm', itemId: 'i', locationId: 'l', qty: 1, type: 'in' }] }))
rejects('拒绝缺 type 的流水', B({ moves: [{ id: 'm', itemId: 'i', locationId: 'l', qty: 1, ts: 1 }] }))
rejects('拒绝 qty 是字符串的流水（求和会退化成字符串拼接）',
  B({ moves: [{ id: 'm', itemId: 'i', locationId: 'l', qty: '5', type: 'in', ts: 1 }] }))
rejects('拒绝坏提案', B({ proposals: [null] }))

// ⚠️ 这条必须**手写 JSON 字符串**：JSON.stringify 会把 Infinity 变成 null，
//    那会被上面「类型不对」那条挡掉，测不到 Number.isFinite 这一层。
//    真实场景是手改/损坏的备份文件 —— 文件里字面写着 1e999。
function rejectsRaw(name, raw, pattern) {
  let e = null
  try { Logic.parseBackup(raw) } catch (ex) { e = ex.message }
  eq(name, typeof e === 'string' && pattern.test(e), true)
}
rejectsRaw('拒绝 qty=1e999（JSON.parse 会还原成 Infinity，库存被永久锁死，补不回来）',
  '{"app":"stock-web","items":[],"locations":[],"moves":[{"id":"m","itemId":"i","locationId":"l","qty":1e999,"type":"in","ts":1}]}',
  /有限数字/)

// 老备份（v1，不含 proposals）要能导入，但 proposals 标成 null 让调用方知道
const v1 = Logic.parseBackup(JSON.stringify(B({ v: 1, moves: [
  { id: 'm', itemId: 'i', locationId: 'l', qty: 1, type: 'in', ts: 1 }] })))
eq('v1 老备份仍可导入，proposals=null 表示不含待办箱', v1.proposals, null)
eq('v2 备份带 proposals', Array.isArray(rt.proposals), true)
eq('v2 往返保留提案', rt.proposals.length, (data.proposals || []).length)

console.log('\n巡检四岗（判定全用规则、纯函数）')
// 巡检用一份带时间戳的独立数据（now 固定，测试永远确定性）
const NOW = new Date('2026-10-15T12:00:00').getTime()
const pmoves = [
  { id: 'pm1', type: 'init',  itemId: 'it_6204', locationId: 'A-2-1', qty: 50,  ts: new Date('2026-09-01T08:00:00').getTime(), by: '期初' },
  { id: 'pm2', type: 'init',  itemId: 'it_6205', locationId: 'B-1-1', qty: 26,  ts: new Date('2026-09-01T08:00:01').getTime(), by: '期初' },
  { id: 'pm3', type: 'init',  itemId: 'it_6308', locationId: 'C-3-1', qty: 30,  ts: new Date('2026-09-01T08:00:02').getTime(), by: '期初' },
  { id: 'pm4', type: 'out',   itemId: 'it_6204', locationId: 'A-2-1', qty: -3,  ts: new Date('2026-10-14T09:00:00').getTime(), by: '张三' },
  { id: 'pm5', type: 'out',   itemId: 'it_6205', locationId: 'B-1-1', qty: -30, ts: new Date('2026-10-15T09:00:00').getTime(), by: '张三' },
  { id: 'pm6', type: 'count', itemId: 'it_6204', locationId: 'A-2-1', qty: 120, ts: new Date('2026-10-15T10:00:00').getTime(), by: '李四' }
]
const pdata = { items, moves: pmoves, locations }

eq('呆滞岗：只有 44 天没动的 6308 被点名',
  Logic.inspectStagnant(pdata, { now: NOW, days: 30 }).map(f => f.detail.itemId), ['it_6308'])
eq('呆滞岗：idleDays 算得对',
  Logic.inspectStagnant(pdata, { now: NOW, days: 30 })[0].detail.idleDays, 44)
eq('呆滞岗：阈值调大就不报（60 天）', Logic.inspectStagnant(pdata, { now: NOW, days: 60 }), [])
eq('呆滞岗：负库存商品不算呆滞（是缺货）',
  Logic.inspectStagnant(pdata, { now: NOW, days: 1 }).map(f => f.detail.itemId).includes('it_6205'), false)

eq('低库存岗：默认阈值 10 → 只有 -4 的 6205',
  Logic.inspectLowStock(pdata).map(f => f.detail.itemId), ['it_6205'])
eq('低库存岗：阈值 35 → 6205 和 6308',
  Logic.inspectLowStock(pdata, { safety: 35 }).map(f => f.detail.itemId), ['it_6205', 'it_6308'])
eq('低库存岗：单品 item.safety 覆盖全局阈值',
  Logic.inspectLowStock({
    items: [{ id: 'i1', sku: 'S1', name: '甲', unit: '个', safety: 5 }],
    moves: [{ id: 'x1', type: 'init', itemId: 'i1', locationId: 'A-1-1', qty: 6 }],
    locations
  }), [])
eq('低库存岗：safety=0 不设防（不报）',
  Logic.inspectLowStock({
    items: [{ id: 'i1', sku: 'S1', name: '甲', unit: '个', safety: 0 }],
    moves: [{ id: 'x1', type: 'init', itemId: 'i1', locationId: 'A-1-1', qty: 1 }],
    locations
  }), [])

const an = Logic.inspectAnomalies(pdata, { bigQty: 100 })
eq('异常岗：负库存（逐笔滚算）+ 超大调整，两条',
  an.map(f => f.detail.reason), ['负库存', '超大调整'])
eq('异常岗：负库存结余算得对', an[0].detail.balance, -4)
eq('异常岗：大额期初不误报（只盯盘点调整）',
  Logic.inspectAnomalies({
    items, locations,
    moves: [{ id: 'h1', type: 'init', itemId: 'it_6204', locationId: 'A-2-1', qty: 999, ts: 1 }]
  }, { bigQty: 100 }), [])

const dr = Logic.dailyReport(pdata, { now: NOW })
eq('日报岗：今天收发/盘点汇总对',
  [dr.inN, dr.inQty, dr.outN, dr.outQty, dr.countN, dr.countQty], [0, 0, 1, 30, 1, 120])
eq('日报岗：日期键', dr.date, '2026-10-15')

const findings = Logic.patrolFindings(pdata, { now: NOW, days: 30 })
eq('四岗汇总按优先级排（异常 > 低库存 > 呆滞 > 日报）',
  findings.map(f => f.kind), ['anomaly', 'anomaly', 'low_stock', 'stagnant', 'daily'])

console.log('\n提案生命周期（只追加、留痕、人批准才落库）')
eq('排序权重表', [Logic.proposalPriority('investigation'), Logic.proposalPriority('anomaly'), Logic.proposalPriority('daily')], [0, 1, 4])
eq('没有同 key 的旧提案 → 立', Logic.shouldPropose([], 'low:it_x', NOW), true)
const pOpen = Logic.newProposal({ key: 'low:it_x', kind: 'low_stock', summary: 's' }, { now: NOW, id: 'pa', created_by: 'AI 巡检 · 规则引擎' })
eq('提案草稿：status=open + 起草事件 + 审计身份',
  [pOpen.status, pOpen.events[0].action, pOpen.created_by], ['open', 'draft', 'AI 巡检 · 规则引擎'])
eq('开着的同 key 提案不重复立', Logic.shouldPropose([pOpen], 'low:it_x', NOW), false)
const dec1 = Logic.decideProposal(pOpen, { approve: false, by: '王五', reason: '不用补', at: NOW + 1000 })
eq('拒绝：理由存档 + 状态 + 留痕', [dec1.proposal.status, dec1.proposal.decide_reason, dec1.proposal.events[1].action], ['rejected', '不用补', 'reject'])
eq('拒绝后冷却期内不唠叨', Logic.shouldPropose([dec1.proposal], 'low:it_x', NOW + 2 * 86400000), false)
eq('拒绝后冷却期过了旧事重提', Logic.shouldPropose([dec1.proposal], 'low:it_x', NOW + 8 * 86400000), true)

const pLines = Logic.newProposal({
  key: 'anomaly:m9', kind: 'anomaly', summary: '负库存',
  lines: [{ type: 'count', itemId: 'it_6204', locationId: 'A-2-1', qty: 4 }]
}, { now: NOW, id: 'pb' })
const dec2 = Logic.decideProposal(pLines, { approve: true, by: '王五', reason: '', at: NOW + 2000 })
eq('通过：有待落库流水行 → moves 交给人落库',
  dec2.moves, [{ type: 'count', itemId: 'it_6204', locationId: 'A-2-1', qty: 4 }])
eq('通过：落库记录进事件（谁批准 · 何时 · 动了什么）',
  [dec2.proposal.events[1].by, dec2.proposal.events[1].moves.length], ['王五', 1])
eq('无 lines 的提案通过 → 不落库', Logic.decideProposal(pOpen, { approve: true, by: '王五', at: 1 }).moves, [])

const rev = Logic.reviseProposal(pLines, { lines: [{ type: 'count', itemId: 'it_6204', locationId: 'A-2-1', qty: 7 }], by: '王五', at: NOW + 3000 })
eq('改提案：旧版本标 superseded 留痕', [rev.old.status, rev.old.events[1].action], ['superseded', 'revise'])
eq('改提案：新版本回 open、新旧挂链、数量已改',
  [rev.revision.status, rev.revision.supersedes, rev.revision.lines[0].qty], ['open', 'pb', 7])

const qa = Logic.appendQa(pOpen, { q: '为什么低', a: '在库 4 低于 10', by: '王五', at: NOW + 4000 })
eq('追问：Q&A 挂回提案留痕', [qa.events.length, qa.events[1].action, qa.status], [2, 'ask', 'open'])

console.log('\n差异调查（确定性兜底报告 + 工具留痕）')
const fb = Logic.investigationFallback(pdata, {
  moveId: 'pm5', reason: '负库存', itemId: 'it_6205', locationId: 'B-1-1',
  sku: '6205', loc: 'B区1排1层', qty: -30, balance: -4
})
eq('调查：顺序 = 查流水 → 查同款 → 查邻位，三步全留痕',
  fb.tool_calls.map(t => t.tool), ['list_recent_moves', 'get_item_distribution', 'get_zone_contents'])
eq('调查：报告带真数字（时间线/结余）',
  /时间线/.test(fb.report) && /结余 -4/.test(fb.report), true)
eq('调查：负库存案附"补平"建议流水行（人可改可拒）',
  fb.lines, [{ type: 'count', itemId: 'it_6205', locationId: 'B-1-1', qty: 4 }])
const fb2 = Logic.investigationFallback(pdata, {
  moveId: 'pm6', reason: '超大调整', itemId: 'it_6204', locationId: 'A-2-1',
  sku: '6204', loc: 'A区2排1层', qty: 120, balance: 167
})
eq('调查：非负库存案不编调整数字', fb2.lines, null)

console.log('\n单据解析（送货单文本 → 收货草稿行，匹配与落库行全规则）')
const pr = Logic.parseReceipt('6204轴承 50\n轴承 6205 x20\n内六角螺丝 M8×30 12盒\n6204\n')
eq('行解析：行尾数字是数量、规格里的 ×30 不是数量',
  pr.map(r => [r.desc, r.qty]),
  [['6204轴承', 50], ['轴承 6205', 20], ['内六角螺丝 M8×30', 12], ['6204', null]])
eq('整行只有编码时不当数量（"6204" ≠ 数量 6204）', pr[3].qty, null)

const draftRes = Logic.draftReceiptRows(pr, data)
eq('草稿行：编码包含匹配 + 同类回存量最多的货位',
  draftRes.lines.map(l => [l.sku, l.locationId, l.qty, l.rowIndex]),
  [['6204', 'A-2-1', 50, 0], ['6205', 'B-1-1', 20, 1]])
eq('草稿行：匹配不上/没数量的行不进落库行，进待人工处理',
  draftRes.notes.length, 2)
eq('草稿行：notes 点名是哪一行', /第 3 行/.test(draftRes.notes[0]) && /第 4 行/.test(draftRes.notes[1]), true)
// 名字原来写的是「数量 0/负数」，但只喂了 0 —— 负数一次都没试。两个都测。
eq('草稿行：数量 0 不进落库行',
  Logic.draftReceiptRows([{ lineNo: 1, raw: '6204 0', desc: '6204', qty: 0 }], data).lines, [])
eq('草稿行：负数量同样不进落库行（名字里那半句原来没测）',
  Logic.draftReceiptRows([{ lineNo: 1, raw: '6204 -5', desc: '6204', qty: -5 }], data).lines, [])
eq('草稿行：改过数量以改动为准（提交层合并 edits 后再走同一规则）',
  Logic.draftReceiptRows([{ lineNo: 1, raw: 'x', desc: '6204', qty: 30 }], data).lines[0].qty, 30)

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : '') + '\n')
process.exit(fail ? 1 : 0)
