// js/app.js —— 界面与交互
// 路由用 hash（#receive / #ship ...），手机后退键能正常用

const S = {
  items: [], locations: [], moves: [],
  receive: null,   // { item, qty, loc, photos, picking }
  ship: null,      // { item, qty }
  count: null,     // { scope, rows, actual:{} }
  search: null,    // { kw }
  scanner: null
}

// ——————————————————————————————————————
// 小工具
// ——————————————————————————————————————
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

let toastTimer = null
function toast(msg) {
  const old = document.querySelector('.toast')
  if (old) old.remove()
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.appendChild(el)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), 2200)
}

// 按编码优先、名称兜底找商品
function findByCode(code) {
  const k = String(code || '').trim().toLowerCase()
  if (!k) return null
  return S.items.find(i => i.sku.toLowerCase() === k) ||
    S.items.find(i => i.name.toLowerCase().includes(k)) ||
    S.items.find(i => i.sku.toLowerCase().includes(k)) || null
}

// 货位分布转成一行字：A区2排1层 50 · A区2排2层 30
function distText(dist) {
  const parts = []
  dist.forEach((q, locId) => {
    const l = S.locations.find(x => x.id === locId)
    parts.push(`${l ? l.label : locId} ${q}`)
  })
  return parts.join(' · ') || '无库存'
}

// ——————————————————————————————————————
// 数据读写
// ——————————————————————————————————————
async function reload() {
  S.items = await DB.getAll('items')
  S.locations = await DB.getAll('locations')
  S.moves = await DB.getAll('moves')
  S.locations.sort((a, b) => a.code.localeCompare(b.code))
}

async function addMove(type, itemId, locationId, qty, photos) {
  const m = DB.makeMove(type, itemId, locationId, qty, photos)
  S.moves.push(m)
  await DB.put('moves', m)      // 立刻落盘，断网/关页面都不丢
  return m
}

// ——————————————————————————————————————
// 拍照（先压到 800px 再存，不然照片很快把本机存储撑满）
// ——————————————————————————————————————
function pickPhoto(cb) {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = 'image/*'
  inp.capture = 'environment'
  inp.onchange = () => {
    const f = inp.files && inp.files[0]
    if (!f) return
    shrink(f, 800).then(cb)
  }
  inp.click()
}

function shrink(file, maxSide) {
  return new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * scale)
      c.height = Math.round(img.height * scale)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      resolve(c.toDataURL('image/jpeg', 0.7))
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

// ——————————————————————————————————————
// 扫码覆盖层
// ——————————————————————————————————————
async function openScanner(onCode) {
  const demo = S.items[Math.floor(Math.random() * S.items.length)]

  const layer = document.createElement('div')
  layer.className = 'scanlayer'
  layer.innerHTML = `
    <video></video>
    <div class="scanmsg" id="scMsg">对准条码</div>
    <div class="bar">
      <button id="scCancel">取消</button>
      <button id="scDemo" style="background:#2563eb;color:#fff">模拟扫到「${esc(demo.name)}」</button>
    </div>`
  document.body.appendChild(layer)

  const msg = t => { const el = layer.querySelector('#scMsg'); if (el) el.textContent = t }

  let ctl = null
  const close = () => { if (ctl) ctl.stop(); layer.remove(); S.scanner = null }
  layer.querySelector('#scCancel').onclick = close
  layer.querySelector('#scDemo').onclick = () => { close(); onCode(demo.sku) }

  if (!Scan.cameraAvailable()) {
    close()
    toast('这台设备的浏览器不支持调用摄像头，请用手动输入')
    return
  }

  try {
    ctl = S.scanner = await Scan.start(
      layer.querySelector('video'),
      code => { close(); onCode(code) },
      note => msg(note)                 // 「正在准备扫码组件…」这类提示
    )
    if (ctl.weak) {
      msg('这台设备认不出条码')
      toast('这台设备认不出条码，点「模拟扫到」演示')
    } else {
      msg('对准条码')
    }
  } catch (e) {
    close()
    toast('扫码打不开：' + (e && e.name === 'NotAllowedError'
      ? '没有授权，或者页面不是 HTTPS' : (e && e.message) || '未知原因'))
  }
}

