/* ============================================================
   귀여운 체스 — 수 찾기 엔진 (미니맥스 + 알파베타 + 정적 탐색)
   ------------------------------------------------------------
   2주차: "힌트" 버튼이 이 엔진을 쓴다        → bestMove(fen, depth)
   3주차: Web Worker 안에서 AI 가 이 엔진을 쓴다 → chooseMove(fen, level)

   · 점수 단위는 센티폰(pawn = 100)
   · 네가맥스(negamax) 관례로 "지금 둘 차례인 쪽" 기준 점수를 돌려준다
   · 반복 심화(iterative deepening) + 시간 제한 → Lv.5 는 1.2초 안에서 최선을 다한다
   · 정적 탐색(quiescence) : 깊이가 끝나도 잡기/프로모션이 남아 있으면 더 파고들어
     "내 말을 공짜로 준다" 같은 착각(수평선 효과)을 줄인다
   ============================================================ */
(function () {
  'use strict';

  const RulesCtor = self.Rules;    // Web Worker 안에서도 같은 코드가 돌아야 한다 (window 없음)
  const MATE = 100000;
  const INF = 1e9;

  // 기물 가치 (p n b r q k)
  const VALUE = [0, 100, 320, 330, 500, 900, 0];

  /* ----------------------------------------------------------
     난이도 정책 (기획서 6장)
       depth    : 몇 수 앞까지 볼지 (최대)
       minDepth : 시간이 모자라도 "반드시" 채우는 깊이
                  → 기기 성능과 무관하게 Lv.5 가 Lv.4 보다 얕아지지 않는다
       blunder  : 이 확률로 최선수를 놓친다 (초보 흉내)
       timeLimit: ms. 반복 심화가 이 시간을 넘기면 그 전 깊이 결과를 쓴다
       variety  : 같은 점수대(±센티폰)의 수 중에서 무작위로 고른다 (5주차)
                  → 같은 국면에서 매번 똑같은 수만 두지 않는다.
                    폭이 실력 손실의 상한이므로 "고르는 재미"만 늘고 세기는 그대로다.
     ---------------------------------------------------------- */
  const LEVELS = {
    1: { depth: 1, blunder: 0.50, timeLimit: 0,    minDepth: 1, variety: 60 },
    2: { depth: 2, blunder: 0.22, timeLimit: 0,    minDepth: 2, variety: 40 },
    3: { depth: 3, blunder: 0.06, timeLimit: 0,    minDepth: 3, variety: 25 },
    4: { depth: 4, blunder: 0,    timeLimit: 1500, minDepth: 4, variety: 15 },
    5: { depth: 6, blunder: 0,    timeLimit: 2000, minDepth: 4, variety: 10 },   // 최소 4수, 시간이 되면 5~6수
  };

  // 초반(기물 28개 이상)에는 후보 폭을 넓혀 매 판 첫 수가 달라지게 한다.
  //   정석이 여럿이라 20센티폰 차이는 실력에 거의 영향이 없다.
  const OPENING_VARIETY = 20;

  // 같은 국면으로 되돌아가는 수(반복 무승부로 흐르는 수)에 주는 벌점.
  //   이기고 있을 때만 준다(sc > -50). 후보 폭(variety)보다 커야 실제로 걸러진다.
  const REPEAT_PENALTY = 40;

  /* ----------------------------------------------------------
     위치 점수 (PST)
       i : 0 = a8 … 63 = h1
       자기 진영에서의 줄(ownRank)과 중앙에서의 거리를 이용해 단순화했다.
     ---------------------------------------------------------- */
  function pst(type, i, color) {
    const f = i & 7, r = i >> 3;
    const ownRank = color === 1 ? 7 - r : r;              // 0 = 자기 1선
    const cd = Math.abs(3.5 - f) + Math.abs(3.5 - r);     // 중앙에서의 거리 (0~7)
    switch (type) {
      // 폰: 전진할수록, 중앙 열일수록 좋다 (d·e 폰 우대)
      case 1: return ownRank * 7 + (3.5 - Math.abs(3.5 - f)) * 6;
      case 2: return (4 - cd) * 9;                                  // 나이트: 중앙 선호
      case 3: return (4 - cd) * 4 + ownRank * 2;                    // 비숍
      case 4: return ownRank * 5;                                   // 룩: 7선으로 전진
      case 5: return (4 - cd) * 2;                                  // 퀸
      // 킹: 자기 진영 + 구석 쪽(g1/c1 등)에 있으면 좋다
      default: return (ownRank <= 1 ? 6 : -10) + ((f <= 2 || f >= 5) ? 5 : 0);
    }
  }

  /* ----------------------------------------------------------
     평가 함수
       재료 + 위치 + (비숍 페어 / 중복·고립 폰 / 열린 파일 룩)
       ※ 노드마다 불리므로 임시 배열은 재사용한다(GC 방지)
     ---------------------------------------------------------- */
  const wPawnFiles = new Int8Array(8), bPawnFiles = new Int8Array(8);
  const wRookFiles = new Int8Array(8), bRookFiles = new Int8Array(8);

  function evaluate(rules) {
    const b = rules.board;      // 0x88 배열 (같은 엔진 패키지라 직접 읽는다)
    wPawnFiles.fill(0); bPawnFiles.fill(0);
    wRookFiles.fill(0); bRookFiles.fill(0);

    let white = 0, black = 0;
    let wBishops = 0, bBishops = 0;

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = b[sq];
      if (!p) continue;
      const t = p & 7;
      const f = sq & 7, r = sq >> 4;
      const i = (r * 8) + f;
      const isWhite = (p & 8) === 0;
      const s = VALUE[t] + pst(t, i, isWhite ? 1 : 2);
      if (isWhite) {
        white += s;
        if (t === 1) wPawnFiles[f]++;
        else if (t === 3) wBishops++;
        else if (t === 4) wRookFiles[f]++;
      } else {
        black += s;
        if (t === 1) bPawnFiles[f]++;
        else if (t === 3) bBishops++;
        else if (t === 4) bRookFiles[f]++;
      }
    }

    // 비숍 페어
    if (wBishops >= 2) white += 25;
    if (bBishops >= 2) black += 25;

    // 중복 폰 / 고립 폰 / 열린 파일 룩
    for (let f = 0; f < 8; f++) {
      const wp = wPawnFiles[f], bp = bPawnFiles[f];
      const wNbr = (f > 0 ? wPawnFiles[f - 1] : 0) + (f < 7 ? wPawnFiles[f + 1] : 0);
      const bNbr = (f > 0 ? bPawnFiles[f - 1] : 0) + (f < 7 ? bPawnFiles[f + 1] : 0);

      if (wp > 1) white -= 12 * (wp - 1);
      if (bp > 1) black -= 12 * (bp - 1);
      if (wp && !wNbr) white -= 14;
      if (bp && !bNbr) black -= 14;

      if (wRookFiles[f]) {
        if (!wp && !bp) white += 14;          // 완전히 열린 파일
        else if (!wp) white += 7;             // 반열린 파일
      }
      if (bRookFiles[f]) {
        if (!wp && !bp) black += 14;
        else if (!bp) black += 7;
      }
    }

    return rules.turn === 1 ? (white - black) : (black - white);
  }

  /* ----------------------------------------------------------
     수 정렬 (좋은 수를 먼저 봐야 알파베타가 많이 잘라낸다)
       MVV-LVA : 값진 것을 싼 기물로 잡는 수를 우선
       킬러    : 이 깊이에서 베타 컷오프를 낸 조용한 수 (두 개)
       히스토리: 컷오프를 낸 수에 깊이² 만큼 점수를 누적
     ---------------------------------------------------------- */
  const KILLER_SLOTS = 24;
  let killers = new Array(KILLER_SLOTS);
  let history = new Int32Array(128 * 128);

  function resetOrderHeuristics() {
    for (let i = 0; i < KILLER_SLOTS; i++) killers[i] = null;
    history.fill(0);
  }

  const moveKey = m => m.from * 128 + m.to;

  function orderScore(m, ply) {
    const victim = m.captured ? VALUE[m.captured & 7] : (m.isEp ? 100 : 0);
    if (victim || m.promotion) {
      const attacker = VALUE[m.piece & 7];
      return 1000000 + victim * 10 - attacker + (m.promotion ? VALUE[m.promotion] * 7 : 0);
    }
    let s = 0;
    const k = killers[ply];
    if (k) {
      const key = moveKey(m);
      if (k[0] === key) s = 900000;
      else if (k[1] === key) s = 800000;
    }
    return s + history[m.from * 128 + m.to];
  }

  function orderMoves(moves, ply) {
    // 정렬 키를 미리 계산해 둔다 (비교 함수 안에서 매번 다시 계산하면 느리다).
    //   genLegal() 이 매번 새 배열/새 move 객체를 주므로 제자리 정렬이 안전하다.
    for (let i = 0; i < moves.length; i++) moves[i].ord = orderScore(moves[i], ply | 0);
    moves.sort(byOrder);
    return moves;
  }
  function byOrder(a, b) { return b.ord - a.ord; }

  // 베타 컷오프를 낸 조용한 수를 기억해 다음 정렬에 쓴다
  function noteCutoff(m, depth, ply) {
    if (m.captured || m.promotion || m.isEp) return;     // 잡기는 이미 앞에 온다
    const key = moveKey(m);
    const k = killers[ply];
    if (!k) killers[ply] = [key, -1];
    else if (k[0] !== key) { k[1] = k[0]; k[0] = key; }

    const hk = m.from * 128 + m.to;
    history[hk] += depth * depth;
    if (history[hk] > 400000) {                          // 너무 커지면 전체를 줄인다
      for (let i = 0; i < history.length; i++) history[i] >>= 1;
    }
  }

  // 잡아서 얻는 즉시 이득 (델타 가지치기용)
  function captureGain(m) {
    return (m.captured ? VALUE[m.captured & 7] : (m.isEp ? 100 : 0))
      + (m.promotion ? VALUE[m.promotion] - 100 : 0);
  }

  /* ----------------------------------------------------------
     정적 탐색 : 잡기/프로모션만 더 파고든다
     ---------------------------------------------------------- */
  function quiesce(rules, alpha, beta, depth, ctx) {
    const stand = evaluate(rules);
    if (depth <= 0 || ctx.timeUp) return stand;
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;

    const caps = orderMoves(rules.genLegal(true), 20);   // ply 20 = 킬러 슬롯과 겹치지 않게

    for (let i = 0; i < caps.length; i++) {
      const m = caps[i];
      // 델타 가지치기 : 이걸 잡아도 alpha 를 못 넘길 것 같으면 볼 필요 없다
      if (stand + captureGain(m) + 200 <= alpha) continue;

      rules.makeMove(m);
      const sc = -quiesce(rules, -beta, -alpha, depth - 1, ctx);
      rules.undoMove();
      if (ctx.timeUp) return alpha;
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }

  /* ----------------------------------------------------------
     네가맥스 + 알파베타
     ---------------------------------------------------------- */
  function negamax(rules, depth, alpha, beta, ctx, ply) {
    ctx.nodes++;
    if (ctx.timeUp) return 0;
    if (ctx.deadline && (ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) {
      ctx.timeUp = true;
      return 0;
    }
    if (depth <= 0) return quiesce(rules, alpha, beta, 4, ctx);

    const moves = rules.genLegal();
    if (moves.length === 0) return rules.isCheck() ? -(MATE + depth) : 0;   // 메이트면 빠른 쪽 선호

    const ordered = orderMoves(moves, ply);

    let best = -INF;
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      rules.makeMove(m);
      const sc = -negamax(rules, depth - 1, -beta, -alpha, ctx, ply + 1);
      rules.undoMove();
      if (ctx.timeUp) return best > -INF ? best : 0;
      if (sc > best) best = sc;
      if (best > alpha) alpha = best;
      if (alpha >= beta) { noteCutoff(m, depth, ply); break; }
    }
    return best;
  }

  /* ----------------------------------------------------------
     루트 탐색 (한 깊이)
       repeats : 이미 나온 국면 키 목록.
                 같은 국면으로 되돌아가는 수에 작은 벌점을 줘서
                 3회 반복 무승부로 흘러가는 것을 피한다(기획서 6장).
     ---------------------------------------------------------- */
  function searchRoot(rules, ordered, depth, ctx, repeats) {
    let bestMove = ordered[0], bestScore = -INF, alpha = -INF;
    let picks = [ordered[0]];
    const upper = [];                    // 각 루트 수의 점수 (최선수가 아니면 "상한")

    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      rules.makeMove(m);
      let sc = -negamax(rules, depth - 1, -INF, -alpha, ctx, 1);
      if (!ctx.timeUp && repeats && repeats.length && sc > -50 &&
          repeats.indexOf(rules.positionKey()) >= 0) sc -= REPEAT_PENALTY;
      rules.undoMove();
      if (ctx.timeUp) return { move: bestMove, score: bestScore, complete: false, upper: upper };
      upper.push({ m: m, sc: sc });
      if (sc > bestScore) { bestScore = sc; bestMove = m; picks = [m]; }
      else if (sc >= bestScore - 6) picks.push(m);
      if (sc > alpha) alpha = sc;
    }

    // 점수가 사실상 같은 수가 여럿이면 "의미 있는 수"를 고른다.
    //   → 초반에 a3 같은 무의미한 수 대신 전개/중앙 수를 둔다.
    //   ※ 알파베타는 "나쁜 수"의 점수를 상한으로만 돌려주므로,
    //     후보가 애초에 더 좋은 것(프로모션·캐슬링·잡기·전개)일 때만 전체 창으로 다시 확인한다.
    //     (메이트를 찾은 경우에는 메이트 거리가 짧은 쪽을 그대로 둔다)
    if (picks.length > 1 && Math.abs(bestScore) < MATE - 200) {
      const want = moveRank(bestMove);
      const cands = [];
      for (let i = 0; i < picks.length; i++) {
        const m = picks[i];
        if (m !== bestMove && moveRank(m) < want) cands.push(m);
      }
      if (cands.length > 1) cands.sort((a, b) => moveRank(a) - moveRank(b));
      for (let i = 0; i < cands.length; i++) {
        const m = cands[i];
        const sc = rootScoreOne(rules, m, depth, ctx, repeats);       // 전체 창 = 정확한 점수
        if (ctx.timeUp) break;
        if (sc >= bestScore - 6) {
          bestScore = sc > bestScore ? sc : bestScore;
          bestMove = m;
          break;
        }
      }
    }
    return { move: bestMove, score: bestScore, complete: true, upper: upper };
  }

  // 루트 수 하나의 정확한 점수 (전체 창) + 반복 벌점
  function rootScoreOne(rules, m, depth, ctx, repeats) {
    rules.makeMove(m);
    let sc = -negamax(rules, depth - 1, -INF, INF, ctx, 1);
    if (!ctx.timeUp && repeats && repeats.length && sc > -50 &&
        repeats.indexOf(rules.positionKey()) >= 0) sc -= REPEAT_PENALTY;
    rules.undoMove();
    return sc;
  }

  /* ----------------------------------------------------------
     다양성 (5주차) : "최선수와 사실상 같은 점수"의 수를 모아 후보 풀을 만든다
       · searchRoot 가 준 점수는 (최선수가 아닌 수의 경우) 알파베타가 잘라낸
         "상한"이라 정확하지 않다 → 후보만 전체 창으로 다시 확인한다.
       · 시간이 모자라면 그때까지 확인된 것만 쓴다 (최선수는 항상 포함).
       · 메이트를 찾았으면 다양성을 포기하고 짧은 메이트를 둔다.
     ---------------------------------------------------------- */
  function varietyPool(rules, rootRes, depth, variety, repeats, budgetMs) {
    const bestMove = rootRes.move, bestScore = rootRes.score;
    const pool = [bestMove];
    if (!(variety > 0) || !rootRes.upper || rootRes.complete === false) return pool;
    if (Math.abs(bestScore) > MATE - 200) return pool;          // 메이트면 그대로

    const cands = [];
    for (let i = 0; i < rootRes.upper.length; i++) {
      const u = rootRes.upper[i];
      if (u.m === bestMove) continue;
      if (u.sc >= bestScore - variety) cands.push(u);            // 상한으로 1차 거르기
    }
    if (!cands.length) return pool;
    // "말이 되는 수"를 먼저 확인한다 → 제한된 시간 안에 쓸모 있는 후보를 채운다
    cands.sort((a, b) => (varietyRank(a.m) - varietyRank(b.m)) || (b.sc - a.sc));
    if (cands.length > 6) cands.length = 6;                      // 시간 보호

    const ctx = { nodes: 0, deadline: budgetMs > 0 ? Date.now() + budgetMs : 0, timeUp: false };
    for (let i = 0; i < cands.length; i++) {
      const m = cands[i].m;
      const sc = rootScoreOne(rules, m, depth, ctx, repeats);     // 전체 창 = 정확한 점수
      if (ctx.timeUp) break;                                     // 시간이 없으면 지금까지 것으로
      if (sc >= bestScore - variety) pool.push(m);               // 최선수와 같은 점수대면 후보
    }
    return pool;
  }

  // 후보 풀에서 하나 고르기 — 점수는 이미 비슷하므로 "말이 되는 수"를 우선하고 그중에서 무작위로.
  //   같은 등급이 여럿이면 무작위 → 매번 다른 수 (5주차 : 응수 다양성)
  function pickVariety(pool) {
    let bestRank = 99, group = null;
    for (let i = 0; i < pool.length; i++) {
      const r = varietyRank(pool[i]);
      if (r < bestRank) { bestRank = r; group = [pool[i]]; }
      else if (r === bestRank) group.push(pool[i]);
    }
    return group[Math.floor(Math.random() * group.length)];
  }

  /* 수의 등급 (작을수록 "말이 되는 수")
       0 프로모션 · 1 캐슬링 · 2 잡기                     → moveRank 그대로
       3 전개(1선에서 꺼내기, 단 중앙 c~f 파일로) · 중앙 폰 전진(c·d·e 파일)
       4 그 밖의 조용한 수 (a·h 가장자리로 나가는 수, 이른 퀸 출동 등)
     ※ 등급은 "점수가 비슷한 후보들 사이의 우선순위"일 뿐이라 실력에는 영향이 없다.
       (점수 차가 후보 폭을 넘으면 애초에 후보에 들지 않는다)
     ※ 이 엔진의 평가는 중앙 폰·전개의 가치를 낮게 보는 편이라, 점수만 믿으면
       초반에 a4·Na6 같은 수가 나온다. 그래서 "중앙으로 나오는 수"를 우선한다.
     ※ 퀸은 4등급 : 나이트·비숍을 먼저 꺼내는 것이 보통 더 좋다(퀸 조기 출동을 피한다). */
  const FILE_CENTER = [0, 1, 2, 3, 3, 2, 1, 0];     // a~h 파일의 중앙도 (d·e 가 3)

  function varietyRank(m) {
    const r = moveRank(m);
    if (r <= 2) return r;
    const t = m.piece & 7;
    const central = FILE_CENTER[m.to & 7];
    if (r === 3 && t !== 5 && central >= 2) return 3;   // 중앙으로 전개
    if (t === 1 && central >= 2) return 3;              // c·d·e 파일로 폰 전진
    return 4;
  }

  // 기물 수 (초반 판단용)
  function pieceCount(rules) {
    const b = rules.board;
    let n = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (!(sq & 0x88) && b[sq]) n++;
    }
    return n;
  }

  /* ----------------------------------------------------------
     반복 심화 : 1수 → 2수 → 3수 … 를 시간이 될 때까지
       · 이전 깊이의 최선수를 맨 앞에 놓아 알파베타가 잘 잘리게 한다
       · 시간이 다 되면 "완료된 마지막 깊이"의 결과를 쓴다
     ---------------------------------------------------------- */
  function searchIterative(rules, moves, maxDepth, timeLimit, repeats, minDepth, variety) {
    const deadline = timeLimit ? Date.now() + timeLimit : 0;
    const floor = Math.min(minDepth || 1, maxDepth || 1);
    const ctx = { nodes: 0, deadline: 0, timeUp: false };
    resetOrderHeuristics();
    let ordered = orderMoves(moves, 0);
    let best = ordered[0], bestScore = -INF, reached = 0;
    let lastRoot = null;                       // 마지막으로 "완료한" 깊이의 루트 결과

    let lastMs = 0;
    for (let d = 1; d <= maxDepth; d++) {
      // 최소 깊이를 채운 뒤부터 시간을 잰다
      //   → 느린 기기에서도 Lv.4 는 4수, Lv.5 는 4수를 보장 (난이도가 뒤집히지 않는다)
      if (d > floor && deadline) {
        const remain = deadline - Date.now();
        // 다음 깊이는 보통 2~4배 오래 걸린다 → 끝낼 가망이 없으면 시작조차 하지 않는다
        if (remain <= 0 || (lastMs > 0 && remain < lastMs * 2)) break;
      }
      ctx.deadline = (d > floor) ? deadline : 0;
      ctx.timeUp = false;

      const t0 = Date.now();
      const res = searchRoot(rules, ordered, d, ctx, repeats);
      lastMs = Date.now() - t0;

      if (res.complete) {
        best = res.move;
        bestScore = res.score;
        reached = d;
        lastRoot = res;
        ordered = [best].concat(ordered.filter(m => m !== best));
      } else if (d === 1) {
        best = res.move;
        reached = 1;
      } else {
        break;                                  // 잘린 반복은 버린다
      }
      if (ctx.timeUp) break;
      if (Math.abs(bestScore) > MATE - 200) break;   // 메이트를 찾았으면 더 볼 필요 없다
    }

    // ── 다양성 (5주차) : 마지막 깊이의 루트 후보들을 정확 점수로 확인한다 ──
    let pool = [best];
    if (lastRoot && variety > 0) {
      // 시간 제한이 있는 난이도는 남은 시간 + 조금만 더 쓴다(응답성 유지)
      const budget = timeLimit ? Math.min(800, Math.max(0, deadline - Date.now()) + 350) : 0;
      pool = varietyPool(rules, lastRoot, reached, variety, repeats, budget);
    }

    return { move: best, score: bestScore, depth: reached, nodes: ctx.nodes, pool: pool };
  }

  const indexOf = sq => ((sq >> 4) * 8 + (sq & 7));
  const nameOf = sq => String.fromCharCode(97 + (sq & 7)) + (8 - (sq >> 4));

  // 기물 코드 → 문자.  ※ 'pnbrqk'[5] 는 'q' 가 아니라 'k' 다.
  //    프로모션 코드는 1부터 시작하므로 배열 인덱스로 쓰면 한 칸씩 밀린다.
  const TYPE_LETTER = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };

  // 힌트용 수 분류 (0 이 가장 "의미 있는" 수)
  function moveRank(m) {
    if (m.promotion) return 0;                                   // 프로모션
    if (m.isCastle) return 1;                                    // 캐슬링
    if (m.captured || m.isEp) return 2;                          // 잡기
    const t = m.piece & 7;
    const backRank = (m.piece & 8) ? 0 : 7;                      // 자기 1선
    if (t >= 2 && t <= 5 && (m.from >> 4) === backRank) return 3; // 기물 전개
    return 4;
  }

  // 결과를 화면에서 쓰기 좋은 형태로
  function describe(rules, m, extra) {
    const out = {
      from: indexOf(m.from),
      to: indexOf(m.to),
      fromName: nameOf(m.from),
      toName: nameOf(m.to),
      promotion: m.promotion ? TYPE_LETTER[m.promotion] : undefined,
      san: rules.san(m),
    };
    if (extra) for (const k in extra) out[k] = extra[k];
    return out;
  }

  /* ==========================================================
     힌트용 : 지정한 깊이의 최선수 (2주차부터 사용)
     ========================================================== */
  function bestMove(fen, depth) {
    depth = depth || 3;
    const rules = new RulesCtor();
    rules.load(fen);
    rules.trackRepetition = false;

    const moves = rules.genLegal();
    if (moves.length === 0) return null;

    // 점수가 비슷한 수들 중에서 고른다.
    // 다만 "의미 있는 수"(프로모션 > 캐슬링 > 잡기 > 전개)를 우선한다.
    //   → 조용한 국면에서 루크를 f1 로 옮기는 것 같은 무의미한 추천을 막는다.
    resetOrderHeuristics();
    const ordered = orderMoves(moves, 0);
    const scored = [];
    const ctx = { nodes: 0, deadline: 0, timeUp: false };
    let best = -INF, alpha = -INF;
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      rules.makeMove(m);
      // 창을 12점만 넓게 잡는다 → 최선수와 12점 안쪽 수는 정확한 점수를 받고,
      //   그보다 나쁜 수는 상한만 받아 빠르게 잘린다 (힌트 후보 풀과 같은 기준).
      const sc = -negamax(rules, depth - 1, -INF, 12 - alpha, ctx, 1);
      rules.undoMove();
      scored.push({ m: m, score: sc });
      if (sc > best) best = sc;
      if (sc > alpha) alpha = sc;
    }

    const top = scored.filter(s => s.score >= best - 12);
    let pool = top;
    for (const r of [0, 1, 2, 3]) {
      const group = top.filter(s => moveRank(s.m) === r);
      if (group.length) { pool = group; break; }
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];

    return describe(rules, pick.m, {
      score: pick.score,
      depth: depth,
      mate: Math.abs(pick.score) > MATE - 200 ? Math.sign(pick.score) : 0,
    });
  }

  /* ==========================================================
     아주 가벼운 오프닝 북 (5주차)
       · "첫 수"와 "그에 대한 첫 응수"만 정석 중에서 고른다.
         → 매 판 다른 오프닝으로 시작하고, 초반에 a4 같은 어색한 수를 두지 않는다.
       · 국면(보드 + 차례)이 정확히 일치할 때만 쓴다 → 다른 국면에는 전혀 영향이 없다.
       · 합법수가 아니면 그냥 무시하고 탐색으로 넘어간다 (안전).
     ========================================================== */
  const sq64 = name => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);

  const BOOK_RAW = {
    // 백의 첫 수
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w':
      ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'e2e3', 'd2d3', 'b1c3', 'g2g3'],
    // 1.e4 에 대한 흑의 응수
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b':
      ['e7e5', 'c7c5', 'e7e6', 'c7c6', 'd7d5', 'g8f6', 'd7d6'],
    // 1.d4
    'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b':
      ['d7d5', 'g8f6', 'e7e6', 'd7d6', 'c7c5'],
    // 1.Nf3
    'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b':
      ['d7d5', 'g8f6', 'c7c5', 'e7e6', 'd7d6'],
    // 1.c4
    'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b':
      ['e7e5', 'c7c5', 'g8f6', 'e7e6', 'c7c6'],
  };

  const BOOK = {};                    // '보드 차례' → [{from, to} …] (64칸 번호)
  for (const k in BOOK_RAW) {
    BOOK[k] = BOOK_RAW[k].map(s => [sq64(s.slice(0, 2)), sq64(s.slice(2, 4))]);
  }

  function bookMove(rules, moves) {
    const key = rules.fen().split(' ').slice(0, 2).join(' ');
    const list = BOOK[key];
    if (!list) return null;
    const cand = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < moves.length; j++) {
        if (indexOf(moves[j].from) === list[i][0] && indexOf(moves[j].to) === list[i][1]) {
          cand.push(moves[j]);
          break;
        }
      }
    }
    if (!cand.length) return null;
    return { move: cand[Math.floor(Math.random() * cand.length)], choices: cand.length };
  }

  /* ==========================================================
     AI용 : 난이도 정책까지 반영한 한 수 (3주차부터 사용)
       5주차 : 같은 점수대(±variety)의 수 중에서 무작위로 골라
               같은 국면에서 매번 같은 수만 두지 않게 했다.
     ========================================================== */
  function chooseMove(fen, level, opts) {
    opts = opts || {};
    const cfg = LEVELS[level] || LEVELS[3];
    const rules = new RulesCtor();
    rules.load(fen);
    rules.trackRepetition = false;

    const moves = rules.genLegal();
    if (moves.length === 0) return null;

    const t0 = Date.now();
    const repeats = opts.repeats || null;

    // (1) 오프닝 북 : 첫 수·첫 응수는 정석 중에서 (매 판 다른 오프닝)
    if (opts.book !== false) {
      const bm = bookMove(rules, moves);
      if (bm) {
        return describe(rules, bm.move, {
          score: 0, depth: 0, nodes: 0, blunder: false,
          book: true, choices: bm.choices, ms: Date.now() - t0,
        });
      }
    }

    // (2) 탐색 : 초반에는 후보 폭을 넓힌다 (매 판 다른 전개)
    const variety = pieceCount(rules) >= 28
      ? Math.max(cfg.variety, OPENING_VARIETY)
      : cfg.variety;

    let res;
    if (cfg.blunder > 0 && Math.random() < cfg.blunder) {
      // 실수 : 합법수 중 아무거나 고른다 (최선수를 놓치는 것 = 초보 실력)
      const pick = moves[Math.floor(Math.random() * moves.length)];
      res = { move: pick, score: 0, depth: 0, nodes: 0, blunder: true, pool: null };
    } else {
      res = searchIterative(rules, moves, cfg.depth, cfg.timeLimit || opts.timeLimit || 0,
                            repeats, cfg.minDepth, variety);
    }

    const pool = res.pool;
    const move = (pool && pool.length > 1) ? pickVariety(pool) : res.move;

    return describe(rules, move, {
      score: res.score,
      depth: res.depth,
      nodes: res.nodes,
      blunder: !!res.blunder,
      choices: pool ? pool.length : 1,      // 이번에 고를 수 있었던 후보 수 (화면 표시용)
      ms: Date.now() - t0,
    });
  }

  /* ==========================================================
     (개발·테스트용) 루트 수 전부의 정확한 점수
       · "고른 수가 최선수와 얼마나 차이나는가"를 검증할 수 있게 해준다
       · 실제 앱에서는 쓰지 않는다 (모든 수를 전체 창으로 탐색 → 느림)
     ========================================================== */
  function rootScores(fen, depth) {
    depth = depth || 3;
    const rules = new RulesCtor();
    rules.load(fen);
    rules.trackRepetition = false;

    const moves = rules.genLegal();
    if (moves.length === 0) return [];

    resetOrderHeuristics();
    const ordered = orderMoves(moves, 0);
    const ctx = { nodes: 0, deadline: 0, timeUp: false };
    const out = [];
    for (let i = 0; i < ordered.length; i++) {
      const m = ordered[i];
      const san = rules.san(m);
      rules.makeMove(m);
      const sc = -negamax(rules, depth - 1, -INF, INF, ctx, 1);
      rules.undoMove();
      out.push({ san: san, from: indexOf(m.from), to: indexOf(m.to), score: sc });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  self.CuteEngine = {
    bestMove: bestMove,       // 힌트
    chooseMove: chooseMove,   // AI (난이도 반영)
    evaluate: evaluate,
    rootScores: rootScores,   // 개발용 : 루트 수 점수표
    LEVELS: LEVELS,
    MATE: MATE,
    VALUE: VALUE,
  };
})();
