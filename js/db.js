// js/db.js —— 数据层
// 所有数据存在浏览器本机（IndexedDB），所以断网照常用。
// 联网后的回传由 sync() 负责 —— demo 阶段是模拟，接后端时只改那一个函数。

const DB_NAME = 'stock_web'
const DB_VER = 2

// stores: items 商品 / locations 货位 / moves 流水 / proposals AI 提案（只追加）
let _db = null

function open() {
  if (_db) return Promise.resolve(_db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = e => {
      const db = e.target.result
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'id' }).createIndex('sku', 'sku')
      }
      if (!db.objectStoreNames.contains('locations')) {
        db.createObjectStore('locations', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('moves')) {
        const s = db.createObjectStore('moves', { keyPath: 'id' })
        s.createIndex('itemId', 'itemId')
        s.createIndex('locationId', 'locationId')
      }
      if (!db.objectStoreNames.contains('proposals')) {
        // AI 起草、人来确认的提案表。只追加语义：写入后不许改历史，
        // 状态流转用新版本记录（P2 送货单解析启用；形状先定死在这里）：
        // { id, kind, source, model, utterance, tool_calls, lines,
        //   status, created_by, changes, created_at }
        db.createObjectStore('proposals', { keyPath: 'id' })
      }
    }
    req.onsuccess = () => { _db = req.result; resolve(_db) }
    req.onerror = () => reject(req.error)
  })
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

const getAll = store => tx(store, 'readonly', s => s.getAll())
const put = (store, obj) => tx(store, 'readwrite', s => s.put(obj))
const clear = store => tx(store, 'readwrite', s => s.clear())
const bulkPut = (store, arr) => tx(store, 'readwrite', s => {
  arr.forEach(o => s.put(o))
  return s.count()   // 同一个事务里，count 成功就代表前面的 put 都成功了
})

// ——————————————————————————————————————————————
// 流水号：时间戳 + 序号 + 随机后缀
// 多台手机离线各记各的，回传时也不会撞号
// ——————————————————————————————————————————————
let _seq = 0
function newMoveId() {
  return 'm' + Date.now().toString(36) +
    '_' + (++_seq).toString(36) +
    '_' + Math.random().toString(36).slice(2, 6)
}

// 期初时间戳：固定在一个过去的时刻，让期初流水排在最前面
const SEED_TS = new Date('2026-09-01T08:00:00').getTime()

// ——————————————————————————————————————————————
// 种子数据：一套五金仓的样例
// 货位编码 A-2-1 = A区 2排 1层，界面上显示成「A区2排1层」
// ——————————————————————————————————————————————
function seedLocations() {
  const out = []
  ;['A', 'B', 'C'].forEach(z => {
    for (let r = 1; r <= 4; r++) {
      for (let l = 1; l <= 3; l++) {
        out.push({
          id: `${z}-${r}-${l}`,
          code: `${z}-${r}-${l}`,
          label: `${z}区${r}排${l}层`,
          zone: z, row: r, layer: l
        })
      }
    }
  })
  return out   // 3 区 × 4 排 × 3 层 = 36 个货位
}

// stock: [ [货位, 期初数量], ... ]
// 三种轴承加起来正好 156 个 —— 搜「轴承」能看到一个多货位汇总的典型例子
const SEED_ITEMS = [
  { sku: '6204', name: '轴承 6204', spec: '内径20 外径47', unit: '个',
    stock: [['A-2-1', 50], ['A-2-2', 30]] },
  { sku: '6205', name: '轴承 6205', spec: '内径25 外径52', unit: '个',
    stock: [['A-2-2', 20], ['B-1-1', 26]] },
  { sku: '6308', name: '轴承 6308', spec: '内径40 外径90', unit: '个',
    stock: [['C-3-1', 30]] },

  { sku: 'LS-M8', name: '内六角螺丝 M8×30', spec: '不锈钢 304', unit: '盒',
    stock: [['A-1-1', 12]] },
  { sku: 'DP-M8', name: '平垫片 M8', spec: '镀锌', unit: '包',
    stock: [['A-1-2', 40], ['A-1-3', 8]] },
  { sku: 'YF-4565', name: '油封 45×65×10', spec: '丁腈橡胶', unit: '个',
    stock: [['A-3-1', 60]] },

  { sku: 'DJ-1.5', name: '三相异步电机 1.5kW', spec: '4极 B3', unit: '台',
    stock: [['B-2-1', 6], ['B-2-2', 3]] },
  { sku: 'PD-A', name: '三角皮带 A型', spec: 'A-1000', unit: '条',
    stock: [['B-1-2', 22]] },
  { sku: 'LZ-LM', name: '弹性联轴器', spec: '外径 105', unit: '个',
    stock: [['B-3-1', 9]] },

  { sku: 'CL-20T', name: '齿轮 20齿', spec: '模数 2', unit: '个',
    stock: [['C-1-1', 18]] },
  { sku: 'DCV-220', name: '电磁阀', spec: 'AC220V 二位五通', unit: '个',
    stock: [['C-2-1', 14], ['C-2-2', 11]] },
  { sku: 'QG-63', name: '气缸 SC63×100', spec: '标准型', unit: '支',
    stock: [['C-3-2', 7]] }
]

