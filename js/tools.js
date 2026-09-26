// js/tools.js —— AI 工具注册表：AI 能用什么，全看这张白名单
//
// 护栏（改代码前先看，test/agent.test.mjs 会锁死这几条）：
//   1. 只收只读工具 —— 任何能写 moves / 改库存的函数都不许注册进来。
//      「写库存的笔永远在人手里」这条红线，靠这张表守住。
//   2. 工具是纯函数：只读入参 data（一份数据快照），不碰 S、不碰 IndexedDB。
//   3. 返回的每个数字都来自 Logic 的流水求和，AI 只负责转述，不许自己算。

const Tools = {
  // 工具名白名单（测试做结构断言用；新增工具必须同步改测试）
  NAMES: [
    'search_items', 'get_item_total', 'get_item_distribution',
    'get_zone_contents', 'list_recent_moves', 'get_daily_summary'
  ],

  // 给 LLM 的说明书（OpenAI function calling 格式）
  schemas() {
    return [
      { type: 'function', function: { name: 'search_items', description: '按名称或编码模糊搜索商品，返回库存总数与货位分布',
        parameters: { type: 'object', properties: { keyword: { type: 'string', description: '商品名称或编码关键词' } }, required: ['keyword'] } } },
      { type: 'function', function: { name: 'get_item_total', description: '查某个商品的总库存数量',
        parameters: { type: 'object', properties: { sku: { type: 'string', description: '商品编码或名称' } }, required: ['sku'] } } },
      { type: 'function', function: { name: 'get_item_distribution', description: '查某个商品在哪些货位、各有多少',
        parameters: { type: 'object', properties: { sku: { type: 'string', description: '商品编码或名称' } }, required: ['sku'] } } },
      { type: 'function', function: { name: 'get_zone_contents', description: '查某个区或货位上放了哪些商品',
        parameters: { type: 'object', properties: { zone: { type: 'string', description: '区号（A/B/C）或货位编码（如 A-2-1）' } }, required: ['zone'] } } },
      { type: 'function', function: { name: 'list_recent_moves', description: '查最近的出入库流水',
        parameters: { type: 'object', properties: { n: { type: 'number', description: '返回条数，默认 5，最多 20' } } } } },
      { type: 'function', function: { name: 'get_daily_summary', description: '今天收货/出库/盘点调整的汇总',
        parameters: { type: 'object', properties: {} } } }
    ]
  },

  // 分发：名字 → Logic 现有纯函数。白名单之外一律拒绝。
  run(name, args, data) {
    if (this.NAMES.indexOf(name) < 0) return { error: '未知工具 ' + name }
    try {
      const box = Logic.toolbox(data)
      const a = args || {}
      switch (name) {
        case 'search_items':          return box.search_items(a)
        case 'get_item_total':        return box.get_total(a)
        case 'get_item_distribution': return box.get_dist(a)
        case 'get_zone_contents':     return this.zoneContents(a, data)
        case 'list_recent_moves':     return box.list_recent_moves(a)
        case 'get_daily_summary':     return box.today_summary()
      }
    } catch (e) {
      return { error: String(e && e.message || e) }
    }
    return { error: '未知工具 ' + name }
  },

  // 查一个区/货位上都放了什么（逻辑在 Logic.zoneContents，这里只做错误兜底）
  zoneContents(a, data) {
    try {
      return Logic.zoneContents(data, a && a.zone)
    } catch (e) {
      return { error: String(e && e.message || e) }
    }
  }
}
