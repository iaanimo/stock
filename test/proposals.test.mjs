// test/proposals.test.mjs —— 待办箱全链路冒烟（CDP 连 headless Edge）
//
// 验的就是「第三级同事 agent」第一期的完整闭环：
//   ①开 App 巡检自主跑（不点任何按钮就有待办）  ②四岗发现进待办箱、按优先级排
//   ③差异调查 = 自由工具循环（工具留痕进报告）  ④改提案（新版本回待处理，旧版本留痕）
//   ⑤通过 → 待落库流水行真的落库（审计：AI 起草 · 谁批准 · 何时）
//   ⑥拒绝 → 理由存档  ⑦追问 → Q&A 挂回提案  ⑧再巡一次不刷屏（去重）
//   ⑨全程 AI 只写 proposals 表 —— 不点批准，moves 一条不多
//
// 用法（先起带假摄像头的 headless Edge，9222 端口；serve 8000 在跑）：
//   msedge --headless=new --remote-debugging-port=9222 --remote-allow-origins='*' \
//          --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
//          --user-data-dir=<无空格路径> about:blank &
//   node test/proposals.test.mjs

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

// —— 迷你测试框架（和 logic.test.cjs 同风格）——
let pass = 0, fail = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log('  OK   ' + name) }
  else { fail++; console.log('  FAIL ' + name + '\n       得到 ' + g + '\n       应为 ' + w) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(cdp, expr, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await cdp.eval(expr)
    if (v) return v
    await sleep(200)
  }
  return null
}