// ——————————————————————————————————————
// 路由与渲染
// ——————————————————————————————————————
const TITLES = {
  home: '仓库管理', receive: '收货上架', ship: '出库拣货',
  search: '库存查询', count: '盘点', overview: '库存总览'
}

function render() {
  const route = (location.hash || '#home').slice(1) || 'home'
  document.getElementById('title').textContent = TITLES[route] || '仓库管理'
  document.getElementById('backBtn').hidden = (route === 'home')
  document.getElementById('view').innerHTML = (VIEWS[route] || (() => '<p class="empty">页面不存在</p>'))()
  if (BIND[route]) BIND[route]()
  window.scrollTo(0, 0)
}

// ——————————————————————————————————————
// 首页
// ——————————————————————————————————————
function vHome() {
  let totalQty = 0
  S.items.forEach(i => { totalQty += Logic.totalOf(i.id, S.moves) })

  return `
  <div class="hero">
    <div class="hero-num">${totalQty}</div>
    <div class="hero-label">在库总件数 · ${S.items.length} 种商品 · ${S.locations.length} 个货位</div>
  </div>
  <div class="grid">
    <a class="card" href="#receive"><span class="ico">📥</span><b>收货上架</b></a>
    <a class="card" href="#ship"><span class="ico">📤</span><b>出库拣货</b></a>
    <a class="card" href="#search"><span class="ico">🔍</span><b>库存查询</b></a>
    <a class="card" href="#count"><span class="ico">📋</span><b>盘点</b></a>
  </div>
  <div class="foot">
    <a class="link" href="#overview">库存总览</a>
    <button class="link" id="syncBtn">同步</button>
    <button class="link" id="resetBtn">重置演示数据</button>
  </div>`
}

// ——————————————————————————————————————
// 收货上架
// ——————————————————————————————————————
function vReceive() {
  const r = S.receive

  // 第 1 步：扫码
  if (!r) {
    return `
    <div class="step">第 1 步 / 扫箱子上的码</div>
    <button class="big primary" id="scanBtn">📷 扫商品码</button>
    <div class="row">
      <input type="text" id="manualSku" placeholder="或手输商品编码 / 名称">
      <button class="btn" id="manualBtn">查</button>
    </div>
    <div class="hint">演示用：没有实物条码时，点下面任意商品直接开始</div>
    <div class="chips">
      ${S.items.map(i => `<button class="chip" data-sku="${esc(i.sku)}">${esc(i.name)}</button>`).join('')}
    </div>`
  }

  // 第 2 步之分支：手动挑货位
  if (r.picking) {
    const dist = Logic.distOf(r.item.id, S.moves)
    const used = new Set()
    Logic.allStock(S.moves).forEach(locMap => locMap.forEach((q, id) => { if (q) used.add(id) }))

    return `
    <div class="step">选一个货位放「${esc(r.item.name)}」</div>
    <div class="list">
      ${S.locations.map(l => {
        const same = dist.get(l.id) || 0
        const busy = used.has(l.id) && !same
        return `<div class="item" data-loc="${esc(l.id)}">
          <div class="grow">
            <div class="nm">${l.label}</div>
            <div class="sub">${same ? '同款已有 ' + same + ' 个' : (busy ? '放着别的货' : '空货位')}</div>
          </div>
          <div class="num">${same || ''}</div>
        </div>`
      }).join('')}
    </div>
    <button class="btn" id="pickBack" style="width:100%;margin-top:12px">返回</button>`
  }

  // 第 2 步：放哪儿、放多少
  const loc = r.loc
  const has = loc ? Logic.qtyAt(r.item.id, loc.id, S.moves) : 0

  return `
  <div class="step">第 2 步 / 放哪儿、放多少</div>
  <div class="panel">
    <div class="k">商品</div>
    <div class="v">${esc(r.item.name)}</div>
    <div class="sub" style="color:var(--muted);font-size:12px;margin-top:4px">
      编码 ${esc(r.item.sku)} · ${esc(r.item.spec)} · 当前库存 ${Logic.totalOf(r.item.id, S.moves)} ${esc(r.item.unit)}
    </div>
  </div>

  <div class="stepper">
    <button data-d="-1">－</button>
    <input type="number" id="rcvQty" value="${r.qty}" min="1">
    <button data-d="1">＋</button>
  </div>

  <div class="pick">
    <div class="lbl">系统建议放到</div>
    <div class="loc">${loc ? esc(loc.label) : '没有空货位'}</div>
    <div class="lbl" style="margin-top:6px">
      ${!loc ? '仓位满了，请手动指定' : (has > 0 ? `这个货位已经有 ${has} 个同款` : '这个货位还是空的')}
    </div>
  </div>
  <button class="btn" id="changeLoc" style="width:100%;margin-bottom:12px">换一个货位</button>

  <button class="big" id="photoBtn">📷 拍照存证</button>
  ${r.photos.length ? `<div class="photos">${r.photos.map(p => `<img src="${p}">`).join('')}</div>` : ''}

  <button class="big ok" id="confirmBtn">✓ 确认上架</button>
  <button class="btn" id="cancelBtn" style="width:100%">取消</button>`
}

