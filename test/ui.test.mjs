// test/ui.test.mjs —— 界面层回归测试（带真实断言，不是打印）
//
// 覆盖两个**实测过的真 bug**，都是"用户每次都会撞到"的那种：
//
//   1. 出库页：改完数量后，第一下点按钮被吞掉
//      原因：数量框 onblur 里调 render() 整页重建，鼠标抬起落在已被移除的节点上，
//      click 根本不派发。实测改完数量点「确认出库」→ 什么都不发生、也没有提示。
//      这里用 **真实鼠标事件**（Input.dispatchMouseEvent）复现，所以能抓到它。
//
//   2. 扫码：等组件加载时点「取消」，摄像头停不下来
//      原因：Scan.start 还在 await，close() 里 ctl 还是 null 什么都停不了；
//      await 回来后又把句柄赋上 → 摄像头一直开着、覆盖层已没了。
//      这里把 Scan.start 换成一个"慢"的假实现来复现那个窗口。
//
// 用法（Edge 要先用 --remote-debugging-port=9222 起好）：
//   msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
//          --user-data-dir=/tmp/edge-ui about:blank &
//   node test/ui.test.mjs

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
  const logs = []
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      logs.push('异常: ' + (d.exception?.description || d.text))
    }
  }
  const send = (method, params) => new Promise(res => {
    const id = ++seq
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
  return {
    ready: new Promise(res => { ws.onopen = res }),
    send, logs,
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      const ex = r.result?.exceptionDetails
      if (ex) throw new Error(ex.exception?.description || ex.text)
      return r.result?.result?.value
    },
    close: () => ws.close()
  }
}

const tab = await newTab()
const cdp = connect(tab.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Page.navigate', { url: APP })
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500))
  try { if (await cdp.eval(`document.readyState==='complete' && !!document.head && document.title.length>0`)) break } catch (e) {}
}
await new Promise(r => setTimeout(r, 1500))

let pass = 0, fail = 0
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  OK   ' + n) }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  → ' + extra : '')) }
}

// 真实鼠标点击：按元素中心派发 mousePressed + mouseReleased。
// 用 element.click() 测不出吞点击的问题 —— 那个走的是 DOM 直接派发，
// 不经过"抬起时目标还在不在"这层判断。
async function realClick(selector) {
  const box = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width/2, y: r.top + r.height/2 }
  })()`)
  if (!box) throw new Error('找不到元素: ' + selector)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await new Promise(r => setTimeout(r, 30))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
}

// ——————————————————————————————————————
console.log('\n【1】出库页：改完数量后点「确认出库」')
await cdp.eval(`location.hash = '#ship'`)
await new Promise(r => setTimeout(r, 600))
await cdp.eval(`document.querySelector('.chip').click()`)      // 选第一个商品
await new Promise(r => setTimeout(r, 600))
ok('进到第 2 步，数量框在', await cdp.eval(`!!document.getElementById('shipQty')`))

const before = await cdp.eval(`S.moves.length`)
// 模拟真人：先聚焦、改数量（触发 oninput），再点按钮（先触发 onblur）
await cdp.eval(`(() => {
  const q = document.getElementById('shipQty')
  q.focus(); q.value = '3'
  q.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await new Promise(r => setTimeout(r, 200))
await realClick('#shipConfirm')
await new Promise(r => setTimeout(r, 900))
const after = await cdp.eval(`S.moves.length`)
ok('改完数量后，第一下点「确认出库」就生效', after === before + 1,
  `流水 ${before} → ${after}（期望 +1；若为 +0 就是点击被 onblur 的 render 吞了）`)

// 顺手验一下 + 号步进键在同一次会话里也没被吞
await cdp.eval(`location.hash = '#ship'`)
await new Promise(r => setTimeout(r, 500))
await cdp.eval(`document.querySelector('.chip').click()`)
await new Promise(r => setTimeout(r, 600))
await cdp.eval(`(() => { const q = document.getElementById('shipQty'); q.focus(); q.value='2'; q.dispatchEvent(new Event('input',{bubbles:true})) })()`)
await new Promise(r => setTimeout(r, 200))
await realClick('.stepper button[data-d="1"]')
await new Promise(r => setTimeout(r, 400))
ok('改完数量后第一下点「＋」也生效', (await cdp.eval(`S.ship && S.ship.qty`)) === 3,
  '实际 qty=' + await cdp.eval(`S.ship && S.ship.qty`))

// ——————————————————————————————————————
console.log('\n【2】扫码：组件还在加载时点「取消」')
await cdp.eval(`location.hash = '#receive'`)
await new Promise(r => setTimeout(r, 500))
// 把 Scan.start 换成一个"慢"的假实现：2 秒后才 resolve 一个带 stop() 的句柄，
// 并且记录 onCode 有没有被调用 —— 这正是真实 polyfill 首次加载的那个窗口
await cdp.eval(`(() => {
  window.__scanStopped = 0
  Scan.start = async (video, onCode) => {
    await new Promise(r => setTimeout(r, 2000))
    // 关键：等 await 落地之后才回调 onCode —— 模拟"取消之后才扫到码"
    setTimeout(() => onCode('SHOULD-NOT-FIRE'), 50)
    return { stop: () => { window.__scanStopped++ }, weak: false }
  }
  return true
})()`)
await cdp.eval(`document.getElementById('scanBtn').click()`)
await new Promise(r => setTimeout(r, 300))                 // 组件"加载中"
ok('覆盖层已经弹出来（正在准备）', await cdp.eval(`!!document.querySelector('.scanlayer')`))
await cdp.eval(`document.getElementById('scCancel').click()`)   // 这个窗口里点取消
await new Promise(r => setTimeout(r, 3000))                // 等假的 Scan.start 落地并回调
ok('取消后摄像头被关掉了（stop 被调用 1 次）', (await cdp.eval(`window.__scanStopped`)) === 1,
  'stop 调用次数=' + await cdp.eval(`window.__scanStopped`))
ok('取消后不会把句柄写回 S.scanner', (await cdp.eval(`S.scanner`)) === null)
ok('覆盖层已消失', !(await cdp.eval(`!!document.querySelector('.scanlayer')`)))
// 迟到的 onCode 如果被响应，会跑 startReceive() → S.receive 被建起来 → 界面跳到第 2 步
ok('迟到的 onCode 被忽略（没有进入收货第 2 步）',
  (await cdp.eval(`S.receive`)) === null, 'S.receive=' + JSON.stringify(await cdp.eval(`S.receive`)))
ok('界面还停在第 1 步（扫码按钮还在、没有出现第 2 步的货位建议）',
  await cdp.eval(`!!document.getElementById('scanBtn') && !document.querySelector('.pick')`))

// ——————————————————————————————————————
console.log('\n控制台错误：' + (cdp.logs.length ? '' : '无'))
cdp.logs.forEach(l => { console.log('   ✗ ' + l); fail++ })

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : '') + '\n')
cdp.close()
process.exit(fail ? 1 : 0)
