# stock-web —— 仓库管理

仓库管理系统：手机扫码收发货、货位定位、盘点比对、AI 问答与巡检、断网可用。

**数据全部存在浏览器本机（IndexedDB）** —— 扫码 / 收货 / 出库 / 盘点这些核心功能不需要后端。
只有 AI 问答要一个轻量转发代理（`app.py`），作用是把 API key 留在服务端，不配也能跑（自动落到本地规则）。

## 跑起来

```bash
cd stock-web
pip install -r requirements.txt
copy .env.example .env     # 可选：填 DEEPSEEK_API_KEY 才有真 AI，不填走本地规则
python app.py              # 静态托管 + AI 转发代理（key 收在服务端 .env，不进前端）
```

- 桌面：`http://localhost:8000` —— 本机可以直接用摄像头
- 手机直连：默认**连不上**（服务只监听本机，原因见下面「安全」）。确实要开：`python app.py --lan`
- 只要静态托管不要 AI 代理：`python serve.py` 也行（问答自动落到本地规则）

**手机要用扫码，必须 HTTPS。** 本机 localhost 不受这个限制，手机测的时候走隧道：

```bash
cloudflared tunnel --url http://localhost:8000
```

拿到的 `https://xxx.trycloudflare.com` 手机直接打开，扫码就能用。

## ⚠️ 安全（三条，改代码前先看）

1. **静态文件走白名单**（`whitelist.py`）。**不要换回裸的 `StaticFiles(directory=项目根)`** ——
   那会把 `.env`（装着 API key）一并端出去：实测 `curl http://localhost:8000/.env`
   直接返回密钥明文，而按上面那条 cloudflared 教程操作，这个端口就暴露在公网上。
2. **默认只监听本机**（`127.0.0.1`）。`/api/chat` 没有用户体系，**谁能连上谁就能用你的 key**，
   所以对外暴露必须是显式的 `--lan`（加了会打印警告）。
3. **`/api/chat` 带限流**（30 次/分钟/IP），防有人拿它刷余额。要更硬的锁就设环境变量
   `CHAT_TOKEN`，之后请求必须带 `X-Chat-Token` 头（前端在「AI 连接设置」里填）。

## 功能

1. **收货上架** —— 扫码/选商品 → 系统按规则推荐货位 → 填数量 → 拍照存证 → 确认，写一条入库流水
2. **出库拣货** —— 扫码/选商品 → 按各货位存量给出拣货顺序（存量多的先去，少跑腿）→ 确认，按顺序扣减
3. **库存查询** —— 搜商品名或编码，出总数 + 各货位分布，精确到排
4. **盘点** —— 按区或全仓列位点，逐个录实际数 → 自动比对，对不上的标红 → 可导出 CSV 差异表 → 可一键调整
5. **断网可用** —— 页面和数据都在本机，飞行模式下照常收发货、盘点；联网后点「同步」回传
6. **AI 问答** —— 问一句查库存（「轴承还剩多少」「6204 在哪个货位」），语音/打字都行，**只读不写**；没接模型或断网时自动用本地规则回答，答案照样带真数字
7. **AI 巡检 + 待办箱**（第三级同事 agent）—— 开 App 自动跑四岗巡检（呆滞 N 天未动 / 低库存 / 异常流水负库存·超大调整 / 每日日报），发现按优先级进「待办箱」；**AI 只起草提案，落库必须人批准**。支持差异调查（LLM 自选工具查因：查流水→查同款→查邻位，工具调用全程留痕）、追问、改提案（新版本回待处理，旧版本留痕）；审计身份 = AI 起草 · 谁批准 · 何时
8. **送货单解析（AI 起草）** —— 粘贴送货单文本 → AI 抽取（有 key）或规则解析 → 商品匹配/货位推荐全规则 → 收货草稿提案（数量可改、匹配不上的行列"待人工处理"）→ 待办箱批准才落库

> 没有实物条码时：扫码页右下角有「模拟扫到「xxx」」按钮，点一下等于扫到那个商品。

## 目录

