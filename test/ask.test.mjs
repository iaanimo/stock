// test/ask.test.mjs —— AI 问答页的冒烟测试（CDP 连 headless Edge）
//
// 验三件事：①问答框渲染出来 ②没配 key 时走本地规则兜底、答案带真数字
// ③全程只读 —— 问完 S.moves 一条不多，这是"AI 永远不写库"的硬保证。
//
// 用法：
//   msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
//          --user-data-dir=/tmp/edge-ask http://localhost:8000/ &
//   node test/ask.test.mjs

const PORT = 9222
const APP = 'http://localhost:8000/'

async function newTab() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${APP}`, { method: 'PUT' })
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
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('异常: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text))
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

// 等页面加载完 + boot() 灌完种子数据
let loaded = false
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 500))
  try {
    if (await cdp.eval(`document.readyState === 'complete' && typeof S !== 'undefined' && S.items.length > 0`)) {
      loaded = true; break
    }
  } catch (e) { /* 导航中 */ }
}
if (!loaded) { console.log('页面没起来'); process.exit(1) }

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

// 等回答完成：以前写死等 1.5s 只够本地规则；现在 8000 是 app.py 真实代理，
// 流式回复要 3~10s，改轮询（跟 proposals/ui 测试一个套路），最多等 25s。
async function waitAnswer() {
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 500))
    const t = await cdp.eval(`document.getElementById('askOut').textContent`)
    if (/回答来源/.test(t)) return t
  }
  return await cdp.eval(`document.getElementById('askOut').textContent`)
}

const movesBefore = await cdp.eval('S.moves.length')

console.log('\nAI 问答页')
await cdp.eval(`location.hash = '#ask'`)
await new Promise(r => setTimeout(r, 600))
ok('问答框渲染出来了',
  await cdp.eval(`!!document.getElementById('askQ') && !!document.getElementById('askGo')`))

// —— 问题 1：轴承还剩多少（多商品汇总）——
await cdp.eval(`(() => {
  const i = document.getElementById('askQ')
  i.value = '轴承还剩多少'
  document.getElementById('askGo').click()
})()`)
const out1 = await waitAnswer()
ok('「轴承还剩多少」答出合计 156', /156/.test(out1), out1.slice(0, 120))
ok('三种轴承都列出来', /6204/.test(out1) && /6205/.test(out1) && /6308/.test(out1))
ok('标注了回答来源', /回答来源/.test(out1))
ok('带工具调用留痕', await cdp.eval(`!!document.querySelector('#askOut .trace')`))

// —— 问题 2：6204 在哪个货位（单商品分布）——
await cdp.eval(`(() => {
  const i = document.getElementById('askQ')
  i.value = '6204 在哪个货位'
  document.getElementById('askGo').click()
})()`)
const out2 = await waitAnswer()
ok('「6204 在哪」答出货位分布', /A区2排1层[：:]?\s*50/.test(out2), out2.slice(0, 120))

// —— 只读保证 ——
const movesAfter = await cdp.eval('S.moves.length')
ok('AI 问答全程只读（流水一条没多）', movesAfter === movesBefore,
  `${movesBefore} → ${movesAfter}`)

console.log('\n控制台错误：' + (cdp.logs.length ? '' : '无'))
cdp.logs.forEach(l => console.log('   ✗ ' + l))
if (cdp.logs.length) fail++

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : '') + '\n')
cdp.close()
process.exit(fail ? 1 : 0)
