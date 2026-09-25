// js/logic.js —— 业务逻辑（纯函数，不碰界面）
//
// 核心设计：库存不是一个「数字字段」，而是「流水求和」算出来的。
// 好处是两台手机离线各记各的，回传时把流水加在一起就行，不会互相覆盖。
// 代价是每次算库存要遍历一遍流水 —— 几千条的量级无所谓。

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
      if (!best || q > best.qty) best = { locId: locId, qty: q }
    })
    if (best) return locations.find(l => l.id === best.locId) || null

    const used = new Set()
    this.allStock(moves).forEach(locMap => {
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
  // 导出差异表（CSV）
  // 前面那个 ﻿ 是 BOM，不加的话 Excel 打开中文是乱码
  // ——————————————————————————————————
  toCSV(rows, locations) {
    const head = ['货位', '商品编码', '商品名称', '规格', '单位', '系统数', '实际数', '差异']
    const lines = [head.join(',')]
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
      ].join(','))
    })
    return '﻿' + lines.join('\r\n')
  }
}
