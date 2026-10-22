#!/usr/bin/env python3
"""6주차 연출 캡처 — 천천히 이동 · 도착 확인 도장 · 웃는/우는 표정

    python dev/make_fx.py          (개발 서버 8123 이 필요하다)

결과
    dev/fx-1-fly.png ... dev/fx-6-tray.png
    dev/week6-preview.png          (모음 이미지)

애니메이션은 document.getAnimations() 로 원하는 시점에 멈춰서 찍는다.
스크린샷 한 장에 0.3초쯤 걸려서, 실시간으로는 정확한 순간을 잡을 수 없다.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent
APP = "http://localhost:8123/"
FONT = "C:/Windows/Fonts/malgun.ttf"

ENTER = """
() => {
  document.getElementById('screen-home').classList.remove('active');
  document.getElementById('screen-game').classList.add('active');
  const C = window.__cuteChess;
  C.profile.nickname = '폰돌이';
  C.settings.level = 3;
  C.settings.playerColor = 'w';
  C.newGame();
  C.render();
}
"""

SET = """
(fen) => {
  const C = window.__cuteChess;
  C.ai.cancel();
  C.fx.clear();
  C.state.thinking = false;
  C.state.animHide = [];
  C.rules.load(fen);
  C.state.result = null;
  C.state.hint = null;
  C.state.selected = null;
  C.state.targets = new Map();
  C.render();
}
"""

# 한 수 둔다. AI 가 끼어들면 그림이 엉키므로 thinking=true 로 잠깐 막아 둔다
PLAY = """
([f, t]) => {
  const C = window.__cuteChess;
  C.state.thinking = true;
  C.play(f, t);
  C.state.thinking = false;
  C.render();
}
"""

# 비행 중 화면 : 연출 종료 타이머(610/770ms)를 잠깐 막아야 멈춘 화면이 사라지지 않는다
PLAY_HOLD = """
([f, t]) => {
  const C = window.__cuteChess;
  const orig = window.setTimeout;
  window.setTimeout = (fn, d) => (d === 610 || d === 770) ? 0 : orig(fn, d);
  C.state.thinking = true;
  C.play(f, t);
  C.state.thinking = false;
  C.render();
  return new Promise(res => orig(() => { window.setTimeout = orig; res(true); }, 70));
}
"""

FREEZE = """
(ms) => {
  document.getAnimations().forEach(a => {
    try { a.pause(); a.currentTime = ms; } catch (e) {}
  });
}
"""

THAW = """
() => {
  document.getAnimations().forEach(a => { try { a.play(); } catch (e) {} });
}
"""


def shot(page, name, clip=None):
    page.screenshot(path=str(OUT / name), clip=clip)
    print("  ·", name)


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(APP)
        page.wait_for_timeout(500)
        page.evaluate(ENTER)
        page.wait_for_timeout(300)

        # ---- 1) 천천히 이동 (미끄러지는 중) ----------------------------------
        print("1) 이동 중")
        page.evaluate(PLAY_HOLD, [52, 36])          # e2 → e4
        page.evaluate(FREEZE, 300)
        shot(page, "fx-1-fly.png")
        page.evaluate(THAW)

        # ---- 2) 도착 : 위치 확인 도장 ---------------------------------------
        print("2) 도착 확인 도장")
        page.evaluate(SET, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
        page.wait_for_timeout(120)
        page.evaluate(PLAY, [52, 36])
        page.wait_for_timeout(900)                  # 비행(600) 끝 + 도장 생성
        page.evaluate(FREEZE, 260)
        shot(page, "fx-2-land.png")
        page.evaluate(THAW)

        # ---- 3) 나이트는 살짝 뛰어넘는다 --------------------------------------
        print("3) 나이트 점프")
        page.evaluate(SET, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
        page.wait_for_timeout(120)
        page.evaluate(PLAY_HOLD, [57, 42])          # b1 → c3
        page.evaluate(FREEZE, 380)
        shot(page, "fx-3-knight.png")
        page.evaluate(THAW)

        # ---- 4) 내가 AI 기물을 잡으면 : 웃는 얼굴 -----------------------------
        print("4) 잡힌 AI 기물 = 웃음")
        page.evaluate(SET, "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3")
        page.wait_for_timeout(120)
        page.evaluate(PLAY, [36, 27])               # e4xd5
        page.wait_for_timeout(800)                  # 비행 0.6초 → 잡힌 기물이 커지는 중
        page.evaluate(FREEZE, 300)
        shot(page, "fx-4-laugh.png")
        page.evaluate(THAW)

        # ---- 5) 내 기물이 잡히면 : 우는 얼굴 ----------------------------------
        print("5) 잡힌 내 기물 = 울음")
        page.evaluate(SET, "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3")
        page.wait_for_timeout(120)
        page.evaluate(PLAY, [27, 36])               # d5xe4 (흑)
        page.wait_for_timeout(800)                  # 비행 0.6초 → 잡힌 기물이 커지는 중
        page.evaluate(FREEZE, 300)
        shot(page, "fx-5-cry.png")
        page.evaluate(THAW)

        # ---- 6) 플레이어 표시의 잡힌 기물 ------------------------------------
        print("6) 잡힌 기물 목록")
        # 폰끼리 3:3 으로 잡아먹는 판 (킹은 구석에 있어 체크가 나지 않는다)
        ladder = "7k/8/8/8/3p2p1/p1p1p2P/1P1P1PP1/K7 w - - 0 1"
        page.evaluate(SET, ladder)
        page.wait_for_timeout(120)
        for f, t in [(49, 40), (42, 51), (53, 44), (38, 47), (44, 35), (47, 54)]:
            page.evaluate(PLAY, [f, t])
            page.wait_for_timeout(900)
        page.wait_for_timeout(700)                  # 마지막 연출이 끝나기를 기다린다
        print("  history:", page.evaluate("() => JSON.stringify(window.__cuteChess.rules.history())"))
        print("  taken:", page.evaluate("() => JSON.stringify(window.__cuteChess.state.taken)"))
        box = page.evaluate("""
        () => {
          const a = document.getElementById('plate-opp').getBoundingClientRect();
          const b = document.getElementById('plate-me').getBoundingClientRect();
          return { x: a.left - 12, y: a.top - 10, width: a.width + 24, height: b.bottom - a.top + 20 };
        }
        """)
        shot(page, "fx-6-tray.png", clip=box)

        print("오류:", errs)
        b.close()

    # ---- 모음 이미지 ---------------------------------------------------------
    items = [
        ("fx-1-fly.png",    "1 천천히 이동 (미끄러지는 중)"),
        ("fx-2-land.png",   "2 도착 확인 도장"),
        ("fx-3-knight.png", "3 나이트는 살짝 점프"),
        ("fx-4-laugh.png",  "4 내가 AI 기물을 잡으면 → 웃음"),
        ("fx-5-cry.png",    "5 내 기물이 잡히면 → 울음"),
        ("fx-6-tray.png",   "6 표시줄에도 얼굴로 남는다"),
    ]
    font = ImageFont.truetype(FONT, 15)
    cellw, cols = 300, 3
    imgs = []
    for fn, _ in items:
        im = Image.open(OUT / fn)
        r = cellw / im.width
        imgs.append(im.resize((cellw, int(im.height * r)), Image.LANCZOS))
    # 트레이 컷은 짧으니 칸 높이에 맞춰 여백을 준다
    rowh = max(i.height for i in imgs) + 30
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cellw + (cols + 1) * 12, (rowh + 12) * rows + 12), (245, 244, 250))
    dr = ImageDraw.Draw(sheet)
    for i, (im, (_, lab)) in enumerate(zip(imgs, items)):
        cx = (i % cols) * (cellw + 12) + 12
        cy = (i // cols) * (rowh + 12) + 12
        dr.text((cx, cy), lab, font=font, fill=(60, 50, 80))
        sheet.paste(im, (cx, cy + 26))
    sheet.save(OUT / "week6-preview.png")
    print("저장: dev/week6-preview.png", sheet.size)


if __name__ == "__main__":
    main()
