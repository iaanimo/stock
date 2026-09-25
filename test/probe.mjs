// test/probe.mjs —— 用 CDP 连上真实浏览器，检查页面到底渲染了没有、有没有报错
// 用法：
//   msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins=* \
//          --user-data-dir=/tmp/edge-probe http://localhost:8000/ &
//   node test/probe.mjs
//
// 为什么不用 --dump-dom：那个在 load 事件就抓，而我们要等 IndexedDB 的异步跑完。

const PORT = 9222
const TARGET = 'http://localhost:8000'

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = list.find(t => t.type === 'page' && t.url.startsWith(TARGET))
      if (page) return page
    } catch (e) { /* devtools 还没起来 */ }
    await new Promise(r => setTimeout(r, 250))
  }
  return null
}

const page = await findPage()
if (!page) { console.log('没找到页面，Edge 起来了吗？'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const errors = []

function send(method, params) {
  return new Promise(resolve => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}

ws.onmessage = ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error → ' + m.params.args.map(a => a.value ?? a.description).join(' '))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    errors.push('未捕获异常 → ' + (d.exception?.description || d.text))
  }
}

await new Promise(r => { ws.onopen = r })
await send('Runtime.enable')
await new Promise(r => setTimeout(r, 2500))

const q = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  if (r.exceptionDetails) return '<求值出错: ' + r.exceptionDetails.text + '>'
  return r.result?.value
}

const line = (k, v) => console.log('  ' + k.padEnd(14, '　') + v)

console.log('\n页面状态')
line('标题', await q('document.getElementById("title").textContent'))
line('#view 长度', await q('document.getElementById("view").innerHTML.length'))
line('首页件数', await q('document.querySelector(".hero-num")?.textContent ?? "（没有）"'))
line('首页卡片', await q('document.querySelectorAll(".card").length + " 张"'))
line('IndexedDB', await q('typeof indexedDB'))
line('S.items', await q('typeof S === "undefined" ? "S 未定义" : S.items.length'))
line('S.locations', await q('typeof S === "undefined" ? "-" : S.locations.length'))
line('S.moves', await q('typeof S === "undefined" ? "-" : S.moves.length'))

console.log('\n切到 #search 看「轴承」')
await q('location.hash = "#search"')
await new Promise(r => setTimeout(r, 800))
line('搜索框的值', await q('document.getElementById("searchKw")?.value ?? "（没有）"'))
line('结果行', await q('[...document.querySelectorAll("#searchResult .nm")].map(e=>e.textContent).join(" | ") || "（空）"'))
line('各自库存', await q('[...document.querySelectorAll("#searchResult .num")].map(e=>e.textContent).join(" | ") || "（空）"'))
line('合计', await q('document.querySelector(".total-bar")?.textContent ?? "（没有）"'))

console.log('\n走一遍主流程')

// 收货上架：选第一个商品，看系统建议放哪
await q('location.hash = "#receive"')
await new Promise(r => setTimeout(r, 500))
await q('document.querySelector(".chip").click()')
await new Promise(r => setTimeout(r, 500))
line('收货·建议货位', await q('document.querySelector(".pick .loc")?.textContent ?? "（没有）"'))
line('收货·提示语', await q('document.querySelector(".pick .lbl:last-child")?.textContent?.trim() ?? "-"'))

// 出库拣货：同样选第一个商品，看拣货顺序
await q('location.hash = "#ship"')
await new Promise(r => setTimeout(r, 500))
await q('document.querySelector(".chip").click()')
await new Promise(r => setTimeout(r, 500))
line('出库·拣货顺序', await q('[...document.querySelectorAll(".list .item")].map(e=>e.querySelector(".nm").textContent.trim()+" "+e.querySelector(".num").textContent.trim()).join(" → ") || "（没有）"'))

// 盘点：填一个对不上的数，看会不会标红
await q('location.hash = "#count"')
await new Promise(r => setTimeout(r, 500))
await q('document.querySelector("[data-scope=\\"A\\"]").click()')
await new Promise(r => setTimeout(r, 500))
await q(`(() => {
  const i = document.querySelector('.cnt')
  i.value = String(Number(i.closest('.item').querySelector('.sub').textContent.match(/\\d+/)[0]) + 7)
  i.dispatchEvent(new Event('input'))
})()`)
line('盘点·差异行', await q('document.querySelector(".cnt").closest(".item").querySelector(".sub").textContent.replace(/\\s+/g," ").trim()'))
line('盘点·底部计数', await q('document.querySelector(".actionbar .info")?.textContent?.replace(/\\s+/g," ").trim() ?? "(没有)"'))

console.log('\n控制台错误：' + (errors.length ? '' : '无'))
errors.forEach(e => console.log('  ✗ ' + e))
console.log('')

process.exit(errors.length ? 1 : 0)