function startReceive(item) {
  if (!item) { toast('没找到这个商品'); return }
  S.receive = {
    item: item,
    qty: 1,
    loc: Logic.suggestLocation(item.id, S.moves, S.locations),
    photos: [],
    picking: false
  }
  render()
}

async function doReceive() {
  const r = S.receive
  if (!r.loc) { toast('先选一个货位'); return }
  const qty = Math.max(1, parseInt(r.qty, 10) || 1)
  const label = r.loc.label
  await addMove('in', r.item.id, r.loc.id, qty, r.photos)
  S.receive = null
  render()
  toast(`已上架 ${qty} 个到 ${label}`)
}

// ——————————————————————————————————————
// 出库拣货
// ——————————————————————————————————————
function vShip() {
  const s = S.ship

  if (!s) {
    return `
    <div class="step">第 1 步 / 扫提货单</div>
    <button class="big primary" id="scanShip">📷 扫提货单 / 商品码</button>
    <div class="row">
      <input type="text" id="shipKw" placeholder="或手输商品编码 / 名称">
      <button class="btn" id="shipFind">查</button>
    </div>
    <div class="hint">演示用：直接点一个商品</div>
    <div class="chips">
      ${S.items.map(i => `<button class="chip" data-sku="${esc(i.sku)}">${esc(i.name)}</button>`).join('')}
    </div>`
  }

  const plan = Logic.pickPlan(s.item.id, S.moves, S.locations)
  const total = Logic.totalOf(s.item.id, S.moves)

  if (!plan.length) {
    return `<div class="empty">${esc(s.item.name)} 当前没有库存</div>
      <button class="btn" id="shipBack" style="width:100%">返回</button>`
  }

  // 按顺序算「每个货位取几个」
  let need = s.qty
  const steps = plan.map(p => {
    const take = Math.min(Math.max(need, 0), p.qty)
    need -= take
    return { loc: p.loc, have: p.qty, take: take }
  })
  const short = need

  return `
  <div class="step">第 2 步 / 去哪个货位拿</div>
  <div class="panel">
    <div class="k">商品</div>
    <div class="v">${esc(s.item.name)}</div>
    <div class="sub" style="color:var(--muted);font-size:12px;margin-top:4px">
      编码 ${esc(s.item.sku)} · 全仓共 ${total} ${esc(s.item.unit)}
    </div>
  </div>

  <div class="stepper">
    <button data-d="-1">－</button>
    <input type="number" id="shipQty" value="${s.qty}" min="1">
    <button data-d="1">＋</button>
  </div>

  <div class="list">
    ${steps.map((st, i) => `
      <div class="item">
        <div class="grow">
          <div class="nm">${i + 1}. ${st.loc.label}</div>
          <div class="sub">这个货位有 ${st.have} ${esc(s.item.unit)}</div>
        </div>
        <div class="num">${st.take > 0
          ? '取 ' + st.take
          : '<span style="color:var(--muted);font-weight:400;font-size:14px">备选</span>'}</div>
      </div>`).join('')}
  </div>

  ${short > 0 ? `<div class="panel" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c;margin-top:12px">
      全仓库存不够，还差 ${short} ${esc(s.item.unit)}</div>` : ''}

  <button class="big ok" id="shipConfirm" style="margin-top:12px">✓ 确认出库</button>
  <button class="btn" id="shipBack" style="width:100%">返回</button>`
}

