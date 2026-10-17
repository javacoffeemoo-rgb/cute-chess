#!/usr/bin/env python3
"""귀여운 체스 — 로컬 개발 서버

왜 python -m http.server 를 안 쓰나
    Windows 의 레지스트리에는 .js 가 text/plain 으로 등록돼 있는 경우가 많다.
    파이썬 http.server 는 그 값을 그대로 쓰기 때문에 .js 를 text/plain 으로 보낸다.
      · <script src="..."> 는 (nosniff 가 없으면) 그래도 동작한다
      · 그런데 Web Worker 는 MIME 타입을 반드시 검사한다 (Chrome)
        → new Worker('engine/ai-worker.js') 가 NetworkError 로 죽는다
        → AI 가 메인 스레드 폴백으로 돌아 화면이 잠깐 얼어붙는다
    그래서 .js 를 항상 text/javascript 로 보내는 서버를 따로 둔다.

실행
    python serve.py            # http://localhost:8123
    python serve.py 8000       # 포트 지정

폰에서 접속
    같은 Wi-Fi 에서 아래에 출력되는 "폰에서" 주소를 열면 된다.
    (Windows 방화벽이 막으면 파이썬 허용 규칙을 추가해야 한다)
"""
import http.server
import socket
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123

# MIME 을 직접 지정한다 (파이썬이 레지스트리를 읽지 않도록)
http.server.SimpleHTTPRequestHandler.extensions_map = {
    **http.server.SimpleHTTPRequestHandler.extensions_map,
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 개발 중에는 캐시가 방해된다
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 요청 로그는 너무 시끄러우니 에러만 보여준다
        if not args or str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))          # 실제로 보내지는 않는다 (라우팅 조회용)
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith('127.'))


with Server(('0.0.0.0', PORT), Handler) as httpd:
    print(f'귀여운 체스 서버 실행 중 (포트 {PORT})')
    print(f'  이 PC   : http://localhost:{PORT}')
    for ip in lan_ips():
        print(f'  폰에서   : http://{ip}:{PORT}')
    print('  종료하려면 Ctrl+C')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n서버를 종료했습니다.')
