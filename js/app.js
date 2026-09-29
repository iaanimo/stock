// js/app.js —— 界面与交互
// 路由用 hash（#receive / #ship ...），手机后退键能正常用

const S = {
  items: [], locations: [], moves: [], proposals: [],
  receive: null,   // { item, qty, loc, photos, picking }
  ship: null,      // { item, qty }
  count: null,     // { scope, rows, actual:{} }
  search: null,    // { kw }
  scanner: null,
  draft: null,     // 送货单解析：{ text, rows, source, notes }
  propTab: 'open'  // 待办箱筛选：open / done / all
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

// 本地日期 YYYY-MM-DD。
// ⚠️ 别用 `new Date().toISOString().slice(0,10)` —— 那是 **UTC**。
//    中国时区（UTC+8）凌晨 0–8 点导出的文件会被命名成"昨天"，
//    跟界面/日报（都用本地时间）对不上。
function localDateStr(d) {
  const t = d || new Date()
  const p = n => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
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
    // ⚠️ 必须 esc：distText 的返回值会被直接拼进 innerHTML（库存查询、库存总览）。
    //    货位名目前只能从「导入备份」进来，所以这是注入面 —— 实测 label 塞
    //    <img src=x onerror=...> 能在 5 个页面执行脚本。
    parts.push(`${esc(l ? l.label : locId)} ${q}`)
  })
  return parts.join(' · ') || '无库存'
}

// ——————————————————————————————————————
// 待办箱小工具
// ——————————————————————————————————————
function fmtTime(ts) {
  const d = new Date(ts || 0)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const PROP_KINDS = {
  investigation: '调查报告', anomaly: '异常流水',
  low_stock: '低库存', stagnant: '呆滞', daily: '日报'
}

// 审计轨迹一行字（审计身份 = AI 起草 · 谁批准 · 何时）
function evText(ev) {
  const t = fmtTime(ev.at)
  if (ev.action === 'draft') return `${t} · ${ev.by} 起草`
  if (ev.action === 'approve') return `${t} · ${ev.by} 批准` +
    (ev.moves && ev.moves.length ? '（已落库 ' + esc(ev.moves.join('；')) + '）' : '（采纳归档）')
  if (ev.action === 'reject') return `${t} · ${ev.by} 拒绝（${esc(ev.note)}）`
  if (ev.action === 'revise') return `${t} · ${ev.by} 改提案（${esc(ev.note)}）`
  if (ev.action === 'ask') return `${t} · ${ev.by} 追问：${esc(ev.note)}\n→ ${esc(ev.answer)}`
  return t
}

// 建议流水行人话化：盘点调整 +7 @ A区2排1层
function linesText(p) {
  return (p.lines || []).map(l => {
    const it = S.items.find(i => i.id === l.itemId)
    const loc = S.locations.find(x => x.id === l.locationId)
    const typeName = { in: '收货', out: '出库', count: '盘点调整', init: '期初' }[l.type] || l.type
    return `${typeName} ${l.qty > 0 ? '+' : ''}${l.qty} ${it ? it.unit : ''} @ ${loc ? loc.label : l.locationId}（${it ? it.name : l.itemId}）`
  }).join('；')
}

// ——————————————————————————————————————
// 数据读写
// ——————————————————————————————————————
async function reload() {
  S.items = await DB.getAll('items')
  S.locations = await DB.getAll('locations')
  S.moves = await DB.getAll('moves')
  S.proposals = await Patrol.list()
  S.locations.sort((a, b) => a.code.localeCompare(b.code))
}

// ——————————————————————————————————————
// 写库在途闸（2026-09-30 修）
//
// 三个落库按钮（确认上架 / 确认出库 / 确认盘点调整）原来都是「await 落盘 → 再清界面状态」。
// 而手机上双击是常态：两次点击都能通过界面检查（状态还没清），同一批流水就落两遍 ——
// 实测「确认上架」双击后库存翻倍，两条 in 流水 id 不同、内容一模一样。
//
// 闸必须是【同步占位】：设闸和检查之间不能有 await，否则两个并发调用会同时通过检查。
// 待办箱的「通过」用的是同一套做法（见 js/patrol.js 的 _deciding）。
// ——————————————————————————————————————
let _writing = false

async function addMove(type, itemId, locationId, qty, photos, counterparty, by) {
  // by 可显式指定（待办箱批准落库时=批准人）；不传则记当前操作人
  const m = DB.makeMove(type, itemId, locationId, qty, photos, by || CONFIG.operator || '', counterparty || '')
  S.moves.push(m)
  await DB.put('moves', m)      // 立刻落盘，断网/关页面都不丢
  return m
}

// ——————————————————————————————————————
// 备份导出/导入（全量 JSON —— 也是将来真后端的数据合同）
// ——————————————————————————————————————
async function exportBackup() {
  // 待办箱也要导出：它是审计台账（谁在何时批准/拒绝了什么），丢了重建不出来
  const proposals = await DB.getAll('proposals')
  const text = Logic.toBackup({
    items: S.items, moves: S.moves, locations: S.locations, proposals: proposals
  })
  const blob = new Blob([text], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'stock-backup-' + localDateStr() + '.json'
  a.click()
  // 别紧跟 click 就回收：部分浏览器会因此掐断下载（exportDiff 那边一直用的延时）
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  toast(`已导出备份（含 ${proposals.length} 条待办记录）`)
}

function importBackup() {
  const inp = document.createElement('input')
  inp.type = 'file'
  inp.accept = '.json,application/json'
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]
    if (!f) return
    try {
      const data = Logic.parseBackup(await f.text())
      const noProps = data.proposals === null
      const msg = `导入备份：${data.items.length} 种商品 / ${data.moves.length} 条流水` +
        (noProps
          ? '\n\n⚠️ 这份备份是老版本导出的，不含待办箱记录 —— 导入后待办箱会清空。'
          : ` / ${data.proposals.length} 条待办记录`) +
        '\n\n现有数据会被整库替换（一个事务，失败自动回滚，不会两头空）。'
      if (!confirm(msg)) return

      // ⚠️ 整库替换走一个 IndexedDB 事务。
      //    原来是「先 clear 三张表、再逐个 bulkPut」，中途失败（配额满、页面被杀）
      //    会让新旧两份数据同时消失，而用户只看到一句"导入失败"。
      await DB.replaceAll(noProps ? Object.assign({}, data, { proposals: [] }) : data)
      await reload()
      render()
      toast('已导入备份')
    } catch (e) {
      toast('导入失败：' + (e && e.message || '未知错误'))
    }
  }
  inp.click()
}