function startShip(item) {
  if (!item) { toast('没找到这个商品'); return }
  S.ship = { item: item, qty: 1 }
  render()
}

async function doShip() {
  const s = S.ship
  const plan = Logic.pickPlan(s.item.id, S.moves, S.locations)
  let need = Math.max(1, parseInt(s.qty, 10) || 1)
  const done = []

  for (const p of plan) {
    if (need <= 0) break
    const take = Math.min(need, p.qty)
    if (take > 0) {
      await addMove('out', s.item.id, p.loc.id, -take, [])
      done.push(`${p.loc.label} 取 ${take}`)
    }
    need -= take
  }

  S.ship = null
  render()
  toast('已出库：' + done.join('，'))
}

// ——————————————————————————————————————
// 库存查询
// ——————————————————————————————————————
function searchResultHTML(kw) {
  const rows = Logic.search(kw, S.items, S.moves)
  if (!kw) return '<div class="empty">输入关键词开始搜索</div>'
  if (!rows.length) return '<div class="empty">没找到</div>'

  const sum = rows.reduce((a, r) => a + r.total, 0)
  return `
  <div class="list">
    ${rows.map(r => `
      <div class="item">
        <div class="grow">
          <div class="nm">${esc(r.item.name)}</div>
          <div class="sub">${esc(r.item.spec)} · ${distText(r.dist)}</div>
        </div>
        <div class="num ${r.total ? '' : 'zero'}">${r.total}</div>
      </div>`).join('')}
  </div>
  <div class="total-bar"><span>合计</span><span>${sum} ${esc(rows[0].item.unit)}</span></div>`
}

function vSearch() {
  // 首次进来默认填「轴承」—— 演示时一进来就能看到效果，不需要现场打字
  const kw = S.search ? S.search.kw : '轴承'
  return `
  <div class="row">
    <input type="text" id="searchKw" placeholder="搜商品名或编码，比如「轴承」" value="${esc(kw)}" autocomplete="off">
    <button class="btn primary" id="searchGo">搜</button>
  </div>
  <div id="searchResult">${searchResultHTML(kw)}</div>`
}

// ——————————————————————————————————————
// 盘点
// ——————————————————————————————————————
function vCount() {
  const c = S.count

  if (!c) {
    return `
    <div class="step">选择盘点范围</div>
    <button class="big primary" data-scope="ALL">全仓盘点</button>
    <button class="big" data-scope="A">A 区</button>
    <button class="big" data-scope="B">B 区</button>
    <button class="big" data-scope="C">C 区</button>
    <div class="hint">挨个货位录实际数量，对不上的会自动标红，最后能导出差异表</div>`
  }

  const rows = c.rows
  return `
  <div class="step">${c.scope === 'ALL' ? '全仓' : c.scope + ' 区'}盘点 · 共 ${rows.length} 个位点</div>
  <div class="list">
    ${rows.map(r => {
      const key = r.itemId + '|' + r.locId
      const a = c.actual[key]
      let extra = ''
      if (a !== undefined) {
        extra = (a === r.system)
          ? '<span class="diff-ok">　✓</span>'
          : `<span class="diff-red">　差异 ${a - r.system > 0 ? '+' : ''}${a - r.system}</span>`
      }
      return `<div class="item">
        <div class="grow">
          <div class="nm">${r.loc.label} <span class="pill loc">${esc(r.item.name)}</span></div>
          <div class="sub">系统数 ${r.system} ${esc(r.item.unit)}${extra}</div>
        </div>
        <input type="number" class="cnt" data-key="${esc(key)}"
               value="${a === undefined ? '' : a}" placeholder="实际"
               style="width:84px;flex:none;text-align:center;padding:9px">
      </div>`
    }).join('')}
  </div>
  <div class="actionbar">
    <div class="info"></div>
    <button class="btn" id="cntExport">导出差异表</button>
    <button class="btn primary" id="cntConfirm">确认调整</button>
  </div>`
}

