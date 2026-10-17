#!/usr/bin/env python3
"""화면 모음(contact sheet) 만들기 — 개발용

    python dev/make_preview.py

결과
    dev/week3-preview.png   shot-*.png   (3주차 : AI 대전)
    dev/week4-preview.png   shot4-*.png  (4주차 : 저장·소리·PWA)

캡처 스크립트(shots.py / verify_week4.py)를 먼저 실행해야 한다.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent
FONT = "C:/Windows/Fonts/malgun.ttf"

SHEETS = [
    ("week3-preview.png", [
        ("shot-1-home.png",            "1 홈"),
        ("shot-2-home-levels.png",     "2 난이도 · 진영"),
        ("shot-3-ai-thinking.png",     "3 AI 생각 중"),
        ("shot-4-ai-reply.png",        "4 AI 응수"),
        ("shot-5-play-as-black.png",   "5 흑 진영"),
        ("shot-6-check.png",           "6 체크"),
        ("shot-7-promotion.png",       "7 프로모션"),
        ("shot-8-result-win.png",      "8 승리"),
        ("shot-9-result-lose.png",     "9 패배"),
        ("shot-10-landscape.png",      "10 가로 화면"),
    ], 5, 300),
    ("week4-preview.png", [
        ("shot4-1-resume-card.png",    "1 이어하기 카드"),
        ("shot4-2-resumed.png",        "2 이어하기로 복원"),
        ("shot4-3-sound-setting.png",  "3 소리 설정"),
        ("shot4-4-install.png",        "4 홈 화면에 추가"),
        ("shot4-5-offline-home.png",   "5 오프라인 (홈)"),
        ("shot4-6-offline-game.png",   "6 오프라인 AI 대전"),
    ], 3, 320),
]


def build(name, items, cols, cellw):
    font = ImageFont.truetype(FONT, 14)
    imgs = []
    for fn, _ in items:
        im = Image.open(OUT / fn)
        r = cellw / im.width
        imgs.append(im.resize((cellw, int(im.height * r)), Image.LANCZOS))
    rowh = max(i.height for i in imgs) + 28
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cellw + (cols + 1) * 10, (rowh + 10) * rows + 10), (245, 244, 250))
    dr = ImageDraw.Draw(sheet)
    for i, (im, (_, lab)) in enumerate(zip(imgs, items)):
        cx = (i % cols) * (cellw + 10) + 10
        cy = (i // cols) * (rowh + 10) + 10
        dr.text((cx, cy), lab, font=font, fill=(60, 50, 80))
        sheet.paste(im, (cx, cy + 24))
    sheet.save(OUT / name)
    print(f"저장: dev/{name}  {sheet.size}")


def main():
    for name, items, cols, cellw in SHEETS:
        missing = [fn for fn, _ in items if not (OUT / fn).exists()]
        if missing:
            print(f"건너뜀 {name} — 없는 파일: {', '.join(missing)}")
            continue
        build(name, items, cols, cellw)


if __name__ == "__main__":
    main()
