#!/usr/bin/env python3
"""4주차 검증 + 화면 캡처 (개발용)

3주차 shots.py 와 달리, 여기서는 "진짜로 브라우저를 다시 열어도" 이어지는지와
"인터넷을 끊어도" 실행되는지를 확인한다.

    python serve.py                 # 8123 서버
    python dev/verify_week4.py

확인하는 것
    · 대국 자동 저장 → 새로고침(진짜 재실행) 후 이어하기 카드 → 이어하기로 복원
    · 효과음 설정이 저장되는지
    · 서비스 워커가 앱 껍데기를 캐시했는지
    · 오프라인(비행기 모드)에서 페이지가 뜨고 AI 대전이 되는지
결과물
    dev/shot4-*.png
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8123/"
OUT = Path(__file__).resolve().parent
PHONE = {"width": 390, "height": 844}

ENTER_GAME = """
(opts) => {
  document.getElementById('screen-home').classList.remove('active');
  document.getElementById('screen-game').classList.add('active');
  const C = window.__cuteChess;
  C.profile.nickname = '폰돌이';
  C.settings.level = (opts && opts.level) || 3;
  C.settings.playerColor = (opts && opts.side) || 'w';
  C.newGame();
  C.render();
}
"""

fails = []


def check(name, cond, info=""):
    print(("  OK   " if cond else "  실패 ") + name + (f"  [{info}]" if info else ""))
    if not cond:
        fails.append(name)


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport=PHONE, device_scale_factor=2)
        page = ctx.new_page()
        page.goto(BASE)
        page.wait_for_timeout(400)

        print("\n[1] 서비스 워커 (PWA)")
        page.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=10000)
        cache_info = page.evaluate("""async () => {
          const keys = await caches.keys();
          const c = await caches.open(keys[0]);
          const reqs = await c.keys();
          return { version: keys[0], count: reqs.length,
                   hasApp: reqs.some(r => r.url.endsWith('/app.js')),
                   hasWorker: reqs.some(r => r.url.endsWith('ai-worker.js')) };
        }""")
        check("서비스 워커가 페이지를 제어", True, cache_info["version"])
        check("앱 껍데기를 캐시함", cache_info["hasApp"] and cache_info["hasWorker"],
              f"{cache_info['count']}개 파일")

        print("\n[2] 대국 저장 → 진짜 재실행 → 이어하기")
        page.evaluate(ENTER_GAME, {"level": 3})
        page.evaluate("() => window.__cuteChess.play(52, 36)")          # e4
        page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        page.evaluate("() => window.__cuteChess.play(62, 45)")          # Nf3
        page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        page.evaluate("() => window.__cuteChess.play(51, 35)")          # d5
        page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        played = page.evaluate("() => window.__cuteChess.rules.history().join(' ')")
        saved = page.evaluate("() => JSON.parse(localStorage.getItem('cuteChess.current') || 'null')")
        check("매 수마다 저장됨", bool(saved) and len(saved["moves"]) > 0,
              f"{len(saved['moves'])}수 · Lv.{saved['level']} {saved['playerColor']}")

        # ---- 진짜 새로고침 (앱을 다시 연 것과 같다) ----
        page.reload()
        page.wait_for_timeout(600)
        home_visible = page.evaluate("() => document.getElementById('screen-home').classList.contains('active')")
        card_hidden = page.evaluate("() => document.getElementById('resume-card').hidden")
        card_text = page.evaluate("() => document.getElementById('resume-info').textContent")
        check("재실행 후 홈 화면", home_visible)
        check("이어하기 카드가 나타남", card_hidden is False, card_text)

        page.evaluate("""() => {
          const s = document.querySelector('#screen-home .scroll');
          s.scrollTop = 0;
        }""")
        page.wait_for_timeout(150)
        page.screenshot(path=str(OUT / "shot4-1-resume-card.png"))

        page.click("#btn-resume")
        page.wait_for_timeout(500)
        restored = page.evaluate("() => window.__cuteChess.rules.history().join(' ')")
        check("이어하기로 기보 복원", restored == played, restored)
        check("이어하기 후 대국 화면", page.evaluate("() => document.getElementById('screen-game').classList.contains('active')"))
        page.screenshot(path=str(OUT / "shot4-2-resumed.png"))

        print("\n[3] 효과음 설정")
        sound_default = page.evaluate("() => window.__cuteChess.settings.sound")
        check("기본값 켜짐", sound_default is True, f"sound={sound_default}")
        page.evaluate("() => { document.getElementById('btn-back').click(); }")
        page.wait_for_timeout(200)
        page.evaluate("""() => {
          const s = document.querySelector('#screen-home .scroll');
          s.scrollTop = s.scrollHeight;
        }""")
        page.wait_for_timeout(150)
        page.screenshot(path=str(OUT / "shot4-3-sound-setting.png"))
        page.click("#tg-sound")
        stored = page.evaluate("() => JSON.parse(localStorage.getItem('cuteChess.settings')).sound")
        check("끄면 저장된다", stored is False)
        page.click("#tg-sound")

        print("\n[4] 오프라인 (비행기 모드) 실행")
        install_hidden = page.evaluate("() => document.getElementById('btn-install').hidden")
        if install_hidden:
            page.evaluate("() => { document.getElementById('btn-install').hidden = false; }")
        page.wait_for_timeout(120)
        page.screenshot(path=str(OUT / "shot4-4-install.png"))
        print(f"  참고 install 버튼 자동 표시 여부: {not install_hidden} (헤드리스에서는 대개 미표시)")

        ctx.set_offline(True)
        page.reload()
        page.wait_for_timeout(900)
        online_ok = page.evaluate("() => !!window.__cuteChess && !!document.getElementById('board')")
        check("오프라인에서도 페이지가 뜬다", online_ok)
        check("오프라인에서 이어하기 카드 유지",
              page.evaluate("() => document.getElementById('resume-card').hidden") is False)
        check("오프라인 표시가 나타난다",
              page.evaluate("() => document.getElementById('net-note').hidden") is False)
        page.wait_for_timeout(150)
        page.screenshot(path=str(OUT / "shot4-5-offline-home.png"))

        # 오프라인에서 AI 대전이 되는지 (엔진이 전부 로컬이라 가능해야 한다)
        page.evaluate(ENTER_GAME, {"level": 2})
        page.evaluate("() => window.__cuteChess.play(52, 36)")
        page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        offline_hist = page.evaluate("() => window.__cuteChess.rules.history().join(' ')")
        worker_mode = page.evaluate("() => window.__cuteChess.ai.mode")
        check("오프라인에서 AI 가 응수", len(offline_hist.split()) >= 2, f"{offline_hist} · {worker_mode}")
        page.screenshot(path=str(OUT / "shot4-6-offline-game.png"))
        ctx.set_offline(False)

        ctx.close()
        browser.close()

    print()
    if fails:
        print(f"실패 {len(fails)}건: " + ", ".join(fails))
        return 1
    print("4주차 검증 전부 통과")
    for f in sorted(OUT.glob("shot4-*.png")):
        print("저장:", f.name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