const tab = await newTab()
const cdp = connect(tab.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Runtime.enable')

// 等 boot() 灌完种子数据 + 巡检引擎就绪
await until(cdp, `typeof Patrol !== 'undefined' && S.items.length > 0`, 8000)

console.log('\n① 开 App 巡检自主跑（没点任何按钮）')
// 自主巡检是异步的（app.js boot 里 fire-and-forget），带 LLM 起草时可能要几秒：
// 这里等「待办真的进台账」再读，而不是抢跑读瞬时值（超时给足 20 秒）
const bootProps = await until(cdp, `S.proposals.length`, 20000)
eq('开 App 不点按钮就有待办（自主跑）', (bootProps || 0) >= 1, true)
const homeCard = await cdp.eval(`!!document.querySelector('a[href="#proposals"]')`)
eq('首页有待办箱卡片', homeCard, true)

console.log('\n② 四岗发现进待办箱（清空重扫，状态可复现）')
const swept = await cdp.eval(`(async () => {
  await DB.clear('proposals')
  const fresh = await Patrol.sweep()
  await reload()
  return fresh.map(p => p.kind)
})()`)
eq('四岗有产出（种子里 3 个低库存 + 日报）',
  swept.includes('low_stock') && swept.includes('daily'), true)
eq('发现按优先级立提案（日报排最后）', swept[swept.length - 1], 'daily')
await cdp.eval(`location.hash = '#proposals'`)
await sleep(300)
const cardCount = await cdp.eval(`document.querySelectorAll('.prop').length`)
eq('待办箱页面渲染出提案卡片', cardCount >= 2, true)
const auditLine = await cdp.eval(`document.querySelector('.prop .audit').textContent`)
eq('卡片带审计身份（AI 起草 · 何时）', /AI 巡检/.test(auditLine) && /\d+\/\d+/.test(auditLine), true)

console.log('\n③ 差异调查 = 自由工具循环（制造一笔负库存）')
const anomPid = await cdp.eval(`(async () => {
  const m = DB.makeMove('out', 'it_6204', 'A-2-1', -200, [], '测试员')
  await DB.put('moves', m)
  await reload()
  await Patrol.sweep()
  await reload()
  render()
  const p = S.proposals.find(x => x.key === 'anomaly:' + m.id)
  return p ? p.id : null
})()`)
eq('负库存被巡检岗抓到（立了提案）', typeof anomPid, 'string')
await cdp.eval(`document.querySelector('[data-act="invest"][data-id="${anomPid}"]').click()`)
const inv = await until(cdp, `(async () => {
  await reload()
  const p = S.proposals.find(x => x.key === 'inv:${anomPid}' && x.status === 'open')
  return p ? JSON.stringify({ id: p.id, tools: p.tool_calls.length, lines: p.lines, model: p.model }) : null
})()`, 15000)
const invJ = inv ? JSON.parse(inv) : null
eq('调查报告生成（不重复调查）', !!invJ, true)
eq('调查走了工具循环（查流水→查同款→查邻位，全留痕）', invJ && invJ.tools >= 3, true)
eq('调查附"补平"建议流水行（数量 = 账面结余补平）',
  invJ && invJ.lines && invJ.lines[0].type === 'count' && invJ.lines[0].qty > 0, true)

console.log('\n④ 改提案（非单向状态机，改的是调查报告的建议行）')
const invPid = invJ.id
await until(cdp, `document.querySelector('[data-act="revise"][data-id="${invPid}"]') ? true : null`, 6000)
await cdp.eval(`document.querySelector('[data-act="revise"][data-id="${invPid}"]').click()`)
const revOk = await cdp.eval(`(async () => {
  const inp = document.getElementById('rev-${invPid}-0')
  if (!inp) return false
  inp.value = '9'
  document.querySelector('[data-act="reviseOk"][data-id="${invPid}"]').click()
  return true
})()`)
eq('改提案入口可用', revOk, true)
const revState = await until(cdp, `(async () => {
  await reload()
  const old = S.proposals.find(x => x.id === '${invPid}')
  const nw = S.proposals.find(x => x.supersedes === '${invPid}')
  return old && nw ? JSON.stringify({ oldStatus: old.status, qty: nw.lines[0].qty, nwStatus: nw.status, nwId: nw.id }) : null
})()`, 8000)
const revJ = revState ? JSON.parse(revState) : null
eq('旧版本留痕（superseded）+ 新版本回待处理',
  revJ && revJ.oldStatus === 'superseded' && revJ.nwStatus === 'open', true)
eq('数量已改成页面输入的 9', revJ && revJ.qty, 9)

console.log('\n⑤ 通过 → 落库（写库存的笔在人手里）')
const movesBefore = await cdp.eval(`S.moves.length`)
// ⚠️ 原来这里是 `?.click(); return true` —— 无条件返回 true，**任何情况下都过**：
//    按钮不存在也过、点了没反应也过。名字说"两步确认"，断言的是个常量。
//    改成断言**可观察的结果**：点第一下之后流水一条没多、而且确认框亮出来了。
const firstClick = await cdp.eval(`(async () => {
  const b = document.querySelector('[data-act="approve"][data-id="${revJ.nwId}"]')
  if (!b) return 'no-button'
  b.click()
  await new Promise(r => setTimeout(r, 400))
  const confirmUp = !!document.querySelector('[data-act="approveOk"][data-id="${revJ.nwId}"]')
  return S.moves.length + '/' + (confirmUp ? 'has-confirm' : 'no-confirm')
})()`)
eq('点「通过」只亮确认框、暂不落库（两步确认）', firstClick, movesBefore + '/has-confirm')
const confirmShown = await until(cdp, `document.querySelector('[data-act="approveOk"][data-id="${revJ.nwId}"]') ? true : null`, 4000)
eq('确认框亮出待落库流水行', confirmShown, true)
await cdp.eval(`document.querySelector('[data-act="approveOk"][data-id="${revJ.nwId}"]').click()`)
const after = await until(cdp, `(async () => {
  await reload()
  const p = S.proposals.find(x => x.id === '${revJ.nwId}')
  const mv = S.moves.find(m => m.type === 'count' && m.qty === 9 && (m.operator || m.by))
  return p && p.status === 'approved' && mv
    ? JSON.stringify({ moves: S.moves.length, mv: mv, decided: !!p.decided_by }) : null
})()`, 8000)
const afterJ = after ? JSON.parse(after) : null
eq('批准后落库 1 条流水（qty=9 的盘点调整）',
  afterJ && afterJ.moves === movesBefore + 1 && !!afterJ.mv, true)
eq('流水带批准人（审计身份）',
  afterJ && (afterJ.mv.operator || afterJ.mv.by) === (await cdp.eval('CONFIG.operator || "未署名"')), true)
eq('提案审计身份完整（AI 起草 · 谁批准 · 何时）', afterJ && afterJ.decided, true)

console.log('\n⑥⑦ 拒绝留理由 · 追问挂回提案')
const rejClicked = await cdp.eval(`(async () => {
  render()
  const daily = S.proposals.find(x => x.kind === 'daily' && x.status === 'open')
  if (!daily) return null
  document.querySelector('[data-act="reject"][data-id="' + daily.id + '"]').click()
  document.getElementById('rej-' + daily.id).value = '今天没动静，不用看'
  document.querySelector('[data-act="rejectOk"][data-id="' + daily.id + '"]').click()
  return daily.id
})()`)
eq('拒绝入口可用', typeof rejClicked, 'string')
const rejState = await until(cdp, `(async () => {
  await reload()
  const p = S.proposals.find(x => x.id === '${rejClicked}')
  return p && p.status === 'rejected' ? JSON.stringify({ status: p.status, reason: p.decide_reason }) : null
})()`, 8000)
const rejJ = rejState ? JSON.parse(rejState) : null
eq('拒绝：理由存档 + 状态流转', rejJ && rejJ.status === 'rejected' && rejJ.reason.length > 0, true)

const askState = await cdp.eval(`(async () => {
  render()
  const low = S.proposals.find(x => x.kind === 'low_stock' && x.status === 'open')
  if (!low) return null
  document.querySelector('[data-act="ask"][data-id="' + low.id + '"]').click()
  document.getElementById('ask-' + low.id).value = '这个要不要补货'
  document.querySelector('[data-act="askOk"][data-id="' + low.id + '"]').click()
  return low.id
})()`)
eq('追问入口可用', typeof askState, 'string')
const qaDone = await until(cdp, `(async () => {
  await reload()
  const p = S.proposals.find(x => x.id === '${askState}')
  const ev = p && (p.events || []).find(e => e.action === 'ask')
  return ev && ev.answer ? JSON.stringify({ q: ev.note, a: ev.answer.slice(0, 30) }) : null
})()`, 15000)
eq('Q&A 挂回提案留痕（带答案）', !!qaDone, true)

console.log('\n⑧ 再巡一次不刷屏（去重生效）')
const dd = JSON.parse(await cdp.eval(`(async () => {
  await Patrol.sweep()          // 第一次：把数据变化（负库存→6204 也低库存了）产生的新发现收进来
  const before = (await DB.getAll('proposals')).length
  await Patrol.sweep()          // 第二次：同 key 开着的不许重复立
  const after = (await DB.getAll('proposals')).length
  return JSON.stringify({ before, after })
})()`))
eq('连续两次巡检：同 key 开着的不重复立', dd.after === dd.before, true)

console.log('\n⑨ 单据解析全链路（粘贴送货单 → AI 起草 → 批准落库）')
await cdp.eval(`location.hash = '#receive'`)
const draftBtnOn = await until(cdp, `document.getElementById('draftBtn') ? true : null`, 4000)
eq('收货页有「粘贴送货单」入口', draftBtnOn, true)
await cdp.eval(`document.getElementById('draftBtn').click()`)
const draftOpen = await until(cdp, `document.getElementById('draftText') ? true : null`, 4000)
eq('粘贴页打开', draftOpen, true)
await cdp.eval(`(async () => {
  document.getElementById('draftText').value = '6204轴承 50\\n没有这个商品 3'
  document.getElementById('draftParse').click()
  return true
})()`)
const preview = await until(cdp, `document.getElementById('draftSubmit')
  ? JSON.stringify({ rows: document.querySelectorAll('.dq').length, noteShown: document.body.innerText.includes('待人工处理') })
  : null`, 8000)
const pvJ = preview ? JSON.parse(preview) : null
eq('解析出可送审的商品行（数量可改）', pvJ && pvJ.rows >= 1, true)
eq('匹配不上的行显示「待人工处理」', pvJ && pvJ.noteShown, true)
await cdp.eval(`(async () => {
  document.querySelector('.dq').value = '30'
  document.getElementById('draftSubmit').click()
  return true
})()`)
const draftProp = await until(cdp, `(async () => {
  await reload()
  const p = S.proposals.find(x => x.kind === 'draft_receipt' && x.status === 'open')
  return p ? JSON.stringify({ id: p.id, lines: p.lines, by: p.created_by }) : null
})()`, 8000)
const dpJ = draftProp ? JSON.parse(draftProp) : null
eq('送审生成收货草稿提案（AI 起草身份）', !!dpJ && /AI 单据起草/.test(dpJ.by), true)
eq('草稿行数量 = 页面改过的 30', dpJ && dpJ.lines[0].qty, 30)
const movesB2 = await cdp.eval(`S.moves.length`)
await cdp.eval(`document.querySelector('[data-act="approve"][data-id="${dpJ.id}"]').click()`)
await until(cdp, `document.querySelector('[data-act="approveOk"][data-id="${dpJ.id}"]') ? true : null`, 4000)
await cdp.eval(`document.querySelector('[data-act="approveOk"][data-id="${dpJ.id}"]').click()`)
const draftAfter = await until(cdp, `(async () => {
  await reload()
  const p = S.proposals.find(x => x.id === '${dpJ ? dpJ.id : ''}')
  const mv = S.moves.find(m => m.type === 'in' && m.qty === 30 && (m.operator || m.by))
  return p && p.status === 'approved' && mv ? JSON.stringify({ moves: S.moves.length }) : null
})()`, 8000)
eq('批准后收货流水落库 1 条（qty=30，带批准人）',
  draftAfter && JSON.parse(draftAfter).moves === movesB2 + 1, true)

console.log('\n⑩ 只读硬保证 + 控制台')
// ⚠️ 用**前缀**匹配。原来写的是 `=== 'AI 巡检'`，而代码里 AI 的实际署名是
//    'AI 巡检 · 规则引擎' / 'AI 调查 · 规则引擎' / 'AI 单据起草 · 规则引擎' ——
//    一个都对不上，所以 AI 就算真自己写了流水也照样绿：**这条断言永远不会失败**。
const aiMoves = await cdp.eval(`(async () => {
  return S.moves.filter(m => /^AI /.test(m.operator || m.by || '')).length
})()`)
eq('AI 名下 0 条流水（写库存的笔只在人手里）', aiMoves, 0)

console.log('\n⑪ 追问写回不能冲掉「已批准」（回归 · 2026-09-30 修）')
// 旧写法：Patrol.ask 拿**渲染时那份 p** 造新对象整条 put。而 await AI.ask 是秒级窗口，
// 用户完全可能在这期间点了「通过」—— 于是 status/decided_by/批准审计事件全被冲回 open，
// 再点「通过」又能落一次 = 同一笔调整落两次（账实不符 + 审计被抹）。
// 这里冻结一份「过期快照」，精确重演界面闭包那条路径。
const qaFix = await cdp.eval(`(async () => {
  const ex = await Patrol.extractRows('6204轴承 3')      // → { rows, source }
  const fresh = await Patrol.submitDraft('6204轴承 3', ex.rows, null)
  const stale = JSON.parse(JSON.stringify(fresh))   // 冻结：模拟界面闭包里那份
  const before = S.moves.length

  await Patrol.decide(stale, true, '回归测试')      // ① 先批准（库里变 approved）
  await Patrol.ask(stale, '回归测试追问')           // ② 再用过期快照走追问写回
  const stored = (await DB.getAll('proposals')).find(x => x.id === stale.id)
  const afterAsk = S.moves.length
  const again = await Patrol.decide(stale, true, '回归测试')   // ③ 再点一次通过

  return {
    status: stored.status,
    decided: stored.decided_by || '(空)',
    approveEvents: (stored.events || []).filter(e => e.action === 'approve').length,
    askEvents: (stored.events || []).filter(e => e.action === 'ask').length,
    movesFromApprove: afterAsk - before,
    secondSkipped: again && again.skipped ? again.skipped : '(没被挡)',
    movesFromSecond: S.moves.length - afterAsk,
  }
})()`)
eq('⑪ 提案停在「已批准」（没被追问冲回 open）', qaFix.status, 'approved')
eq('⑪ 批准人还在（没被清空）', qaFix.decided !== '(空)', true)
eq('⑪ 批准时的审计事件还在', qaFix.approveEvents >= 1, true)
eq('⑪ 追问的 Q&A 也挂上了（不是简单拒绝写入）', qaFix.askEvents >= 1, true)
eq('⑪ 再点一次「通过」被状态闸挡住', qaFix.secondSkipped !== '(没被挡)', true)
eq('⑪ 第二次点击落 0 条流水（不翻倍）', qaFix.movesFromSecond, 0)

console.log('\n⑫ 落库按钮防连点（回归 · 2026-09-30 修）')
// 旧写法：await 落盘之后才清 S.receive —— 两次点击都能通过界面检查，
// 同一批流水落两遍（实测库存翻倍）。这里在**同一个 tick 里调两次**模拟双击。
const dbl = await cdp.eval(`(async () => {
  S.receive = { item: S.items[0], loc: S.locations[0], qty: 1, photos: [] }
  const before = S.moves.length
  await Promise.all([doReceive(), doReceive()])
  return { delta: S.moves.length - before }
})()`)
eq('⑫ 双击「确认上架」只落 1 条流水（不翻倍）', dbl.delta, 1)

const errs = cdp.logs.filter(l => l.startsWith('异常') || l.startsWith('error:'))
console.log('\n控制台错误：' + (errs.length ? errs.join('\n') : '无'))
eq('控制台 0 错误', errs.length, 0)

console.log('\n结果：' + pass + ' 通过' + (fail ? '，' + fail + ' 失败' : '') + '\n')

// 自清理：本测试注入过负库存流水，收工前恢复种子数据，别把脏状态留给别的测试套件
await cdp.eval(`(async () => { await DB.reset(); await DB.clear('proposals'); return true })()`)
cdp.close()
process.exit(fail ? 1 : 0)
