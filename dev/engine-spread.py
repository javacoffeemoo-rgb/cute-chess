"""국면 점수표 · 레벨별 선택 확인 — 난이도·후보 폭 튜닝용.

사용법:
    python dev/engine-spread.py                    # 기본 국면들
    python dev/engine-spread.py "FEN" 4            # 특정 국면 · 깊이

보여주는 것:
  1) 루트 수를 "정확한 점수"로 줄세워 상위 수와 최선수와의 차이(cp)
  2) 후보 폭(10·15·25…) 안에 몇 개가 들어오는지 → 다양성이 얼마나 생기는지
  3) 레벨별로 실제로 고르는 수 (응수 다양성)
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8123/"

POS = [
    ("시작 국면", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 4),
    ("이탈리안 조용한 중반", "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", 4),
    ("캐슬링 완료 중반", "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 6 7", 4),
    ("북 없는 초반 (1.e4 d6 2.d4)", "rnbqkbnr/ppp1pppp/3p4/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 2", 4),
]

JS_SCORES = "(o) => window.CuteEngine.rootScores(o.fen, o.depth)"

JS_PICK = """(o) => {
  const E = window.CuteEngine;
  const out = {}, flags = { blunder: 0, book: 0 };
  let i = 0, got = 0;
  while (got < o.n && i < 400) {
    i++;
    const m = E.chooseMove(o.fen, o.lv);
    if (m.blunder) { flags.blunder++; continue; }        // 설계된 실수는 따로 센다
    if (m.book) { flags.book++; continue; }              // 오프닝 북도 따로
    got++;
    out[m.san] = (out[m.san] || 0) + 1;
  }
  return { sans: out, flags: flags };
}
"""

LV_NAME = {1: "쉬움", 2: "조금 쉬움", 3: "보통", 4: "어려움", 5: "아주 어려움"}


def show(page, name, fen, depth):
    rows = page.evaluate(JS_SCORES, {"fen": fen, "depth": depth})
    if not rows:
        print(f"\n=== {name} ===\n  (합법수 없음)")
        return
    best = rows[0]["score"]
    print(f"\n=== {name} · 깊이 {depth} ===")
    for r in rows[:8]:
        print(f"  {r['san']:>6}  {r['score']:>7}   (최선수와 {best - r['score']:+}cp)")
    counts = {m: sum(1 for r in rows if best - r["score"] <= m) for m in (10, 15, 25, 40, 60)}
    print("  후보 폭 안에 들어오는 수:", " · ".join(f"±{m}cp={c}개" for m, c in counts.items()))

    picks = {}
    for lv in (1, 2, 3, 4, 5):
        r = page.evaluate(JS_PICK, {"fen": fen, "lv": lv, "n": 12 if lv < 4 else 6})
        keys = list(r["sans"])
        picks[lv] = f"{len(keys)}가지 " + ",".join(keys[:6])
        if r["flags"]["blunder"] or r["flags"]["book"]:
            picks[lv] += f" (실수 {r['flags']['blunder']}·북 {r['flags']['book']} 제외)"
    print("  레벨별 실제 선택 (같은 국면을 반복했을 때):")
    for lv, txt in picks.items():
        print(f"    Lv.{lv} {LV_NAME[lv]:8} → {txt}")


def main():
    args = sys.argv[1:]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 420, "height": 900})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(BASE)
        page.wait_for_timeout(400)
        if args:
            fen = args[0]
            depth = int(args[1]) if len(args) > 1 else 4
            show(page, "지정한 국면", fen, depth)
        else:
            for name, fen, depth in POS:
                show(page, name, fen, depth)
        if errs:
            print("\npageerror:", errs)
        ctx.close()
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
