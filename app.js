/* ============================================================
   귀여운 체스  —  3주차 구현
   ------------------------------------------------------------
   [1주차]  보드 · 기물 · 터치 조작(탭/드래그) · 별명 · 설정 저장
   [2주차]
     · 정식 규칙 엔진 연결 (engine/rules.js)
       체크 · 체크메이트 · 스테일메이트 · 캐슬링 · 앙파상 · 프로모션
       무승부(스테일메이트 / 3회 반복 / 50수 / 기물 부족)
     · 대수 표기법(SAN) 기보  (Nf3, exd5, O-O, e8=Q+, Qxf7#)
     · 힌트 (engine/search.js : 미니맥스 + 알파베타)
     · 프로모션 선택 팝업 / 체크 표시 / 위험한 칸 경고
     · 결과 화면 (승 · 무 · 이동 수 · 소요 시간) / 가로 화면 대응
   [3주차]  ← 지금 이 파일
     · AI 대전 : Web Worker(engine/ai-worker.js)에서 생각한다
       → 생각하는 동안에도 화면이 얼지 않는다 (입력 잠금 + "생각 중…" 표시)
     · 난이도 5단계를 실제로 적용 (탐색 깊이 · 실수 확률 · 시간 제한)
     · 진영 선택 (백 = 먼저 둠 / 흑 = AI가 먼저 둠). 흑을 고르면 보드가 뒤집힌다
     · 승 / 패 / 무 결과를 "내 진영" 기준으로 표시
     · 되돌리기는 내 수 + AI 수를 한 쌍으로 되돌린다
     · 반복 국면 회피 (무승부로 흘러가는 것 방지)
   [4주차]  ← 지금 이 파일
     · 대국 자동 저장 / 이어하기  (앱을 닫아도 판이 남는다)
     · 효과음 — 외부 파일 없이 WebAudio 로 직접 만든 소리
     · PWA — 서비스 워커 등록(오프라인) + 홈 화면에 추가 버튼

   규칙의 "단일 진실 공급원"은 state.rules 다.
   state.board 는 렌더링을 위해 rules 에서 매번 파생시킨다(syncFromRules).
   ============================================================ */

