"""5주차 증거 이미지 — 같은 수(1.e4)를 6번 두었을 때 AI 응수가 매번 달라지는가.

    python dev/make_variety.py     →  dev/var-1..6.png + dev/week5-preview.png

(서버가 떠 있어야 한다. dev/shots.py 와 같은 방식으로 크롬을 띄운다)
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8123/"
OUT = Path(__file__).resolve().parent
FONT = "C:/Windows/Fonts/malgun.ttf"
ROUNDS = 6


def main():
    shots = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844},
                                  device_scale_factor=2)
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(BASE)
        page.wait_for_timeout(500)
        page.evaluate("""() => {
          document.getElementById('screen-home').classList.remove('active');
          document.getElementById('screen-game').classList.add('active');
          const C = window.__cuteChess;
          C.profile.nickname = '폰돌이';
          C.settings.level = 3; C.settings.playerColor = 'w';
          C.newGame(); C.render();
        }""")
        page.wait_for_timeout(400)

        for i in range(ROUNDS):
            page.evaluate("""() => {
              const C = window.__cuteChess;
              C.newGame();
              C.play(52, 36);                 // e2→e4 : 매번 똑같은 수
            }""")
            page.wait_for_function(
                "() => !window.__cuteChess.state.thinking && window.__cuteChess.rules.history().length >= 2",
                timeout=30000)
            page.wait_for_timeout(150)
            hist = page.evaluate("() => window.__cuteChess.rules.history()")
            fn = f"var-{i+1}.png"
            # 기물이 움직이는 애니메이션이 멈추길 기다리면 타임아웃이 난다 → 보드 영역만 잘라 찍는다
            box = page.evaluate("""() => {
              const r = document.getElementById('board').getBoundingClientRect();
              return { x: r.x + window.scrollX, y: r.y + window.scrollY,
                       width: r.width, height: r.height };
            }""")
            page.screenshot(path=str(OUT / fn), clip=box, animations="disabled")
            shots.append((fn, f"{i+1}.  1.e4  {hist[1]}"))
            print(f"  {i+1}판 : 1.e4 {hist[1]}")

        if errs:
            print("pageerror:", errs)
        ctx.close()
        browser.close()

    # ── 모아 붙이기 ──
    cols, cellw = 3, 300
    font = ImageFont.truetype(FONT, 15)
    head = ImageFont.truetype(FONT, 18)
    imgs = []
    for fn, _ in shots:
        im = Image.open(OUT / fn)
        r = cellw / im.width
        imgs.append(im.resize((cellw, int(im.height * r)), Image.LANCZOS))
    rowh = max(i.height for i in imgs) + 30
    rows = (len(imgs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cellw + (cols + 1) * 10, (rowh + 10) * rows + 34),
                      (245, 244, 250))
    dr = ImageDraw.Draw(sheet)
    dr.text((12, 8), "같은 수(1.e4)를 6번 두었을 때 — AI 응수가 매번 다릅니다 (오프닝 북 + 후보 무작위 선택)",
            font=head, fill=(60, 50, 80))
    for i, (im, (_, lab)) in enumerate(zip(imgs, shots)):
        cx = (i % cols) * (cellw + 10) + 10
        cy = (i // cols) * (rowh + 10) + 34
        dr.text((cx + 4, cy), lab, font=font, fill=(60, 50, 80))
        sheet.paste(im, (cx, cy + 24))
    sheet.save(OUT / "week5-preview.png")
    print(f"저장: dev/week5-preview.png  {sheet.size}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
