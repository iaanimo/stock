// js/agent.js —— agent 回路：把「模型 ↔ 本地只读工具」的往返跑起来
//
// 数据流：用户问题 → LLM（走 /api/chat 代理或直连）→ 模型点名要查数据
//        → 本地跑只读工具（Tools 白名单）→ 结果喂回模型 →（最多 5 轮）→ 最终回答
//
// 护栏：
//   · 回路里只有 Tools 这一张只读白名单，模型叫不动任何写操作
//   · 轮数硬上限 MAX_ROUNDS，防模型拽着工具死循环（防失控）
//   · 用户输入（含条码/OCR 文本）只作为 user 消息和工具参数 JSON 传递，
//     永远不进系统提示词（防注入）
//
// SSE 流式解析：内容增量交给 onDelta（界面边到边显示），
// tool_calls 按流式分片拼回来（name/arguments 可能被拆成多段）。

const Agent = {
  MAX_ROUNDS: 5,

  // 跑一轮：发请求 → 读 SSE 流 → 拼出本轮 { content, finish, toolCalls }
  async round(endpoint, payload, headers, onDelta) {
    const res = await fetch(endpoint, {
      method: 'POST', headers: headers, body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    if (!res.body) throw new Error('响应不是流（SSE）')

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = '', content = '', finish = null
    const calls = []

    const handleData = data => {
      if (data === '[DONE]') return
      let j
      try { j = JSON.parse(data) } catch (e) { return }   // 空行/残行，跳过
      if (j.error) throw new Error(j.error)
      const ch = j.choices && j.choices[0]
      if (!ch) return
      if (ch.finish_reason) finish = ch.finish_reason
      const d = ch.delta
      if (!d) return
      if (d.content) { content += d.content; if (onDelta) onDelta(d.content) }
      if (d.tool_calls) for (const tc of d.tool_calls) {
        const i = tc.index || 0
        if (!calls[i]) calls[i] = { id: '', name: '', args: '' }
        if (tc.id) calls[i].id = tc.id
        if (tc.function) {
          if (tc.function.name) calls[i].name += tc.function.name
          if (tc.function.arguments) calls[i].args += tc.function.arguments
        }
      }
    }

    while (true) {
      const r = await reader.read()
      if (r.done) break
      buf += dec.decode(r.value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line.indexOf('data:') === 0) handleData(line.slice(5).trim())
      }
    }

    return {
      content: content,
      finish: finish,
      toolCalls: calls.filter(Boolean).map(c => ({
        id: c.id || 'call_' + Math.random().toString(36).slice(2, 10),
        name: c.name, args: c.args
      }))
    }
  },

  // 完整回路。opts: { endpoint, headers, systemPrompt?, source, onDelta? }
  // 返回 { answer, source, trace, rounds }
  async run(question, opts) {
    const o = opts || {}
    const data = { items: S.items, moves: S.moves, locations: S.locations }  // 快照，工具只读它
    const messages = []
    // 系统提示词只有两种来源：直连模式的固定常量（ai.js 传入）、或服务端注入（不传）。
    // 用户原话永远只进 user 消息，绝不拼进 system。
    if (o.systemPrompt) messages.push({ role: 'system', content: o.systemPrompt })
    messages.push({ role: 'user', content: String(question || '') })

    const trace = []
    let rounds = 0

    while (rounds < this.MAX_ROUNDS) {
      rounds++
      const r = await this.round(o.endpoint, {
        model: CONFIG.llmModel,
        messages: messages,
        tools: Tools.schemas(),
        tool_choice: 'auto',
        stream: true
      }, o.headers, o.onDelta)

      if (!r.toolCalls.length) {
        return { answer: r.content || '（模型没有回答）', source: o.source, trace: trace, rounds: rounds }
      }

      messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: c.args }
      })) })

      for (const c of r.toolCalls) {
        let args = {}
        try { args = c.args ? JSON.parse(c.args) : {} } catch (e) { args = {} }
        const result = Tools.run(c.name, args, data)
        trace.push({ tool: c.name, args: args, result: result })
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) })
      }
    }

    return { answer: '查询轮数超限，已停止。请把问题拆小一点再问。', source: o.source, trace: trace, rounds: rounds }
  }
}
