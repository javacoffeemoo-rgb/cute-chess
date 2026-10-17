"""기물 SVG 를 PNG 로 래스터화해서 눈으로 확인하기 위한 개발용 스크립트.

사용법:
    python dev/render_sheet.py dev/piece-sheet-render.svg dev/piece-sheet-render.png

- 브라우저(dev/piece-sheet.html)에서 뽑은 SVG 를 읽어
  QtSvg 가 잘 다루는 <g transform> 형태로 바꾼 뒤 2배 크기 PNG 로 저장한다.
- PyQt5(Anaconda 기본 포함)만 있으면 된다.
"""
import re
import sys

from PyQt5.QtCore import Qt
from PyQt5.QtGui import QImage, QPainter
from PyQt5.QtSvg import QSvgRenderer

SRC = sys.argv[1] if len(sys.argv) > 1 else "dev/piece-sheet-render.svg"
DST = sys.argv[2] if len(sys.argv) > 2 else "dev/piece-sheet-render.png"
SCALE = 2

NESTED = re.compile(
    r'<svg x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)" height="([0-9.]+)" '
    r'viewBox="0 0 100 100">(.*?)</svg>',
    re.S,
)


def to_group(m):
    x, y, w, inner = m.group(1), m.group(2), m.group(3), m.group(5)
    return '<g transform="translate(%s,%s) scale(%.4f)">%s</g>' % (x, y, float(w) / 100.0, inner)


def main():
    svg = open(SRC, encoding="utf-8").read()
    svg, n = NESTED.subn(to_group, svg)
    print("변환한 기물 수:", n)

    renderer = QSvgRenderer(svg.encode("utf-8"))
    if not renderer.isValid():
        raise SystemExit("SVG 를 읽을 수 없습니다: " + SRC)

    size = renderer.defaultSize()
    img = QImage(size.width() * SCALE, size.height() * SCALE, QImage.Format_ARGB32)
    img.fill(Qt.white)
    painter = QPainter(img)
    renderer.render(painter)
    painter.end()

    if not img.save(DST):
        raise SystemExit("PNG 저장 실패")
    print("저장 완료:", DST, img.width(), "x", img.height())


if __name__ == "__main__":
    main()
