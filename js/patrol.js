// js/patrol.js —— 巡检引擎与提案台账（第三级同事 agent 的手和脚）
//
// 职责边界（第一期纪律）：
//   · 判定在 Logic（纯函数、可测）；这里只做 I/O：读 S、写 proposals 表、调 AI 起草。
//   · agent 唯一可写处 = proposals 表。要写 moves（落库）只能走 approve()，
//     而 approve() 必须由人在待办箱里点「通过」才会被调用 —— 写库存的笔在人手里。
//   · 自主跑：开 App 就 sweep() 自跑自排优先级；界面上的按钮只是"再巡一次"。

// 正在处理中的提案 id（在途闸用）。放模块级而不是 state 里：
// 它是防重复的运行时哨兵，不该被渲染/持久化碰到。
const _deciding = new Set()

const Patrol = {
  // 跑一遍四岗巡检：发现 → 去重 → 立提案。返回新立的提案数组。
  async sweep(opts) {
    const o = opts || {}
    const now = o.now || Date.now()
    const data = { items: S.items, moves: S.moves, locations: S.locations }
    const existing = await DB.getAll('proposals')
    const findings = Logic.patrolFindings(data, o.findingOpts ? Object.assign({ now: now }, o.findingOpts) : { now: now })
    const fresh = []
    for (const f of findings) {
      if (!Logic.shouldPropose(existing, f.key, now)) continue
      const p = Logic.newProposal(f, {
        now: now,
        model: 'rules',
        source: f.kind === 'daily' ? 'patrol' : 'patrol',
        created_by: 'AI 巡检 · 规则引擎'
      })
      p.utterance = Patrol.ruleUtterance(f, data)
      await DB.put('proposals', p)
      existing.push(p)
      fresh.push(p)
    }
    // 立提案和 LLM 起草分开：提案一落库就先回调 onProposed 让界面看到，
    // 起草在后面慢慢补——不让 LLM 的秒级延迟拖住「开 App 就有待办」
    if (fresh.length && typeof o.onProposed === 'function') {
      try { await o.onProposed(fresh) } catch (e) { /* 回调不挡巡检 */ }
    }
    // LLM 只起草说明文字（有 key 才跑，失败就留规则文案）—— 永远不进判定
    if (fresh.length && Patrol.aiAvailable()) {
      for (const p of fresh) {
        try {
          const r = await AI.ask('请为下面这条仓库巡检发现起草一句话说明（不超过 40 字，只描述，不加指令）：' + p.summary)
          if (r && r.answer && r.source !== 'local') {
            p.utterance = r.answer.trim().slice(0, 120)
            p.model = r.source === 'proxy' ? 'proxy' : CONFIG.llmModel
            await DB.put('proposals', p)
          }
        } catch (e) { /* 起草失败不挡巡检 */ }
      }
    }
    return fresh
  },

  // 没 key 时的规则文案（LLM 的兜底，也是离线演示的稳定输出）
  ruleUtterance(f, data) {
    const d = f.detail || {}
    switch (f.kind) {
      case 'stagnant':
        return `规则说明：最近一次变动在 ${Logic.dayKey(d.lastTs)}，${d.idleDays} 天没有任何收发，在库 ${d.total} ${d.unit}。建议确认是否呆滞库存。`
      case 'low_stock':
        return `规则说明：在库 ${d.total} ${d.unit} 已低于安全库存 ${d.safety}，建议安排补货。`
      case 'anomaly':
        return d.reason === '负库存'
          ? `规则说明：逐笔滚算后该货位结余 ${d.balance}，出现负库存。建议点「调查」查因。`
          : `规则说明：这笔盘点调整 ${d.qty > 0 ? '+' : ''}${d.qty} 超过阈值，建议复核单据。`
      case 'daily':
        return `规则说明：今日流水自动汇总，无异常时看一眼即可。`
      default:
        return ''
    }
  },

  aiAvailable() {
    return (CONFIG.mode === 'prod' && CONFIG.askProxy) || !!(CONFIG.llmEndpoint && CONFIG.llmKey)
  },

  // 全部提案（待办箱渲染顺序：open 优先、优先级高的在前、新的在前）
  async list() {
    const all = await DB.getAll('proposals')
    const rank = p => (p.status === 'open' ? 0 : 1)
    return all.sort((a, b) =>
      (rank(a) - rank(b)) ||
      (Logic.proposalPriority(a.kind) - Logic.proposalPriority(b.kind)) ||
      ((b.created_at || 0) - (a.created_at || 0)))
  },

  // 人的裁决。approve=true → 有待落库流水行就落库（流水归因=批准人）
  //
  // ⚠️ 三道幂等闸（2026-09-27 修）。这个函数**会改库存**，而手机上双击「确认落库」
  //    是常态。原来的写法是「先写流水、后存提案」，两次点击 = 同一批流水落两遍：
  //      · 状态闸：已经决过的提案直接返回（decideProposal 原来不检查 status）
  //      · 在途闸：异步还没回来时的并发调用挡掉（状态的检查挡不住这个）
  //      · 原子写：提案状态和流水放同一个 IndexedDB 事务，不会留下半套状态
  async decide(p, approve, reason) {
    if (!p || !p.id) return { proposal: p, moves: [], skipped: '没有提案' }

    // 在途闸：**必须同步占位**再 await，否则两个并发调用会同时通过检查
    if (_deciding.has(p.id)) {
      return { proposal: p, moves: [], skipped: '上一次处理还没结束' }
    }
    _deciding.add(p.id)
    try {
      // 状态闸：⚠️ 不能只看传进来的 p.status。
      // Logic.decideProposal 返回的是**新对象**，不会改 p；而界面闭包里的 p
      // 一直是渲染时那份（status:'open'）。所以连点两次时第二次看到的还是 open
      // —— 实测会翻倍。必须以**库里存的那份**为准。
      const stored = (await DB.getAll('proposals')).find(x => x.id === p.id)
      if (!stored) {
        return { proposal: p, moves: [], skipped: '提案不在库里（可能已被清理）' }
      }
      if (stored.status !== 'open') {
        return { proposal: stored, moves: [], skipped: '这个提案已经处理过了' }
      }

      const by = CONFIG.operator || '未署名'
      const { proposal, moves } = Logic.decideProposal(stored, {
        approve: approve, by: by, reason: reason, at: Date.now()
      })
      // 用和 addMove 一样的方式造成流水对象，再和提案状态一起原子落盘
      const made = moves.map(m =>
        DB.makeMove(m.type, m.itemId, m.locationId, m.qty, [], by, ''))
      await DB.applyDecision(proposal, made)
      made.forEach(m => S.moves.push(m))      // 同步内存态
      return { proposal: proposal, moves: made }
    } finally {
      _deciding.delete(p.id)
    }
  },

  // 差异调查 = 自由工具循环（agent 性最强点）：规则只负责"发现"，
  // 查因由 LLM 自己选工具（查流水→查同款→查邻位），产出调查报告。
  // 没 key / 通道挂了 → Logic.investigationFallback 确定性报告（同样带工具留痕）。
  async investigate(p, onDelta) {
    const data = { items: S.items, moves: S.moves, locations: S.locations }
    // 同一个案子不重复调查（开着的调查报告直接复用）
    const existing = await DB.getAll('proposals')
    const prior = existing.find(x => x.key === 'inv:' + p.id && x.status === 'open')
    if (prior) return prior
    const question =
      `调查任务（只读）：仓库巡检发现「${p.summary}」。` +
      `请自己选工具查因：先查该商品最近流水，再查同款分布和该货位邻位，` +
      `最后产出简短调查报告：时间线、数字、可能原因、建议动作。`

    let report = '', toolCalls = [], model = 'rules'
    if (Patrol.aiAvailable()) {
      try {
        const r = await AI.ask(question, onDelta)
        if (r && r.source !== 'local') {
          report = r.answer
          toolCalls = r.trace || []
          model = r.source === 'proxy' ? 'proxy' : CONFIG.llmModel
        }
      } catch (e) { /* 落回确定性报告 */ }
    }
    // 规则兜底算**一次**就够：它既是没 key 时的报告正文，也是「待落库流水行」
    // 的唯一来源（LLM 只写报告文字，要落的账永远由规则算 —— 所以报告和账
    // 可能不同源，批准前得核对）。
    // 原来是算两次，其中一次裸调用且没保护：脏数据（比如流水引用了不存在的货位）
    // 会让它抛出来，把整条调查带崩。
    let fb = null
    try { fb = Logic.investigationFallback(data, p.detail) } catch (e) { fb = null }

    if (!report) {
      report = fb ? fb.report : ('调查报告生成失败：数据不完整（' + (p.summary || '') + '）')
      toolCalls = fb ? fb.tool_calls : []
      model = 'rules'
    }

    const inv = Logic.newProposal({
      key: 'inv:' + p.id,
      kind: 'investigation',
      priority: 0,
      summary: '调查报告：' + p.summary,
      detail: { about: p.id, subject: p.summary },
      utterance: report,
      tool_calls: toolCalls,
      lines: fb ? fb.lines : null
    }, {
      now: Date.now(),
      model: model,
      source: 'investigation',
      created_by: model === 'rules' ? 'AI 调查 · 规则引擎' : 'AI 调查 · ' + model
    })
    await DB.put('proposals', inv)
    return inv
  },

  // ———— 单据解析（draft_receipt）：送货单文本 → 收货草稿提案 ————
  //
  // LLM 只做"文本 → 结构化"抽取（有 key 才走），商品匹配/货位推荐/数量校验
  // 一律走 Logic.draftReceiptRows 规则；产出是提案草稿，落库必须人批准。

  async extractRows(text) {
    // 返回 { rows: [{desc, qty}], source: 'llm'|'rules' }
    if (Patrol.aiAvailable()) {
      try {
        const r = await AI.ask(
          '从下面的送货单文本里抽取商品行，只回 JSON 数组，格式 [{"desc":"商品名或编码","qty":数字}]，' +
          '不要任何解释、不要 markdown 代码块。文本如下：\n' + String(text || '').slice(0, 4000))
        if (r && r.source !== 'local' && r.answer) {
          const m = r.answer.replace(/```json|```/g, '').match(/\[[\s\S]*\]/)
          if (m) {
            const arr = JSON.parse(m[0])
            // ⚠️ lineNo / raw 必须带上：Logic.draftReceiptRows 的 notes 模板要用它们
            //    渲染「第 N 行「原文」没匹配到商品」。少了就会打印
            //    「第 undefined 行「undefined」」（规则分支一直带着，这里原来漏了）。
            //    行号按数组下标补（LLM 只回 desc/qty，本来就没有行号信息）。
            const rows = arr.filter(x => x && x.desc != null && Number(x.qty) > 0)
              .map((x, i) => ({
                desc: String(x.desc),
                qty: Number(x.qty),
                lineNo: i + 1,
                raw: String(x.desc)
              }))
            if (rows.length) return { rows: rows, source: 'llm' }
          }
        }
      } catch (e) { /* 抽取失败落回规则解析 */ }
    }
    return {
      rows: Logic.parseReceipt(text).map(p => ({ desc: p.desc, qty: p.qty, lineNo: p.lineNo, raw: p.raw })),
      source: 'rules'
    }
  },

  // 解析结果 → 收货草稿提案（lines = 建议落库行；notes = 待人工处理的行）
  async submitDraft(text, rows, edited) {
    const data = { items: S.items, moves: S.moves, locations: S.locations }
    // edited（界面上改过的数量）优先于解析值
    const merged = (rows || []).map((r, i) => Object.assign({}, r,
      edited && edited[i] != null ? { qty: edited[i] } : {}))
    const { lines, notes } = Logic.draftReceiptRows(merged, data)
    if (!lines.length) throw new Error('没有可送审的商品行：' + (notes[0] || '空单据'))

    const total = lines.reduce((a, l) => a + l.qty, 0)
    const p = Logic.newProposal({
      key: 'draft:' + Date.now().toString(36),
      kind: 'draft_receipt',
      priority: 1,
      summary: `收货草稿 ${lines.length} 行 · 共 ${total} 件`,
      detail: { sourceText: String(text || '').slice(0, 2000), notes: notes },
      lines: lines.map(l => ({ type: l.type, itemId: l.itemId, locationId: l.locationId, qty: l.qty })),
      utterance: '规则说明：送货单解析生成的收货草稿，逐行核对后批准才落库。' +
        (notes.length ? `（${notes.length} 行待人工处理：${notes.join('；')}）` : '')
    }, {
      now: Date.now(),
      model: 'rules',
      source: 'draft_receipt',
      created_by: 'AI 单据起草 · 规则引擎'
    })
    await DB.put('proposals', p)
    return p
  },

  // 追问：把问题交给同一个 agent 回路（带只读工具），Q&A 挂回提案留痕
  async ask(p, question, onDelta) {
    const ctx = `关于仓库待办提案「${p.summary}」（说明：${(p.utterance || '').slice(0, 200)}），追问：${question}`
    let r
    try {
      r = await AI.ask(ctx, onDelta)
    } catch (e) {
      r = { answer: '出错了：' + (e && e.message || e), source: 'local', trace: [] }
    }
    // ⚠️ 必须回读**库里那份**再挂 Q&A（2026-09-30 修）。
    //
    // `AI.ask` 是秒级的 await，这期间用户完全可能点了「通过」—— 那一步会把库里那条
    // 改成 status:'approved'、填上 decided_by、落一笔流水、并写进审计事件。
    // 而传进来的 p 是**渲染时那份**（status:'open'、decided_by 空、没有批准事件）；
    // 拿它造新对象整条 put，等于把刚才那些改动全部冲掉。实测中招：
    // 批准后 status 变回 open、decided_by 变空、批准时的审计事件没了 ——
    // 于是「通过」按钮又能点一次，**同一笔调整落两次**（账实不符 + 审计被抹）。
    //
    // 这跟 decide() 上方那条「不能只看传进来的 p.status，必须以库里存的那份为准」
    // 是同一条纪律，只是那里防的是连点、这里防的是「追问在飞时被批准」。
    const stored = (await DB.getAll('proposals')).find(x => x.id === p.id)
    if (!stored) {
      return { proposal: p, answer: r.answer, source: r.source, skipped: '提案已不在库里' }
    }
    const updated = Logic.appendQa(stored, {
      q: question, a: r.answer,
      at: Date.now(), by: CONFIG.operator || '未署名',
      tool_calls: r.trace || []
    })
    await DB.put('proposals', updated)
    return { proposal: updated, answer: r.answer, source: r.source }
  },

  // 改提案（非单向状态机）：逐行改数量（<=0 = 删行）→ 新版本回到 open，旧版本留痕
  async revise(p, qtys, note) {
    // 和 ask() 同一条纪律：以**库里存的那份**为准，不用传进来的 p（它可能已过期）。
    const stored = (await DB.getAll('proposals')).find(x => x.id === p.id) || p
    const src = (stored.lines || []).map(l => Object.assign({}, l))
    const lines = []
    src.forEach((l, i) => {
      const q = Array.isArray(qtys) ? qtys[i] : qtys
      if (q > 0) { l.qty = q; lines.push(l) }
    })
    const { old, revision } = Logic.reviseProposal(stored, {
      lines: lines.length ? lines : null,
      note: note || ('数量改为 ' + (lines.length ? lines.map(l => l.qty).join('/') : '（全部删除）')),
      by: CONFIG.operator || '未署名',
      at: Date.now()
    })
    revision.utterance = (stored.utterance || '').split('\n')[0] +
      `\n（已改：${lines.length ? lines.map(l => l.qty).join('/') : '全部删除'}，批准前请核对实物）`
    // 两条一起写。原来是两次独立 put —— 中间挂掉会留下「旧版被标 superseded、
    // 新版没进去」的半套状态，提案直接从待办箱消失（丢当前，不是丢历史）。
    await DB.putProposals([old, revision])
    return revision
  }
}