(function () {
  'use strict';

  const pieceHTML = window.CutePieces.pieceHTML;
  const Rules = window.Rules;
  const Engine = window.CuteEngine;

  /* ==========================================================
     1. 상수
     ========================================================== */
  const FILES = 'abcdefgh';
  const LEVEL_NAME = { 1: '쉬움', 2: '조금 쉬움', 3: '보통', 4: '어려움', 5: '아주 어려움' };
  const LEVEL_DESC = {
    1: '1수 앞만 보고, 절반은 최선수를 놓쳐요. 체스를 처음 배울 때 좋아요.',
    2: '2수 앞을 봐요. 가끔 실수하니 입문 연습에 좋아요.',
    3: '3수 앞을 봐요. 실수가 거의 없어요.',
    4: '4수 앞을 보고 기물 교환을 정확히 계산해요.',
    5: '1.2초 동안 될 만큼 깊이 봐요(보통 5~6수). 반칙은 하지 않아요.',
  };
  const PIECE_LABEL = { q: '퀸', r: '루크', b: '비숍', n: '나이트' };
  const HINT_DEPTH = 3;        // 힌트 탐색 깊이 (3수 = 나-상대-나)

  const NICK_ADJ = ['졸린', '용감한', '귀여운', '배고픈', '엉뚱한', '빛나는', '장난꾸러기', '느긋한', '씩씩한'];
  const NICK_NOUN = ['폰', '나이트', '비숍', '루크', '퀸', '킹', '체스병아리'];

  const SETTINGS_KEY = 'cuteChess.settings';
  const PROFILE_KEY  = 'cuteChess.profile';
  const SESSION_KEY  = 'cuteChess.current';   // 진행 중인 대국 (4주차)

  const DEFAULT_SETTINGS = {
    theme: 'pastel', level: 3, playerColor: 'w',
    coords: true, legal: true, danger: true, vibrate: true, sound: true,
  };

  const sqIndex = name => (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - 97);

  /* ==========================================================
     2. 상태
     ========================================================== */
  const state = {
    rules: new Rules(),      // ← 규칙의 단일 진실 공급원
    board: [],               // 렌더링용 64칸 (rules 에서 파생)
    turn: 'w',
    selected: null,
    targets: new Map(),      // 칸 index -> 'move' | 'capture'
    lastMove: null,
    flipped: false,
    started: false,
    popSquare: null,         // 이동 직후 "뿅" 애니메이션 (한 번 쓰고 비움)
    hint: null,              // {from, to, san}
    pending: null,           // 프로모션 대기 {from, to}
    result: null,            // {type, winner?, reason}
    danger: [],              // 위험한 칸 index 목록
    thinking: false,         // AI가 생각하는 중 (입력 잠금)
    aiInfo: null,            // 마지막 AI 탐색 정보 {depth, nodes, ms}
    clock: 0,
    timerId: null,
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let profile = { nickname: '' };

  // 내 진영 / AI 진영 ('w' | 'b')
  const myColor = () => (settings.playerColor === 'b' ? 'b' : 'w');
  const aiColor = () => (myColor() === 'w' ? 'b' : 'w');

  /* ==========================================================
     3. 저장 / 불러오기 (localStorage)
     ========================================================== */
  function loadStorage() {
    try { settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch (e) { settings = Object.assign({}, DEFAULT_SETTINGS); }
    try { profile = Object.assign({ nickname: '' }, JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}')); }
    catch (e) { profile = { nickname: '' }; }
  }
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
  function saveProfile()  { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) {} }

  function randomNickname() {
    const a = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)];
    const n = NICK_NOUN[Math.floor(Math.random() * NICK_NOUN.length)];
    return `${a} ${n}`;
  }

  /* ==========================================================
     4. DOM 참조
     ========================================================== */
  const $ = id => document.getElementById(id);
  const boardEl     = $('board');
  const dragLayer   = $('drag-layer');
  const movelistEl  = $('movelist');
  const statusEl    = $('status');
  const clockEl     = $('clock');
  const meNameEl    = $('me-name');
  const plateMeEl   = $('plate-me');
  const plateOppEl  = $('plate-opp');
  const oppNameEl   = $('opp-name');
  const oppBadgeEl  = $('opp-badge');
  const turnBadgeEl = $('turn-badge');
  const gameTitleEl = $('game-title');
  const levelChips  = $('level-chips');
  const levelHint   = $('level-hint');
  const sideChips   = $('side-chips');
  const themeChips  = $('theme-chips');
  const nicknameEl  = $('nickname');
  const resumeCard  = $('resume-card');
  const resumeInfo  = $('resume-info');
  const installBtn  = $('btn-install');
  const netNote     = $('net-note');

  function showModal(id) { $(id).classList.add('show'); }
  function hideModal(id) { $(id).classList.remove('show'); }
  function closeModals() { hideModal('promo-modal'); hideModal('result-modal'); }

  /* ==========================================================
     5. 게임 시작 / 규칙 → 화면 상태 동기화
     ========================================================== */
  function newGame() {
    AI.cancel();                       // 이전 판의 "생각 중" 응답은 버린다
    clearSession();                    // 새 판을 시작하면 저장된 대국은 무효 (4주차)
    state.rules.reset();
    state.selected = null;
    state.targets = new Map();
    state.flipped = myColor() === 'b';   // 흑을 고르면 내 기물이 아래로 오게 뒤집는다
    state.started = true;
    state.popSquare = null;
    state.hint = null;
    state.pending = null;
    state.result = null;
    state.thinking = false;
    state.aiInfo = null;
    closeModals();
    clockEl.classList.remove('done');
    startClock();
    render();
    maybeAI();                         // 내가 흑이면 AI(백)가 먼저 둔다
  }

  // 규칙 엔진의 상태를 화면용 상태로 옮긴다
  function syncFromRules() {
    state.board = state.rules.board64();
    state.turn = state.rules.turnChar();
    const hist = state.rules.history({ verbose: true });
    const last = hist[hist.length - 1];
    state.lastMove = last ? { from: sqIndex(last.from), to: sqIndex(last.to) } : null;
  }

  /* ==========================================================
     6. 이동 가능 칸 (규칙 엔진이 계산한 "합법수"만)
     ========================================================== */
  function computeTargets(from) {
    const out = new Map();
    for (const m of state.rules.moves({ square: from, verbose: true })) {
      out.set(m.toIndex, m.isCapture ? 'capture' : 'move');
    }
    return out;
  }

  function selectSquare(i) {
    state.selected = i;
    state.targets = computeTargets(i);
  }
  function clearSelection() {
    state.selected = null;
    state.targets = new Map();
  }

  /* ==========================================================
     7. 위험한 칸 (상대가 잡을 수 있는데 지켜지지 않는 내 기물)
        · isAttacked 만 쓰는 간단한 근사치라 핀은 고려하지 않는다
     ========================================================== */
  function computeDanger() {
    if (!settings.danger || state.result || !state.started) return [];
    const rules = state.rules;
    const us = rules.turn, them = (us === 1 ? 2 : 1);
    const mineChar = us === 1 ? 'w' : 'b';
    const out = [];
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (!p || p.color !== mineChar) continue;
      const sq88 = (i >> 3) * 16 + (i & 7);
      if (rules.isAttacked(sq88, them) && !rules.isAttacked(sq88, us)) out.push(i);
    }
    return out;
  }

  /* ==========================================================
     8. 렌더링
     ========================================================== */
  function render() {
    syncFromRules();
    state.danger = computeDanger();

    boardEl.className = 'board' +
      (settings.coords ? '' : ' hide-coords') +
      (settings.legal ? '' : ' hide-legal');

    const checkIdx = (state.rules.isCheck() && !state.result)
      ? state.rules.kingSquare64(state.turn) : -1;

    let html = '';
    for (let pos = 0; pos < 64; pos++) {
      const i = state.flipped ? 63 - pos : pos;
      const dispRow = pos >> 3, dispCol = pos % 8;
      const f = i % 8, r = i >> 3;
      const isLight = ((f + r) % 2 === 0);

      const cls = ['square', isLight ? 'light' : 'dark'];
      if (state.lastMove && (state.lastMove.from === i || state.lastMove.to === i)) cls.push('last');
      if (state.selected === i) cls.push('sel');
      if (state.popSquare === i) cls.push('pop');
      if (state.danger.indexOf(i) >= 0) cls.push('danger');
      const t = state.targets.get(i);
      if (t === 'move') cls.push('can-move');
      if (t === 'capture') cls.push('capture');

      html += `<div class="${cls.join(' ')}" data-i="${i}">`;
      if (settings.coords) {
        if (dispRow === 7) html += `<span class="coord file">${FILES[f]}</span>`;
        if (dispCol === 0) html += `<span class="coord rank">${8 - r}</span>`;
      }
      if (t === 'move') html += '<span class="dot"></span>';
      const piece = state.board[i];
      if (piece) html += pieceHTML(piece.type, piece.color);
      if (i === checkIdx) html += '<span class="check-ring"></span>';
      if (state.hint && (state.hint.from === i || state.hint.to === i)) html += '<span class="hint-ring"></span>';
      html += '</div>';
    }
    boardEl.innerHTML = html;

    state.popSquare = null;          // "뿅" 애니메이션은 한 번만

    renderPlayers();
    renderMoveList();

    // AI가 생각하는 동안에는 입력을 막는다 (되돌리기/힌트도 잠금)
    const busy = !!state.thinking;
    $('btn-undo').disabled = busy || state.rules.history().length === 0;
    $('btn-hint').disabled = busy;
  }

  function renderPlayers() {
    const nick = profile.nickname || '나';
    const me = myColor();
    const myTurn = state.turn === me;

    meNameEl.textContent = nick;
    oppNameEl.textContent = `AI Lv.${settings.level}`;
    gameTitleEl.textContent = `AI 대전 · Lv.${settings.level} ${LEVEL_NAME[settings.level]}`;

    // 상대 : 생각 중이면 뱃지가 바뀐다
    oppBadgeEl.textContent = state.thinking
      ? '생각 중…'
      : `Lv.${settings.level} ${LEVEL_NAME[settings.level]}`;
    plateOppEl.classList.toggle('thinking', !!state.thinking);
    if (state.aiInfo && !state.thinking) {
      const ai = state.aiInfo;
      const cand = ai.choices > 1 ? ` · 후보 ${ai.choices}가지` : '';
      plateOppEl.title = ai.book
        ? `오프닝 북에서 골랐어요${cand}`
        : `${ai.depth}수까지 탐색`
          + (ai.nodes ? ` · ${ai.nodes.toLocaleString()}국면` : '')
          + ` · ${ai.ms}ms${cand}${ai.blunder ? ' · 일부러 실수' : ''}`;
    } else {
      plateOppEl.title = '';
    }

    plateMeEl.classList.toggle('active', myTurn && !state.result);
    plateOppEl.classList.toggle('active', !myTurn && !state.result);
    turnBadgeEl.textContent = state.result ? '대국 종료' : (myTurn ? '내 차례' : '상대 차례');

    if (state.result) {
      statusEl.textContent = state.result.type === 'checkmate'
        ? (state.result.winner === me ? '🎉 내가 이겼어요!' : '😵 내가 졌어요')
        : `무승부 · ${state.result.reason}`;
      return;
    }
    if (state.thinking) {
      statusEl.textContent = `🤖 AI가 생각 중이에요…`;
      return;
    }
    if (state.hint) { statusEl.textContent = `💡 추천 수 : ${state.hint.san}`; return; }

    const mySide = me === 'w' ? '백' : '흑';
    const oppSide = me === 'w' ? '흑' : '백';
    const who = myTurn ? `${nick} (${mySide})` : `AI (${oppSide})`;
    statusEl.textContent = state.rules.isCheck() ? `체크! ${who} 차례` : `${who} 차례`;
  }

  function renderMoveList() {
    const hist = state.rules.history();       // 대수 표기법(SAN)
    if (!hist.length) {
      movelistEl.innerHTML = '<span class="mv">아직 둔 수가 없어요. 기물을 눌러 보세요.</span>';
      return;
    }
    let html = '';
    for (let i = 0; i < hist.length; i += 2) {
      html += `<span class="mv no">${i / 2 + 1}.</span>`;
      html += `<span class="mv${i === hist.length - 1 ? ' now' : ''}">${hist[i]}</span>`;
      if (hist[i + 1] !== undefined) {
        html += `<span class="mv${i + 1 === hist.length - 1 ? ' now' : ''}">${hist[i + 1]}</span>`;
      }
    }
    movelistEl.innerHTML = html;
    movelistEl.scrollLeft = movelistEl.scrollWidth;
  }

  /* ==========================================================
     9. 이동 실행
     ========================================================== */
  function vibrate(ms) {
    if (!settings.vibrate) return;
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  // 사용자가 "여기로" 라고 고른 칸이 합법수인지 확인하고 실행한다
  function doMove(from, to) {
    if (state.thinking || state.result) return;         // AI가 생각 중이면 무시
    if (state.turn !== myColor()) return;               // 내 차례가 아니면 무시
    const cands = state.rules.moves({ square: from, verbose: true })
      .filter(m => m.toIndex === to);
    if (!cands.length) return;

    if (cands[0].promotion) {                  // 프로모션 : 어떤 기물로 바꿀지 물어본다
      state.pending = { from: from, to: to };
      openPromo(cands[0].color);
      return;
    }
    applyMove(from, to);
  }

  function applyMove(from, to, promotion) {
    const info = state.rules.move({ from: from, to: to, promotion: promotion });
    if (!info) return;

    state.hint = null;
    state.pending = null;
    clearSelection();
    state.popSquare = to;
    vibrate(info.captured || info.isEp ? 26 : 12);

    // 효과음 (4주차) : 캐슬링 / 잡기 / 보통 이동
    if (info.isCastle) SOUND.play('castle');
    else if (info.captured || info.isEp) SOUND.play('capture');
    else SOUND.play('move');

    const res = state.rules.result();
    if (res) {
      state.result = res;
      stopClock();
      clockEl.classList.add('done');
    } else if (state.rules.isCheck()) {
      vibrate(30);
      setTimeout(() => SOUND.play('check'), 120);
    }

    render();
    if (res) {
      clearSession();                            // 끝난 대국은 이어할 필요가 없다
      SOUND.play(res.type === 'checkmate' ? (res.winner === myColor() ? 'win' : 'lose') : 'draw');
      openResult(res);
      return;
    }
    saveSession();                               // 여기까지의 대국을 저장 (4주차)
    maybeAI();                                   // 다음이 AI 차례면 이어서 둔다
  }

  // AI 대전에서는 "내 수 + AI 수"를 한 쌍으로 되돌린다.
  //  한 번만 되돌리면 차례가 상대에게 넘어가 내가 둘 수 없기 때문이다.
  function undo() {
    if (!state.rules.history().length) return;
    AI.cancel();                             // 생각 중이던 수는 버린다
    state.thinking = false;

    state.rules.undo();
    if (state.rules.history().length && state.rules.turnChar() !== myColor()) {
      state.rules.undo();
    }

    state.hint = null;
    state.pending = null;
    if (state.result) {                      // 종료 후 되돌리면 대국을 계속한다
      state.result = null;
      clockEl.classList.remove('done');
      closeModals();
    }
    resumeClock();
    clearSelection();
    vibrate(8);
    SOUND.play('undo');
    render();
    saveSession();                           // 되돌린 상태를 그대로 저장 (4주차)
    maybeAI();                               // 첫 수까지 되돌렸다면 AI가 다시 둔다
  }

  /* ==========================================================
     10. 시계
     ========================================================== */
  function fmtClock(sec) {
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }
  function renderClock() { clockEl.textContent = fmtClock(state.clock); }
  function resumeClock() {
    if (state.timerId) return;
    state.timerId = setInterval(() => { state.clock++; renderClock(); }, 1000);
  }
  function stopClock() {
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
  }
  function startClock() {
    stopClock();
    state.clock = 0;
    renderClock();
    resumeClock();
  }

  /* ==========================================================
     11. 힌트 (engine/search.js)
     ========================================================== */
  function showHint() {
    if (state.result || !state.started || state.thinking) return;
    if (state.turn !== myColor()) {          // AI 차례에는 힌트를 줄 수 없다
      statusEl.textContent = '상대 차례에는 힌트를 쓸 수 없어요';
      return;
    }
    if (state.hint) {                        // 한 번 더 누르면 힌트 끄기
      state.hint = null;
      clearSelection();
      render();
      return;
    }
    const mv = Engine.bestMove(state.rules.fen(), HINT_DEPTH);
    if (!mv) return;
    state.hint = mv;
    selectSquare(mv.from);                   // 추천 기물을 바로 선택해 준다
    vibrate(10);
    render();
  }

  /* ==========================================================
     11-B. AI 대전 (3주차)
        · 무거운 계산은 Web Worker 에서 → 화면이 얼지 않는다
        · Worker 를 못 쓰는 환경(file:// 등)은 메인 스레드로 자동 폴백
        · 요청마다 번호를 매겨, 되돌리기/새 게임 후 도착한 늦은 응답은 버린다
     ========================================================== */
  const AI = (function () {
    let worker = null;
    let mode = 'main';          // 'worker' | 'main'
    let seq = 0;
    let pending = {};

    function init() {
      if (typeof Worker === 'undefined') return;
      try {
        worker = new Worker('engine/ai-worker.js');
        worker.onmessage = onMessage;
        worker.onerror = () => {             // Worker 차단 환경 → 조용히 폴백
          try { if (worker) worker.terminate(); } catch (e) {}
          worker = null;
          mode = 'main';
        };
        mode = 'worker';
      } catch (e) {
        worker = null;
        mode = 'main';
      }
    }

    function onMessage(e) {
      const msg = e.data || {};
      if (msg.type === 'ready') return;
      const cb = pending[msg.id];
      delete pending[msg.id];
      if (cb) cb(msg.move, msg);
    }

    function think(fen, level, cb) {
      const id = ++seq;
      const repeats = recentPositionKeys();

      if (worker) {
        const t0 = Date.now();
        pending[id] = (move, meta) => {
          if (id !== seq) return;            // 이미 무효가 된 요청
          cb(move, {
            depth: meta.depth, nodes: meta.nodes, ms: Date.now() - t0,
            blunder: meta.blunder, book: meta.book, choices: meta.choices,
          });
        };
        worker.postMessage({ type: 'search', id: id, fen: fen, level: level, repeats: repeats });
        return;
      }

      // 폴백 : 화면에 "생각 중"을 먼저 그릴 틈을 준다(계산이 시작되면 화면이 멈춘다)
      const t0 = Date.now();
      setTimeout(() => {
        if (id !== seq) return;
        let move = null;
        try {
          move = Engine.chooseMove(fen, level, { repeats: repeats });
        } catch (err) { move = null; }
        cb(move, move ? {
          depth: move.depth, nodes: move.nodes, ms: Date.now() - t0,
          blunder: move.blunder, book: move.book, choices: move.choices,
        } : null);
      }, 40);
    }

    function cancel() { seq++; pending = {}; }

    return { init: init, think: think, cancel: cancel, get mode() { return mode; } };
  })();

  // 3회 반복으로 흘러가지 않도록, 이미 나온 국면 키를 AI에게 알려준다
  function recentPositionKeys() {
    const keys = state.rules.positions;
    if (!keys || !keys.length) return null;
    return keys.slice(-48);
  }

  // AI 차례면 생각을 시작한다
  function maybeAI() {
    if (!state.started || state.result || state.pending || state.thinking) return;
    if (state.turn !== aiColor()) return;
    if (!state.rules.genLegal().length) return;        // 둘 수 있는 수가 없다

    state.thinking = true;
    state.hint = null;
    render();                                          // "생각 중…"을 먼저 보여준다

    AI.think(state.rules.fen(), settings.level, (mv, meta) => {
      state.thinking = false;
      state.aiInfo = meta || null;
      if (!mv || state.result || !state.started) { render(); return; }
      applyMove(mv.from, mv.to, mv.promotion);
    });
  }

  /* ==========================================================
     11-C. 효과음 (4주차)
       · 외부 음원 파일을 쓰지 않고 WebAudio 로 직접 만든다
         → 오프라인(PWA)에서도 소리가 나고, 저작권 문제도 없다
       · 모바일은 "사용자 동작" 없이 소리를 못 낸다 → 첫 터치에서 깨운다(AudioContext.resume)
       · 소리 크기는 작게, 길이는 짧게 (연속으로 둬도 시끄럽지 않게)
     ========================================================== */
  const SOUND = (function () {
    let ac = null;

    function ctx() {
      if (ac) return ac;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ac = new AC(); } catch (e) { ac = null; }
      return ac;
    }

    // 사용자 동작 안에서 호출해야 소리가 살아난다
    function unlock() {
      const a = ctx();
      if (a && a.state === 'suspended') { try { a.resume(); } catch (e) {} }
    }

    // 기본 음 : 사인/삼각파 + 짧은 엔벨로프(딸깍 소리 방지)
    function tone(freq, dur, o) {
      o = o || {};
      const a = ctx();
      if (!a) return;
      const t0 = a.currentTime + (o.at || 0);
      const osc = a.createOscillator();
      const g = a.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
      const vol = (o.gain === undefined ? 0.13 : o.gain);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(a.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.04);
    }

    const SFX = {
      move:    () => tone(560, 0.085, { type: 'triangle', gain: 0.12 }),
      capture: () => { tone(320, 0.11, { type: 'square', gain: 0.09 });
                       tone(180, 0.15, { gain: 0.12, at: 0.035 }); },
      castle:  () => { tone(440, 0.09, { gain: 0.11 });
                       tone(620, 0.11, { gain: 0.10, at: 0.085 }); },
      check:   () => { tone(880, 0.09, { gain: 0.12 });
                       tone(1180, 0.13, { gain: 0.10, at: 0.095 }); },
      win:     () => [523, 659, 784, 1047].forEach((f, i) =>
                       tone(f, 0.18, { type: 'triangle', gain: 0.13, at: i * 0.12 })),
      lose:    () => [392, 330, 262].forEach((f, i) =>
                       tone(f, 0.22, { gain: 0.12, at: i * 0.16 })),
      draw:    () => { tone(494, 0.16, { gain: 0.11 });
                       tone(494, 0.20, { gain: 0.11, at: 0.19 }); },
      undo:    () => tone(400, 0.10, { type: 'triangle', gain: 0.09, to: 290 }),
    };

    function play(name) {
      if (!settings.sound || !SFX[name]) return;
      const a = ctx();
      if (!a) return;
      if (a.state === 'suspended') { try { a.resume(); } catch (e) {} }
      try { SFX[name](); } catch (e) {}
    }

    return { play: play, unlock: unlock };
  })();

  /* ==========================================================
     11-D. 대국 저장 / 이어하기 (4주차)
       · FEN 만 저장하면 기보·3회 반복 판정이 사라진다
         → "둔 수 목록"을 저장하고 이어할 때 처음부터 다시 둔다(리플레이).
           그러면 기보(SAN) · 캐슬링 권리 · 앙파상 · 반복 판정이 모두 원래대로 복원된다
       · 매 수마다 저장하고, 끝난 대국은 지운다
     ========================================================== */
  const SESSION_VERSION = 1;

  // 현재까지 둔 수 (이어할 때 그대로 재생할 수 있는 형태)
  function moveList() {
    return state.rules.history({ verbose: true }).map(h => {
      const m = { from: h.from, to: h.to };
      if (h.promotion) m.promotion = h.promotion;
      return m;
    });
  }

  function saveSession() {
    if (!state.started || state.result) return;
    const moves = moveList();
    if (!moves.length) { clearSession(); return; }   // 아직 둔 수가 없으면 저장할 게 없다
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        v: SESSION_VERSION,
        moves: moves,
        level: settings.level,
        playerColor: myColor(),
        elapsed: state.clock,
        savedAt: Date.now(),
      }));
    } catch (e) {}
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function savedSession() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { s = null; }
    if (!s || s.v !== SESSION_VERSION || !Array.isArray(s.moves) || !s.moves.length) return null;
    return s;
  }

  // 저장된 대국을 "처음부터 다시 두어" 복원한다
  function resumeSession() {
    const s = savedSession();
    if (!s) return false;

    AI.cancel();
    state.rules.reset();
    for (const m of s.moves) {
      if (!state.rules.move({ from: m.from, to: m.to, promotion: m.promotion })) {
        state.rules.reset();                            // 어중간하게 되감긴 판을 남기지 않는다
        clearSession();                                 // 저장이 깨졌다 → 버린다
        return false;
      }
    }

    if (s.playerColor === 'w' || s.playerColor === 'b') settings.playerColor = s.playerColor;
    if (s.level >= 1 && s.level <= 5) settings.level = s.level;
    saveSettings();

    state.selected = null;
    state.targets = new Map();
    state.flipped = myColor() === 'b';
    state.started = true;
    state.popSquare = null;
    state.hint = null;
    state.pending = null;
    state.result = null;
    state.thinking = false;
    state.aiInfo = null;
    closeModals();
    clockEl.classList.remove('done');

    stopClock();
    state.clock = Math.max(0, Math.floor(Number(s.elapsed) || 0));
    renderClock();
    resumeClock();

    render();
    syncHomeUI();
    maybeAI();                     // 저장 시점이 AI 차례였다면 AI가 이어서 둔다
    return true;
  }

  /* ==========================================================
     12. 프로모션 / 결과 팝업
     ========================================================== */
  function openPromo(color) {
    $('promo-row').innerHTML = ['q', 'r', 'b', 'n'].map(t =>
      `<button class="promo-btn" type="button" data-promo="${t}">
         ${pieceHTML(t, color)}
         <span class="plabel">${PIECE_LABEL[t]}</span>
       </button>`).join('');
    showModal('promo-modal');
  }

  function openResult(res) {
    const nick = profile.nickname || '나';
    const me = myColor();
    const hist = state.rules.history();
    const lv = `AI Lv.${settings.level}`;

    let emoji, title, sub;
    if (res.type === 'checkmate') {
      const iWon = res.winner === me;
      emoji = iWon ? '🎉' : '😵';
      title = iWon ? `${nick} 승리!` : `${lv} 승리`;
      sub = iWon ? `체크메이트 · ${lv}의 킹을 잡았어요` : '체크메이트 · 내 킹이 잡혔어요';
    } else {
      emoji = '🤝';
      title = '무승부';
      sub = `${res.reason} · ${lv}`;
    }

    $('result-emoji').textContent = emoji;
    $('result-title').textContent = title;
    $('result-reason').textContent = sub;
    $('result-moves').textContent = `${Math.ceil(hist.length / 2)}수`;
    $('result-time').textContent = fmtClock(state.clock);
    showModal('result-modal');
  }

  /* ==========================================================
     13. 터치 조작 (탭-탭 + 드래그)
         - 탭-탭 : 기물 탭 → 도착칸 탭
         - 드래그 : 기물을 끌어서 놓기
         - 포인터 이벤트로 통일(마우스/터치 동일)
     ========================================================== */
  let drag = null;

  boardEl.addEventListener('pointerdown', e => {
    if (!state.started || state.result || state.pending || state.thinking) return;
    // 이전 제스처가 유실됐다면(포인터가 화면 밖에서 떼임 등) 복구
    if (drag && drag.id !== e.pointerId) drag = null;
    if (drag) return;
    const cell = e.target.closest('.square');
    if (!cell) return;
    const i = Number(cell.dataset.i);

    // (1) 선택된 기물의 이동 가능 칸을 탭 → 그 자리로 이동
    if (state.selected !== null && state.targets.has(i)) {
      doMove(state.selected, i);
      return;
    }

    const piece = state.board[i];
    // 내 기물만 잡을 수 있다 (AI 진영 기물을 대신 두는 것을 막는다)
    if (piece && piece.color === state.turn && piece.color === myColor()) {
      const already = state.selected === i;
      selectSquare(i);
      render();
      drag = { from: i, id: e.pointerId, x: e.clientX, y: e.clientY, active: false, already: already };
      try { boardEl.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    // (2) 빈 칸 / 상대 기물 탭 → 선택 해제
    clearSelection();
    render();
  });

  // move / up / cancel 은 window 에서 받는다.
  // → 렌더링으로 DOM 이 교체되거나, 손가락이 보드 밖에서 떼지거나, 터치가 취소돼도
  //    drag 상태가 절대 남지 않는다(보드 잠김 방지).
  window.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 8) return;      // 살짝 움직임은 탭으로 처리
      startGhost(drag.from);
      drag.active = true;
    }
    moveGhost(e.clientX, e.clientY);
  });

  function endDrag(e) {
    if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    const d = drag;
    drag = null;

    if (d.active) {
      removeGhost();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cell = el && el.closest ? el.closest('.square') : null;
      if (cell) {
        const i = Number(cell.dataset.i);
        if (state.targets.has(i)) { doMove(d.from, i); return; }
      }
      render();                                 // 이동 실패 → 선택 유지
      return;
    }

    // 탭으로 끝남 : 이미 선택돼 있던 기물을 다시 탭하면 선택 해제
    if (d.already) { clearSelection(); render(); }
  }

  function cancelDrag() {
    if (!drag) return;
    const wasActive = drag.active;
    drag = null;
    removeGhost();
    if (wasActive) render();
  }

  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('blur', cancelDrag);

  function startGhost(from) {
    const piece = state.board[from];
    if (!piece) return;
    const rect = boardEl.getBoundingClientRect();
    const size = rect.width / 8;
    const cell = boardEl.querySelector(`.square[data-i="${from}"]`);
    if (cell) cell.classList.add('dragging');

    const ghost = document.createElement('div');
    ghost.className = 'ghost';
    ghost.style.width = size + 'px';
    ghost.style.height = size + 'px';
    ghost.innerHTML = pieceHTML(piece.type, piece.color);
    dragLayer.appendChild(ghost);
  }
  function moveGhost(x, y) {
    const ghost = dragLayer.firstElementChild;
    if (!ghost) return;
    ghost.style.left = x + 'px';
    ghost.style.top = y + 'px';
  }
  function removeGhost() {
    dragLayer.innerHTML = '';
    boardEl.querySelectorAll('.square.dragging').forEach(el => el.classList.remove('dragging'));
  }

  /* ==========================================================
     14. 홈 화면 UI
     ========================================================== */
  function buildLevelChips() {
    levelChips.innerHTML = [1, 2, 3, 4, 5].map(lv =>
      `<button class="chip${lv === settings.level ? ' active' : ''}" type="button" data-level="${lv}">Lv.${lv} ${LEVEL_NAME[lv]}</button>`
    ).join('');
    levelHint.textContent = `Lv.${settings.level} ${LEVEL_NAME[settings.level]} — ${LEVEL_DESC[settings.level]}`;
  }

  const TOGGLES = [
    ['tg-coords', 'coords'],
    ['tg-legal', 'legal'],
    ['tg-danger', 'danger'],
    ['tg-sound', 'sound'],
    ['tg-vibrate', 'vibrate'],
  ];

  // 이어하기 카드 : 저장된 대국이 있을 때만 보인다 (4주차)
  function syncResumeCard() {
    const s = savedSession();
    if (!s) { resumeCard.hidden = true; return; }
    const moves = Math.ceil(s.moves.length / 2);
    const who = s.playerColor === 'b' ? '흑' : '백';
    resumeInfo.textContent =
      `AI Lv.${s.level} · ${who} · ${moves}수 · ${fmtClock(Math.floor(s.elapsed || 0))}`;
    resumeCard.hidden = false;
  }

  // 오프라인 표시 (4주차) : 인터넷이 없어도 캐시로 실행된다는 걸 알려준다
  function syncNetNote() {
    netNote.hidden = navigator.onLine !== false;
  }

  function syncHomeUI() {
    nicknameEl.value = profile.nickname || '';
    if (!profile.nickname) nicknameEl.placeholder = randomNickname();
    document.documentElement.dataset.theme = settings.theme;
    themeChips.querySelectorAll('.chip').forEach(c =>
      c.classList.toggle('active', c.dataset.themeValue === settings.theme));
    sideChips.querySelectorAll('.chip').forEach(c =>
      c.classList.toggle('active', c.dataset.side === myColor()));
    TOGGLES.forEach(([id, key]) => {
      const el = $(id);
      el.classList.toggle('on', !!settings[key]);
      el.setAttribute('aria-checked', String(!!settings[key]));
    });
    buildLevelChips();
    syncResumeCard();
    syncNetNote();
  }

  levelChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    settings.level = Number(chip.dataset.level);
    saveSettings();
    buildLevelChips();
  });

  sideChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    settings.playerColor = chip.dataset.side;
    saveSettings();
    syncHomeUI();
  });

  themeChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    settings.theme = chip.dataset.themeValue;
    saveSettings();
    syncHomeUI();
    if (state.started) render();
  });

  TOGGLES.forEach(([id, key]) => {
    $(id).addEventListener('click', () => {
      settings[key] = !settings[key];
      saveSettings();
      syncHomeUI();
      if (state.started) render();
    });
  });

  $('btn-random-name').addEventListener('click', () => {
    profile.nickname = randomNickname();
    nicknameEl.value = profile.nickname;
    saveProfile();
  });

  nicknameEl.addEventListener('input', () => {
    const v = nicknameEl.value.trim().slice(0, 12);
    profile.nickname = v;
    saveProfile();
  });

  /* ==========================================================
     15. 화면 전환 / 버튼
     ========================================================== */
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  }

  $('btn-start').addEventListener('click', () => {
    let nick = nicknameEl.value.trim().slice(0, 12);
    if (!nick) { nick = randomNickname(); nicknameEl.value = nick; }
    profile.nickname = nick;
    saveProfile();
    showScreen('screen-game');
    newGame();
  });

  // 이어하기 / 삭제 (4주차)
  $('btn-resume').addEventListener('click', () => {
    showScreen('screen-game');
    if (!resumeSession()) {                 // 저장이 깨졌다면 새 판으로
      syncHomeUI();
      newGame();
    }
  });

  $('btn-discard').addEventListener('click', () => {
    clearSession();
    SOUND.play('undo');
    syncResumeCard();
  });

  // 홈 화면에 추가 (안드로이드 크롬이 beforeinstallprompt 를 줄 때만 버튼이 보인다)
  $('btn-install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (e) {}
    installPrompt = null;
    installBtn.hidden = true;
  });

  $('btn-back').addEventListener('click', () => {
    AI.cancel();
    state.thinking = false;
    saveSession();                          // 나가기 전에 경과 시간까지 저장 (4주차)
    state.started = false;
    stopClock();
    closeModals();
    showScreen('screen-home');
    syncHomeUI();
  });

  $('btn-reset').addEventListener('click', () => {
    clearSelection();
    newGame();
  });

  $('btn-undo').addEventListener('click', undo);
  $('btn-hint').addEventListener('click', showHint);

  $('btn-flip').addEventListener('click', () => {
    state.flipped = !state.flipped;
    render();
  });

  // 프로모션 선택
  $('promo-row').addEventListener('click', e => {
    const btn = e.target.closest('.promo-btn');
    if (!btn || !state.pending) return;
    const p = state.pending;
    hideModal('promo-modal');
    applyMove(p.from, p.to, btn.dataset.promo);
  });

  $('btn-promo-cancel').addEventListener('click', () => {
    state.pending = null;
    hideModal('promo-modal');
    clearSelection();
    render();
  });

  // 결과 팝업
  $('btn-again').addEventListener('click', () => { clearSelection(); newGame(); });
  $('btn-home').addEventListener('click', () => {
    AI.cancel();
    state.thinking = false;
    state.started = false;
    stopClock();
    closeModals();
    showScreen('screen-home');
    syncHomeUI();
  });

  /* ==========================================================
     16. 시작
     ========================================================== */
  loadStorage();
  AI.init();
  syncHomeUI();
  renderClock();
  if (!localStorage.getItem(PROFILE_KEY)) nicknameEl.placeholder = randomNickname();

  // 첫 터치에서 소리를 깨운다 (모바일 자동재생 차단 대응)
  window.addEventListener('pointerdown', () => SOUND.unlock(), { once: true });
  $('btn-start').addEventListener('click', () => SOUND.unlock(), { once: true });

  // 화면 높이 변화(주소창 접힘 / 가로↔세로) 대응
  window.addEventListener('resize', () => { if (state.started) render(); });
  window.addEventListener('orientationchange', () => { setTimeout(() => { if (state.started) render(); }, 220); });

  /* ---------- 4주차 · PWA ---------- */

  // 홈 화면에 추가 버튼 (크롬이 설치 가능하다고 알려줄 때만 나타난다)
  let installPrompt = null;

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    installBtn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installBtn.hidden = true;
  });

  // 서비스 워커 : 오프라인에서도 실행되게 한다.
  //  · http(s) 에서만 동작한다(file:// 는 브라우저가 막는다)
  //  · 실패해도 게임은 그대로 동작한다(조용히 넘어간다)
  let swReady = null;
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      swReady = navigator.serviceWorker.register('sw.js').catch(() => null);
    });
  }

  // 앱이 백그라운드로 갈 때도 저장 (시간이 흐른 뒤 바로 닫는 경우 대비)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSession();
  });
  window.addEventListener('pagehide', () => saveSession());

  // 인터넷 연결이 끊기거나 돌아오면 홈 화면에 표시를 바꾼다 (4주차)
  window.addEventListener('online', syncNetNote);
  window.addEventListener('offline', syncNetNote);

  // 개발용 확인 훅 (자동 테스트에서 사용)
  window.__cuteChess = {
    get state() { return state; },
    get settings() { return settings; },
    get profile() { return profile; },
    rules: state.rules,
    newGame: newGame,
    play: applyMove,                       // applyMove(from, to, promotion?)
    doMoveByTap: doMove,
    undo: undo,
    hint: showHint,
    select: selectSquare,
    render: render,
    fen: () => state.rules.fen(),
    // 3주차
    ai: AI,
    maybeAI: maybeAI,
    myColor: myColor,
    aiColor: aiColor,
    engine: Engine,
    // 4주차
    sound: SOUND,
    saveSession: saveSession,
    savedSession: savedSession,
    resumeSession: resumeSession,
    clearSession: clearSession,
    syncHomeUI: syncHomeUI,
    get sw() { return swReady; },
  };
})();
