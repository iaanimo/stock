# -*- coding: utf-8 -*-
# whitelist.py —— 静态文件白名单（app.py 与 serve.py 共用这一份，避免两边漂移）
#
# 为什么需要它：
#   默认的 `StaticFiles(directory=项目根)` 和 `SimpleHTTPRequestHandler`
#   会把**整个项目目录**当静态文件端出去。实测（2026-09-27，本机 8000 端口）：
#
#       curl http://localhost:8000/.env          → 200，直接吐出 DEEPSEEK_API_KEY 明文
#       curl http://localhost:8000/.git/config   → 200
#       curl http://localhost:8000/app.py        → 200
#
#   而 README 教用户 `cloudflared tunnel --url http://localhost:8000` 把 8000 挂到公网
#   做手机演示 —— 照做一遍，key 就上了公网，任何人都能下载。
#
# 规则：浏览器真正需要的才放行，其余一律 404。

from urllib.parse import unquote

ALLOW_EXACT = {
    'index.html',
    'manifest.json',
    'sw.js',
    '.nojekyll',          # GitHub Pages 用；点文件里唯一的例外
}

ALLOW_PREFIX = (
    'css/',
    'js/',                # 含 js/vendor/（扫码兜底的 wasm，1.1MB）
    'icons/',             # PWA 图标（manifest.json 引用）
    'test/fixtures/',     # 真解码测试用的条码图片，不含敏感内容
)


def allowed(path):
    """path 是 URL 里的路径（可能带前导斜杠、查询串、片段、百分号编码、反斜杠）。

    返回 True 才允许作为静态文件发出。"""
    p = (path or '').split('?', 1)[0].split('#', 1)[0]

    # ⚠️ 先解码再判断。实测 /js/%2e%2e/.env 会绕过：
    #    未解码时它以 'js/' 开头看着人畜无害，而 serve.py 的 translate_path
    #    会把它解码并规范化成项目根下的 .env。反复解码是为了挡双重编码。
    for _ in range(3):
        d = unquote(p)
        if d == p:
            break
        p = d

    # ⚠️ Windows 上 Starlette 传进来的分隔符是反斜杠、根路径传的是 '.'：
    #    实测 get_response 收到 path='css\\app.css'、path='.'。
    #    Linux 上是正斜杠、根是 ''。两边都归一化，否则白名单会误杀正常文件。
    p = p.replace('\\', '/').lstrip('/')

    # 目录穿越和空字节一律拒（Starlette 自己也会拦，这里是第二道）
    if '..' in p or '\x00' in p:
        return False

    if p in ('', '.') or p in ALLOW_EXACT:
        return True

    # 点文件一律挡掉：.env / .env.example / .gitignore / .git/…
    if p.startswith('.'):
        return False

    return any(p.startswith(pre) for pre in ALLOW_PREFIX)
