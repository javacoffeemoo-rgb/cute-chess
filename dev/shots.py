"""3주차 화면 캡처 (개발용)

실제 Chromium 으로 페이지를 열어 폰 크기 화면을 찍는다.
    사용법: python dev/shots.py       (serve.py 로 8123 서버가 떠 있어야 함)
결과물: dev/shot-*.png

2주차와 달라진 점
    이제 AI 가 실제로 둔다. 그래서 "양쪽을 손으로 두는" 방식 대신
      · 진짜로 내가 두고 → AI 가 생각하고 → AI 가 응수하는 흐름을 찍거나
      · 특정 국면이 필요하면 rules.load() 로 세팅한다 (AI 는 취소)
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8123/"
OUT = Path(__file__).resolve().parent

PHONE = {"width": 390, "height": 844}
LAND = {"width": 844, "height": 390}

# 대국 화면으로 바로 들어간다 (홈에서 시작 버튼 누르는 것과 같은 효과)
ENTER_GAME = """
(opts) => {
  document.getElementById('screen-home').classList.remove('active');
  document.getElementById('screen-game').classList.add('active');
  const C = window.__cuteChess;
  C.profile.nickname = '폰돌이';
  opts = opts || {};
  C.settings.level = opts.level || 3;
  C.settings.playerColor = opts.side || 'w';      /* 씬마다 진영을 명시한다 (이전 씬 값이 남지 않게) */
  C.newGame();
  C.render();
}
"""

# 특정 국면을 세팅한다 (AI 가 덮어쓰지 않도록 취소 후 로드)
SET_POS = """
(fen) => {
  const C = window.__cuteChess;
  C.ai.cancel();
  C.state.thinking = false;
  C.rules.load(fen);
  C.state.result = null;
  C.state.hint = null;
  C.render();
  return C.rules.history().join(' ');
}
"""


def main():
    notes = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport=PHONE, device_scale_factor=2, reduced_motion="reduce")
        page.goto(BASE)
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "shot-1-home.png"))

        # 홈 화면의 AI 설정(난이도 · 진영 칩)이 보이도록 스크롤
        page.evaluate("""() => {
          const s = document.querySelector('#screen-home .scroll');
          const card = document.getElementById('level-chips').closest('.card');
          s.scrollTop = card.offsetTop - 90;
        }""")
        page.fill("#nickname", "폰돌이")
        page.evaluate("""() => {
          const chips = document.querySelectorAll('#level-chips .chip');
          chips[4].click();                       /* Lv.5 아주 어려움 */
        }""")
        page.wait_for_timeout(200)
        page.screenshot(path=str(OUT / "shot-2-home-levels.png"))

        # ---- 대국 : 내가 두고 AI 가 "생각 중" 인 순간 (Lv.5 라서 잠깐 보인다) ----
        page.evaluate(ENTER_GAME, {"level": 5})
        page.evaluate("() => window.__cuteChess.play(52, 36)")     # e2 → e4
        page.wait_for_timeout(260)
        notes.append("생각 중 표시: " + str(page.evaluate(
            "() => document.getElementById('opp-badge').textContent")))
        page.screenshot(path=str(OUT / "shot-3-ai-thinking.png"))

        # ---- AI 가 응수한 뒤 (진짜 AI 수) ----
        page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        page.evaluate("() => window.__cuteChess.play(51, 35)")     # d7 → d5 (내가 흑으로)
        page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        page.wait_for_timeout(200)
        notes.append("Lv.5 대국 기보: " + str(page.evaluate("() => window.__cuteChess.rules.history().join(' ')")))
        page.screenshot(path=str(OUT / "shot-4-ai-reply.png"))

        # ---- 흑 진영 선택 : AI 가 먼저 두고 보드가 뒤집힌다 ----
        page.evaluate(ENTER_GAME, {"level": 3, "side": "b"})
        page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        page.wait_for_timeout(200)
        notes.append("흑 진영 첫 수: " + str(page.evaluate(
            "() => JSON.stringify({ hist: window.__cuteChess.rules.history(), flipped: window.__cuteChess.state.flipped })")))
        page.screenshot(path=str(OUT / "shot-5-play-as-black.png"))

        # ---- 체크 표시 ----
        # 흑 진영으로 두면 Rh8+ 뒤가 "내 차례"라 AI 가 응수하지 않아 체크 상태를 찍을 수 있다
        page.evaluate(ENTER_GAME, {"level": 3, "side": "b"})
        page.evaluate(SET_POS, '4k3/8/8/8/8/8/8/4K2R w - - 0 1')
        page.evaluate("() => window.__cuteChess.play(63, 7)")      # h1 → h8 : Rh8+
        page.evaluate("""() => { const C = window.__cuteChess; C.ai.cancel(); C.state.thinking = false; C.render(); }""")
        page.wait_for_timeout(200)
        notes.append("체크: " + str(page.evaluate("() => document.getElementById('status').textContent")))
        page.screenshot(path=str(OUT / "shot-6-check.png"))

        # ---- 프로모션 팝업 (사람) ----
        page.evaluate(ENTER_GAME, {"level": 3})
        page.evaluate(SET_POS, 'K6k/4P3/8/8/8/8/8/8 w - - 0 1')
        page.evaluate("() => window.__cuteChess.doMoveByTap(12, 4)")    # e7 → e8 (승급)
        page.wait_for_timeout(350)
        page.screenshot(path=str(OUT / "shot-7-promotion.png"))

        # ---- 결과 : 내가 이김 (백랭크 메이트) ----
        page.evaluate("() => document.getElementById('promo-modal').classList.remove('show')")
        page.evaluate(ENTER_GAME, {"level": 3})
        page.evaluate(SET_POS, '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1')
        page.evaluate("() => window.__cuteChess.play(56, 0)")          # a1 → a8 : Ra8#
        page.wait_for_timeout(350)
        notes.append("승리 결과: " + str(page.evaluate(
            "() => document.getElementById('result-title').textContent + ' / ' + document.getElementById('result-reason').textContent")))
        page.screenshot(path=str(OUT / "shot-8-result-win.png"))

        # ---- 결과 : AI 가 이김 (AI 가 백랭크 메이트) ----
        # Lv.3 은 6% 확률로 "일부러 실수"를 둔다 → 메이트를 놓칠 수 있으니 다시 시도한다
        for _try in range(5):
            page.evaluate("() => document.getElementById('result-modal').classList.remove('show')")
            page.evaluate(ENTER_GAME, {"level": 3})
            page.evaluate(SET_POS, 'r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1')
            page.evaluate("() => window.__cuteChess.maybeAI()")
            try:
                page.wait_for_function("() => !!window.__cuteChess.state.result", timeout=12000)
                break
            except Exception:
                continue
        else:
            raise RuntimeError("AI 패배 장면을 만들지 못했습니다 (메이트를 계속 놓침)")
        page.wait_for_timeout(350)
        notes.append("패배 결과: " + str(page.evaluate(
            "() => document.getElementById('result-title').textContent + ' / ' + document.getElementById('result-reason').textContent")))
        page.screenshot(path=str(OUT / "shot-9-result-lose.png"))
        page.close()

        # ---- 가로 화면 ----
        land = browser.new_page(viewport=LAND, device_scale_factor=2, reduced_motion="reduce")
        land.goto(BASE)
        land.evaluate(ENTER_GAME, {"level": 4})
        land.evaluate("() => window.__cuteChess.play(52, 36)")
        land.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        land.evaluate("() => window.__cuteChess.play(51, 35)")
        land.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
        land.wait_for_timeout(250)
        land.screenshot(path=str(OUT / "shot-10-landscape.png"))
        land.close()

        browser.close()

    for n in notes:
        print(n)
    for f in sorted(OUT.glob("shot-*.png")):
        print("저장:", f.name)


if __name__ == "__main__":
    sys.exit(main())