// ——————————————————————————————————————————————
// 灌种子（只在库空着的时候灌一次）
// ——————————————————————————————————————————————
async function ensureSeed() {
  const exist = await getAll('moves')
  if (exist.length) return false

  await bulkPut('locations', seedLocations())

  const items = []
  const moves = []
  let n = 0

  SEED_ITEMS.forEach(it => {
    const id = 'it_' + it.sku
    items.push({ id, sku: it.sku, name: it.name, spec: it.spec, unit: it.unit })
    it.stock.forEach(([loc, qty]) => {
      moves.push({
        id: newMoveId(),
        type: 'init',          // init 期初 / in 收货 / out 出库 / count 盘点调整
        itemId: id,
        locationId: loc,
        qty: qty,
        photos: [],
        by: '期初',            // 操作人：谁经手的这条流水
        ts: SEED_TS + (++n) * 1000,
        synced: 1
      })
    })
  })

  await bulkPut('items', items)
  await bulkPut('moves', moves)
  return true
}

// 演示用：清空重来
async function reset() {
  // proposals 也要清：它是审计台账，留着会指向已经被清掉的商品/货位，
  // 在待办箱里点「批准」就能落出查不到商品的幽灵流水。
  await clear('items')
  await clear('locations')
  await clear('moves')
  await clear('proposals')
  await ensureSeed()
}

// 建一条流水（id 是幂等键：多机离线各记各的，回传时服务端按 id 去重）
// by = operator（历史归因）；counterparty = 交易对手（供应商/客户/承运商）。
// v1 的老流水没有这两个字段，不回填，读取处一律 (m.operator || m.by || '') 兜底，不伪造。
function makeMove(type, itemId, locationId, qty, photos, by, counterparty) {
  return {
    id: newMoveId(),
    type: type,
    itemId: itemId,
    locationId: locationId,
    qty: qty,
    photos: photos || [],
    by: by || '',                  // 兼容 v1 老数据的显示字段（= operator）
    operator: by || '',            // 操作人：谁经手的（留痕归一，新代码读这个）
    counterparty: counterparty || '',  // 交易对手：跟谁发生的这笔账（可空）
    ts: Date.now(),
    synced: 0               // 0 = 还没回传，等联网了同步
  }
}

// ——————————————————————————————————————————————
// 回传（demo 阶段是模拟：把没同步的流水标记成已同步并打印出来）
// 接真后端时，把这里换成 fetch('/api/moves', {...}) 即可
// ——————————————————————————————————————————————
async function sync(moves) {
  const pending = moves.filter(m => !m.synced)
  if (!pending.length) return 0
  // await fetch('/api/moves', { method:'POST', body: JSON.stringify(pending) })
  for (const m of pending) {
    m.synced = 1
    await put('moves', m)
  }
  return pending.length
}

// ——————————————————————————————————————————————
// 一次事务里同时写「提案状态」和「流水」
//
// 为什么不能一条一条 put：待办箱批准落库是**改库存**的动作。中间挂掉
// （关页面、配额满、崩溃）会留下半套状态：
//   · 流水写了、提案还开着 → 用户再点一次就翻倍（原来的顺序就是这个，实测会中招）
//   · 提案批了、流水没写   → 账少了，而且状态是终态、改不回来
// IndexedDB 本身支持跨表事务，用它把这件事变成原子的：要么都成，要么都不成。
// ——————————————————————————————————————————————
function applyDecision(proposal, moves) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(['proposals', 'moves'], 'readwrite')
    t.objectStore('proposals').put(proposal)
    const ms = t.objectStore('moves')
    moves.forEach(m => ms.put(m))
    t.oncomplete = () => resolve(moves.length)
    t.onerror = () => reject(t.error || new Error('写入失败'))
    t.onabort = () => reject(t.error || new Error('事务被中止'))
  }))
}

const ALL_STORES = ['items', 'locations', 'moves', 'proposals']

// 整库替换（导入备份用）：四张表在**一个事务**里清空 + 重写。
//
// 为什么不能一条一条 clear/put：导入是「先清后写」，中途失败（配额满、浏览器被杀）
// 会让**新旧两份数据同时消失**，而原来只弹一句「导入失败」。放进一个事务里，
// 失败自动回滚，库要么是旧的、要么是新的。
function replaceAll(data) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(ALL_STORES, 'readwrite')
    ALL_STORES.forEach(s => t.objectStore(s).clear())
    ;(data.items || []).forEach(o => t.objectStore('items').put(o))
    ;(data.locations || []).forEach(o => t.objectStore('locations').put(o))
    ;(data.moves || []).forEach(o => t.objectStore('moves').put(o))
    ;(data.proposals || []).forEach(o => t.objectStore('proposals').put(o))
    t.oncomplete = () => resolve(true)
    t.onerror = () => reject(t.error || new Error('写入失败'))
    t.onabort = () => reject(t.error || new Error('事务被中止（已回滚，原数据没动）'))
  }))
}

const DB = {
  open, getAll, put, clear, bulkPut, ensureSeed, reset, makeMove, sync, newMoveId,
  applyDecision, replaceAll
}
