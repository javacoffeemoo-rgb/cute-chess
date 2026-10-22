#!/usr/bin/env python3
"""배포 검증 — 정적 파일 · PWA(서비스 워커/오프라인) · AI(Web Worker) 가
   "실제로 배포된 상태"에서도 도는지 확인한다.

    python dev/verify_deploy.py                    # dist/ 를 하위 경로(/dist/)로 띄워 검증
                                                   #   → GitHub Pages 처럼 /저장소/ 아래에 놓여도 되는지
    python dev/verify_deploy.py https://주소/      # 실제 배포 주소 검증 (올린 뒤 마지막 확인)

검사 항목
    [1] 정적 파일   index/manifest/icons/engine 200 · manifest 내용 · .js MIME(Worker 필수)
    [2] 서비스 워커  등록·활성·범위 · 페이지 제어 · 앱 껍데기 캐시 개수
    [3] 앱 동작     보드 64칸 · AI 응수(Worker 모드) · 자동 저장 기록
    [4] 오프라인    인터넷 끄고 새로고침 → 화면이 뜨는가 · AI 가 응수하는가

먼저 python dev/make_dist.py 로 dist/ 를 만들어야 한다.
"""
import http.server
import re
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
APP = HERE.parent
DIST = APP / "dist"
PORT = 8125

RESULTS = []


def check(name, ok, note=""):
    RESULTS.append((name, bool(ok)))
    print(f"  {'OK  ' if ok else 'FAIL'} {name}" + (f"   → {note}" if note else ""))
    return bool(ok)