// 只更新差异数字和那一行的标记，不整页重画（不然输入框会掉焦点）
function paintCountBar() {
  const c = S.count
  let filled = 0
  let diffs = 0

  c.rows.forEach(r => {
    const key = r.itemId + '|' + r.locId
    const a = c.actual[key]
    const inp = document.querySelector(`.cnt[data-key="${key}"]`)
    if (!inp) return
    const sub = inp.closest('.item').querySelector('.sub')
    let extra = ''
    if (a !== undefined) {
      filled++
      if (a === r.system) {
        extra = '<span class="diff-ok">　✓</span>'
      } else {
        extra = `<span class="diff-red">　差异 ${a - r.system > 0 ? '+' : ''}${a - r.system}</span>`
        diffs++
      }
    }
    sub.innerHTML = `系统数 ${r.system} ${esc(r.item.unit)}${extra}`
  })

  const info = document.querySelector('.actionbar .info')
  if (info) {
    info.innerHTML = `已填 ${filled}/${c.rows.length}　差异 <b class="${diffs ? 'diff-red' : ''}">${diffs}</b> 项`
  }
}

function exportDiff() {
  const c = S.count
  const rows = c.rows
    .map(r => {
      const a = c.actual[r.itemId + '|' + r.locId]
      return a === undefined ? null : { itemId: r.itemId, locId: r.locId, item: r.item, system: r.system, actual: a }
    })
    .filter(Boolean)

  if (!rows.length) { toast('还没填任何实际数量'); return }

  const csv = Logic.toCSV(rows, S.locations)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `盘点差异_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  toast('已导出差异表')
}

async function confirmCount() {
  const c = S.count
  const todo = c.rows
    .map(r => {
      const a = c.actual[r.itemId + '|' + r.locId]
      return a === undefined ? null : { r: r, a: a }
    })
    .filter(Boolean)
    .filter(x => x.a !== x.r.system)

  if (!todo.length) { toast('没有差异，不用调整'); return }
  if (!confirm(`把 ${todo.length} 项差异调整成实际数量？`)) return

  for (const x of todo) {
    await addMove('count', x.r.itemId, x.r.locId, x.a - x.r.system, [])
  }
  S.count = null
  render()
  toast(`已调整 ${todo.length} 项`)
}

// ——————————————————————————————————————
// 库存总览（给桌面看的）
// ——————————————————————————————————————
function vOverview() {
  const rows = S.items
    .map(i => ({ item: i, total: Logic.totalOf(i.id, S.moves), dist: Logic.distOf(i.id, S.moves) }))
    .sort((a, b) => b.total - a.total)

  return `
  <table>
    <thead><tr><th>商品</th><th>规格</th><th class="r">库存</th><th>货位分布</th></tr></thead>
    <tbody>
      ${rows.map(r => `<tr>
        <td>${esc(r.item.name)}</td>
        <td>${esc(r.item.spec)}</td>
        <td class="r">${r.total}</td>
        <td>${distText(r.dist)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <div class="total-bar"><span>合计</span><span>${rows.reduce((a, r) => a + r.total, 0)} 件</span></div>`
}

// ——————————————————————————————————————
// 事件绑定
// ——————————————————————————————————————
const VIEWS = { home: vHome, receive: vReceive, ship: vShip, search: vSearch, count: vCount, overview: vOverview }

const BIND = {
  home() {
    document.getElementById('syncBtn').onclick = async () => {
      const n = await DB.sync(S.moves)
      toast(n ? `已同步 ${n} 条记录` : '没有待同步的记录')
    }
    document.getElementById('resetBtn').onclick = async () => {
      if (!confirm('清空并恢复成演示数据？')) return
      await DB.reset()
      await reload()
      render()
      toast('已重置')
    }
  },

  receive() {
    const r = S.receive

    if (!r) {
      document.getElementById('scanBtn').onclick = () => openScanner(code => {
        startReceive(findByCode(code))
      })
      document.getElementById('manualBtn').onclick = () => {
        startReceive(findByCode(document.getElementById('manualSku').value))
      }
      document.querySelectorAll('.chip').forEach(c => {
        c.onclick = () => startReceive(findByCode(c.dataset.sku))
      })
      return
    }

    if (r.picking) {
      document.querySelectorAll('[data-loc]').forEach(el => {
        el.onclick = () => {
          r.loc = S.locations.find(l => l.id === el.dataset.loc) || r.loc
          r.picking = false
          render()
        }
      })
      document.getElementById('pickBack').onclick = () => { r.picking = false; render() }
      return
    }

    const qtyEl = document.getElementById('rcvQty')
    document.querySelectorAll('.stepper button').forEach(b => {
      b.onclick = () => {
        const v = Math.max(1, (parseInt(qtyEl.value, 10) || 0) + parseInt(b.dataset.d, 10))
        qtyEl.value = v
        r.qty = v
      }
    })
    qtyEl.oninput = () => { r.qty = Math.max(1, parseInt(qtyEl.value, 10) || 1) }
    qtyEl.onblur = () => { qtyEl.value = r.qty }

    document.getElementById('photoBtn').onclick = () => pickPhoto(d => {
      if (d) { r.photos.push(d); render() }
    })
    document.getElementById('changeLoc').onclick = () => { r.picking = true; render() }
    document.getElementById('cancelBtn').onclick = () => { S.receive = null; render() }
    document.getElementById('confirmBtn').onclick = doReceive
  },

  ship() {
    const s = S.ship

    if (!s) {
      document.getElementById('scanShip').onclick = () => openScanner(code => {
        startShip(findByCode(code))
      })
      document.getElementById('shipFind').onclick = () => {
        startShip(findByCode(document.getElementById('shipKw').value))
      }
      document.querySelectorAll('.chip').forEach(c => {
        c.onclick = () => startShip(findByCode(c.dataset.sku))
      })
      return
    }

    const back = document.getElementById('shipBack')
    if (back) back.onclick = () => { S.ship = null; render() }
    const conf = document.getElementById('shipConfirm')
    if (!conf) return

    const qtyEl = document.getElementById('shipQty')
    document.querySelectorAll('.stepper button').forEach(b => {
      b.onclick = () => {
        const v = Math.max(1, (parseInt(qtyEl.value, 10) || 0) + parseInt(b.dataset.d, 10))
        qtyEl.value = v
        s.qty = v
        render()                     // 数量变了，「每个货位取几个」要重算
      }
    })
    qtyEl.oninput = () => { s.qty = Math.max(1, parseInt(qtyEl.value, 10) || 1) }
    qtyEl.onblur = () => render()
    conf.onclick = doShip
  },

  search() {
    const inp = document.getElementById('searchKw')
    const paint = () => {
      S.search = { kw: inp.value }
      document.getElementById('searchResult').innerHTML = searchResultHTML(inp.value)
    }
    inp.oninput = paint
    document.getElementById('searchGo').onclick = paint
    paint()                          // 初始化（首次会把默认的「轴承」写进 state）
  },

  count() {
    const c = S.count

    if (!c) {
      document.querySelectorAll('[data-scope]').forEach(b => {
        b.onclick = () => {
          const scope = b.dataset.scope
          S.count = {
            scope: scope,
            actual: {},
            rows: Logic.countSheet(scope, S.moves, S.locations, S.items)
          }
          render()
        }
      })
      return
    }

    document.querySelectorAll('.cnt').forEach(inp => {
      inp.oninput = () => {
        const k = inp.dataset.key
        if (inp.value === '') delete c.actual[k]
        else c.actual[k] = parseInt(inp.value, 10) || 0
        paintCountBar()
      }
    })
    document.getElementById('cntExport').onclick = exportDiff
    document.getElementById('cntConfirm').onclick = confirmCount
    paintCountBar()
  }
}

// ——————————————————————————————————————
// 启动
// ——————————————————————————————————————
async function boot() {
  await DB.ensureSeed()
  await reload()

  window.addEventListener('hashchange', render)
  window.addEventListener('online', updateNet)
  window.addEventListener('offline', updateNet)
  updateNet()
  render()

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {})
  }
}

function updateNet() {
  const el = document.getElementById('net')
  const on = navigator.onLine
  el.textContent = on ? '在线' : '离线'
  el.className = 'net' + (on ? ' on' : ' off')
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('backBtn').onclick = () => { location.hash = '#home' }
  boot()
})
