// test/barcode.test.mjs —— 扫码的真解码验证
//
// 光证明"没报错"不够，要证明真的能认出条码。这里把 test/fixtures/ 里的条码图片
// 喂给 BarcodeDetector，断言解出来的文字 == 文件名里写的文字。
//
// 这条路径就是 **iPhone 会走的那条**：没有原生 BarcodeDetector → 加载 polyfill
// → 读本机 js/vendor/zxing_reader.wasm 解码。
//
// 顺带抓出 .wasm 是从哪个域名加载的 —— 如果偷偷走 jsdelivr CDN，断网就废，断言会红。
//
// 用法：
//   1) 先起 headless Edge（脚本自己会开新标签页）
//      msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
//             --user-data-dir=/tmp/edge-bc about:blank &
//   2) node test/barcode.test.mjs
//
// fixtures 里的图片是 2026-09-26 用 zxing-wasm 的 writer 生成的真条码
// （`ZXingWASM.writeBarcode(文本, {format, scale:4, withQuietZones:true})`）。

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 9222
// 可以传一个网址进去测线上部署：node test/barcode.test.mjs https://iaanimo.github.io/stock/
const APP = process.argv.slice(2).find(a => a.startsWith('http')) || 'http://localhost:8000/'
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

// 文件名形如 Code128-6204.png —— 破折号后是期望解出来的文字
const cases = readdirSync(FIXTURES)
  .filter(f => f.endsWith('.png'))
  .map(f => {
    const m = f.replace(/\.png$/, '').match(/^(\w+)-(.+)$/)
    return { file: f, format: m[1], expect: m[2].replace(/_/g, '-') }
  })

if (!cases.length) {
  console.log('test/fixtures/ 里没有条码图片')
  process.exit(1)
}

// ——————————————————————————————————————
// CDP 连接
// ——————————————————————————————————————
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
    send,
    logs,
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

// 等页面真的加载完 —— 光 sleep 一个固定时间是靠不住的（尤其是线上地址）
let loaded = false
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 500))
  try {
    if (await cdp.eval(`document.readyState === 'complete' && !!document.head && document.title.length > 0`)) {
      loaded = true; break
    }
  } catch (e) { /* 导航中 eval 会失败，忽略 */ }
}
if (!loaded) {
  console.log('页面没加载出来，当前地址：' + await cdp.eval('location.href').catch(() => '（读不到）'))
  process.exit(1)
}
await new Promise(r => setTimeout(r, 1500))   // 再给 boot() 一点时间灌种子数据

const native = await cdp.eval(`'BarcodeDetector' in window`)
console.log('\n环境')
console.log('  页面              ' + await cdp.eval('document.title'))
console.log('  原生 BarcodeDetector  ' + (native ? '有（这台机器走原生，测不到 polyfill）' : '没有 → 走 polyfill（就是 iPhone 的情况）'))

// ——————————————————————————————————————
const script = `(async () => {
  const out = { cases: [] }
  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src
    s.onload = res
    s.onerror = () => rej(new Error('加载失败 ' + src))
    document.head.appendChild(s)
  })

  // 和 js/scan.js 走同一条路：没有原生就装 polyfill，wasm 指到本机
  if (!('BarcodeDetector' in window)) {
    await loadScript('js/vendor/barcode-detector-polyfill.js')
    BarcodeDetectionAPI.prepareZXingModule({
      overrides: { locateFile: (p, pre) => p.endsWith('.wasm') ? 'js/vendor/zxing_reader.wasm' : pre + p }
    })
  }
  out.readerReady = 'BarcodeDetector' in window

  const CASES = ${JSON.stringify(cases)}

  for (const c of CASES) {
    const rec = { file: c.file, expect: c.expect }
    try {
      const blob = await (await fetch('test/fixtures/' + c.file)).blob()
      const bmp = await createImageBitmap(blob)

      const cv = document.createElement('canvas')
      cv.width = bmp.width; cv.height = bmp.height
      const ctx = cv.getContext('2d')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height)
      ctx.drawImage(bmp, 0, 0)

      const det = new BarcodeDetector()
      const t0 = performance.now()
      const codes = await det.detect(cv)
      rec.ms = Math.round(performance.now() - t0)
      rec.size = cv.width + 'x' + cv.height
      rec.decoded = codes.map(x => x.rawValue)
      rec.match = codes.length === 1 && codes[0].rawValue === c.expect
    } catch (e) {
      rec.error = String((e && e.message) || e)
    }
    out.cases.push(rec)
  }

  out.origin = location.origin
  out.wasmSources = performance.getEntriesByType('resource')
    .map(e => e.name).filter(n => n.includes('.wasm'))

  return out
})()`

let result
try {
  result = await cdp.eval(script)
} catch (e) {
  console.log('\n页面里跑挂了：' + e.message)
  cdp.logs.forEach(l => console.log('   ' + l))
  cdp.close()
  process.exit(1)
}

// ——————————————————————————————————————
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')) }
}

if (!result.readerReady) { fail++; console.log('\n  FAIL reader 没装上') }

console.log('\n解码（图片 → 文字）')
for (const c of result.cases) {
  const label = (c.file + '  ').padEnd(30) + (c.size || '') + '  ' + (c.ms != null ? c.ms + 'ms' : '')
  if (c.error) { fail++; console.log('  FAIL ' + label + '  → ' + c.error); continue }
  ok(label + '  解出 ' + JSON.stringify(c.decoded), c.match,
    '期望 "' + c.expect + '"，实际 ' + JSON.stringify(c.decoded))
}

console.log('\nwasm 加载来源（必须本站，走 jsdelivr CDN 的话断网就废）')
console.log('  站点 origin：' + result.origin)
for (const src of result.wasmSources) {
  const local = src.startsWith(result.origin + '/')
  ok(src.replace(result.origin + '/', ''), local, '不在本站！实际是 ' + src)
}
if (!result.wasmSources.length) { fail++; console.log('  FAIL 一个 .wasm 都没加载 → 解码根本没跑起来') }

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : '') + '\n')
cdp.logs.forEach(l => console.log('  页面: ' + l))
cdp.close()
process.exit(fail ? 1 : 0)
