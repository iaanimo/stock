// js/config.js —— 全部可变配置的唯一入口（改这里就够了，业务代码不许散落 if）
//
// mode:
//   'prod' —— 走 CONFIG.askProxy（app.py 的 /api/chat）转发，key 和系统提示词都收在服务端
//   'demo' —— 直连 CONFIG.llmEndpoint + llmKey（OpenAI 兼容），key 只放自己机器/演示环境
// 兜底：两条路都没配或调用失败 → 本地规则回答（Logic.askLocal），断网也能用。
//
// 换运行环境 = 改这里 + 按需部署一个转发代理，业务代码一行不动（这是接口的验收标准）。
// localStorage 里的值优先于默认值（界面上的「AI 连接设置」写的就是它）。

const CONFIG_DEFAULTS = {
  mode: 'prod',           // 配合 app.py 开箱即用；想直连 LLM 就改成 demo
  llmEndpoint: '',        // 例：https://api.deepseek.com/v1/chat/completions（OpenAI 兼容）
  llmKey: '',             // ⚠️ 只许在本机/演示环境填；prod 模式不读它
  llmModel: 'deepseek-chat',
  askProxy: '/api/chat',  // prod 模式的转发端点（app.py 提供，key 在服务端 .env）
  operator: ''            // 操作人：记在每条流水的 operator 字段上
}

const CONFIG = (() => {
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem('stock_config') || '{}') } catch (e) { saved = {} }
  return Object.assign({}, CONFIG_DEFAULTS, saved)
})()

function saveConfig(patch) {
  Object.assign(CONFIG, patch || {})
  const out = {}
  for (const k of Object.keys(CONFIG_DEFAULTS)) out[k] = CONFIG[k]
  localStorage.setItem('stock_config', JSON.stringify(out))
}
