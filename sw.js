// sw.js —— Service Worker：把页面本身缓存下来，断网也能打开
// 数据不走这里（数据在 IndexedDB），这里只管外壳（html/css/js）

const CACHE = 'stock-web-v5'

const ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'css/app.css',
  'js/config.js',
  'js/db.js',
  'js/logic.js',
  'js/scan.js',
  'js/tools.js',
  'js/agent.js',
  'js/ai.js',
  'js/patrol.js',
  'js/app.js',
  // 扫码兜底：iPhone 上没有原生 BarcodeDetector，靠这两个跑 WASM 解码。
  // 那 1.1MB 的 wasm 也一并预缓存 —— 不预缓存的话，地下室断网 + 第一次扫码 = 扫不了。
  // 代价是安装时多下 1.1MB，安卓用户其实用不到（他们有原生 API，不会加载这个脚本）。
  'js/vendor/barcode-detector-polyfill.js',
  'js/vendor/zxing_reader.wasm'
]

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  // 清掉旧版本的缓存
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// 策略：网络优先，断网回退缓存。
//
// 为什么不用更常见的「缓存优先」：那个在有网时也吐旧文件，改完代码刷新看不到变化，
// 调试时会以为是代码坏了。网络优先 = 有网永远最新、断网照样能打开。
// 真上线交付、不再频繁改代码时，可以换回缓存优先（加载更快）。
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return

  const url = new URL(e.request.url)
  if (url.origin !== location.origin) return      // 只管自己域名下的东西

  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone()
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {})
      return res
    }).catch(() =>
      caches.match(e.request).then(hit => hit || caches.match('index.html'))
    )
  )
})
