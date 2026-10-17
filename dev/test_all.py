#!/usr/bin/env python3
"""귀여운 체스 — 4주차 종합 테스트 (실제 기기 프로필 + 터치 + 오프라인)

실기기(안드로이드)를 못 붙이는 환경이라, 그에 최대한 가깝게 검증한다.
  · Playwright 의 실제 기기 프로필 92종 중 대표 8종 (픽셀·갤럭시·아이폰·가로)
  · CDP 로 진짜 터치 이벤트(touchStart/Move/End) 를 보내 드래그까지 확인
  · CDP 로 CPU 를 4배 느리게 해서 "중급 폰" 성능을 흉내 (Lv.5 가 Lv.4 보다 얕아지지 않는지)
  · 오프라인 컨텍스트로 서비스 워커 캐시 실행 확인

    python dev/test_all.py
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8123/"
OUT = Path(__file__).resolve().parent
results = []          # (구역, 이름, 통과, 참고)


def check(section, name, ok, info=""):
    results.append((section, name, bool(ok), str(info)))
    mark = "OK  " if ok else "실패"
    print(f"  {mark} {name}" + (f"   → {info}" if info else ""))


def sq_box(page, i, tries=6):
    """칸의 화면 좌표. AI 응수로 보드가 다시 그려지는 순간과 겹치면
    Playwright 가 None 을 돌려줄 수 있으므로 잠깐 기다렸다 다시 시도한다."""
    sel = f'.square[data-i="{i}"]'
    for _ in range(tries):
        b = page.locator(sel).bounding_box()
        if b:
            return b
        page.wait_for_timeout(60)
    raise AssertionError(f"칸 {i} 의 좌표를 찾지 못했습니다 (보드가 다시 그려지는 중?)")


DEVICES = {}


def dev_kwargs(name):
    """Playwright 기기 프로필 → new_context 인자 (default_browser_type 는 제외)"""
    d = dict(DEVICES[name])
    d.pop("default_browser_type", None)
    return d


def tap_square(page, i):
    b = sq_box(page, i)
    page.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


def touch_drag(cdp, page, x1, y1, x2, y2, steps=8):
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart",
                                          "touchPoints": [{"x": x1, "y": y1}]})
    for k in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {
            "type": "touchMove",
            "touchPoints": [{"x": x1 + (x2 - x1) * k / steps, "y": y1 + (y2 - y1) * k / steps}]})
        page.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


# ---------------------------------------------------------------- 1. 기기 프로필
PROFILES = [
    ("Pixel 5", "픽셀 5 (390×844)"),
    ("Pixel 4a (5G)", "픽셀 4a 5G"),
    ("Galaxy S9+", "갤럭시 S9+ (320×658)"),
    ("Galaxy S8", "갤럭시 S8"),
    ("Nexus 5X", "넥서스 5X (구형)"),
    ("iPhone SE", "아이폰 SE (작음)"),
    ("iPhone 13", "아이폰 13"),
    ("Pixel 5 landscape", "픽셀 5 가로"),
    ("Galaxy S9+ landscape", "갤럭시 S9+ 가로"),
]


def section_profiles(browser):
    print("\n[1] 기기 프로필별 레이아웃 · 터치 크기")
    for name, label in PROFILES:
        ctx = browser.new_context(**dev_kwargs(name))
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(BASE)
        page.wait_for_timeout(500)
        page.evaluate("""() => {
          const C = window.__cuteChess;
          document.getElementById('screen-home').classList.remove('active');
          document.getElementById('screen-game').classList.add('active');
          C.profile.nickname = '폰돌이';
          C.newGame(); C.render();
        }""")
        page.wait_for_timeout(250)
        m = page.evaluate("""() => {
          const b = document.getElementById('board').getBoundingClientRect();
          const sq = document.querySelector('.square').getBoundingClientRect();
          return {
            iw: window.innerWidth, ih: window.innerHeight,
            bw: b.width, bh: b.height, bt: b.top, bb: b.bottom,
            sq: sq.width,
            scrollW: document.documentElement.scrollWidth,
            bodyScrollW: document.body.scrollWidth,
          };
        }""")
        landscape = "landscape" in name
        # 가로 화면은 높이가 보드 크기를 제한하므로 기준을 낮춘다(세로는 손가락 크기 34px) 
        min_sq = 26 if landscape else 34
        # 보드가 정사각형이고 화면 밖으로 나가지 않는가
        check("1", f"{label} · 보드 정사각형",
              abs(m["bw"] - m["bh"]) < 1.5, f"{m['bw']:.0f}×{m['bh']:.0f}")
        check("1", f"{label} · 보드가 화면 안에 들어옴",
              m["bt"] >= -1 and m["bb"] <= m["ih"] + 1 and m["iw"] - m["bw"] >= -1,
              f"top {m['bt']:.0f} · bottom {m['bb']:.0f} / 화면 {m['ih']:.0f}")
        check("1", f"{label} · 가로 스크롤 없음",
              m["scrollW"] <= m["iw"] + 1, f"{m['scrollW']} ≤ {m['iw']}")
        check("1", f"{label} · 칸 크기 ≥ {min_sq}px", m["sq"] >= min_sq, f"{m['sq']:.1f}px")
        check("1", f"{label} · 스크립트 오류 없음", not errs, errs[0] if errs else "")
        ctx.close()


# ---------------------------------------------------------------- 2. 실제 터치
def section_touch(browser):
    print("\n[2] 실제 터치 조작 (CDP 터치 이벤트)")
    ctx = browser.new_context(**dev_kwargs("Pixel 5"))
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE)
    page.wait_for_timeout(500)

    # 진짜 손가락으로 "게임 시작" 버튼 누르기 (홈은 스크롤되므로 먼저 화면 안으로)
    page.evaluate("() => { window.__cuteChess.profile.nickname = '폰돌이'; }")
    start = page.locator("#btn-start")
    start.scroll_into_view_if_needed()
    page.wait_for_timeout(150)
    btn = start.bounding_box()
    page.touchscreen.tap(btn["x"] + btn["width"] / 2, btn["y"] + btn["height"] / 2)
    page.wait_for_timeout(500)
    check("2", "홈에서 시작 버튼을 터치하면 대국 화면",
          page.evaluate("() => document.getElementById('screen-game').classList.contains('active')"))

    # 탭-탭 : e2 → e4
    page.evaluate("() => { window.__cuteChess.settings.level = 1; }")
    tap_square(page, 52)
    page.wait_for_timeout(180)
    sel = page.evaluate("() => document.getElementById('board').querySelectorAll('.square.sel').length")
    dots = page.evaluate("() => document.getElementById('board').querySelectorAll('.dot').length")
    check("2", "기물을 탭하면 선택 + 이동칸 점 표시", sel == 1 and dots >= 2, f"선택 {sel} · 점 {dots}")
    tap_square(page, 36)
    page.wait_for_timeout(600)
    check("2", "도착칸 탭 = 이동 (탭-탭)",
          page.evaluate("() => window.__cuteChess.rules.history()[0]") == "e4",
          page.evaluate("() => window.__cuteChess.rules.history().join(' ')"))

    page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)

    # 드래그 : d2 → d4 (진짜 터치 이동)
    cdp = ctx.new_cdp_session(page)
    a = sq_box(page, 51)
    b = sq_box(page, 35)
    touch_drag(cdp, page, a["x"] + a["width"] / 2, a["y"] + a["height"] / 2,
               b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    page.wait_for_timeout(600)
    hist = page.evaluate("() => window.__cuteChess.rules.history().join(' ')")
    check("2", "기물을 끌어서 이동 (드래그)", "d4" in hist, hist)

    # 상대 기물 탭 → 무시
    page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
    page.evaluate("() => { window.__cuteChess.settings.level = 3; }")
    opp = page.evaluate("""() => {
      const C = window.__cuteChess;
      for (let i = 0; i < 64; i++) { const p = C.state.board[i]; if (p && p.color !== C.state.turn) return i; }
      return -1;
    }""")
    tap_square(page, opp)
    page.wait_for_timeout(200)
    check("2", "상대 기물 탭은 무시된다 (선택되지 않음)",
          page.evaluate("() => window.__cuteChess.state.selected") is None)

    # 같은 기물 두 번 탭 → 선택 해제
    tap_square(page, 62)                    # 나이트 g1
    page.wait_for_timeout(200)
    sel1 = page.evaluate("() => window.__cuteChess.state.selected")
    tap_square(page, 62)
    page.wait_for_timeout(200)
    sel2 = page.evaluate("() => window.__cuteChess.state.selected")
    check("2", "기물 탭 = 선택 · 같은 기물 다시 탭 = 해제", sel1 == 62 and sel2 is None,
          f"선택 {sel1} → {sel2}")

    # 빈 칸 탭 → 선택 해제
    tap_square(page, 62)
    page.wait_for_timeout(180)
    tap_square(page, 44)                    # e3 (빈 칸, 나이트 이동칸 아님)
    page.wait_for_timeout(200)
    check("2", "빈 칸 탭 = 선택 해제",
          page.evaluate("() => window.__cuteChess.state.selected") is None)

    # 도착 칸을 연달아 빠르게 탭해도 수가 두 번 실행되지 않는다
    before = page.evaluate("() => window.__cuteChess.state.rules.history().length")
    tap_square(page, 62)                    # 나이트 g1 선택
    tap_square(page, 45)                    # f3 로 이동
    tap_square(page, 45)                    # 같은 칸을 곧바로 한 번 더 탭
    page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=15000)
    after = page.evaluate("() => window.__cuteChess.state.rules.history().length")
    played = page.evaluate("(n) => window.__cuteChess.state.rules.history().slice(n)", before)
    check("2", "도착 칸을 연달아 탭해도 한 수만 실행 (내 수 1 + AI 1)",
          after - before == 2, f"{before} → {after}수 : {' '.join(played)}")

    check("2", "터치 조작 중 스크립트 오류 없음", not errs, errs[0] if errs else "")
    ctx.close()


# ---------------------------------------------------------------- 3. 엔진
def section_engine(browser):
    print("\n[3] 규칙 · AI 엔진")
    ctx = browser.new_context(viewport={"width": 420, "height": 900})
    page = ctx.new_page()
    page.goto(BASE)
    page.wait_for_timeout(300)

    # perft 23개 케이스 (개발용 페이지 그대로)
    page.goto(BASE + "dev/perft.html")
    try:
        page.wait_for_function("() => window.__perft && window.__perft.done", timeout=300000)
        info = page.evaluate("() => window.__perft")
        check("3", f"perft {info['total']}개 케이스 전부 통과",
              info["fails"] == 0, f"실패 {info['fails']}개")
    except Exception as e:
        check("3", "perft 23개 케이스", False, "시간 초과")

    page.goto(BASE)
    page.wait_for_timeout(300)
    r = json.loads(page.evaluate("""() => {
      const E = window.CuteEngine, R = window.Rules;
      const base = s => String(s).replace(/[+#]$/, '');
      const out = {};
      const TAC = [
        { fen:'7k/6pp/8/8/8/8/5Q2/6K1 w - - 0 1', e:'Qf8' },
        { fen:'6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', e:'Ra8' },
        { fen:'k7/8/8/4q3/4R3/8/8/4K3 w - - 0 1', e:'Rxe5' },
        { fen:'4k3/8/8/8/7r/8/8/4K2R w K - 0 1', e:'Rxh4' },
        { fen:'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2', e:'exd5' },
      ];
      out.tac = {};
      for (const lv of [4,5]) {
        let bad = [];
        for (let k = 0; k < 4; k++) for (const t of TAC) {
          const mv = E.chooseMove(t.fen, lv);
          if (base(mv.san) !== t.e) bad.push(t.e + '→' + mv.san);
        }
        out.tac[lv] = bad.length === 0 ? '완벽 (20/20)' : bad.join(', ');
      }
      // 합법수 퍼즈
      let n = 0, bad = 0;
      for (let g = 0; g < 5; g++) {
        const r = new R(); r.trackRepetition = false;
        for (let ply = 0; ply < 60; ply++) {
          const legal = r.genLegal(); if (!legal.length) break;
          const mv = E.chooseMove(r.fen(), 1 + ((g + ply) % 3), { repeats: null });
          if (!mv) { bad++; break; }
          const h = legal.find(m => ((m.from>>4)*8+(m.from&7)) === mv.from && ((m.to>>4)*8+(m.to&7)) === mv.to);
          if (!h) { bad++; break; }
          r.move({ from: mv.from, to: mv.to, promotion: mv.promotion }); n++;
          if (r.result()) break;
        }
      }
      out.fuzz = { moves: n, illegal: bad };
      // 3회 반복 (엔진)
      const rep = new R();
      const seq = [[62,45],[6,21],[45,62],[21,6],[62,45],[6,21],[45,62],[21,6]];
      for (const [f,t] of seq) rep.move({ from:f, to:t });
      out.threefold = rep.result();
      out.fifty = (() => { const r = new R('K6k/8/8/8/8/8/8/7R w - - 99 60'); r.move({ from:63, to:55 }); return r.result(); })();
      out.insufficient = new R('K6k/8/8/8/8/8/8/8 w - - 0 1').result();
      out.promo = E.chooseMove('K6k/8/8/8/8/8/4p3/8 b - - 0 1', 4).promotion;
      out.noMove = E.chooseMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 3);

      /* ── 응수 다양성 (5주차) ── */
      const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      const MIDP = 'r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 6 7';

      // (1) 오프닝 북 : 첫 수가 여러 가지로 나온다
      const firsts = {};
      for (let i = 0; i < 16; i++) firsts[E.chooseMove(START, 3).san] = 1;
      out.book = Object.keys(firsts).length;

      // (2) 같은 국면에서 매번 다른 수 (중반 · Lv.3 · 설계된 실수는 제외)
      const many = {};
      let manyN = 0;
      for (let i = 0; i < 200 && manyN < 15; i++) {
        const m = E.chooseMove(MIDP, 3);
        if (m.blunder) continue;
        manyN++; many[m.san] = 1;
      }
      out.many = Object.keys(many).length;

      // (3) 다양성을 넣어도 실력은 그대로 : 고른 수의 손실 ≤ 후보 폭
      let worst = 0, worstSan = '-';
      for (let i = 0; i < 8; i++) {
        const m = E.chooseMove(MIDP, 4);
        const table = E.rootScores(MIDP, m.depth);
        const best = table[0].score;
        const mine = table.filter(t => t.san === m.san)[0];
        const loss = mine ? (best - mine.score) : 9999;
        if (loss > worst) { worst = loss; worstSan = m.san; }
      }
      out.loss = { max: worst, san: worstSan };

      // (4) 되돌아가는 수(반복)는 피한다
      const REP = '4k3/8/8/8/8/8/8/R3K2R w - - 0 1';
      const rc = {};
      for (let i = 0; i < 10; i++) { const m = E.chooseMove(REP, 4); rc[m.san] = (rc[m.san] || 0) + 1; }
      const repSan = Object.keys(rc)[0];
      const rk = (() => {
        const r2 = new R(); r2.load(REP); r2.trackRepetition = false;
        const mv = r2.moves({ verbose: true }).filter(m => m.san === repSan)[0];
        r2.move({ from: mv.from, to: mv.to });
        return r2.positionKey();
      })();
      const rw = {};
      for (let i = 0; i < 10; i++) {
        const m = E.chooseMove(REP, 4, { repeats: [rk] });
        rw[m.san] = (rw[m.san] || 0) + 1;
      }
      out.rep = { san: repSan, without: rc[repSan], withRep: (rw[repSan] || 0), others: Object.keys(rw).join(' ') };
      return JSON.stringify(out);
    }"""))
    check("3", "전술 5문제 × 4회 · Lv.4", r["tac"]["4"] == "완벽 (20/20)", r["tac"]["4"])
    check("3", "전술 5문제 × 4회 · Lv.5", r["tac"]["5"] == "완벽 (20/20)", r["tac"]["5"])
    check("3", f"합법수 퍼즈 {r['fuzz']['moves']}수 (AI가 둔 수 전부 합법)",
          r["fuzz"]["illegal"] == 0, f"불법 {r['fuzz']['illegal']}건")
    check("3", "3회 반복 감지", r["threefold"] and r["threefold"]["reason"] == "3회 반복",
          json.dumps(r["threefold"], ensure_ascii=False))
    check("3", "50수 규칙 감지", r["fifty"] and r["fifty"]["reason"] == "50수 규칙",
          json.dumps(r["fifty"], ensure_ascii=False))
    check("3", "기물 부족 감지", r["insufficient"] and r["insufficient"]["reason"] == "기물 부족")
    check("3", "AI 프로모션 문자 q", r["promo"] == "q")
    check("3", "둘 수 없으면 null", r["noMove"] is None)
    check("3", f"오프닝 북 — 첫 수가 여러 가지 ({r['book']}가지)",
          r["book"] >= 4, f"{r['book']}가지")
    check("3", f"같은 국면에서 매번 다른 수 ({r['many']}가지)",
          r["many"] >= 2, f"{r['many']}가지 수")
    check("3", f"다양성을 넣어도 실력은 그대로 (최대 손실 {r['loss']['max']}cp)",
          r["loss"]["max"] <= 25, f"{r['loss']['san']} = 최선수 -{r['loss']['max']}cp")
    check("3", "되돌아가는 수(반복)는 피한다",
          r["rep"]["without"] >= 1 and r["rep"]["withRep"] == 0,
          f"{r['rep']['san']} : 벌점 없이 {r['rep']['without']}회 → 벌점 주면 {r['rep']['withRep']}회"
          + (f" (대신 {r['rep']['others']})" if r["rep"]["others"] else ""))
    ctx.close()


# ---------------------------------------------------------------- 4. 앱 엣지 케이스
APP_TESTS = r"""
(async () => {
  const c = window.__cuteChess, $ = id => document.getElementById(id);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 9000)) { if (cond()) return true; await wait(40); } return false; };
  const R = []; const ok = (n, p, i) => R.push({ n: n, pass: !!p, info: i === undefined ? '' : String(i) });
  const sq = n => (8 - Number(n[1])) * 8 + (n.charCodeAt(0) - 97);

  c.settings.level = 2; c.settings.playerColor = 'w'; c.settings.sound = false;
  c.newGame();

  /* 동시 입력 / 잠금 */
  c.play(52, 36);
  ok('AI 생각 중 = 입력 잠금 (되돌리기·힌트 비활성)',
     c.state.thinking && $('btn-undo').disabled && $('btn-hint').disabled);
  const histBefore = c.rules.history().length;
  c.play(51, 35);                       // AI 차례에 내가 두려는 시도
  ok('AI 차례에 내가 두려 해도 무시', c.rules.history().length === histBefore, c.rules.history().join(' '));
  await until(() => !c.state.thinking, 9000);

  /* 힌트 */
  c.hint();
  ok('내 차례 힌트 동작', !!c.state.hint && !!$('board').querySelector('.hint-ring'), c.state.hint && c.state.hint.san);
  c.hint();
  ok('힌트 한 번 더 = 끄기', !c.state.hint);

  /* 이동칸 계산 */
  c.select(62);                       // 나이트 g1
  ok('기물을 선택하면 이동칸을 계산한다', c.state.selected === 62 && c.state.targets.size >= 2,
     c.state.targets.size + '칸');
  c.select(52);                       // e2 는 비어 있다 (폰이 e4 로 감)
  ok('빈 칸을 선택하면 이동칸이 없다', c.state.targets.size === 0, c.state.targets.size + '칸');
  c.select(-1);
  c.render();

  /* 새 게임 20회 (누수 확인) */
  const nodes0 = $('board').childElementCount;
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) c.newGame();
  c.render();
  ok('새 게임 20회 후 보드 칸 수 그대로', $('board').childElementCount === nodes0,
     nodes0 + '칸');
  ok('새 게임 20회가 1초 안에 끝남', Date.now() - t0 < 1000, (Date.now() - t0) + 'ms');

  /* AI 생각 중 새 게임 → 이전 응답 무시 */
  //  ※ 시작 국면은 오프닝 북이라 즉시 응수한다 → 북에 없는 중반 국면에서 시험한다
  c.settings.level = 5;
  c.rules.load('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3');   // 흑 차례 = AI 차례
  c.state.result = null; c.state.hint = null; c.render();
  c.maybeAI();
  await until(() => c.state.thinking, 4000);
  ok('AI 가 계산을 시작한다 (생각 중 표시)', c.state.thinking, c.state.thinking ? '생각 중' : '시작 안 함');
  c.newGame();
  await wait(600);
  ok('생각 중 새 게임 → 이전 AI 응답이 적용되지 않음',
     c.rules.history().length === 0 && !c.state.thinking, c.rules.history().join(' ') || '(없음)');

  /* 되돌리기 연타 */
  c.settings.level = 1; c.newGame();
  c.play(52, 36); await until(() => !c.state.thinking, 9000);
  c.play(62, 45); await until(() => !c.state.thinking, 9000);
  for (let i = 0; i < 10; i++) c.undo();
  ok('되돌리기 연타에도 크래시 없음 · 차례 정상',
     c.rules.history().length === 0 && c.state.turn === 'w' && c.state.selected === null,
     c.rules.history().join(' ') || '(없음)');

  /* 프로모션 4종 */
  for (const p of ['q', 'r', 'b', 'n']) {
    c.newGame();
    c.rules.load('K6k/4P3/8/8/8/8/8/8 w - - 0 1'); c.render();
    c.doMoveByTap(12, 4);                     // e7→e8 → 팝업
    const shown = $('promo-modal').classList.contains('show');
    const opts = $('promo-row').querySelectorAll('.promo-btn').length;
    if (p === 'q' && (!shown || opts !== 4)) { ok('프로모션 팝업 (4종 선택)', false, shown + '/' + opts); }
    c.play(12, 4, p);
    const piece = c.state.board[4];
    ok('프로모션 ' + p + ' → 올바른 기물', !!piece && piece.type === p, piece && piece.type);
  }
  c.newGame();
  c.rules.load('K6k/4P3/8/8/8/8/8/8 w - - 0 1'); c.render();
  c.doMoveByTap(12, 4);
  $('btn-promo-cancel').click();
  ok('프로모션 취소 = 아무 일도 없음',
     !c.state.pending && c.rules.history().length === 0 && !$('promo-modal').classList.contains('show'));

  /* 결과 3종 + 되돌리기로 재개 */
  c.newGame();
  c.rules.load('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'); c.render();
  c.play(56, 0);                                  // Ra8#
  ok('내 승리 문구', $('result-title').textContent.indexOf('승리') > 0, $('result-title').textContent);
  ok('결과 팝업 표시', $('result-modal').classList.contains('show'));
  c.undo();
  ok('종료 후 되돌리기 = 대국 재개', !c.state.result && !$('result-modal').classList.contains('show'),
     c.rules.history().join(' ') || '(없음)');

  c.newGame();
  c.rules.load('K6k/8/8/8/8/8/8/8 w - - 0 1'); c.render();
  ok('기물 부족 = 무승부', c.rules.result() && c.rules.result().reason === '기물 부족');

  /* 뒤집기 */
  c.newGame();
  const f0 = c.state.flipped;
  $('btn-flip').click();
  ok('판 뒤집기 토글', c.state.flipped === !f0 && $('board').childElementCount === 64);

  /* 시계 */
  c.newGame();
  await wait(1200);
  const clockText = $('clock').textContent;
  ok('시계가 흐른다', /^00:0[12]$/.test(clockText), clockText);
  c.rules.load('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'); c.render();
  c.play(56, 0);
  ok('대국 종료 시 시계 정지', c.state.timerId === null && $('clock').classList.contains('done'));

  /* 별명 */
  c.profile.nickname = '가나다라마바사아자차카타';     // 12자
  c.newGame();
  c.rules.load('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'); c.render();
  c.play(56, 0);
  ok('12자 별명이 결과에 그대로', $('result-title').textContent.indexOf('가나다라마바사아자차카타') === 0,
     $('result-title').textContent);
  c.profile.nickname = '폰돌이';

  /* 접근성 (스위치 · 버튼 라벨) */
  const bad = [];
  document.querySelectorAll('.switch').forEach(el => {
    if (!el.getAttribute('aria-checked') || !el.getAttribute('aria-label')) bad.push(el.id);
  });
  document.querySelectorAll('button').forEach(el => {
    const label = (el.textContent || '').trim() || el.getAttribute('aria-label');
    if (!label) bad.push(el.id || el.className);
  });
  ok('모든 스위치/버튼에 라벨 있음', bad.length === 0, bad.join(', '));

  c.newGame();
  return JSON.stringify(R);
})()
"""


def section_app(browser):
    print("\n[4] 앱 엣지 케이스 (동시 입력 · 되돌리기 · 프로모션 · 결과 · 시계 · 접근성)")
    ctx = browser.new_context(**dev_kwargs("Pixel 5"))
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE)
    page.wait_for_timeout(400)
    r = json.loads(page.evaluate(APP_TESTS))
    for x in r:
        check("4", x["n"], x["pass"], x["info"])
    check("4", "엣지 케이스 중 스크립트 오류 없음", not errs, errs[0] if errs else "")
    ctx.close()


# ---------------------------------------------------------------- 5. 저장 견고성
SAVE_TESTS = r"""
(async () => {
  const c = window.__cuteChess;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 9000)) { if (cond()) return true; await wait(40); } return false; };
  const R = []; const ok = (n, p, i) => R.push({ n: n, pass: !!p, info: i === undefined ? '' : String(i) });
  const K = 'cuteChess.current';
  const set = v => localStorage.setItem(K, typeof v === 'string' ? v : JSON.stringify(v));
  const get = () => localStorage.getItem(K);

  /* 정상 저장 → 이어하기 */
  c.settings.level = 1; c.settings.playerColor = 'w';
  c.newGame();
  c.play(52, 36); await until(() => !c.state.thinking, 9000);
  const moves = c.rules.history({ verbose: true }).map(h => ({ from: h.from, to: h.to }));
  ok('저장 형식 = 좌표 기보', JSON.parse(get()).moves.length === moves.length, get().slice(0, 90) + '…');

  /* 손상 데이터 6종 → 조용히 버리고 게임은 계속 */
  const broken = {
    'JSON 아님': '{{{ 이건 JSON 이 아님',
    'null': 'null',
    '버전 다름': { v: 99, moves: [{ from: 'e2', to: 'e4' }] },
    'moves 없음': { v: 1, level: 3 },
    'moves 빈 배열': { v: 1, moves: [] },
    '불법수 포함': { v: 1, moves: [{ from: 'e2', to: 'e4' }, { from: 'a1', to: 'h8' }] },
  };
  for (const [name, payload] of Object.entries(broken)) {
    set(payload);
    let threw = false, ret = null;
    try { ret = c.resumeSession(); } catch (e) { threw = true; }
    const cleared = name === '불법수 포함' ? get() === null : true;
    ok('손상 저장(' + name + ') → 크래시 없이 새 판', !threw && ret === false && !!c.state.started,
       'resume=' + ret + (threw ? ' 예외' : ''));
  }

  /* 정상 저장은 그대로 살아 있다 (이어하기 두 번) */
  set({ v: 1, moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }], level: 3, playerColor: 'w', elapsed: 42 });
  ok('이어하기 1회차 성공', c.resumeSession() === true, c.rules.history().join(' '));
  ok('이어하기 2회차도 같은 기보', c.resumeSession() === true, c.rules.history().join(' '));
  ok('이어하기가 경과 시간 복원', c.state.clock >= 42, c.state.clock + '초');

  /* 흑 진영 저장 → 이어하기 시 뒤집힘 유지 + AI 가 이어서 둠 */
  // 2수까지 저장 = 흑(나)의 수 다음 → 백(AI) 차례 → 이어하면 AI 가 둔다
  set({ v: 1, moves: [{ from: 'e2', to: 'e4' }, { from: 'e7', to: 'e5' }], level: 2, playerColor: 'b', elapsed: 5 });
  const okResume = c.resumeSession();
  ok('흑 진영 이어하기 = 보드 뒤집힘', okResume && c.state.flipped === true && c.myColor() === 'b',
     'flipped=' + c.state.flipped + ' · 내 차례=' + c.state.turn);
  await until(() => !c.state.thinking && c.rules.history().length >= 3, 9000);
  ok('흑 진영 이어하기 = AI 차례면 AI 가 이어서 응수', c.rules.history().length >= 3,
     c.rules.history().join(' '));

  /* 홈 새로고침 없이 카드 갱신 */
  document.getElementById('btn-back').click();
  await wait(200);
  ok('홈으로 나가면 이어하기 카드가 갱신됨', document.getElementById('resume-card').hidden === false,
     document.getElementById('resume-info').textContent);
  document.getElementById('btn-discard').click();
  await wait(150);
  ok('삭제를 누르면 카드가 사라지고 저장도 삭제', document.getElementById('resume-card').hidden === true && get() === null);

  c.newGame();
  return JSON.stringify(R);
})()
"""


def section_save(browser):
    print("\n[5] 저장/이어하기 견고성 (손상 데이터 · 반복 이어하기 · 흑 진영)")
    ctx = browser.new_context(**dev_kwargs("Pixel 5"))
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(BASE)
    page.wait_for_timeout(400)
    r = json.loads(page.evaluate(SAVE_TESTS))
    for x in r:
        check("5", x["n"], x["pass"], x["info"])
    check("5", "저장 테스트 중 스크립트 오류 없음", not errs, errs[0] if errs else "")
    ctx.close()


# ---------------------------------------------------------------- 6. PWA
def section_pwa(browser):
    print("\n[6] PWA 설치 요건 · 오프라인")
    ctx = browser.new_context(**dev_kwargs("Pixel 5"))
    page = ctx.new_page()
    page.goto(BASE)
    page.wait_for_timeout(500)
    page.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=10000)

    m = page.evaluate("""async () => {
      const r = await fetch('manifest.webmanifest');
      const j = await r.json();
      const icons = [];
      for (const ic of j.icons) { const res = await fetch(ic.src); icons.push(ic.sizes + ':' + ic.purpose + ':' + res.status); }
      const startRes = await fetch(j.start_url);
      return { j: j, icons: icons, start: startRes.status };
    }""")
    j = m["j"]
    check("6", "manifest: 이름·약칭", bool(j.get("name")) and bool(j.get("short_name")), f"{j.get('name')} / {j.get('short_name')}")
    check("6", "manifest: start_url 200", m["start"] == 200, f"{j.get('start_url')} → {m['start']}")
    check("6", "manifest: display standalone", j.get("display") == "standalone", j.get("display"))
    check("6", "manifest: 세로 고정(portrait)", j.get("orientation") == "portrait")
    check("6", "manifest: 테마/배경색", bool(j.get("theme_color")) and bool(j.get("background_color")),
          f"{j.get('theme_color')} / {j.get('background_color')}")
    check("6", "아이콘 192·512(any) + maskable(512)", any("192x192:any" in i for i in m["icons"])
          and any("512x512:any" in i for i in m["icons"]) and any("512x512:maskable" in i for i in m["icons"]),
          " · ".join(m["icons"]))
    check("6", "모든 아이콘이 200", all(i.endswith(":200") for i in m["icons"]))

    info = page.evaluate("""async () => {
      const keys = await caches.keys(); const c = await caches.open(keys[0]); const reqs = await c.keys();
      const reg = await navigator.serviceWorker.getRegistration();
      return { version: keys[0], count: reqs.length, active: !!reg.active, scope: reg.scope };
    }""")
    check("6", "서비스 워커 active + 페이지 제어", info["active"], f"{info['version']} · 범위 {info['scope']}")
    check("6", f"앱 껍데기 {info['count']}개 파일 선(先)캐시", info["count"] >= 10, info["count"])

    ctx.set_offline(True)
    page.reload()
    page.wait_for_timeout(900)
    check("6", "오프라인 새로고침 = 화면이 뜬다",
          page.evaluate("() => !!window.__cuteChess && !!document.getElementById('board')"))
    check("6", "오프라인 안내 표시",
          page.evaluate("() => document.getElementById('net-note').hidden") is False)
    page.evaluate("""() => {
      const C = window.__cuteChess;
      document.getElementById('screen-home').classList.remove('active');
      document.getElementById('screen-game').classList.add('active');
      C.settings.level = 2; C.settings.playerColor = 'w'; C.newGame(); C.render();
      C.play(52, 36);
    }""")
    page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=20000)
    check("6", "오프라인에서 AI 대전",
          len(page.evaluate("() => window.__cuteChess.rules.history()")) >= 2,
          page.evaluate("() => window.__cuteChess.rules.history().join(' ') + ' · ' + window.__cuteChess.ai.mode"))
    ctx.close()


# ---------------------------------------------------------------- 7. 성능(스로틀)
def section_perf(browser):
    print("\n[7] 중급 폰 성능 (CPU 4배 느리게 · CDP)")
    ctx = browser.new_context(**dev_kwargs("Pixel 5"))
    page = ctx.new_page()
    page.goto(BASE)
    page.wait_for_timeout(400)
    page.evaluate("""() => {
      const C = window.__cuteChess;
      document.getElementById('screen-home').classList.remove('active');
      document.getElementById('screen-game').classList.add('active');
      C.settings.playerColor = 'w'; C.newGame(); C.render();
    }""")
    cdp = ctx.new_cdp_session(page)
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})

    MID = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3"
    depths = {}
    for lv in (3, 4, 5):
        page.evaluate("""(o) => {
          const C = window.__cuteChess;
          C.ai.cancel(); C.state.thinking = false; C.state.result = null;
          C.state.aiInfo = null;
          C.rules.load(o.fen); C.render();
          C.settings.level = o.lv;
        }""", {"fen": MID, "lv": lv})
        t0 = time.time()
        page.evaluate("() => window.__cuteChess.maybeAI()")
        page.wait_for_function("() => !!window.__cuteChess.state.aiInfo && !window.__cuteChess.state.thinking",
                               timeout=60000)
        info = page.evaluate("() => window.__cuteChess.state.aiInfo")
        depths[lv] = info
        # Lv.3 은 6% 확률로 "일부러 실수(blunder)" 를 둔다 → 그때는 깊이가 의미 없다
        want = {4: 4, 5: 4}[lv] if lv != 3 else 3
        good = info["depth"] >= want or (lv == 3 and info.get("blunder"))
        check("7", f"Lv.{lv} · CPU 4배 느린 폰에서 응답",
              good,
              f"깊이 {info['depth']}수 · {info['ms']}ms"
              + (f" · {info['nodes']:,}국면" if info.get("nodes") else "")
              + (" · 일부러 실수" if info.get("blunder") else ""))
    check("7", "느린 폰에서도 Lv.5 깊이 ≥ Lv.4 깊이 (난이도 역전 없음)",
          depths[5]["depth"] >= depths[4]["depth"],
          f"Lv.4 {depths[4]['depth']}수 vs Lv.5 {depths[5]['depth']}수")
    tip = page.evaluate("() => document.getElementById('plate-opp').title")
    check("7", "AI 정보 툴팁에 탐색 깊이·국면 수가 채워진다",
          "수까지 탐색" in tip and "undefined" not in tip and "NaN" not in tip, tip)

    # 계산 중에도 화면이 살아 있는가 (배지가 '생각 중…')
    #   ※ 시작 국면은 오프닝 북이라 즉시 응수한다 → 북에 없는 중반 국면을 쓴다
    page.evaluate("""(o) => {
      const C = window.__cuteChess;
      C.ai.cancel(); C.state.thinking = false; C.state.result = null;
      C.rules.load(o.fen);
      C.settings.playerColor = 'w'; C.settings.level = 5; C.render();
    }""", {"fen": MID})
    page.evaluate("() => window.__cuteChess.maybeAI()")
    page.wait_for_timeout(250)
    badge = page.evaluate("() => document.getElementById('opp-badge').textContent")
    alive = page.evaluate("""() => {          // 계산 중에도 자바스크립트가 돌아가는지
      let n = 0; const t = Date.now(); while (Date.now() - t < 60) n++;
      return n > 0;
    }""")
    check("7", "계산 중에도 화면(스레드)이 살아있음", alive and "생각" in badge, f"배지 '{badge}'")
    page.wait_for_function("() => !window.__cuteChess.state.thinking", timeout=60000)

    # 메모리 (새 게임 20회)
    page.evaluate("() => { window.__cuteChess.settings.playerColor = 'w'; }")
    heap0 = page.evaluate("() => performance.memory ? performance.memory.usedJSHeapSize : 0")
    page.evaluate("() => { const C = window.__cuteChess; for (let i = 0; i < 20; i++) C.newGame(); }")
    page.wait_for_timeout(400)
    heap1 = page.evaluate("() => performance.memory ? performance.memory.usedJSHeapSize : 0")
    grew = (heap1 - heap0) / 1048576
    check("7", "새 게임 20회 후 힙 증가 미미 (< 8MB)", grew < 8, f"{grew:+.1f}MB")
    ctx.close()


def main():
    t_start = time.time()
    with sync_playwright() as p:
        global DEVICES
        DEVICES = p.devices
        browser = p.chromium.launch()
        section_profiles(browser)
        section_touch(browser)
        section_engine(browser)
        section_app(browser)
        section_save(browser)
        section_pwa(browser)
        section_perf(browser)
        browser.close()

    print("\n" + "=" * 62)
    total = len(results)
    failed = [r for r in results if not r[2]]
    by = {}
    for s, n, ok_, i in results:
        by.setdefault(s, [0, 0])
        by[s][1] += 1
        if ok_:
            by[s][0] += 1
    names = {"1": "기기 프로필", "2": "실제 터치", "3": "규칙·AI 엔진",
             "4": "앱 엣지 케이스", "5": "저장 견고성", "6": "PWA·오프라인", "7": "성능·메모리"}
    for s in sorted(by):
        print(f"  [{s}] {names[s]:<14} {by[s][0]:>2}/{by[s][1]:>2}")
    print(f"\n전체 {total - len(failed)}/{total} 통과 · {time.time() - t_start:.0f}초")
    if failed:
        print("\n실패 목록:")
        for s, n, ok_, i in failed:
            print(f"  - [{s}] {n}" + (f"  ({i})" if i else ""))
        return 1
    print("모든 테스트 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
