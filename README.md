# stock-web —— 仓库管理

一个纯前端的仓库管理系统：手机扫码收发货、货位定位、盘点比对、断网可用。
**数据全部存在浏览器本机（IndexedDB），不需要后端就能跑起来。**

## 跑起来

```bash
cd stock-web
python serve.py
```

- 桌面：`http://localhost:8000` —— 本机可以直接用摄像头
- 手机：`http://<局域网IP>:8000` —— **只能看，扫码用不了**（http 页面浏览器不给摄像头权限）

**手机要用扫码，必须 HTTPS。** 本机 localhost 不受这个限制，手机测的时候走隧道：

```bash
cloudflared tunnel --url http://localhost:8000
```

拿到的 `https://xxx.trycloudflare.com` 手机直接打开，扫码就能用。

## 功能

1. **收货上架** —— 扫码/选商品 → 系统按规则推荐货位 → 填数量 → 拍照存证 → 确认，写一条入库流水
2. **出库拣货** —— 扫码/选商品 → 按各货位存量给出拣货顺序（存量多的先去，少跑腿）→ 确认，按顺序扣减
3. **库存查询** —— 搜商品名或编码，出总数 + 各货位分布，精确到排
4. **盘点** —— 按区或全仓列位点，逐个录实际数 → 自动比对，对不上的标红 → 可导出 CSV 差异表 → 可一键调整
5. **断网可用** —— 页面和数据都在本机，飞行模式下照常收发货、盘点；联网后点「同步」回传

> 没有实物条码时：扫码页右下角有「模拟扫到「xxx」」按钮，点一下等于扫到那个商品。

## 目录

```
index.html          单页外壳
css/app.css         全部样式
js/db.js            数据层：IndexedDB + 种子数据 + sync()
js/logic.js         业务逻辑（纯函数）：库存分布 / 货位推荐 / 拣货顺序 / 盘点 / 导出
js/scan.js          扫码：优先原生 BarcodeDetector，没有就自动装 WASM polyfill
js/vendor/          扫码兜底（iPhone 用）：barcode-detector polyfill + ZXing 的 wasm，都 MIT
js/app.js           界面与交互（hash 路由）
sw.js               Service Worker，断网还能打开页面
manifest.json       PWA，可以「添加到主屏幕」
serve.py            本地静态服务
test/logic.test.cjs   业务逻辑自测（node 直接跑，不用浏览器）
test/probe.mjs        用 CDP 连真实浏览器验渲染（见下）
test/barcode.test.mjs 真解码验证 + fixtures/ 里的条码图片
```

## 扫码走哪条路

| 设备 | 路径 |
|---|---|
| 安卓 Chrome / Edge、桌面 Chromium | 浏览器自带的 `BarcodeDetector`，零额外开销 |
| **iPhone**（任何浏览器） | 自动加载 `js/vendor/` 里的 WASM polyfill（ZXing-C++ 编译） |

为什么 iPhone 要特殊处理：Safari 没实现 `BarcodeDetector`，而 iOS 强制所有浏览器都用 WebKit 内核
—— **iPhone 上装 Chrome 也一样没有**。polyfill 提供一模一样的接口，所以 `js/scan.js` 里不用写分支。

⚠️ polyfill 默认从 jsdelivr CDN 拉那 1.1MB 的 wasm，**断网就废**。这里用 `prepareZXingModule`
把它指到本机 `js/vendor/zxing_reader.wasm`，并由 `sw.js` 预缓存 —— 不然"地下室断网"和"iPhone 能扫"
这两个需求会互相打架。代价是安装时多下 1.1MB。

## 自测

```bash
node test/logic.test.cjs
```

15 项，覆盖库存求和、搜索、货位推荐、拣货顺序、盘点点数、CSV 导出。
logic.js 是纯函数所以能脱离浏览器测；db.js 用了 IndexedDB，测不了。
（后缀是 `.cjs` 不是 `.js`——上层目录有 `"type":"module"` 的 package.json，`.js` 会被当成 ESM。）

`test/probe.mjs` 是渲染层的冒烟测试，用 CDP 连一个 headless Edge 跑一遍主流程：

```bash
msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
       --user-data-dir=/tmp/edge-probe http://localhost:8000/ &
node test/probe.mjs
```

> 注意：**别用 `--dump-dom` 验这个项目**。它在 load 事件就抓 DOM，而数据要等 IndexedDB 异步读完，
> 抓到的一定是空页面，会误判成 bug。

`test/barcode.test.mjs` 验的是扫码能不能**真的解出条码**——把 `test/fixtures/` 里的条码图片喂给
`BarcodeDetector`，断言解出来的文字和文件名一致：

```bash
msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
       --user-data-dir=/tmp/edge-bc about:blank &
node test/barcode.test.mjs
```

它同时断言 `.wasm` 是从本机加载的——哪天退回 jsdelivr CDN，这个测试会红（断网就废了）。
fixtures 里的图片是 2026-09-26 用 zxing-wasm 的 writer 生成的真条码
（`ZXingWASM.writeBarcode(文本, {format, scale: 4, withQuietZones: true})`），不是手画的。

## 三个关键设计（改代码前先看这里）

**1. 库存不是字段，是流水算出来的**（`js/logic.js`）
所有增减都写一条 `moves` 记录（`in` 收货 / `out` 出库 / `count` 盘点调整 / `init` 期初），库存 = 把同一个「商品+货位」的 qty 加起来。
好处：**多台设备离线各记各的，回传时把流水合并就行，不会互相覆盖**。代价是每次算库存要遍历流水——几千条无所谓。

**2. 货位推荐规则**（`Logic.suggestLocation`）
- 这个商品已经有货位 → 放回原处（同类放一起，下次找得快）
- 全新商品 → 找一个完全空的货位
- 全满 → 返回 null，界面提示手动选

**3. 接后端只改一个函数**
`DB.sync(moves)` 现在是把没同步的流水标记成已同步（模拟）。接真后端时换成 `fetch('/api/moves', ...)` 就行，其它代码不用动。

## 待办（按优先级）

- [ ] **还没在真 iPhone 上跑过**：polyfill 那条路已在桌面浏览器上做过真解码验证（`test/barcode.test.mjs`），但它没在真实的 iOS Safari 上跑过。有机会拿真机确认一次
- [ ] 扫码性能：polyfill 走 WASM + canvas，每帧约 10–70ms。真机上如果觉得卡，可以调大 `js/scan.js` 里 `setTimeout(tick, 300)` 的间隔
- [ ] **真后端 + 多端同步**：现在 `sync()` 是模拟的。要真用起来，得有个服务端收流水、按流水合并库存
- [ ] **标签打印**：如果要自己打印并贴条码标签，网页方案做不了（浏览器连不上蓝牙标签机），得转微信小程序或原生 App
- [ ] 标签编码规则可配置（现在货位编码是写死的 `区-排-层`）
- [ ] 商品增删改（现在只有种子数据，没有维护商品的界面）
- [ ] 单据管理（真正的提货单/收货单，现在出库是直接选商品）
- [ ] 用户与权限（谁收的货、谁盘的盘）
