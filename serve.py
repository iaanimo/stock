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

def port_in_use(port):
    """端口上已经有人在监听了吗。

    Windows 上 SO_REUSEADDR 允许两个进程绑同一个端口（Linux 不允许），
    不先查一下的话会**静默开出两个服务**，请求归谁看运气，还很难查。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


if port_in_use(PORT):
    print('')
    print('  端口 %d 已经被占用了 —— 多半是上一个 serve.py 还在跑。' % PORT)
    print('')
    print('  要么直接用它（浏览器打开 http://localhost:%d 即可），' % PORT)
    print('  要么把它关掉：先在命令行里找出是哪个进程：')
    print('')
    print('      netstat -ano | findstr :%d' % PORT)
    print('')
    print('  最后一列的数字就是 PID，然后：')
    print('')
    print('      taskkill /F /PID <那个数字>')
    print('')
    print('  （别用 taskkill /F /IM python.exe —— 那会把机器上所有 python 全杀掉）')
    print('')
    print('  或者换个端口：  python serve.py %d' % (PORT + 1))
    print('')
    sys.exit(1)

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
