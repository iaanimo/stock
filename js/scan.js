// js/scan.js —— 扫码
//
// 优先用浏览器原生的 BarcodeDetector（Chromium 系：安卓 Chrome/Edge、桌面）。
//
// iPhone 上 Safari 没有这个 API，而且 iOS 强制所有浏览器都用 WebKit 内核
// —— 所以 iPhone 上装 Chrome 也一样没有。这里挂一个 WASM 版 polyfill（ZXing-C++ 编译），
// 它提供一模一样的接口，代码不用改。
//
// ⚠️ polyfill 默认从 jsdelivr CDN 拉那 1.1MB 的 wasm，断网就废。
//    这里用 prepareZXingModule 把它指到本机 js/vendor/zxing_reader.wasm（sw.js 会缓存）。
//
// ⚠️ 摄像头必须 HTTPS（或 localhost），http 页面浏览器直接拒绝给权限。

const Scan = (() => {

  // 从 scan.js 自己的位置推出 vendor/ 目录，这样放在子路径下部署也不会错
  const VENDOR = (() => {
    const s = document.currentScript
    return (s && s.src ? s.src.replace(/[^/]*$/, '') : 'js/') + 'vendor/'
  })()

  let polyfillPromise = null

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script')
      el.src = src
      el.onload = () => resolve()
      el.onerror = () => reject(new Error('加载失败：' + src))
      document.head.appendChild(el)
    })
  }

  // 有原生就用原生；没有就装 polyfill。
  // 返回 true = 具备识别能力；false = 装了也没用（连 polyfill 都起不来）
  function ensureDetector(onNote) {
    if ('BarcodeDetector' in window) return Promise.resolve(true)

    if (!polyfillPromise) {
      polyfillPromise = (async () => {
        if (onNote) onNote('正在准备扫码组件…')
        await loadScript(VENDOR + 'barcode-detector-polyfill.js')

        if (typeof BarcodeDetectionAPI === 'undefined') {
          throw new Error('polyfill 没有注册到全局')
        }

        BarcodeDetectionAPI.prepareZXingModule({
          overrides: {
            // 只拦 .wasm，其余照常（polyfill 自己是内联的，不需要额外文件）
            locateFile: (path, prefix) =>
              path.endsWith('.wasm') ? VENDOR + 'zxing_reader.wasm' : prefix + path
          },
          // 趁摄像头打开的那几百毫秒在后台把 wasm 实例化好，第一次扫不用等
          fireImmediately: true
        })

        return 'BarcodeDetector' in window
      })().catch(err => {
        polyfillPromise = null      // 失败就允许下次重试
        throw err
      })
    }

    return polyfillPromise
  }

  return {
    // 这台设备有没有原生识别能力（没有也不代表扫不了 —— 会自动装 polyfill）
    nativeSupported() {
      return 'BarcodeDetector' in window && !!navigator.mediaDevices
    },

    // 摄像头能用吗（HTTPS / 授权）
    cameraAvailable() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    },

    // 打开摄像头并持续识别，扫到就回调 onCode(text) 并自动停
    // 返回 { stop(), weak } —— weak=true 表示这台设备认不出码，只能看不能扫
    async start(videoEl, onCode, onNote) {
      if (!this.cameraAvailable()) {
        throw new Error('这台设备的浏览器不支持调用摄像头')
      }

      const hasDetector = await ensureDetector(onNote)

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      })

      videoEl.srcObject = stream
      videoEl.setAttribute('playsinline', 'true')
      await videoEl.play()

      const stop = () => stream.getTracks().forEach(t => t.stop())

      if (!hasDetector) return { stop: stop, weak: true }

      const detector = new BarcodeDetector()
      let alive = true

      // 用 setTimeout 而不是 requestAnimationFrame：
      // detect() 是异步的（polyfill 走 WASM 更慢），rAF 循环会把请求堆起来
      const tick = async () => {
        if (!alive) return
        try {
          const codes = await detector.detect(videoEl)
          if (codes && codes.length) {
            alive = false
            stop()
            onCode(codes[0].rawValue)
            return
          }
        } catch (e) { /* 单帧失败无所谓，接着下一帧 */ }
        setTimeout(tick, 300)
      }
      tick()

      return { stop: () => { alive = false; stop() }, weak: false }
    }
  }
})()