class Handler(http.server.SimpleHTTPRequestHandler):
    """serve.py 와 같은 이유로 MIME 을 직접 지정 (Worker 는 .js 의 MIME 을 검사한다)."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".json": "application/json",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(APP), **kw)

    def log_message(self, *a):
        pass


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def run(base):
    """base : 배포 주소 (끝에 / 포함)."""
    print(f"\n검증 대상: {base}")
    local = base.startswith("http://127.0.0.1")
    fetch = base + "index.html"
    scope_expect = base.split("://", 1)[1].split("/", 1)[1] if "/" in base.split("://", 1)[1] else ""
    scope_expect = "/" + scope_expect

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844},
                                  device_scale_factor=2)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        print("\n[1] 정적 파일")
        r = page.goto(fetch, wait_until="domcontentloaded")
        check("index.html 이 뜬다", r is not None and r.ok, f"HTTP {r.status if r else '?'}")
        man = page.evaluate("""async (base) => {
          const r = await fetch(base + 'manifest.webmanifest');
          if (!r.ok) return { ok: false, status: r.status };
          const j = await r.json();
          return { ok: true, name: j.name, icons: (j.icons || []).length,
                   start: j.start_url, scope: j.scope, display: j.display };
        }""", base)
        check("manifest 를 읽는다", man.get("ok"), str(man.get("name") if man.get("ok") else man))
        if man.get("ok"):
            check("manifest 내용", man["icons"] >= 3 and man["display"] == "standalone",
                  f"아이콘 {man['icons']}개 · {man['display']} · start {man['start']}")
        icons = page.evaluate("""async (base) => {
          const out = {};
          for (const f of ['icons/icon-192.png', 'icons/icon-512.png',
                           'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png']) {
            const r = await fetch(base + f);
            out[f] = r.ok;
          }
          return out;
        }""", base)
        check("아이콘 4종 모두 200", all(icons.values()), ", ".join(k.split("/")[1] for k, v in icons.items() if not v) or "전부 OK")
        eng = page.evaluate("""async (base) => {
          const out = {};
          for (const f of ['engine/rules.js', 'engine/search.js', 'engine/ai-worker.js']) {
            const r = await fetch(base + f);
            out[f] = [r.ok, r.headers.get('content-type') || ''];
          }
          return out;
        }""", base)
        js_ok = all(v[0] and "javascript" in v[1].lower() for v in eng.values())
        check("엔진 .js 3종 + MIME 가 javascript", js_ok,
              " · ".join(f"{k.split('/')[1]}={v[1].split(';')[0]}" for k, v in eng.items()))

        print("\n[2] 서비스 워커 (PWA)")
        sw = page.evaluate("""async (base) => {
          if (!('serviceWorker' in navigator)) return { ok: false };
          const reg = await navigator.serviceWorker.register(base + 'sw.js', { scope: base });
          const ready = await navigator.serviceWorker.ready.catch(() => null);
          return { ok: true, scope: String(reg.scope).replace(location.origin, ''),
                   regScope: String(reg.scope), state: (ready && ready.active) ? ready.active.state : 'none' };
        }""", base)
        if local:
            check("서비스 워커 등록·활성", sw.get("ok") and sw.get("state") == "activated",
                  f"state={sw.get('state')} · scope={sw.get('scope')}")
            check("서비스 워커 범위가 배포 경로와 같다", sw.get("regScope", "").endswith(scope_expect),
                  f"{sw.get('regScope')} (기대 ...{scope_expect})")
        else:
            check("서비스 워커 등록(이미 배포된 sw.js)", sw.get("ok"), f"scope={sw.get('scope')}")

        page.wait_for_timeout(600)
        cache = page.evaluate("""async () => {
          const keys = await caches.keys();
          if (!keys.length) return { keys: [], n: 0 };
          const c = await caches.open(keys[0]);
          const reqs = await c.keys();
          return { keys: keys, n: reqs.length };
        }""")
        check("앱 껍데기를 캐시에 담았다", cache["n"] >= 11, f"{cache['n']}개 · {', '.join(cache['keys'])}")

        print("\n[3] 앱 동작 (Worker AI)")
        page.wait_for_timeout(300)
        page.evaluate("""() => {
          document.getElementById('screen-home').classList.remove('active');
          document.getElementById('screen-game').classList.add('active');
          const C = window.__cuteChess;
          C.profile.nickname = '폰돌이';
          C.settings.level = 3; C.settings.playerColor = 'w';
          C.newGame(); C.render();
        }""")
        squares = page.eval_on_selector_all(".square", "els => els.length")
        check("보드 64칸 렌더", squares == 64, f"{squares}칸")
        page.evaluate("() => window.__cuteChess.play(52, 36)")     # e2 → e4
        fly = page.evaluate("() => document.querySelectorAll('.fly-piece').length")
        page.wait_for_timeout(750)                                 # 비행 0.6초 + 도착
        stamp = page.evaluate("() => document.querySelectorAll('.land-stamp').length")
        check("이동 연출 · 도착 확인 도장 (6주차)", fly == 1 and stamp == 1,
              f"비행 {fly}개 · 도장 {stamp}개")
        page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=20000)
        hist = page.evaluate("() => window.__cuteChess.rules.history().join(' ')")
        mode = page.evaluate("() => window.__cuteChess.ai.mode")
        check("AI 가 응수한다", len(hist.split()) >= 2, hist)
        check("AI 가 Web Worker 로 돈다 (화면 안 얼음)", mode == "worker", f"mode={mode}")
        saved = page.evaluate("() => !!localStorage.getItem('cuteChess.current')")
        check("대국이 자동 저장된다", saved)

        print("\n[4] 오프라인 (인터넷 끊고 새로고침)")
        ctx.set_offline(True)
        try:
            page.reload(wait_until="domcontentloaded", timeout=15000)
            stood = True
        except Exception as e:
            stood = False
            print(f"      (reload 예외: {e})")
        page.wait_for_timeout(700)
        alive = page.evaluate("() => !!window.__cuteChess")
        check("오프라인에서도 앱이 뜬다 (서비스 워커 캐시)", stood and alive)
        off_ok = False
        off_hist = "(응수 없음)"
        if alive:
            page.evaluate("""() => {
              document.getElementById('screen-home').classList.remove('active');
              document.getElementById('screen-game').classList.add('active');
              window.__cuteChess.newGame();
            }""")
            off_squares = page.eval_on_selector_all(".square", "els => els.length")
            check("오프라인에서도 보드 64칸 렌더", off_squares == 64, f"{off_squares}칸")
            page.evaluate("() => window.__cuteChess.play(52, 36)")
            try:
                page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=20000)
                off_hist = page.evaluate("() => window.__cuteChess.rules.history().join(' ')")
                off_ok = len(off_hist.split()) >= 2
            except Exception:
                pass
            check("오프라인에서도 AI 가 응수한다", off_ok, off_hist)
        ctx.set_offline(False)

        check("콘솔 오류 0", not errs, "; ".join(errs[:3]) if errs else "없음")

        # 오프라인 검사에서 쌓인 SW 는 그대로 두고 브라우저만 닫는다
        ctx.close()
        browser.close()


def main():
    args = sys.argv[1:]
    if args:
        base = args[0]
        if not base.endswith("/"):
            base += "/"
        run(base)
    else:
        if not (DIST / "index.html").exists():
            print("dist/ 가 없습니다. 먼저 python dev/make_dist.py 를 실행하세요.")
            return 1
        httpd = serve()
        try:
            run(f"http://127.0.0.1:{PORT}/dist/")
        finally:
            httpd.shutdown()

    fail = [n for n, ok in RESULTS if not ok]
    print(f"\n{'=' * 56}")
    print(f"  검사 {len(RESULTS)}개 · 통과 {len(RESULTS) - len(fail)}개 · 실패 {len(fail)}개")
    if fail:
        print("  실패 목록:")
        for n in fail:
            print(f"    - {n}")
    else:
        print("  전부 통과 — 이대로 올리면 됩니다.")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