```
index.html          单页外壳
css/app.css         全部样式
js/config.js        配置唯一入口（AI 连接 / demo|prod 模式 / 操作人）
js/db.js            数据层：IndexedDB + 种子数据 + proposals 提案表 + sync()
js/logic.js         业务逻辑（纯函数）：库存分布 / 货位推荐 / 拣货顺序 / 盘点 / 导出 / AI 工具箱 / 巡检四岗 / 提案生命周期 / 调查兜底 / 备份
js/scan.js          扫码：优先原生 BarcodeDetector，没有就自动装 WASM polyfill
js/tools.js         AI 工具白名单（只读，模型叫不动任何写操作）
js/agent.js         agent 回路：模型 ↔ 只读工具的多轮往返（SSE 流式，轮数硬上限）
js/ai.js            AI 问答唯一出入口（prod 代理 / demo 直连 / 本地兜底）
js/patrol.js        巡检引擎与提案台账（自主跑 / 调查 / 追问 / 改提案 / 人批准落库）
js/vendor/          扫码兜底（iPhone 用）：barcode-detector polyfill + ZXing 的 wasm，都 MIT
js/app.js           界面与交互（hash 路由，含待办箱页）
app.py              本地服务：静态托管 + AI 转发代理（服务端注入系统提示词和 key）
whitelist.py        静态文件白名单（app.py / serve.py 共用）—— 挡住 .env 之类不该发的文件
sw.js               Service Worker，断网还能打开页面
manifest.json       PWA，可以「添加到主屏幕」
serve.py            纯静态服务（不需要 AI 代理时用）
test/logic.test.cjs    业务逻辑自测（node 直接跑，不用浏览器）
test/agent.test.mjs    agent 回路/工具白名单/流水留痕自测（node 直接跑）
test/probe.mjs         渲染 + 主流程冒烟（带断言，可传网址验线上）
test/ui.test.mjs       界面回归：真实鼠标事件测「点击被吞」、「扫码取消竞态」
test/barcode.test.mjs  真解码验证 + fixtures/ 里的条码图片
test/scanflow.test.mjs 扫码动线（假摄像头，含 track 释放验证）
test/ask.test.mjs      AI 问答页冒烟 + 「全程只读」硬保证
test/proposals.test.mjs 待办箱全链路（巡检→调查→改提案→批准落库→审计留痕）
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

**全套 = 238 项断言 / 9 层测试网**（2026-09-27 全绿，数字是实测的）：

| 层 | 命令 | 项数 | 验什么 |
|---|---|---|---|
| 1 | `python test/py_selftest.py` | 48 | **服务端安全边界**（零依赖，不用 pytest）：静态白名单 + 目录穿越/编码绕过、丢弃前端 system、工具配对校验、长度与条数上限、限流、提示词纪律 |
| 2 | `node test/logic.test.cjs` | 80 | 业务纯函数：库存/搜索/推荐/拣货/盘点/CSV/问答兜底/备份 + 巡检四岗/提案生命周期/调查兜底/单据解析。**含 11 项备份校验**（坏数据必须被拒，否则 App 会变砖） |
| 3 | `node test/agent.test.mjs` | 39 | agent 回路、工具白名单只读、防注入、降级链、流水留痕字段 |
| 4 | `node test/ask.test.mjs` | 7 | AI 问答页冒烟 + 「问完流水一条不多」只读硬保证 |
| 5 | `node test/barcode.test.mjs` | 4 | 条码真解码 + wasm 必须本站加载（不许 CDN） |
| 6 | `node test/scanflow.test.mjs` | 8 | 扫码动线：假摄像头真的出图、**取消后原 stream 的 track 全部 ended** |
| 7 | `node test/ui.test.mjs` | 9 | 界面回归（**真实鼠标事件**）：改完数量后第一下点按钮不能失效、扫码等组件时点取消不能把摄像头留在开着 |
| 8 | `node test/probe.mjs` | 11 | 渲染 + 三个主流程冒烟（可传网址验线上） |
| 9 | `node test/proposals.test.mjs` | 32 | 待办箱全链路：自主巡检→调查工具循环→改提案→批准落库→审计留痕→拒绝存档→追问→去重→单据解析链路 |

```bash
node test/logic.test.cjs
node test/agent.test.mjs
```

1、2 层不依赖浏览器（node 直接跑）。logic.js 是纯函数所以能脱离浏览器测；db.js 用了 IndexedDB，测不了。
（后缀是 `.cjs` 不是 `.js`——上层目录有 `"type":"module"` 的 package.json，`.js` 会被当成 ESM。）

3–9 层用 CDP 连 headless Edge（先起探针再跑测试）。**scanflow 和 proposals 建议都带假摄像头参数**：

```bash
msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
       --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
       --user-data-dir=<无空格路径> about:blank &
node test/ask.test.mjs
node test/barcode.test.mjs
node test/scanflow.test.mjs
node test/ui.test.mjs
node test/probe.mjs
node test/proposals.test.mjs
```

这些脚本都会自己导航（`about:blank` 起探针即可），也可以传网址去验线上部署：
`node test/probe.mjs https://iaanimo.github.io/stock/`

> Windows 探针三坑（实测踩过）：①`msedge` 不在 PATH，用完整路径
> `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` ②`--user-data-dir` 带空格会被
> Start-Process 拆成多个参数（报 "Multiple targets are not supported"），路径别带空格（放 %TEMP%）
> ③旧探针没退干净会占住 `127.0.0.1:9222`，新探针只能绑到 `[::1]`，测试连的还是旧实例——换 profile 前先杀旧探针。
> 清理探针只杀自己起的 PID，别杀全部 msedge（用户自己的浏览器混在里面）。

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

`test/ask.test.mjs` 验 AI 问答页：渲染、答案带真数字、以及**全程只读**（问完流水一条不多）：

```bash
msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
       --user-data-dir=/tmp/edge-ask http://localhost:8000/ &
node test/ask.test.mjs
```

