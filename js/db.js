// js/db.js —— 数据层
// 所有数据存在浏览器本机（IndexedDB），所以断网照常用。
// 联网后的回传由 sync() 负责 —— demo 阶段是模拟，接后端时只改那一个函数。

const DB_NAME = 'stock_web'
const DB_VER = 1

// stores: items 商品 / locations 货位 / moves 流水
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
  await clear('items')
  await clear('locations')
  await clear('moves')
  await ensureSeed()
}

// 建一条流水
function makeMove(type, itemId, locationId, qty, photos) {
  return {
    id: newMoveId(),
    type: type,
    itemId: itemId,
    locationId: locationId,
    qty: qty,
    photos: photos || [],
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

const DB = { open, getAll, put, clear, bulkPut, ensureSeed, reset, makeMove, sync, newMoveId }
