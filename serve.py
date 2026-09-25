# -*- coding: utf-8 -*-
# serve.py —— 本地起一个静态服务，桌面和手机都能打开
# 用法： python serve.py        （默认 8000 端口）
#        python serve.py 8080   （换端口）

import http.server
import socketserver
import socket
import os
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


def lan_ip():
    """拿本机在局域网里的地址，手机同 WiFi 就能连"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 关掉缓存，改完代码刷新就生效，不用手动清
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass          # 静音，控制台干净点


Handler.extensions_map['.js'] = 'application/javascript'
Handler.extensions_map['.json'] = 'application/json'
Handler.extensions_map['.css'] = 'text/css'
Handler.extensions_map['.webmanifest'] = 'application/manifest+json'

socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer(('0.0.0.0', PORT), Handler) as httpd:
    print('')
    print('  桌面（本机）    http://localhost:%d' % PORT)
    print('  手机（同一个WiFi）http://%s:%d' % (lan_ip(), PORT))
    print('')
    print('  注意：手机上要用摄像头扫码，http 页面浏览器不给权限，必须 HTTPS。')
    print('        本机 localhost 不受这个限制，桌面测没问题。')
    print('        手机测的话用 Cloudflare 隧道：')
    print('          cloudflared tunnel --url http://localhost:%d' % PORT)
    print('')
    print('  Ctrl+C 停止')
    print('')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n  已停止')