`test/proposals.test.mjs` 验待办箱全链路（第三级同事 agent 第一期）：开 App 自主巡检 → 四岗发现进待办箱 →
负库存案子调查（工具循环留痕）→ 改提案（新版本回待处理）→ 批准后流水真的落库且带批准人 → 拒绝存理由 →
追问挂回提案 → 连续巡检不刷屏 → **AI 自己名下 0 条流水**（不点批准 moves 一条不多）：

```bash
node test/proposals.test.mjs
```

测试收工前自动恢复种子数据（它注入过负库存流水），不会把脏状态留给别的套件。

## 五个关键设计（改代码前先看这里）

**1. 库存不是字段，是流水算出来的**（`js/logic.js`）
所有增减都写一条 `moves` 记录（`in` 收货 / `out` 出库 / `count` 盘点调整 / `init` 期初），库存 = 把同一个「商品+货位」的 qty 加起来。
好处：**多台设备离线各记各的，回传时把流水合并就行，不会互相覆盖**。代价是每次算库存要遍历流水——几千条无所谓。

**2. 货位推荐规则**（`Logic.suggestLocation`）
- 这个商品已经有货位 → 放回原处（同类放一起，下次找得快）
- 全新商品 → 找一个完全空的货位
- 全满 → 返回 null，界面提示手动选

**3. 接后端只改一个函数**
`DB.sync(moves)` 现在是把没同步的流水标记成已同步（模拟）。接真后端时换成 `fetch('/api/moves', ...)` 就行，其它代码不用动。

**4. AI 只读，且只有一个出入口（`js/ai.js` + `js/config.js`）**
AI 拿到的工具全是查询（`Logic.toolbox` 包现有纯函数），写操作一条都没暴露给模型——问答页有测试钉死「全程只读」。
换模型 / 转商用只改 `config.js`：demo 直连（key 只放本机）、prod 走服务端代理（key 不进前端），业务代码一行不动。
没配 key、断网、模型抽风 → 自动落回 `Logic.askLocal` 本地规则回答，答案照样带真数字。
回答附「工具调用记录」，AI 查过什么、拿的什么数，全部可审计。

**5. agent 只起草，落库的笔在人手里**（`js/logic.js` 巡检/提案层 + `js/patrol.js`）
巡检四岗的**判定全用规则**（`inspectStagnant/inspectLowStock/inspectAnomalies/dailyReport`，纯函数可测），
LLM 只起草说明文字——没 key 用规则文案，判定结果永远一致。agent 唯一可写处是 `proposals` 提案表：
通过 → 有待落库流水行才逐条 `addMove`（流水归因=批准人）；拒绝 → 理由存档；改提案 → 新版本回待处理、
旧版本留痕（非单向状态机）；调查/追问的工具调用记录全部进 `events`。审计身份 = **AI 起草 · 谁批准 · 何时**，
`test/proposals.test.mjs` 钉死「AI 自己名下 0 条流水」。去重靠 `shouldPropose`：同 key 开着的不重复立，
拒绝后 7 天冷却，条件还在冷却过后旧事重提。

## 待办（按优先级）

- [ ] **还没在真 iPhone 上跑过**：polyfill 那条路已在桌面浏览器上做过真解码验证（`test/barcode.test.mjs`），但它没在真实的 iOS Safari 上跑过。有机会拿真机确认一次
- [ ] **真机演示前先预热**：线上首次解码要等 wasm 下载+编译（实测约 60 秒量级，本地 55ms）。手机第一次打开页面后缓存就装好了，但**别在现场才第一次打开**
- [ ] 扫码性能：polyfill 走 WASM + canvas，每帧约 10–70ms。真机上如果觉得卡，可以调大 `js/scan.js` 里 `setTimeout(tick, 300)` 的间隔
- [ ] **AI 转发代理已就位（`app.py`）**：key 收服务端 `.env`、服务端注入系统提示词。商用交付还差**正式隧道 + 自己域名**（trycloudflare 官方定位是开发测试）；演示期直连自己的 key 没问题，但 key 不许进公开部署
- [x] **AI 单据解析**（2026-09-26 已落地）：粘贴送货单文本 → AI 抽取/规则解析 → 收货草稿提案 → 人工批准才落库。剩：**拍照 OCR 抽取入口**（照片现在只存证不过 OCR）
- [ ] **真后端 + 多端同步**：现在 `sync()` 是模拟的。流水 `id` 已是幂等键（多机不撞号），服务端按它去重即可合并
- [ ] **作废/反冲**：录错了怎么改？现在只能补反向流水，还没有"作废的是哪条"的引用关系
- [ ] **标签打印**：如果要自己打印并贴条码标签，网页方案做不了（浏览器连不上蓝牙标签机），得转微信小程序或原生 App
- [ ] 标签编码规则可配置（现在货位编码是写死的 `区-排-层`）
- [ ] 商品增删改（现在只有种子数据，没有维护商品的界面）
- [ ] 单据管理（真正的提货单/收货单，现在出库是直接选商品）
- [ ] 用户与权限（流水 `by` 字段已记操作人留痕，但没有登录鉴权，谁都能改）