function setOperator() {
  const v = prompt('操作人姓名（会记在每条流水上，留痕用）', CONFIG.operator || '')
  if (v === null) return
  saveConfig({ operator: v.trim() })
  render()
  toast(CONFIG.operator ? `操作人：${CONFIG.operator}` : '已清空操作人')
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
  // ⚠️ 商品表可能是空的（导入了一份 items:[] 的备份就会）。
  //    原来是 S.items[0].name 直接取 —— 空数组得到 undefined，
  //    在拼模板时抛异常；而异常发生在覆盖层插入之前，用户点「扫商品码」
  //    毫无反应、也没有任何提示（async 函数里只变成一条 unhandled rejection）。
  const demo = S.items.length
    ? S.items[Math.floor(Math.random() * S.items.length)]
    : null

  const layer = document.createElement('div')
  layer.className = 'scanlayer'
  layer.innerHTML = `
    <video></video>
    <div class="scanmsg" id="scMsg">对准条码</div>
    <div class="bar">
      <button id="scCancel">取消</button>
      ${demo
        ? `<button id="scDemo" style="background:#2563eb;color:#fff">模拟扫到「${esc(demo.name)}」</button>`
        : `<button id="scDemo" disabled style="opacity:.5">没有商品可模拟</button>`}
    </div>`
  document.body.appendChild(layer)

  const msg = t => { const el = layer.querySelector('#scMsg'); if (el) el.textContent = t }

  // ⚠️ closed 这个标志是必需的。
  //    Scan.start 里要等 polyfill 加载（线上首次是秒级到十秒级）。在这段时间里点
  //    「取消」：原来的 close() 里 ctl 还是 null，**什么都停不了**；等 await 回来
  //    ctl 又被赋值，于是摄像头一直开着 —— 而覆盖层已经移除，用户再也点不到取消。
  //    而且 onCode 照样会回调，把用户莫名推进「收货第 2 步」。
  let closed = false
  let ctl = null
  const close = () => {
    closed = true
    if (ctl) ctl.stop()
    layer.remove()
    S.scanner = null
  }
  layer.querySelector('#scCancel').onclick = close
  if (demo) layer.querySelector('#scDemo').onclick = () => { close(); onCode(demo.sku) }

  if (!Scan.cameraAvailable()) {
    close()
    toast('这台设备的浏览器不支持调用摄像头，请用手动输入')
    return
  }

  try {
    const got = await Scan.start(
      layer.querySelector('video'),
      code => { if (closed) return; close(); onCode(code) },   // 关掉之后的回调一律不理
      note => { if (!closed) msg(note) }                       // 「正在准备扫码组件…」
    )
    if (closed) { got.stop(); return }      // 等待期间被取消了 → 立刻把摄像头关掉
    ctl = S.scanner = got
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
  search: '库存查询', count: '盘点', overview: '库存总览', ask: 'AI 问答', proposals: '待办箱'
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
    <a class="card" href="#ask"><span class="ico">🤖</span><b>AI 问答</b><small>问一句查库存 · 只读</small></a>
    <a class="card" href="#proposals"><span class="ico">📬</span><b>待办箱</b><small>${S.proposals.filter(p => p.status === 'open').length} 条待办 · AI 起草你批准</small></a>
  </div>
  <div class="foot">
    <a class="link" href="#overview">库存总览</a>
    <button class="link" id="syncBtn">同步</button>
    <button class="link" id="backupExp">导出备份</button>
    <button class="link" id="backupImp">导入备份</button>
    <button class="link" id="opBtn">操作人${CONFIG.operator ? '：' + esc(CONFIG.operator) : ''}</button>
    <button class="link" id="resetBtn">重置演示数据</button>
  </div>`
}

// ——————————————————————————————————————
// 收货上架
// ——————————————————————————————————————
function vReceive() {
  const r = S.receive

  // 分支：粘贴送货单 → AI 起草收货提案（批准才落库）
  if (S.draft) return vDraft()

  // 第 1 步：扫码
  if (!r) {
    return `
    <div class="step">第 1 步 / 扫箱子上的码</div>
    <button class="big primary" id="scanBtn">📷 扫商品码</button>
    <div class="row">
      <input type="text" id="manualSku" placeholder="或手输商品编码 / 名称">
      <button class="btn" id="manualBtn">查</button>
    </div>
    <button class="btn" id="draftBtn" style="width:100%;margin-top:10px">📋 粘贴送货单，AI 起草收货提案</button>
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
            <div class="nm">${esc(l.label)}</div>
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

// ——————————————————————————————————————
// 送货单解析（draft_receipt）：粘贴文本 → 起草收货提案 → 人批准才落库
// ——————————————————————————————————————
function vDraft() {
  const d = S.draft

  if (!d.rows) {
    return `
    <div class="step">粘贴送货单文本 · AI 起草收货提案（批准才落库）</div>
    <textarea id="draftText" rows="8" placeholder="每行一件：编码或名称 + 数量&#10;比如：&#10;6204轴承 50&#10;内六角螺丝 M8×30 12盒">${esc(d.text || '')}</textarea>
    <button class="big primary" id="draftParse">解析</button>
    <button class="btn" id="draftCancel" style="width:100%">返回</button>`
  }

  const pv = d.preview || { lines: [], notes: [] }
  const rowsHtml = pv.lines.map(l => {
    const it = S.items.find(x => x.id === l.itemId)
    const loc = S.locations.find(x => x.id === l.locationId)
    return `<div class="item">
      <div class="grow">
        <div class="nm">${esc(it ? it.name : l.itemId)}</div>
        <div class="sub">${esc(it ? it.sku + ' · ' + it.spec : '')} → ${esc(loc ? loc.label : '待指定')}</div>
      </div>
      <input type="number" class="dq" data-dq="${l.rowIndex}" value="${l.qty}" min="1" style="width:72px">
    </div>`
  }).join('')

  return `
  <div class="step">解析结果（可改数量，送审后仍可改可拒）</div>
  <div class="hint">来源：${d.source === 'llm' ? 'AI 抽取 + 规则匹配' : '规则解析（未接 AI 模型）'}</div>
  ${pv.lines.length ? `<div class="list">${rowsHtml}</div>` : ''}
  ${pv.notes.length ? `<div class="hint">${pv.notes.map(esc).join('<br>')}</div>` : ''}
  <button class="big ok" id="draftSubmit">送审到待办箱</button>
  <button class="btn" id="draftBack" style="width:100%">返回重贴</button>`
}

async function doReceive() {
  if (_writing) return                       // 在途闸：同步挡掉第二次点击
  const r = S.receive
  if (!r.loc) { toast('先选一个货位'); return }
  const qty = Math.max(1, parseInt(r.qty, 10) || 1)
  const label = r.loc.label
  _writing = true
  try {
    await addMove('in', r.item.id, r.loc.id, qty, r.photos)
    S.receive = null
    render()
    toast(`已上架 ${qty} 个到 ${label}`)
  } finally {
    _writing = false
  }
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

  <div id="shipPlan">${shipPlanHTML(s)}</div>

  <button class="big ok" id="shipConfirm" style="margin-top:12px">✓ 确认出库</button>
  <button class="btn" id="shipBack" style="width:100%">返回</button>`
}

// 「先去哪个货位、各取几个」这一段单独抽出来，是为了能**只重画这一段**。
//
// ⚠️ 数量一变就 render() 整页是个坑：点按钮时输入框会先失焦，如果 onblur 里
//    调 render()，整个 #view 会被重建，鼠标抬起落在已经被移除的节点上 →
//    **点击被吞掉**。实测：改完数量后第一下点「确认出库」和「＋/－」全部失灵，
//    而且界面毫无反馈，第二下才生效。盘点页的 paintCountBar 就是"只改数字不重画"。
function shipPlanHTML(s) {
  const plan = Logic.pickPlan(s.item.id, S.moves, S.locations)
  let need = s.qty
  const steps = plan.map(p => {
    const take = Math.min(Math.max(need, 0), p.qty)
    need -= take
    return { loc: p.loc, have: p.qty, take: take }
  })
  const short = need
  return `
  <div class="list">
    ${steps.map((st, i) => `
      <div class="item">
        <div class="grow">
          <div class="nm">${i + 1}. ${esc(st.loc.label)}</div>
          <div class="sub">这个货位有 ${st.have} ${esc(s.item.unit)}</div>
        </div>
        <div class="num">${st.take > 0
          ? '取 ' + st.take
          : '<span style="color:var(--muted);font-weight:400;font-size:14px">备选</span>'}</div>
      </div>`).join('')}
  </div>

  ${short > 0 ? `<div class="panel" style="border-color:#fecaca;background:#fef2f2;color:#b91c1c;margin-top:12px">
      全仓库存不够，还差 ${short} ${esc(s.item.unit)}</div>` : ''}`
}

function startShip(item) {
  if (!item) { toast('没找到这个商品'); return }
  S.ship = { item: item, qty: 1 }
  render()
}

async function doShip() {
  if (_writing) return                       // 在途闸（同上）
  const s = S.ship
  const plan = Logic.pickPlan(s.item.id, S.moves, S.locations)
  let need = Math.max(1, parseInt(s.qty, 10) || 1)
  const total = Logic.totalOf(s.item.id, S.moves)

  // 库存不足不许静默少发：要么先去收货补库，要么明确确认按现有库存发
  if (total <= 0) { toast('没有库存可发'); return }
  if (need > total) {
    const okGo = confirm(`全仓只有 ${total} ${s.item.unit}，要发 ${need}，缺 ${need - total}。\n` +
      `确认按现有库存只发 ${total} 吗？（取消 = 不出库，先去收货）`)
    if (!okGo) return
    need = total
  }

  _writing = true
  try {
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
  } finally {
    _writing = false
  }
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
          <div class="nm">${esc(r.loc.label)} <span class="pill loc">${esc(r.item.name)}</span></div>
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
  a.download = `盘点差异_${localDateStr()}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  toast('已导出差异表')
}

async function confirmCount() {
  if (_writing) return                       // 在途闸（同上）
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

  _writing = true
  try {
    for (const x of todo) {
      await addMove('count', x.r.itemId, x.r.locId, x.a - x.r.system, [])
    }
    S.count = null
    render()
    toast(`已调整 ${todo.length} 项`)
  } finally {
    _writing = false
  }
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
// AI 问答（只读：问库存/流水，绝不写数据）
// ——————————————————————————————————————
function vAsk() {
  const src = CONFIG.mode === 'prod' ? '服务器代理'
    : (CONFIG.llmEndpoint && CONFIG.llmKey ? 'AI 模型 · ' + CONFIG.llmModel : '本地规则（未接 AI 模型）')
  return `
  <div class="step">问一句，查库存 · 只读，不会改动任何数据</div>
  <div class="row">
    <input type="text" id="askQ" placeholder="比如：轴承还剩多少">
    <button class="btn primary" id="askGo">问</button>
    <button class="btn" id="askMic" title="语音输入">🎤</button>
  </div>
  <div class="hint">试试：「轴承还剩多少」 · 「6204 在哪个货位」 · 「今天出了多少货」</div>
  <div id="askOut"></div>
  <div class="foot"><button class="link" id="askCfg">AI 连接设置（当前：${esc(src)}）</button></div>`
}

// ——————————————————————————————————————
// 待办箱（agent 只起草，落库必须人批准）
// ——————————————————————————————————————
function vProposals() {
  const open = S.proposals.filter(p => p.status === 'open')
  const done = S.proposals.filter(p => p.status !== 'open')
  const tab = S.propTab
  const rows = tab === 'open' ? open : (tab === 'done' ? done : S.proposals)

  const tabs = `<div class="chips">
    <button class="chip ${tab === 'open' ? 'on' : ''}" data-tab="open">待处理 ${open.length}</button>
    <button class="chip ${tab === 'done' ? 'on' : ''}" data-tab="done">已办 ${done.length}</button>
    <button class="chip ${tab === 'all' ? 'on' : ''}" data-tab="all">全部 ${S.proposals.length}</button>
  </div>`

  const body = rows.length
    ? rows.map(propCard).join('')
    : '<p class="empty">没有待办。巡检没发现异常，或者都被处理完了。</p>'

  return `
  <div class="step">AI 只能起草提案 · 通过才落库 · 拒绝留理由 · 全程留痕</div>
  ${tabs}
  ${body}
  <div class="foot"><button class="link" id="sweepBtn">再巡一次</button></div>`
}

function propCard(p) {
  const kind = PROP_KINDS[p.kind] || p.kind
  const statusName = { open: '待处理', approved: '已通过', rejected: '已拒绝', superseded: '已改版' }[p.status] || p.status
  const audit = `AI 起草（${esc(p.created_by)}）· ${fmtTime(p.created_at)}` +
    (p.decided_by ? ` · ${esc(p.decided_by)} ${p.status === 'approved' ? '批准' : '拒绝'} · ${fmtTime(p.decided_at)}` : '')

  const linesHtml = (p.lines && p.lines.length)
    ? `<div class="prop-lines">通过后落库：${esc(linesText(p))}</div>` : ''

  const traceHtml = (p.tool_calls && p.tool_calls.length)
    ? `<details class="trace"><summary>工具调用记录（${p.tool_calls.length} 次 · 审计留痕）</summary><pre>${esc(p.tool_calls.map(t =>
        t.tool + '(' + JSON.stringify(t.args) + ')\n→ ' + JSON.stringify(t.result)).join('\n\n'))}</pre></details>`
    : ''

  const qaHtml = (p.events || []).filter(e => e.action === 'ask').map(e =>
    `<div class="prop-qa"><b>问：</b>${esc(e.note)}<br><b>答：</b>${esc(e.answer)}</div>`).join('')

  const reasonHtml = (p.status === 'rejected' && p.decide_reason)
    ? `<div class="prop-reason">拒绝理由：${esc(p.decide_reason)}</div>` : ''

  let actions = ''
  if (p.status === 'open') {
    const canInvest = (p.kind === 'anomaly' || p.kind === 'low_stock' || p.kind === 'stagnant')
    actions = `<div class="prop-actions">
      <button class="btn primary" data-act="approve" data-id="${p.id}">✓ 通过${p.lines ? '并落库' : ''}</button>
      <button class="btn" data-act="reject" data-id="${p.id}">✗ 拒绝</button>
      ${canInvest ? `<button class="btn" data-act="invest" data-id="${p.id}">🔍 调查</button>` : ''}
      <button class="btn" data-act="ask" data-id="${p.id}">💬 追问</button>
      ${p.lines ? `<button class="btn" data-act="revise" data-id="${p.id}">✏️ 改提案</button>` : ''}
    </div>
    <div class="prop-box" id="box-${p.id}"></div>`
  }

  return `<div class="prop" data-pid="${p.id}">
    <div class="prop-head"><span class="badge">${esc(kind)}</span><span class="badge st-${p.status}">${esc(statusName)}</span></div>
    <div class="prop-summary">${esc(p.summary)}</div>
    ${p.utterance ? `<div class="prop-note">${esc(p.utterance).replace(/\n/g, '<br>')}</div>` : ''}
    ${linesHtml}
    ${reasonHtml}
    ${qaHtml}
    ${traceHtml}
    <div class="audit">${audit}</div>
    ${actions}
  </div>`
}

// ——————————————————————————————————————
// 事件绑定
// ——————————————————————————————————————
const VIEWS = { home: vHome, receive: vReceive, ship: vShip, search: vSearch, count: vCount, overview: vOverview, ask: vAsk, proposals: vProposals }

const BIND = {
  home() {
    document.getElementById('syncBtn').onclick = async () => {
      const n = await DB.sync(S.moves)
      // ⚠️ 文案要说实话：sync() 现在只是把本地流水的 synced 标志置 1（模拟），
      //    **没有任何数据离开这台设备**。写「已同步」会让人以为有服务器备份了，
      //    于是放心去清浏览器数据 —— 那就真没了。
      toast(n ? `已标记 ${n} 条待回传（演示模式：还没有真正上传）` : '没有待回传的记录')
    }
    document.getElementById('backupExp').onclick = exportBackup
    document.getElementById('backupImp').onclick = importBackup
    document.getElementById('opBtn').onclick = setOperator
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

    // 送货单解析分支
    if (S.draft) {
      const d = S.draft
      if (!d.rows) {
        document.getElementById('draftParse').onclick = async () => {
          const text = document.getElementById('draftText').value
          if (!text.trim()) { toast('先粘贴送货单文本'); return }
          toast('解析中…')
          const ex = await Patrol.extractRows(text)
          const preview = Logic.draftReceiptRows(ex.rows, { items: S.items, moves: S.moves, locations: S.locations })
          S.draft = { text: text, rows: ex.rows, source: ex.source, preview: preview }
          render()
        }
        document.getElementById('draftCancel').onclick = () => { S.draft = null; render() }
        return
      }
      document.getElementById('draftBack').onclick = () => {
        S.draft = { text: S.draft.text, rows: null }
        render()
      }
      document.getElementById('draftSubmit').onclick = async () => {
        const edits = {}
        document.querySelectorAll('.dq').forEach(inp => {
          edits[inp.dataset.dq] = parseInt(inp.value, 10) || 0
        })
        try {
          const p = await Patrol.submitDraft(d.text, d.rows, edits)
          S.draft = null
          S.proposals = await Patrol.list()
          location.hash = '#proposals'
          toast(`已送审：${p.summary}，批准后才落库`)
        } catch (e) {
          toast(String(e && e.message || e))
        }
      }
      return
    }

    if (!r) {
      document.getElementById('scanBtn').onclick = () => openScanner(code => {
        startReceive(findByCode(code))
      })
      document.getElementById('manualBtn').onclick = () => {
        startReceive(findByCode(document.getElementById('manualSku').value))
      }
      document.getElementById('draftBtn').onclick = () => {
        S.draft = { text: '', rows: null }
        render()
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
    // 只重画「取几个」那一段，**不要 render() 整页** —— 见 shipPlanHTML 的说明
    const repaint = () => {
      const box = document.getElementById('shipPlan')
      if (box) box.innerHTML = shipPlanHTML(s)
    }
    document.querySelectorAll('.stepper button').forEach(b => {
      b.onclick = () => {
        const v = Math.max(1, (parseInt(qtyEl.value, 10) || 0) + parseInt(b.dataset.d, 10))
        qtyEl.value = v
        s.qty = v
        repaint()
      }
    })
    qtyEl.oninput = () => { s.qty = Math.max(1, parseInt(qtyEl.value, 10) || 1); repaint() }
    qtyEl.onblur = () => { qtyEl.value = s.qty }   // 只把数字写回来，不重画
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
  },

  ask() {
    const inp = document.getElementById('askQ')
    const out = document.getElementById('askOut')

    const doAsk = async () => {
      const q = inp.value.trim()
      if (!q) { toast('先输入问题'); return }
      out.innerHTML = '<div class="answer"><div class="src">思考中…</div></div>'
      AI.lastError = null
      let acc = ''
      let r
      try {
        r = await AI.ask(q, d => {
          acc += d
          out.innerHTML = '<div class="answer"><div class="src">回答中…</div>' + esc(acc) + '</div>'
        })
      } catch (e) {
        r = { answer: '出错了：' + (e && e.message || e), source: 'local', trace: [] }
      }
      const srcName = { llm: 'AI 模型', proxy: '服务器代理', local: '本地规则' }[r.source] || r.source
      const offline = (r.source === 'local' && AI.lastError)
        ? '\n（AI 通道不可用：' + AI.lastError + '，已自动落到本地规则）' : ''
      const traceHtml = (r.trace || []).length
        ? `<details class="trace"><summary>工具调用记录（${r.trace.length} 次 · 审计留痕）</summary><pre>${esc(r.trace.map(t =>
            t.tool + '(' + JSON.stringify(t.args) + ')\n→ ' + JSON.stringify(t.result)).join('\n\n'))}</pre></details>`
        : ''
      out.innerHTML = `<div class="answer"><div class="src">回答来源：${esc(srcName)}${r.rounds ? ' · ' + r.rounds + ' 轮' : ''}</div>${esc(r.answer + offline)}${traceHtml}</div>`
    }

    document.getElementById('askGo').onclick = doAsk
    inp.onkeydown = e => { if (e.key === 'Enter') doAsk() }

    document.getElementById('askMic').onclick = () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition
      if (!SR) { toast('这个浏览器不支持语音输入，请打字'); return }
      try {
        const rec = new SR()
        rec.lang = 'zh-CN'
        rec.onresult = e => { inp.value = e.results[0][0].transcript; doAsk() }
        rec.onerror = () => toast('语音识别失败，请打字')
        rec.start()
        toast('请讲话…')
      } catch (e) {
        toast('语音识别打不开')
      }
    }

    document.getElementById('askCfg').onclick = () => {
      const mode = prompt('模式：demo（直连 AI）/ prod（走服务端代理，key 不进前端）', CONFIG.mode)
      if (mode === null) return
      const endpoint = prompt('API 地址（OpenAI 兼容，demo 用；留空=本地规则兜底）', CONFIG.llmEndpoint)
      if (endpoint === null) return
      const key = prompt('API Key（⚠️ 只许本机/演示填；prod 留空）', CONFIG.llmKey)
      if (key === null) return
      const model = prompt('模型名', CONFIG.llmModel)
      if (model === null) return
      saveConfig({
        mode: mode.trim() || 'demo',
        llmEndpoint: endpoint.trim(),
        llmKey: key.trim(),
        llmModel: model.trim() || 'deepseek-chat'
      })
      render()
      toast('已保存 AI 连接设置')
    }
  },

  proposals() {
    const refresh = async () => { S.proposals = await Patrol.list(); render() }

    document.querySelectorAll('[data-tab]').forEach(b => {
      b.onclick = () => { S.propTab = b.dataset.tab; render() }
    })
    const sweepBtn = document.getElementById('sweepBtn')
    if (sweepBtn) sweepBtn.onclick = async () => {
      toast('巡检中…')
      const fresh = await Patrol.sweep({ onProposed: refresh })   // 立完提案就先亮出来，LLM 起草在后台补
      await refresh()
      toast(fresh.length ? `巡检完成：${fresh.length} 条新待办` : '巡检完成：没有新的异常')
    }

    document.querySelectorAll('[data-act]').forEach(b => {
      const p = S.proposals.find(x => x.id === b.dataset.id)
      if (!p) return

      if (b.dataset.act === 'approve') {
        b.onclick = () => {
          const box = document.getElementById('box-' + p.id)
          box.innerHTML = `<div class="hint">${p.lines ? '确认后立即落库：' + esc(linesText(p)) : '确认采纳并归档？'}</div>
            <div class="row">
              <button class="btn primary" data-act="approveOk" data-id="${p.id}">确认${p.lines ? '落库' : '批准'}</button>
              <button class="btn" data-act="cancel" data-id="${p.id}">再想想</button>
            </div>`
          box.querySelector('[data-act="cancel"]').onclick = () => { box.innerHTML = '' }
          box.querySelector('[data-act="approveOk"]').onclick = async (ev) => {
            // ⚠️ 必须立刻 disable：这是会改库存的按钮，手机上双击/连点是常态。
            //    Patrol.decide 里还有状态闸和在途闸兜底，但那两道闸只保证不重复写，
            //    界面这边也要让用户看得出"已经在处理了"。
            const btn = ev.currentTarget
            btn.disabled = true
            btn.textContent = '正在落库…'
            try {
              const r = await Patrol.decide(p, true, '')
              if (r.skipped) toast(r.skipped)
              else toast(r.moves.length ? `已批准并落库 ${r.moves.length} 条流水` : '已批准归档')
            } catch (e) {
              toast('落库失败：' + (e && e.message || e))
            }
            await refresh()
          }
        }
      }

      if (b.dataset.act === 'reject') {
        b.onclick = () => {
          const box = document.getElementById('box-' + p.id)
          box.innerHTML = `<div class="row">
            <input type="text" id="rej-${p.id}" placeholder="拒绝理由（必填，存档）">
            <button class="btn" data-act="rejectOk" data-id="${p.id}">确认拒绝</button>
          </div>`
          box.querySelector('[data-act="rejectOk"]').onclick = async () => {
            const reason = document.getElementById('rej-' + p.id).value.trim()
            if (!reason) { toast('拒绝要填理由（存档用）'); return }
            await Patrol.decide(p, false, reason)
            toast('已拒绝并存档')
            await refresh()
          }
        }
      }

      if (b.dataset.act === 'invest') {
        b.onclick = async () => {
          b.disabled = true
          b.textContent = '调查中…'
          toast('调查中：查流水 → 查同款 → 查邻位')
          try {
            await Patrol.investigate(p)
            toast('调查完成，报告已进待办箱')
          } catch (e) {
            toast('调查失败：' + (e && e.message || e))
          }
          await refresh()
        }
      }

      if (b.dataset.act === 'ask') {
        b.onclick = () => {
          const box = document.getElementById('box-' + p.id)
          box.innerHTML = `<div class="row">
            <input type="text" id="ask-${p.id}" placeholder="对这条提案追问一句">
            <button class="btn" data-act="askOk" data-id="${p.id}">发</button>
          </div><div id="askOut-${p.id}"></div>`
          box.querySelector('[data-act="askOk"]').onclick = async () => {
            const q = document.getElementById('ask-' + p.id).value.trim()
            if (!q) { toast('先输入问题'); return }
            const out = document.getElementById('askOut-' + p.id)
            out.innerHTML = '<div class="hint">思考中…</div>'
            const r = await Patrol.ask(p, q)
            out.innerHTML = `<div class="prop-qa"><b>问：</b>${esc(q)}<br><b>答：</b>${esc(r.answer)}</div>`
            S.proposals = await Patrol.list()
          }
        }
      }

      if (b.dataset.act === 'revise') {
        b.onclick = () => {
          const box = document.getElementById('box-' + p.id)
          const ls = p.lines || []
          box.innerHTML = `<div class="hint">逐行改数量（0 或清空 = 删掉这行）</div>` +
            ls.map((l, i) => {
              const it = S.items.find(x => x.id === l.itemId)
              const loc = S.locations.find(x => x.id === l.locationId)
              return `<div class="row">
                <span class="grow">${esc(it ? it.name : l.itemId)} → ${esc(loc ? loc.label : '')}</span>
                <input type="number" id="rev-${p.id}-${i}" value="${l.qty}">
              </div>`
            }).join('') +
            `<div class="row"><button class="btn" data-act="reviseOk" data-id="${p.id}">存为新版本</button>
             <button class="btn" data-act="cancel" data-id="${p.id}">取消</button></div>
            <div class="hint">新版本回到待处理，旧版本留痕可查</div>`
          box.querySelector('[data-act="cancel"]').onclick = () => { box.innerHTML = '' }
          box.querySelector('[data-act="reviseOk"]').onclick = async () => {
            const qtys = ls.map((l, i) =>
              parseInt(document.getElementById(`rev-${p.id}-${i}`).value, 10) || 0)
            if (qtys.every(q => q <= 0)) { toast('至少留一行'); return }
            await Patrol.revise(p, qtys)
            toast('已存新版本')
            await refresh()
          }
        }
      }
    })
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

  // 巡检自主跑：开 App 就跑一遍四岗，按优先级进待办箱（按钮只是"再巡一次"）
  // 提案一立完就先刷待办箱（onProposed），LLM 起草完再刷一次（文案可能换）——界面不被起草拖着
  const showProposals = async () => {
    S.proposals = await Patrol.list()
    const route = (location.hash || '#home').slice(1) || 'home'
    if (route === 'home' || route === 'proposals') render()
  }
  Patrol.sweep({ onProposed: showProposals }).then(async fresh => {
    if (!fresh.length) return
    await showProposals()
    toast(`巡检完成：${fresh.length} 条新待办`)
  }).catch(() => {})
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
