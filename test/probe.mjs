// test/probe.mjs —— 页面渲染 + 主流程冒烟测试（**带断言**）
//
// ⚠️ 这个脚本原来通篇零断言，只打印。页面全白、货位推荐为空、搜索查不出东西，
//    它也照样退出 0 —— 那不能叫测试，只能叫诊断脚本。
//    现在关键项都有断言，挂了会以非零码退出。
//
// 会自己导航，不需要先手动打开页面。
//
// 用法：
//   node test/probe.mjs                                        （默认 localhost:8000）
//   node test/probe.mjs https://iaanimo.github.io/stock/       （验线上）

const PORT = 9222
const APP = process.argv.slice(2).find(a => a.startsWith('http')) || 'http://localhost:8000/'

async function newTab() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  return r.json()
}

let seq = 0
function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  const errors = []
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      errors.push('异常: ' + (d.exception?.description || d.text))
    }
  }
  const send = (method, params) => new Promise(res => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
  return {
    ready: new Promise(res => { ws.onopen = res }),
    send, errors,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      const ex = r.result?.exceptionDetails
      if (ex) throw new Error(ex.exception?.description || ex.text)
      return r.result?.result?.value
    },
    close: () => ws.close()
  }
}

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + extra : '')) }
}
const line = (k, v) => console.log('  ' + k.padEnd(18, '　') + v)

const tab = await newTab()
const cdp = connect(tab.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Page.navigate', { url: APP })

let loaded = false
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500))
  try {
    if (await cdp.eval(`document.readyState==='complete' && !!document.head && document.title.length>0`)) { loaded = true; break }
  } catch (e) { /* 导航中 */ }
}
if (!loaded) {
  console.log('页面没加载出来：' + await cdp.eval('location.href').catch(() => '（读不到）'))
  process.exit(1)
}
await new Promise(r => setTimeout(r, 1500))

// 测试隔离：同一批跑的时候，前面的用例（scanflow / ui / proposals）会往同一个
// headless profile 的 IndexedDB 里写数据，后面的断言就不确定了。
// 本机跑时先恢复演示数据；验线上时不重置（那边本来就是全新 profile）。
if (/localhost|127\.0\.0\.1/.test(APP)) {
  try {
    await cdp.eval(`(async () => { await DB.reset(); await reload(); render(); return true })()`)
    await new Promise(r => setTimeout(r, 600))
  } catch (e) { console.log('  （恢复演示数据失败，继续：' + e.message + '）') }
}

console.log('\n页面状态  ' + APP)
line('标题', await cdp.eval('document.getElementById("title").textContent'))
line('#view 长度', await cdp.eval('document.getElementById("view").innerHTML.length'))
line('首页件数', await cdp.eval('document.querySelector(".hero-num")?.textContent ?? "（没有）"'))
line('首页卡片', await cdp.eval('document.querySelectorAll(".card").length + " 张"'))
line('S.items / locations / moves',
  (await cdp.eval('S.items.length')) + ' / ' + (await cdp.eval('S.locations.length')) + ' / ' + (await cdp.eval('S.moves.length')))

console.log('')
ok('首页渲染出内容了（#view 非空）', (await cdp.eval('document.getElementById("view").innerHTML.length')) > 200)
ok('首页件数是数字', /^\d+$/.test(String(await cdp.eval('document.querySelector(".hero-num")?.textContent'))))
ok('首页功能卡片都在（≥4 张）', (await cdp.eval('document.querySelectorAll(".card").length')) >= 4)
ok('种子数据灌进去了', (await cdp.eval('S.items.length')) > 0 && (await cdp.eval('S.locations.length')) > 0)

// —— 库存查询 ——
console.log('\n库存查询（搜「轴承」）')
await cdp.eval(`location.hash = "#search"`)
await new Promise(r => setTimeout(r, 800))
const names = await cdp.eval(`[...document.querySelectorAll("#searchResult .nm")].map(e=>e.textContent).join(" | ")`)
const nums = await cdp.eval(`[...document.querySelectorAll("#searchResult .num")].map(e=>e.textContent).join(" | ")`)
line('结果行', names || '（空）')
line('各自库存', nums || '（空）')
line('合计', await cdp.eval(`document.querySelector(".total-bar")?.textContent ?? "（没有）"`))
ok('搜「轴承」出 3 行', (await cdp.eval(`document.querySelectorAll("#searchResult .item").length`)) === 3)
ok('三种轴承合计 156', /156/.test(String(await cdp.eval(`document.querySelector(".total-bar")?.textContent`))))

// —— 三个主流程 ——
console.log('\n主流程')
await cdp.eval(`location.hash = "#receive"`)
await new Promise(r => setTimeout(r, 600))
await cdp.eval(`document.querySelector(".chip").click()`)
await new Promise(r => setTimeout(r, 600))
const loc = await cdp.eval(`document.querySelector(".pick .loc")?.textContent ?? ""`)
line('收货·建议货位', loc || '（没有）')
ok('收货给出了货位建议', loc.length > 0 && loc !== '没有空货位')

await cdp.eval(`location.hash = "#ship"`)
await new Promise(r => setTimeout(r, 600))
await cdp.eval(`document.querySelector(".chip").click()`)
await new Promise(r => setTimeout(r, 600))
const plan = await cdp.eval(`[...document.querySelectorAll("#shipPlan .item")].map(e=>e.querySelector(".nm").textContent.trim()).join(" → ")`)
line('出库·拣货顺序', plan || '（没有）')
ok('出库给出了拣货顺序', plan.length > 0)

await cdp.eval(`location.hash = "#count"`)
await new Promise(r => setTimeout(r, 600))
await cdp.eval(`document.querySelector('[data-scope="A"]').click()`)
await new Promise(r => setTimeout(r, 600))
const rowCount = await cdp.eval(`document.querySelectorAll(".cnt").length`)
await cdp.eval(`(() => {
  const i = document.querySelector('.cnt')
  const sys = Number(i.closest('.item').querySelector('.sub').textContent.match(/\\d+/)[0])
  i.value = String(sys + 7); i.dispatchEvent(new Event('input'))
})()`)
const diffTxt = await cdp.eval(`document.querySelector(".cnt").closest(".item").querySelector(".sub").textContent.replace(/\\s+/g," ").trim()`)
line('盘点·位点数', rowCount)
line('盘点·差异行', diffTxt)
ok('盘点列了位点', rowCount > 0)
ok('填错数量会标红差异', /差异 \+7/.test(diffTxt))

// —— 控制台 ——
console.log('\n控制台错误：' + (cdp.errors.length ? '' : '无'))
cdp.errors.forEach(e => console.log('   ✗ ' + e))
ok('控制台 0 错误', cdp.errors.length === 0)

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : '') + '\n')
cdp.close()
process.exit(fail ? 1 : 0)
