#!/usr/bin/env python3
"""귀여운 체스 — 앱 아이콘 생성 (4주차)

dev/icon.html 을 실제 크롬으로 열어 그대로 캡처한다.
(기물 SVG 를 이미지 편집 도구로 다시 그리지 않아도 되고,
 아이콘과 게임 화면의 기물 모양이 100% 일치한다)

사용법
    python serve.py            # 다른 창에서 서버 실행 (8123)
    python dev/make_icons.py

결과
    icons/icon-192.png            any        (안드로이드/브라우저 탭)
    icons/icon-512.png            any        (스플래시·스토어)
    icons/icon-maskable-512.png   maskable   (안드로이드가 동그랗게 잘라냄)
    icons/apple-touch-icon.png    iOS 홈 화면
"""
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8123/dev/icon.html"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"

# (파일, 픽셀 크기, maskable, 기물)
JOBS = [
    ("icon-192.png",          192, False, "k"),
    ("icon-512.png",          512, False, "k"),
    ("icon-maskable-512.png", 512, True,  "k"),
    ("apple-touch-icon.png",  180, False, "k"),
]


def main() -> int:
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, size, mask, piece in JOBS:
            ctx = browser.new_context(
                viewport={"width": size, "height": size},
                device_scale_factor=1,
            )
            page = ctx.new_page()
            page.goto(f"{BASE}?size={size}&mask={1 if mask else 0}&p={piece}",
                      wait_until="networkidle")
            page.wait_for_timeout(180)          # 폰트/그라데이션 안정화
            path = OUT / name
            page.screenshot(path=str(path))
            ctx.close()
            print(f"저장: icons/{name}  ({size}×{size}{' · maskable' if mask else ''})")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
