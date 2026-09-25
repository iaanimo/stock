// test/scanflow.test.mjs —— 验「点扫码按钮 → 摄像头打开 → 识别循环在跑」
//
// 用 Edge 的假摄像头（--use-fake-device-for-media-stream），所以不需要真设备、不弹授权框。
// 目的是回答一个很具体的问题：**打开这个界面，扫码到底能不能直接用。**
//
// 用法：
//   msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
//          --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
//          --user-data-dir=/tmp/edge-sf about:blank &
//   node test/scanflow.test.mjs

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
await new Promise(r => setTimeout(r, 2000))

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}
const line = (k, v) => console.log('  ' + k.padEnd(20, '　') + v)

console.log('\n前置条件')
line('摄像头 API', await cdp.eval(`navigator.mediaDevices ? '有' : '没有'`))
line('原生 BarcodeDetector', await cdp.eval(`'BarcodeDetector' in window ? '有' : '没有'`))
line('安全上下文', await cdp.eval(`window.isSecureContext ? '是' : '否（摄像头会被拒）'`))

// —— 点「收货上架」→「扫商品码」，全程模拟用户操作 ——
console.log('\n模拟用户操作：收货上架 → 扫商品码')
await cdp.eval(`location.hash = '#receive'`)
await new Promise(r => setTimeout(r, 600))
ok('第 1 步页面出来了，扫码按钮在', await cdp.eval(`!!document.getElementById('scanBtn')`))

await cdp.eval(`document.getElementById('scanBtn').click()`)
await new Promise(r => setTimeout(r, 4000))     // 等 polyfill 加载 + 摄像头起

const st = await cdp.eval(`(() => {
  const layer = document.querySelector('.scanlayer')
  const v = layer && layer.querySelector('video')
  return {
    overlay: !!layer,
    msg: layer ? (layer.querySelector('#scMsg') || {}).textContent : null,
    hasVideo: !!v,
    videoW: v ? v.videoWidth : 0,
    videoH: v ? v.videoHeight : 0,
    playing: v ? (!v.paused && v.readyState >= 2) : false,
    detectorReady: 'BarcodeDetector' in window,
    toast: (document.querySelector('.toast') || {}).textContent || null
  }
})()`)

line('扫码界面弹出了', st.overlay ? '是' : '否')
line('界面上的提示', JSON.stringify(st.msg))
line('视频元素', st.hasVideo ? '有' : '没有')
line('画面尺寸', st.videoW + 'x' + st.videoH)
line('正在播放', st.playing ? '是' : '否')
line('识别器就绪', st.detectorReady ? '是' : '否')
if (st.toast) line('弹出的提示', st.toast)

console.log('')
ok('扫码界面弹出来了', st.overlay)
ok('摄像头画面有尺寸（真的出图了）', st.videoW > 0 && st.videoH > 0, st.videoW + 'x' + st.videoH)
ok('视频在播放', st.playing)
ok('识别器已就绪（原生或 polyfill）', st.detectorReady)
ok('没有报错提示', !st.toast || !/打不开|不支持/.test(st.toast), st.toast)

// —— 关掉，确认能正常退出（摄像头要释放）——
await cdp.eval(`document.getElementById('scCancel') && document.getElementById('scCancel').click()`)
await new Promise(r => setTimeout(r, 600))
ok('点取消能关掉扫码界面', await cdp.eval(`!document.querySelector('.scanlayer')`))
ok('摄像头已释放（没有残留的 track）',
  await cdp.eval(`!window.S || !S.scanner`))

console.log('\n控制台错误：' + (cdp.logs.length ? '' : '无'))
cdp.logs.forEach(l => console.log('   ✗ ' + l))
if (cdp.logs.length) fail++

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : '') + '\n')
cdp.close()
process.exit(fail ? 1 : 0)
