// js/logic.js —— 业务逻辑（纯函数，不碰界面）
//
// 核心设计：库存不是一个「数字字段」，而是「流水求和」算出来的。
// 好处是两台手机离线各记各的，回传时把流水加在一起就行，不会互相覆盖。
// 代价是每次算库存要遍历一遍流水 —— 几千条的量级无所谓。

// CSV 单元格转义（给 toCSV 用）。两层，缺一层都出过事：
//
//   1) RFC4180 引号包裹 —— 值里有逗号/引号/换行时必须包起来。
//      实测：商品名 "轴承, 内径20" 会把 8 列劈成 10 列，导出的差异表整行错位。
//
//   2) 防公式注入 —— 以 = + @ 开头的值在 Excel/WPS 里会被当公式执行（CSV 注入）。
//      前面补一个单引号让它变回文本。负数不碰：差异列本来就是 -3 这种，
//      而 -3 是合法数值不是公式；只有 "-后跟非数字" 才可疑。
function csvCell(v) {
  let s = (v === null || v === undefined) ? '' : String(v)
  if (/^[=+@\t\r]/.test(s) || /^-[^\d.]/.test(s)) s = "'" + s
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"'
  return s
}

const Logic = {

  // 某商品在某货位上有多少
  qtyAt(itemId, locationId, moves) {
    let n = 0
    for (const m of moves) {
      if (m.itemId === itemId && m.locationId === locationId) n += m.qty
    }
    return n
  },

  // 某商品在各货位的分布：Map(货位id -> 数量)，只保留不为 0 的
  distOf(itemId, moves) {
    const map = new Map()
    for (const m of moves) {
      if (m.itemId !== itemId) continue
      map.set(m.locationId, (map.get(m.locationId) || 0) + m.qty)
    }
    for (const [k, v] of [...map]) if (v === 0) map.delete(k)
    return map
  },

  // 某商品总库存
  totalOf(itemId, moves) {
    let n = 0
    for (const m of moves) if (m.itemId === itemId) n += m.qty
    return n
  },

  // 全部库存：Map(itemId -> Map(locationId -> qty))
  allStock(moves) {
    const out = new Map()
    for (const m of moves) {
      if (!out.has(m.itemId)) out.set(m.itemId, new Map())
      const locMap = out.get(m.itemId)
      locMap.set(m.locationId, (locMap.get(m.locationId) || 0) + m.qty)
    }
    return out
  },

  // ——————————————————————————————————
  // 收货上架：系统推荐放哪儿
  //  1) 这个商品已经有货位 → 放回原处（同类东西放一起，下次找得快）
  //  2) 全新商品 → 找一个完全空的货位
  //  3) 都没有（仓位全满）→ null，让界面提示手动选
  // ——————————————————————————————————
  suggestLocation(itemId, moves, locations) {
    const dist = this.distOf(itemId, moves)
    let best = null
    dist.forEach((q, locId) => {
      // ⚠️ 只认正数。负库存是**账实不符的异常**，不是"这个货位已经有货"。
      //    原来会把 -5 也当成"有货位"然后推荐它 —— 实测：某货位账面 -5、
      //    另一个货位全空，系统推荐了那个负数的，空货位根本没被考虑。
      //    新货不该被塞进一个待查的异常货位。
      if (q <= 0) return
      if (!best || q > best.qty) best = { locId: locId, qty: q }
    })
    if (best) return locations.find(l => l.id === best.locId) || null

    const used = new Set()
    this.allStock(moves).forEach(locMap => {
      // 负数货位也算"被占"：它有账要查，先别当空位发出去
      locMap.forEach((q, locId) => { if (q !== 0) used.add(locId) })
    })
    const empty = locations.filter(l => !used.has(l.id))
    return empty.length ? empty[0] : null
  },

  // ——————————————————————————————————
  // 出库拣货：这个商品都在哪些货位、各有多少
  // 排序规则：存量多的排前面 —— 一次能拿完的概率高，少跑腿
  // ——————————————————————————————————
  pickPlan(itemId, moves, locations) {
    const dist = this.distOf(itemId, moves)
    const rows = []
    dist.forEach((q, locId) => {
      if (q <= 0) return
      const loc = locations.find(l => l.id === locId)
      if (loc) rows.push({ loc: loc, qty: q })
    })
    rows.sort((a, b) => b.qty - a.qty)
    return rows
  },

  // ——————————————————————————————————
  // 盘点：列出该范围里每个「货位 × 商品」的系统数
  // scope = 'ALL' 或 'A' / 'B' / 'C'
  // ——————————————————————————————————
  countSheet(scope, moves, locations, items) {
    const stock = this.allStock(moves)
    const rows = []
    stock.forEach((locMap, itemId) => {
      const item = items.find(i => i.id === itemId)
      if (!item) return
      locMap.forEach((q, locId) => {
        if (q === 0) return
        const loc = locations.find(l => l.id === locId)
        if (!loc) return
        if (scope !== 'ALL' && loc.zone !== scope) return
        rows.push({ itemId: itemId, locId: locId, loc: loc, item: item, system: q })
      })
    })
    rows.sort((a, b) => a.loc.code.localeCompare(b.loc.code))
    return rows
  },

  // 搜索：按名称或编码模糊匹配
  search(kw, items, moves) {
    const k = (kw || '').trim().toLowerCase()
    const hit = items.filter(i =>
      !k ||
      i.name.toLowerCase().includes(k) ||
      i.sku.toLowerCase().includes(k)
    )
    return hit.map(i => ({
      item: i,
      total: this.totalOf(i.id, moves),
      dist: this.distOf(i.id, moves)
    })).sort((a, b) => b.total - a.total)
  },

  // ——————————————————————————————————
  // AI 问答的纯逻辑部分（只读！绝不写库）
  // data = { items, moves, locations } 一份数据快照
  //
  // toolbox 是 AI 唯一能用的五个只读工具，全部包现有纯函数。
  // AI 拿到的任何数字都从这里出，杜绝"模型口算库存"。
  // ——————————————————————————————————
  toolbox(data) {
    const { items, moves, locations } = data
    // ⚠️ 空关键词必须直接返回 null。
    //    原来没有这道闸，k='' 时 includes('') 恒真 → **返回第一个商品**。
    //    实测 get_total({}) 返回「内六角螺丝 M8，total:50」：模型少传一个参数，
    //    就会拿到一个看起来很真、实际是别的东西的数字，人不会怀疑。
    //    这也违反 ai.js SYS 写死的纪律「工具查不到就固定回答没查到」。
    const findItem = q => {
      const k = String(q || '').trim().toLowerCase()
      if (!k) return null
      const exact = items.find(i => i.sku.toLowerCase() === k) ||
        items.find(i => i.name.toLowerCase() === k)
      if (exact) return exact
      // 模糊匹配要求关键词至少 2 个字，避免 "6" 这种命中一大片
      if (k.length < 2) return null
      return items.find(i => i.name.toLowerCase().includes(k) ||
        i.sku.toLowerCase().includes(k)) || null
    }
    const distRows = (itemId) => {
      const out = []
      Logic.distOf(itemId, moves).forEach((qty, locId) => {
        const l = locations.find(x => x.id === locId)
        out.push({ loc: l ? l.label : locId, qty })
      })
      return out
    }
    return {
      search_items({ keyword }) {
        return Logic.search(keyword, items, moves).map(r => ({
          sku: r.item.sku, name: r.item.name, spec: r.item.spec, unit: r.item.unit,
          total: r.total,
          dist: distRows(r.item.id)
        }))
      },
      get_total({ sku }) {
        const it = findItem(sku)
        if (!it) return null
        return { sku: it.sku, name: it.name, unit: it.unit, total: Logic.totalOf(it.id, moves) }
      },
      get_dist({ sku }) {
        const it = findItem(sku)
        if (!it) return null
        return {
          sku: it.sku, name: it.name, unit: it.unit,
          total: Logic.totalOf(it.id, moves),
          dist: distRows(it.id)
        }
      },
      list_recent_moves({ n, itemId, sku }) {
        // ⚠️ 过滤必须在**截断之前**。
        //    原来是「先取全仓最近 N 条、再由调用方按商品筛」，仓里流水一多
        //    就必然筛成空（实测：25 条别的流水 + 目标商品 1 条 → 时间线空），
        //    调查报告于是输出「最近没有流水记录」这句**假话** —— 而那正是人
        //    用来判断"先出后补 / 串货 / 漏记"的依据。
        let pool = moves
        if (itemId) {
          pool = moves.filter(m => m.itemId === itemId)
        } else if (sku) {
          const it2 = findItem(sku)
          if (!it2) return []
          pool = moves.filter(m => m.itemId === it2.id)
        }
        return [...pool]
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .slice(0, Math.max(1, Math.min(20, n || 5)))
          .map(m => {
            const it = items.find(i => i.id === m.itemId)
            const l = locations.find(x => x.id === m.locationId)
            return {
              ts: m.ts || 0,
              type: m.type,
              item: it ? it.name : m.itemId,
              loc: l ? l.label : m.locationId,
              qty: m.qty,
              by: m.by || ''
            }
          })
      },
      today_summary() {
        const t0 = new Date(); t0.setHours(0, 0, 0, 0)
        const rows = moves.filter(m => (m.ts || 0) >= t0.getTime() && m.type !== 'init')
        const sum = type => rows.filter(m => m.type === type).reduce((a, m) => a + Math.abs(m.qty), 0)
        return {
          inQty: sum('in'), outQty: sum('out'), countQty: sum('count'),
          rows: rows.map(m => {
            const it = items.find(i => i.id === m.itemId)
            const l = locations.find(x => x.id === m.locationId)
            return {
              type: m.type, item: it ? it.name : m.itemId,
              loc: l ? l.label : m.locationId, qty: m.qty
            }
          })
        }
      }
    }
  },

  // ——————————————————————————————————
  // 本地规则回答（AI 的兜底，也是"AI 挂了核心功能不受影响"的保证）
  // 纯函数、确定性：同样的问题永远给同样的答案
  // ——————————————————————————————————
  askLocal(question, data) {
    const q = String(question || '').trim()
    const trace = []
    const tools = this.toolbox(data)
    const distRowsText = (distMap, locations) => {
      const parts = []
      distMap.forEach((qty, locId) => {
        const l = locations.find(x => x.id === locId)
        parts.push(`${l ? l.label : locId} ${qty}`)
      })
      return parts.join(' · ') || '无库存'
    }
    if (!q) return { answer: '想查什么？比如：「轴承还剩多少」「6204 在哪个货位」「今天出了多少货」', trace }

    // 今天 / 最近
    if (/今天|今日|今天出|今天收/.test(q)) {
      const r = tools.today_summary()
      trace.push({ tool: 'today_summary', args: {}, result: r })
      return {
        answer: `今天：收货 ${r.inQty} · 出库 ${r.outQty} · 盘点调整 ${r.countQty}\n` +
          (r.rows.length ? r.rows.map(x =>
            `· ${({ in: '收', out: '出', count: '调' })[x.type] || x.type} ${x.item} ${x.qty} → ${x.loc}`).join('\n') : '（今天还没有流水）'),
        trace
      }
    }
    if (/最近|流水|记录/.test(q)) {
      const r = tools.list_recent_moves({ n: 5 })
      trace.push({ tool: 'list_recent_moves', args: { n: 5 }, result: r })
      return {
        answer: r.length ? ('最近的流水：\n' + r.map(x =>
          `· ${({ in: '收', out: '出', count: '调', init: '期初' })[x.type] || x.type} ${x.item} ${x.qty} → ${x.loc}${x.by ? '（' + x.by + '）' : ''}`).join('\n')) : '（还没有流水）',
        trace
      }
    }

    // 找商品：编码命中优先，其次名称/名称主词（轴承 6204 → 精确；轴承 → 全部轴承）
    const q2 = q.toLowerCase()
    const items = data.items
    const skuHit = items.filter(i => q2.includes(i.sku.toLowerCase()))
    const nameHit = items.filter(i => {
      const n0 = i.name.split(/[\s_]+/)[0]
      return q.includes(i.name) || (n0.length >= 2 && q.includes(n0))
    })
    const matched = skuHit.length ? skuHit : nameHit

    if (!matched.length) {
      return {
        answer: `没查到「${q}」对应的商品。可以说商品名或编码，比如「轴承」「6204」「电磁阀」；\n` +
          '也可以问「今天出了多少货」「最近的流水」。',
        trace
      }
    }

    const rows = matched.map(it => {
      const total = Logic.totalOf(it.id, data.moves)
      const dist = distRowsText(Logic.distOf(it.id, data.moves), data.locations)
      return { sku: it.sku, name: it.name, unit: it.unit, total, dist }
    })
    trace.push({ tool: skuHit.length ? 'get_dist' : 'search_items', args: { keyword: q }, result: rows })

    const kind = matched.length > 1
      ? `「${q}」共 ${rows.length} 种，合计 ${rows.reduce((a, r) => a + r.total, 0)}：\n` +
        rows.map(r => `· ${r.name}：${r.total} ${r.unit}（${r.dist}）`).join('\n')
      : `${rows[0].name} 现有 ${rows[0].total} ${rows[0].unit}\n货位分布：${rows[0].dist}`
    return { answer: kind, trace }
  },

  // ——————————————————————————————————
  // 全量备份：导出/导入（JSON = 将来真后端的数据合同，现在定格式是免费的）
  // ——————————————————————————————————
  toBackup(data) {
    return JSON.stringify({
      app: 'stock-web',
      v: 2,
      exportedAt: new Date().toISOString(),
      items: data.items,
      locations: data.locations,
      moves: data.moves,
      // v2 起纳入 proposals。它是 AI 巡检 / 调查 / 批准落库的**审计台账**：
      // 「谁在什么时候批准了什么、为什么拒绝」这些不是从 items/moves 派生的，
      // 丢了重建不出来。原来注释写「全量备份」却不含它 —— 换台设备导入，留痕整段消失。
      proposals: data.proposals || []
    }, null, 2)
  },

  parseBackup(text) {
    let o
    try { o = JSON.parse(text) } catch (e) { throw new Error('不是有效的备份文件（JSON 解析失败）') }
    if (!o || o.app !== 'stock-web') throw new Error('不是 stock-web 的备份文件')
    if (!Array.isArray(o.items) || !Array.isArray(o.locations) || !Array.isArray(o.moves)) {
      throw new Error('备份缺少数据表')
    }

    // ⚠️ 校验必须够严：这是**唯一**能把外部数据写进库的入口，而写坏的后果特别重 ——
    //    比如 items 里混进一个 null，首页渲染就抛异常，而导航和「重置数据」按钮
    //    都在首页里，页面一片空白 → App 内再也救不回来，只能去浏览器手删 IndexedDB。
    //    原来只查了 moves 的四个字段类型，实测以下**全部放行**：
    //      items=[null] / items=[{}] / moves 缺 ts / 缺 type / 版本号乱写 / qty=Infinity
    const bad = msg => { throw new Error(msg) }

    for (const it of o.items) {
      if (!it || typeof it.id !== 'string' || typeof it.name !== 'string') {
        bad('商品记录损坏（缺 id / name）')
      }
    }
    for (const l of o.locations) {
      if (!l || typeof l.id !== 'string' || typeof l.label !== 'string') {
        bad('货位记录损坏（缺 id / label）')
      }
    }
    for (const m of o.moves) {
      if (!m || typeof m.id !== 'string' || typeof m.itemId !== 'string' ||
        typeof m.locationId !== 'string' || typeof m.qty !== 'number') {
        bad('流水记录损坏（缺 id / itemId / locationId / qty）')
      }
      // NaN / Infinity 会粘住之后所有求和：一旦进库，该商品的库存永久是 Infinity，
      // 之后任何盘点调整都是 Infinity + 有限数 = Infinity，补不回来。
      if (!Number.isFinite(m.qty)) bad('流水数量不是有限数字')
      if (typeof m.type !== 'string' || !m.type) bad('流水缺少 type（init / in / out / count）')
      // ts 是必需的：呆滞岗算"多少天没动"、异常岗逐笔滚算余额、日报按天汇总，
      // 全靠它。缺了会被当成 1970 年，报出「已 20000 天无进出」这种假数字。
      if (!Number.isFinite(m.ts)) bad('流水缺少有效时间戳 ts')
    }
    for (const p of (o.proposals || [])) {
      if (!p || typeof p.id !== 'string' || typeof p.status !== 'string') {
        bad('提案记录损坏（缺 id / status）')
      }
    }

    return {
      items: o.items,
      locations: o.locations,
      moves: o.moves,
      // null = 老备份（v1 不含待办箱），导入方据此决定是保留现有提案还是清空
      proposals: Array.isArray(o.proposals) ? o.proposals : null,
      v: o.v || 1,
      exportedAt: o.exportedAt
    }
  },

  // ——————————————————————————————————
  // 导出差异表（CSV）
  // 前面那个 ﻿ 是 BOM，不加的话 Excel 打开中文是乱码
  // ——————————————————————————————————
  toCSV(rows, locations) {
    const head = ['货位', '商品编码', '商品名称', '规格', '单位', '系统数', '实际数', '差异']
    const lines = [head.map(csvCell).join(',')]
    rows.forEach(r => {
      const loc = locations.find(l => l.id === r.locId)
      lines.push([
        loc ? loc.label : r.locId,
        r.item.sku,
        r.item.name,
        r.item.spec,
        r.item.unit,
        r.system,
        r.actual,
        r.actual - r.system
      ].map(csvCell).join(','))
    })
    return '﻿' + lines.join('\r\n')
  },

  // ================================================================
  // 巡检 + 提案（第一期：第三级同事 agent）
  //
  // 纪律（改代码前先看，test/logic.test.cjs 会锁死这几条）：
  //   1. 判定全用规则 —— 下面全是纯函数，同样的数据永远给同样的发现。
  //   2. LLM 只起草说明文字，永远不进判定、不进 lines。
  //   3. 写库的笔在人手里 —— 提案只是草稿，落库必须人批准（decideProposal
  //      只返回"待落库的流水行"，真正落库由调用方 addMove 执行）。
  // ================================================================

  // ———— 四岗巡检 ————

  // 岗1 呆滞：N 天没有任何收发记录、且还压着库存的商品
  inspectStagnant(data, opts) {
    const o = opts || {}
    const days = o.days || 30
    const now = o.now || Date.now()
    const lastTs = new Map()
    data.moves.forEach(m => {
      const t = m.ts || 0
      if (t > (lastTs.get(m.itemId) || 0)) lastTs.set(m.itemId, t)
    })
    const out = []
    data.items.forEach(it => {
      const total = Logic.totalOf(it.id, data.moves)
      if (total <= 0) return                       // 没库存的不算呆滞（那是缺货）
      const idleDays = Math.floor((now - (lastTs.get(it.id) || 0)) / 86400000)
      if (idleDays < days) return
      out.push({
        key: 'stagnant:' + it.id, kind: 'stagnant', priority: 3,
        summary: `${it.name} 已 ${idleDays} 天无进出，压着 ${total} ${it.unit}`,
        detail: { itemId: it.id, sku: it.sku, name: it.name, unit: it.unit,
          total: total, lastTs: lastTs.get(it.id) || 0, idleDays: idleDays }
      })
    })
    return out
  },

  // 岗2 低库存：在库低于安全库存阈值（单品可用 item.safety 覆盖全局阈值）
  inspectLowStock(data, opts) {
    const o = opts || {}
    const safety = o.safety != null ? o.safety : 10
    const out = []
    data.items.forEach(it => {
      const s = it.safety != null ? it.safety : safety
      if (!(s > 0)) return
      const total = Logic.totalOf(it.id, data.moves)
      if (total >= s) return
      out.push({
        key: 'low:' + it.id, kind: 'low_stock', priority: 2,
        summary: `${it.name} 在库 ${total} ${it.unit}，低于安全库存 ${s}`,
        detail: { itemId: it.id, sku: it.sku, name: it.name, unit: it.unit,
          total: total, safety: s }
      })
    })
    return out
  },

  // 岗3 异常流水：负库存（逐笔滚算余额）/ 超大调整（|盘点调整量| 超阈值）
  inspectAnomalies(data, opts) {
    const o = opts || {}
    const bigQty = o.bigQty != null ? o.bigQty : 100
    const rows = [...data.moves].sort((a, b) =>
      ((a.ts || 0) - (b.ts || 0)) || String(a.id).localeCompare(String(b.id)))
    const bal = new Map()          // itemId|locationId → 滚算余额
    const out = []
    rows.forEach(m => {
      const k = m.itemId + '|' + m.locationId
      const b = (bal.get(k) || 0) + m.qty
      bal.set(k, b)
      const it = data.items.find(i => i.id === m.itemId)
      const loc = data.locations.find(l => l.id === m.locationId)
      const name = it ? it.name : m.itemId
      const locLabel = loc ? loc.label : m.locationId
      const negative = b < 0
      const huge = m.type === 'count' && Math.abs(m.qty) >= bigQty
      if (!negative && !huge) return
      out.push({
        key: 'anomaly:' + m.id, kind: 'anomaly', priority: 1,
        summary: negative
          ? `${name} ${locLabel} 出现负库存（结余 ${b}）`
          : `超大调整：${name} ${locLabel} ${m.qty > 0 ? '+' : ''}${m.qty}`.trim(),
        detail: { moveId: m.id, reason: negative ? '负库存' : '超大调整',
          itemId: m.itemId, locationId: m.locationId, loc: locLabel,
          qty: m.qty, balance: b, ts: m.ts || 0, by: m.by || m.operator || '' }
      })
    })
    return out
  },

  // 岗4 日报：今天收发/盘点的汇总（每天一条）
  dailyReport(data, opts) {
    const o = opts || {}
    const now = o.now || Date.now()
    const t0 = new Date(now); t0.setHours(0, 0, 0, 0)
    const rows = data.moves.filter(m => (m.ts || 0) >= t0.getTime() && m.type !== 'init')
    const sum = type => rows.filter(m => m.type === type).reduce((a, m) => a + Math.abs(m.qty), 0)
    const cnt = type => rows.filter(m => m.type === type).length
    return {
      date: Logic.dayKey(now),
      inN: cnt('in'), inQty: sum('in'),
      outN: cnt('out'), outQty: sum('out'),
      countN: cnt('count'), countQty: sum('count')
    }
  },

  dayKey(ts) {
    const d = new Date(ts)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0')
  },

  // 查一个区/货位上放了什么（Tools.get_zone_contents 也委托到这里，一份逻辑）
  // 单查一个货位：空也报（能回答"这里没放东西"）；查整区：空货位不列，省得刷屏
  zoneContents(data, zone) {
    const z = String(zone || '').trim().toUpperCase()
    if (!z) throw new Error('缺少 zone（区号 A/B/C 或货位编码如 A-2-1）')
    const locs = data.locations.filter(l =>
      l.zone === z || l.code === z || l.code.indexOf(z + '-') === 0)
    if (!locs.length) throw new Error('没有匹配到区或货位：' + z)

    const byLoc = new Map()
    Logic.allStock(data.moves).forEach((locMap, itemId) => {
      locMap.forEach((qty, locId) => {
        if (!qty) return
        if (!byLoc.has(locId)) byLoc.set(locId, [])
        const it = data.items.find(i => i.id === itemId)
        byLoc.get(locId).push({
          sku: it ? it.sku : itemId, name: it ? it.name : itemId,
          unit: it ? it.unit : '', qty: qty
        })
      })
    })

    const rows = locs.map(l => ({
      loc: l.code, label: l.label,
      items: (byLoc.get(l.id) || []).sort((x, y) => y.qty - x.qty)
    }))
    return locs.length === 1 ? rows : rows.filter(r => r.items.length)
  },

  // 跑一遍四岗，返回按优先级排好的发现（异常 > 低库存 > 呆滞 > 日报）
  patrolFindings(data, opts) {
    const o = opts || {}
    const out = []
      .concat(Logic.inspectAnomalies(data, o))
      .concat(Logic.inspectLowStock(data, o))
      .concat(Logic.inspectStagnant(data, o))
    const d = Logic.dailyReport(data, o)
    out.push({
      key: 'daily:' + d.date, kind: 'daily', priority: 4,
      summary: `日报 ${d.date}：收货 ${d.inN} 笔 ${d.inQty} 件 · 出库 ${d.outN} 笔 ${d.outQty} 件 · 盘点调整 ${d.countN} 笔`,
      detail: d
    })
    return out.sort((a, b) => (a.priority - b.priority) || a.key.localeCompare(b.key))
  },

  // ———— 提案生命周期 ————

  // 待办箱排序权重：越小越靠前（调查报告跟着案子走，排最前）
  proposalPriority(kind) {
    return ({ investigation: 0, anomaly: 1, low_stock: 2, stagnant: 3, daily: 4 })[kind] != null
      ? ({ investigation: 0, anomaly: 1, low_stock: 2, stagnant: 3, daily: 4 })[kind] : 9
  },

  // 该不该就这个发现立新提案：没有同 key 的、或上次处理完且过了冷却期（renagDays）才立。
  // 开着的不重复立（防刷屏）；刚拒绝的不唠叨（冷却期）；条件一直不消失，冷却过后旧事重提。
  shouldPropose(existing, key, now, renagDays) {
    const win = (renagDays != null ? renagDays : 7) * 86400000
    const same = existing.filter(p => p.key === key)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
    if (!same.length) return true
    const last = same[0]
    if (last.status === 'open' || last.status === 'superseded') return false
    return ((now || Date.now()) - (last.created_at || 0)) >= win
  },

  // 发现 → 提案草稿（agent 唯一可写处就是这张表；record 本身不落库，DB.put 由调用方做）
  newProposal(finding, opts) {
    const o = opts || {}
    const now = o.now || Date.now()
    return {
      id: o.id || ('p' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
      key: finding.key,
      kind: finding.kind,
      source: o.source || 'patrol',
      model: o.model || 'rules',
      summary: finding.summary,
      detail: finding.detail || {},
      lines: finding.lines || null,          // 可选：建议落库的流水行（人批准才生效）
      utterance: finding.utterance || '',    // 说明文字：LLM 起草（有 key 时），否则规则文案
      tool_calls: finding.tool_calls || [],  // 调查时的工具调用留痕（审计）
      status: 'open',
      created_by: o.created_by || 'AI 巡检',
      created_at: now,
      events: [{ at: now, by: o.created_by || 'AI 巡检', action: 'draft', note: '' }]
    }
  },

  // 裁决。返回 { proposal, moves }：moves 是"待落库流水行"，批准了才由调用方 addMove。
  // 拒绝必须给理由（存档）；批准人和时间写进 events —— 审计身份 = AI 起草 · 谁批准 · 何时。
  decideProposal(p, d) {
    const at = d.at || Date.now()
    const by = d.by || ''
    const moves = (d.approve && p.lines) ? p.lines.map(l => ({
      type: l.type, itemId: l.itemId, locationId: l.locationId, qty: l.qty
    })) : []
    const proposal = Object.assign({}, p, {
      status: d.approve ? 'approved' : 'rejected',
      decided_by: by, decided_at: at, decide_reason: d.reason || '',
      moves_applied: moves.map(m => m.itemId + '|' + m.locationId + '|' + m.qty),
      events: (p.events || []).concat([{
        at: at, by: by,
        action: d.approve ? 'approve' : 'reject',
        note: d.reason || '',
        moves: moves.map(m => m.type + ' ' + m.itemId + ' ' + m.locationId + ' ' + m.qty)
      }])
    })
    return { proposal: proposal, moves: moves }
  },

  // 改提案：旧记录标 superseded 留痕，新版本回到 open（非单向状态机）
  reviseProposal(p, r) {
    const at = r.at || Date.now()
    const by = r.by || ''
    const ev = { at: at, by: by, action: 'revise', note: r.note || '' }
    const old = Object.assign({}, p, {
      status: 'superseded',
      events: (p.events || []).concat([ev])
    })
    const revision = Object.assign({}, p, {
      id: r.id || ('p' + at.toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
      supersedes: p.id,
      status: 'open',
      lines: r.lines || p.lines || null,
      created_at: at,
      events: (p.events || []).concat([ev])
    })
    return { old: old, revision: revision }
  },

  // 追问留痕：Q&A 挂回提案（带着工具调用记录），提案不改状态
  appendQa(p, qa) {
    return Object.assign({}, p, {
      events: (p.events || []).concat([{
        at: qa.at || Date.now(), by: qa.by || '', action: 'ask',
        note: String(qa.q || ''), answer: String(qa.a || ''),
        tool_calls: qa.tool_calls || []
      }])
    })
  },

  // ———— 单据解析（P2：送货单文本 → 收货草稿行）————
  //
  // 分工和巡检同一条纪律：LLM 只做"文本 → 结构化"的抽取，匹配商品、推荐货位、
  // 数量校验全在这里用规则做（纯函数、可测）；产出只是草稿行，落库必须人批准。
  //
  // 行格式宽容（真实送货单五花八门）：
  //   "6204轴承 50" / "轴承 6205 x20" / "内六角螺丝 M8×30 12盒" / "平垫片 M8 40包"
  //
  // ⚠️ 数量陷阱（2026-09-27 修）：数字前面**必须有空白**才算数量。
  //   因为硬件规格里 ×N 是极常见的写法，而它紧贴着数字、前面没有空格：
  //       "内六角螺丝 M8×30"     ← ×30 是螺纹规格，不是 30 件
  //       "油封 45×65×10"        ← 是尺寸，不是 10 个
  //       "气缸 SC63×100"        ← 是缸径×行程
  //   老写法 `^(.*?)[\s:：]*(\d+)$` 里那个 `*` 允许零个空白，于是把这些规格
  //   全当成了数量 —— 粘一张只写品名的送货单，系统会凭空给出「40 件」的干净草稿。
  //   **判不出来宁可推给人工**（notes 里提示"没解析出数量"），也不猜：
  //   这是要写进库存的数字。

  parseReceipt(text) {
    const out = []
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim()
      if (!line) return
      let qty = null, desc = line

      // 1) 行尾「空白(或冒号) + 数字 + 可选单位」→ 数量。例如 "6204轴承 50"、"平垫片 M8 40包"
      let m = line.match(/^(.*?)[\s:：]+(\d+)\s*(个|盒|包|台|条|支|只|件|箱|套|米|kg|千克|克)?\s*$/i)
      if (m && m[2]) {
        desc = m[1].trim(); qty = parseInt(m[2], 10)
      } else {
        // 2) 行尾「空白 + x/×/* + 数字」→ 数量。例如 "轴承 6205 x20"
        //    中间那个空白是判据：没有空白就不进这一支（那是规格）。
        m = line.match(/^(.*?)[\s]+[x×*]\s*(\d+)\s*$/i)
        if (m && m[2]) { desc = m[1].trim(); qty = parseInt(m[2], 10) }
      }
      desc = desc.replace(/[x×*]\s*$/i, '').trim()   // "轴承 6205 x20" 的尾巴 x 不算描述
      if (!desc) { desc = line; qty = null }         // 整行是编码/名称时不当数量（"6204" ≠ 数量 6204）
      out.push({ lineNo: i + 1, raw: line, desc: desc, qty: qty })
    })
    return out
  },

  // 解析行 → 草稿落库行。匹配规则（确定性）：编码精确 > 名称精确 > 编码包含 > 名称互含。
  // 匹配不上 / 数量无效 / 无货位可放 → 不进 lines，进 notes（"待人工处理"）。
  draftReceiptRows(parsed, data) {
    const lines = []
    const notes = []
    const findItem = desc => {
      const d = String(desc || '').trim().toLowerCase()
      if (!d) return null
      return data.items.find(i => i.sku.toLowerCase() === d) ||
        data.items.find(i => i.name.toLowerCase() === d) ||
        data.items.find(i => d.indexOf(i.sku.toLowerCase()) >= 0 && i.sku.length >= 3) ||
        data.items.find(i => i.name.toLowerCase().indexOf(d) >= 0 || d.indexOf(i.name.toLowerCase()) >= 0) ||
        null
    }
    parsed.forEach((r, idx) => {
      const it = findItem(r.desc)
      if (!it) {
        notes.push(`第 ${r.lineNo} 行「${r.raw}」没匹配到商品，待人工处理`)
        return
      }
      if (!(r.qty > 0)) {
        notes.push(`第 ${r.lineNo} 行「${r.raw}」没解析出数量，待人工处理`)
        return
      }
      const loc = Logic.suggestLocation(it.id, data.moves, data.locations)
      if (!loc) {
        notes.push(`第 ${r.lineNo} 行「${it.name}」没有空货位可放，待人工指定`)
        return
      }
      lines.push({
        type: 'in', itemId: it.id, locationId: loc.id, qty: r.qty, rowIndex: idx,
        name: it.name, sku: it.sku, unit: it.unit, raw: r.raw
      })
    })
    return { lines: lines, notes: notes }
  },

  // ———— 差异调查（无 key 时的确定性兜底报告）————
  // 顺序就是老规矩：查流水 → 查同款分布 → 查邻位。每一步都留痕进 tool_calls。
  // 负库存的案子附一条"按账面补平"的建议流水行（只是建议，人可改可拒）。
  investigationFallback(data, detail) {
    const toolCalls = []
    const box = Logic.toolbox(data)
    const it = data.items.find(i => i.id === detail.itemId)
    const name = it ? it.name : detail.itemId

    // 按 itemId 过滤（在工具内部、截断之前）—— 不能取回全仓再筛，那样必空
    const recentArgs = { n: 20, itemId: detail.itemId }
    const recent = box.list_recent_moves(recentArgs)
    toolCalls.push({ tool: 'list_recent_moves', args: recentArgs, result: recent })

    const dist = box.get_dist({ sku: detail.sku || name })
    toolCalls.push({ tool: 'get_item_distribution', args: { sku: detail.sku || name }, result: dist })

    const around = Logic.zoneContents(data, detail.locationId || 'A')
    toolCalls.push({ tool: 'get_zone_contents', args: { zone: detail.locationId || 'A' }, result: around })

    const lines = []
    let suggestion = ''
    if (detail.reason === '负库存' && detail.balance < 0) {
      const fix = -detail.balance
      lines.push({ type: 'count', itemId: detail.itemId, locationId: detail.locationId, qty: fix })
      suggestion = `建议按账面补平 ${fix} ${it ? it.unit : ''}（请核对实盘，可在待办箱改数量后批准）`
    } else {
      suggestion = '建议核对原始单据与实盘，确认调整依据后再处理'
    }

    const timeline = recent.length
      ? recent.map(r => `${Logic.dayKey(r.ts)} ${r.type} ${r.qty}（${r.by || '未署名'}）`).join('；')
      : '最近没有流水记录'
    const report =
      `调查对象：${name}（${detail.sku || ''}）@ ${detail.loc || detail.locationId}\n` +
      `发现：${detail.reason}（${detail.qty > 0 ? '+' : ''}${detail.qty}，结余 ${detail.balance}）\n` +
      `时间线：${timeline}\n` +
      `同款分布：${dist && dist.dist ? dist.dist.map(d => d.loc + ' ' + d.qty).join(' · ') : '无'}\n` +
      `可能原因：${detail.reason === '负库存'
        ? '出库数量超过该货位实际在库（先出后补未记账 / 串货位拣货 / 漏记收货）'
        : '大额盘点调整，需确认是集中盘盈盘亏还是录入错误'}\n` +
      `建议动作：${suggestion}`

    return { report: report, tool_calls: toolCalls, lines: lines.length ? lines : null }
  }
}
