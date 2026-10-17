/* ============================================================
   귀여운 체스 — 체스 규칙 엔진 (자체 구현)
   ------------------------------------------------------------
   왜 직접 만들었나
     · chess.js 최신판은 ESM 전용 → file:// 로 열면 동작하지 않음
     · 3주차 AI(미니맥스)는 make/unmake 가 빠른 내부 이동 생성기가 필요
       (chess.js 로 검색을 돌리면 문자열 변환 때문에 매우 느림)
     · 외부 라이선스 0, 전부 읽고 고칠 수 있는 코드

   API 는 chess.js 와 같은 이름으로 맞춰 두었다.
   (moves / move / undo / history / isCheckmate / isStalemate / isDraw / fen / board …)
   → 문제가 생기면 이 파일만 chess.js 로 교체하면 나머지는 그대로 동작한다.

   보드 표현: 0x88 (128칸).  sq = (rank * 16) + file
     · rank 0 = 8단(위), rank 7 = 1단(아래)
     · file 0 = a, file 7 = h        → a8 = 0, h1 = 119, e1 = 116
     · 보드 밖 판정은 (sq & 0x88) 한 번으로 끝난다
   기물: 백 1~6 (P,N,B,R,Q,K), 흑은 +8 (9~14)
   ============================================================ */
(function () {
  'use strict';

  const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  const WHITE = 1, BLACK = 2;
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const TYPE_LETTER = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
  const LETTER_TYPE = { p: P, n: N, b: B, r: R, q: Q, k: K };

  const KNIGHT_OFF = [33, 31, 18, 14, -14, -18, -31, -33];
  const BISHOP_OFF = [17, 15, -15, -17];
  const ROOK_OFF   = [16, -16, 1, -1];
  const KING_OFF   = [17, 16, 15, 1, -1, -15, -16, -17];

  // 캐슬링 권리 비트
  const CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8;

  const colorOf = p => ((p & 8) ? BLACK : WHITE);
  const typeOf  = p => (p & 7);
  const piece   = (t, color) => (color === WHITE ? t : (t | 8));
  const onBoard = sq => ((sq & 0x88) === 0);
  const to64    = sq => ((sq >> 4) * 8 + (sq & 7));
  const to88    = i  => ((i >> 3) * 16 + (i & 7));
  const other   = c  => (c === WHITE ? BLACK : WHITE);

  function sqFromName(name) {
    const f = name.charCodeAt(0) - 97;
    const r = Number(name[1]);
    return (8 - r) * 16 + f;
  }
  function nameFromSq(sq) {
    return String.fromCharCode(97 + (sq & 7)) + (8 - (sq >> 4));
  }

  /* ==========================================================
     생성자
     ========================================================== */
  function Rules(fen) {
    this.reset(fen);
  }

  Rules.prototype.reset = function (fen) {
    this.load(fen || START_FEN);
    return this;
  };

  /* ---------- FEN ---------- */
  Rules.prototype.load = function (fen) {
    const parts = String(fen).trim().split(/\s+/);
    const rows = parts[0].split('/');
    this.board = new Int8Array(128);
    this.kingW = -1;
    this.kingB = -1;
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') { f += Number(ch); continue; }
        const t = LETTER_TYPE[ch.toLowerCase()];
        const color = ch === ch.toUpperCase() ? WHITE : BLACK;
        this.board[r * 16 + f] = piece(t, color);
        if (t === K) { if (color === WHITE) this.kingW = r * 16 + f; else this.kingB = r * 16 + f; }
        f++;
      }
    }
    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    const c = parts[2] || '-';
    this.castling = (c.includes('K') ? CR_WK : 0) | (c.includes('Q') ? CR_WQ : 0) |
                    (c.includes('k') ? CR_BK : 0) | (c.includes('q') ? CR_BQ : 0);
    this.ep = (parts[3] && parts[3] !== '-') ? sqFromName(parts[3]) : -1;
    this.halfmove = parts[4] ? Number(parts[4]) : 0;
    this.fullmove = parts[5] ? Number(parts[5]) : 1;
    this.moveLog = [];     // 공개 move() 로 둔 수 (san 포함)
                           // ※ 이름 주의: this.history 로 두면 프로토타입의 history() 메서드를 가려버린다
    this.stack = [];       // makeMove 되돌리기용
    this.positions = [];   // 3회 반복 판정용 국면 키
    this.trackRepetition = true;   // 검색(perft/AI) 중에는 끈다 → positionKey 문자열 생성 비용 제거
    this.positions.push(this.positionKey());
    return this;
  };

  Rules.prototype.fen = function () {
    let out = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 16 + f];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        const l = TYPE_LETTER[typeOf(p)];
        out += colorOf(p) === WHITE ? l.toUpperCase() : l;
      }
      if (empty) out += empty;
      if (r < 7) out += '/';
    }
    let cast = '';
    if (this.castling & CR_WK) cast += 'K';
    if (this.castling & CR_WQ) cast += 'Q';
    if (this.castling & CR_BK) cast += 'k';
    if (this.castling & CR_BQ) cast += 'q';
    return [out, this.turn === WHITE ? 'w' : 'b', cast || '-',
      this.ep >= 0 ? nameFromSq(this.ep) : '-', this.halfmove, this.fullmove].join(' ');
  };

  // 3회 반복용 국면 키 (앙파상은 "실제로 잡을 수 있을 때만" 반영 → 거짓 반복 방지)
  Rules.prototype.positionKey = function () {
    let s = '';
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) s += String.fromCharCode(48 + this.board[r * 16 + f]);
    }
    const ep = this.epCapturable() ? this.ep : -1;
    return s + '|' + this.turn + '|' + this.castling + '|' + ep;
  };

  Rules.prototype.epCapturable = function () {
    if (this.ep < 0) return false;
    const pawn = piece(P, this.turn);
    const dir = this.turn === WHITE ? -16 : 16;
    // 앙파상 칸을 대각선으로 노릴 수 있는 상대 폰이 있는가
    return ((onBoard(this.ep - dir + 1) && this.board[this.ep - dir + 1] === pawn) ||
            (onBoard(this.ep - dir - 1) && this.board[this.ep - dir - 1] === pawn));
  };

  /* ==========================================================
     렌더링용 64칸 보드 (index 0 = a8)  ← app.js 가 쓰는 형식
     ========================================================== */
  Rules.prototype.board64 = function () {
    const out = new Array(64);
    for (let i = 0; i < 64; i++) {
      const p = this.board[to88(i)];
      out[i] = p ? { type: TYPE_LETTER[typeOf(p)], color: colorOf(p) === WHITE ? 'w' : 'b' } : null;
    }
    return out;
  };

  // chess.js 호환용 이름 (내부 배열은 this.board 이므로 메서드 이름은 board64 로 둔다)
  Rules.prototype.turnChar = function () { return this.turn === WHITE ? 'w' : 'b'; };

  /* ==========================================================
     공격 판정 (체크 판정의 기반)
     ========================================================== */
  Rules.prototype.findKing = function (color) {
    // kingW / kingB 는 makeMove·undoMove 가 유지하는 캐시.
    //   예전에는 여기서 매번 보드를 128칸 훑었는데, 합법수 생성이 수마다
    //   이 함수를 부르는 바람에 검색 시간의 절반 이상을 여기서 썼다.
    const cached = color === WHITE ? this.kingW : this.kingB;
    if (cached >= 0 && this.board[cached] === piece(K, color)) return cached;

    // 안전망 : 캐시가 어긋났으면 다시 센다 (킹을 잡는 불법수가 잠깐 만들어질 때 등)
    const k = piece(K, color);
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      if (this.board[sq] === k) {
        if (color === WHITE) this.kingW = sq; else this.kingB = sq;
        return sq;
      }
    }
    return -1;
  };

  Rules.prototype.isAttacked = function (sq, byColor) {
    const b = this.board;

    // 폰 : 뒤에서 대각선으로 노린다
    const pawn = piece(P, byColor);
    if (byColor === WHITE) {
      if (onBoard(sq + 15) && b[sq + 15] === pawn) return true;
      if (onBoard(sq + 17) && b[sq + 17] === pawn) return true;
    } else {
      if (onBoard(sq - 15) && b[sq - 15] === pawn) return true;
      if (onBoard(sq - 17) && b[sq - 17] === pawn) return true;
    }

    // 나이트
    const kn = piece(N, byColor);
    for (let i = 0; i < 8; i++) {
      const s = sq + KNIGHT_OFF[i];
      if (onBoard(s) && b[s] === kn) return true;
    }

    // 킹
    const kg = piece(K, byColor);
    for (let i = 0; i < 8; i++) {
      const s = sq + KING_OFF[i];
      if (onBoard(s) && b[s] === kg) return true;
    }

    // 슬라이딩 (비숍/퀸, 룩/퀸)
    const bi = piece(B, byColor), qu = piece(Q, byColor), ro = piece(R, byColor);
    for (let i = 0; i < 4; i++) {
      let s = sq + BISHOP_OFF[i];
      while (onBoard(s)) {
        const p = b[s];
        if (p) { if (p === bi || p === qu) return true; break; }
        s += BISHOP_OFF[i];
      }
    }
    for (let i = 0; i < 4; i++) {
      let s = sq + ROOK_OFF[i];
      while (onBoard(s)) {
        const p = b[s];
        if (p) { if (p === ro || p === qu) return true; break; }
        s += ROOK_OFF[i];
      }
    }
    return false;
  };

  Rules.prototype.isCheck = function () {
    const k = this.findKing(this.turn);
    return k >= 0 && this.isAttacked(k, other(this.turn));
  };
  Rules.prototype.in_check = Rules.prototype.isCheck;

  /* ==========================================================
     이동 생성
     ========================================================== */
  Rules.prototype.genPseudo = function () {
    const moves = [];
    const us = this.turn, them = other(us);
    const b = this.board;

    const push = (from, to, opts) => {
      const m = {
        from: from, to: to, piece: b[from], captured: b[to],
        promotion: 0, isEp: false, isCastle: false, isDouble: false,
      };
      if (opts) {
        if (opts.promotion) m.promotion = opts.promotion;
        if (opts.isEp) m.isEp = true;
        if (opts.isCastle) m.isCastle = true;
        if (opts.isDouble) m.isDouble = true;
      }
      moves.push(m);
    };

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = b[sq];
      if (!p || colorOf(p) !== us) continue;
      const t = typeOf(p);

      if (t === P) {
        const dir = us === WHITE ? -16 : 16;
        const startRank = us === WHITE ? 6 : 1;
        const promoRank = us === WHITE ? 0 : 7;
        const one = sq + dir;

        if (onBoard(one) && !b[one]) {
          if ((one >> 4) === promoRank) {
            for (const pr of [Q, R, B, N]) push(sq, one, { promotion: pr });
          } else {
            push(sq, one);
            const two = sq + dir * 2;
            if ((sq >> 4) === startRank && !b[two]) push(sq, two, { isDouble: true });
          }
        }
        for (const df of [-1, 1]) {
          const d = one + df;
          if (!onBoard(d)) continue;
          const tp = b[d];
          if (tp && colorOf(tp) === them) {
            if ((d >> 4) === promoRank) {
              for (const pr of [Q, R, B, N]) push(sq, d, { promotion: pr });
            } else push(sq, d);
          } else if (!tp && d === this.ep) {
            push(sq, d, { isEp: true });
          }
        }
      } else if (t === N || t === K) {
        const offs = t === N ? KNIGHT_OFF : KING_OFF;
        for (let i = 0; i < 8; i++) {
          const s = sq + offs[i];
          if (!onBoard(s)) continue;
          const tp = b[s];
          if (tp && colorOf(tp) === us) continue;
          push(sq, s);
        }
      } else {
        const offs = t === B ? BISHOP_OFF : (t === R ? ROOK_OFF : KING_OFF);
        for (let i = 0; i < offs.length; i++) {
          let s = sq + offs[i];
          while (onBoard(s)) {
            const tp = b[s];
            if (!tp) push(sq, s);
            else { if (colorOf(tp) === them) push(sq, s); break; }
            s += offs[i];
          }
        }
      }
    }

    // 캐슬링 (킹/룩이 제자리에 있고, 사이가 비었고, 지나가는 칸이 공격받지 않을 때)
    if (us === WHITE) {
      if ((this.castling & CR_WK) && !b[117] && !b[118] &&
          b[116] === piece(K, WHITE) && b[119] === piece(R, WHITE) &&
          !this.isAttacked(116, them) && !this.isAttacked(117, them) && !this.isAttacked(118, them)) {
        push(116, 118, { isCastle: true });
      }
      if ((this.castling & CR_WQ) && !b[115] && !b[114] && !b[113] &&
          b[116] === piece(K, WHITE) && b[112] === piece(R, WHITE) &&
          !this.isAttacked(116, them) && !this.isAttacked(115, them) && !this.isAttacked(114, them)) {
        push(116, 114, { isCastle: true });
      }
    } else {
      if ((this.castling & CR_BK) && !b[5] && !b[6] &&
          b[4] === piece(K, BLACK) && b[7] === piece(R, BLACK) &&
          !this.isAttacked(4, them) && !this.isAttacked(5, them) && !this.isAttacked(6, them)) {
        push(4, 6, { isCastle: true });
      }
      if ((this.castling & CR_BQ) && !b[3] && !b[2] && !b[1] &&
          b[4] === piece(K, BLACK) && b[0] === piece(R, BLACK) &&
          !this.isAttacked(4, them) && !this.isAttacked(3, them) && !this.isAttacked(2, them)) {
        push(4, 2, { isCastle: true });
      }
    }

    return moves;
  };

  // 합법수 = 의사 합법수 중, 두고 나서 자기 킹이 잡히지 않는 수
  // onlyCaptures=true 면 잡기/앙파상/프로모션만 검사한다 (정적 탐색 전용, 속도용)
  Rules.prototype.genLegal = function (onlyCaptures) {
    const out = [];
    const us = this.turn;
    for (const m of this.genPseudo()) {
      if (onlyCaptures && !(m.captured || m.isEp || m.promotion)) continue;
      this.makeMove(m);
      const k = this.findKing(us);
      if (k < 0 || !this.isAttacked(k, other(us))) out.push(m);
      this.undoMove();
    }
    return out;
  };

  /* ==========================================================
     make / unmake
     ========================================================== */
  Rules.prototype.makeMove = function (m) {
    const us = colorOf(m.piece), them = other(us);
    const b = this.board;

    this.stack.push({
      move: m, castling: this.castling, ep: this.ep,
      halfmove: this.halfmove, capturedSq: -1, captured: 0,
    });

    // 앙파상으로 잡히는 폰은 도착 칸이 아니라 옆 칸에 있다
    if (m.isEp) {
      const capSq = us === WHITE ? m.to + 16 : m.to - 16;
      this.stack[this.stack.length - 1].capturedSq = capSq;
      this.stack[this.stack.length - 1].captured = b[capSq];
      b[capSq] = 0;
    }

    b[m.to] = m.promotion ? piece(m.promotion, us) : m.piece;
    b[m.from] = 0;

    // 킹 위치 캐시 (findKing 용)
    const movingType = typeOf(m.piece);
    if (movingType === K) { if (us === WHITE) this.kingW = m.to; else this.kingB = m.to; }
    if (m.captured && typeOf(m.captured) === K) { if (them === WHITE) this.kingW = -1; else this.kingB = -1; }

    // 캐슬링 : 룩도 같이 옮긴다
    if (m.isCastle) {
      let rf, rt;
      if (m.to === 118) { rf = 119; rt = 117; }      // 백 킹사이드  h1 → f1
      else if (m.to === 114) { rf = 112; rt = 115; } // 백 퀸사이드  a1 → d1
      else if (m.to === 6) { rf = 7; rt = 5; }       // 흑 킹사이드  h8 → f8
      else { rf = 0; rt = 3; }                       // 흑 퀸사이드  a8 → d8
      b[rt] = b[rf];
      b[rf] = 0;
    }

    // 캐슬링 권리 갱신
    const t = typeOf(m.piece);
    if (t === K) this.castling &= (us === WHITE ? ~(CR_WK | CR_WQ) : ~(CR_BK | CR_BQ));
    if (m.from === 119 || m.to === 119) this.castling &= ~CR_WK;
    if (m.from === 112 || m.to === 112) this.castling &= ~CR_WQ;
    if (m.from === 7   || m.to === 7)   this.castling &= ~CR_BK;
    if (m.from === 0   || m.to === 0)   this.castling &= ~CR_BQ;

    // 앙파상 칸 (실제로 잡을 수 있을 때만 기록 → FEN 규칙과 동일)
    //   상대 폰은 "2칸 전진한 폰의 옆 칸"(= m.to ± 1)에 있어야 앙파상으로 잡을 수 있다.
    //   (처음엔 앙파상 칸 옆칸을 봤는데, 그건 한 줄 위라서 항상 빈 칸이었다 → perft 로 발견)
    this.ep = -1;
    if (m.isDouble) {
      const enemyPawn = piece(P, them);
      if ((onBoard(m.to + 1) && b[m.to + 1] === enemyPawn) ||
          (onBoard(m.to - 1) && b[m.to - 1] === enemyPawn)) this.ep = (m.from + m.to) / 2;
    }

    // 50수 규칙 : 폰 이동/잡기가 없으면 카운트
    this.halfmove = (t === P || m.captured || m.isEp) ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;

    this.turn = them;
    if (this.trackRepetition) this.positions.push(this.positionKey());
    return m;
  };

  Rules.prototype.undoMove = function () {
    const h = this.stack.pop();
    if (!h) return null;
    const m = h.move;
    const us = colorOf(m.piece);
    const b = this.board;

    if (this.trackRepetition && this.positions.length > 1) this.positions.pop();

    b[m.from] = m.piece;
    b[m.to] = 0;

    if (h.capturedSq >= 0) b[h.capturedSq] = h.captured;
    else if (h.move.captured) b[m.to] = h.move.captured;   // makeMove 에서 저장해 둔 원래 기물

    if (m.isCastle) {
      let rf, rt;
      if (m.to === 118) { rf = 119; rt = 117; }
      else if (m.to === 114) { rf = 112; rt = 115; }
      else if (m.to === 6) { rf = 7; rt = 5; }
      else { rf = 0; rt = 3; }
      b[rf] = b[rt];
      b[rt] = 0;
    }

    this.castling = h.castling;
    this.ep = h.ep;
    this.halfmove = h.halfmove;
    if (us === BLACK) this.fullmove--;

    // 킹 위치 캐시 복구
    if (typeOf(m.piece) === K) { if (us === WHITE) this.kingW = m.from; else this.kingB = m.from; }
    if (h.move.captured && typeOf(h.move.captured) === K) {
      const them = other(us);
      if (them === WHITE) this.kingW = m.to; else this.kingB = m.to;
    }

    this.turn = us;
    return m;
  };

  /* ==========================================================
     대수 표기법 (SAN)
     ========================================================== */
  const LETTER = { 1: '', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K' };

  Rules.prototype.sanBase = function (m) {
    const t = typeOf(m.piece);
    const isKingside = (m.to === 118 || m.to === 6);
    if (m.isCastle) return isKingside ? 'O-O' : 'O-O-O';

    let s = LETTER[t];
    if (t === P) {
      // 폰은 파일을 먼저 쓰고 x 를 붙인다 (exd5). 아래의 공통 'x' 처리는 기물용이다.
      if (m.captured || m.isEp) s = String.fromCharCode(97 + (m.from & 7)) + 'x';
    } else {
      // 같은 기물이 같은 칸으로 갈 수 있으면 파일/랭크로 구분
      const same = this.genLegal().filter(x =>
        x.to === m.to && x.from !== m.from && typeOf(x.piece) === t && colorOf(x.piece) === colorOf(m.piece));
      if (same.length) {
        const sameFile = same.some(x => (x.from & 7) === (m.from & 7));
        const sameRank = same.some(x => (x.from >> 4) === (m.from >> 4));
        if (!sameFile) s += String.fromCharCode(97 + (m.from & 7));
        else if (!sameRank) s += (8 - (m.from >> 4));
        else s += nameFromSq(m.from);
      }
      if (m.captured || m.isEp) s += 'x';
    }
    s += nameFromSq(m.to);
    if (m.promotion) s += '=' + LETTER[m.promotion];
    return s;
  };

  Rules.prototype.san = function (m) {
    const base = this.sanBase(m);
    this.makeMove(m);
    let suffix = '';
    if (this.isCheck()) suffix = (this.genLegal().length === 0) ? '#' : '+';
    this.undoMove();
    return base + suffix;
  };

  /* ==========================================================
     공개 API (chess.js 와 같은 이름)
     ========================================================== */
  Rules.prototype.moves = function (opts) {
    opts = opts || {};
    let list = this.genLegal();
    if (opts.square) {
      const sq = typeof opts.square === 'number' ? to88(opts.square) : sqFromName(opts.square);
      list = list.filter(m => m.from === sq);
    }
    if (opts.verbose) {
      return list.map(m => ({
        from: nameFromSq(m.from),
        to: nameFromSq(m.to),
        fromIndex: to64(m.from),
        toIndex: to64(m.to),
        piece: TYPE_LETTER[typeOf(m.piece)],
        color: colorOf(m.piece) === WHITE ? 'w' : 'b',
        captured: m.captured ? TYPE_LETTER[typeOf(m.captured)] : (m.isEp ? 'p' : undefined),
        promotion: m.promotion ? TYPE_LETTER[m.promotion] : undefined,
        isEp: m.isEp,
        isCastle: m.isCastle,
        isCapture: !!(m.captured || m.isEp),
        san: this.sanBase(m),
      }));
    }
    return list.map(m => this.sanBase(m));
  };

  Rules.prototype.move = function (input) {
    const from = typeof input.from === 'number' ? to88(input.from) : sqFromName(input.from);
    const to = typeof input.to === 'number' ? to88(input.to) : sqFromName(input.to);
    const promo = input.promotion ? LETTER_TYPE[String(input.promotion).toLowerCase()] : 0;

    const list = this.genLegal().filter(m => m.from === from && m.to === to);
    if (!list.length) return null;
    const m = list.length === 1 ? list[0] : (list.find(x => x.promotion === promo) || list[0]);

    const san = this.san(m);
    this.makeMove(m);
    const info = {
      from: nameFromSq(m.from), to: nameFromSq(m.to), san: san,
      captured: m.captured ? TYPE_LETTER[typeOf(m.captured)] : (m.isEp ? 'p' : undefined),
      promotion: m.promotion ? TYPE_LETTER[m.promotion] : undefined,
      isEp: m.isEp, isCastle: m.isCastle,
    };
    this.moveLog.push(info);
    return info;
  };

  Rules.prototype.undo = function () {
    if (!this.moveLog.length) return null;
    this.moveLog.pop();
    this.undoMove();
    return this;
  };

  Rules.prototype.history = function (opts) {
    return opts && opts.verbose ? this.moveLog.slice() : this.moveLog.map(h => h.san);
  };

  /* ---------- 상태 판정 ---------- */
  Rules.prototype.isCheckmate = function () {
    return this.isCheck() && this.genLegal().length === 0;
  };
  Rules.prototype.in_checkmate = Rules.prototype.isCheckmate;

  Rules.prototype.isStalemate = function () {
    return !this.isCheck() && this.genLegal().length === 0;
  };
  Rules.prototype.in_stalemate = Rules.prototype.isStalemate;

  Rules.prototype.isInsufficientMaterial = function () {
    const rest = [];
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = this.board[sq];
      if (!p) continue;
      const t = typeOf(p);
      if (t === K) continue;
      rest.push({ t: t, color: colorOf(p), light: (((sq >> 4) + (sq & 7)) % 2) === 0 });
    }
    if (rest.length === 0) return true;                                  // 킹 대 킹
    if (rest.length === 1) return rest[0].t === N || rest[0].t === B;     // 킹+나이트 / 킹+비숍
    if (rest.length === 2 && rest[0].t === B && rest[1].t === B &&
        rest[0].color !== rest[1].color && rest[0].light === rest[1].light) return true;  // 같은 색 비숍
    return false;
  };
  Rules.prototype.insufficient_material = Rules.prototype.isInsufficientMaterial;

  Rules.prototype.isThreefold = function () {
    const key = this.positionKey();
    let n = 0;
    for (let i = 0; i < this.positions.length; i++) if (this.positions[i] === key) n++;
    return n >= 3;
  };
  Rules.prototype.in_threefold_repetition = Rules.prototype.isThreefold;

  Rules.prototype.isFiftyMove = function () { return this.halfmove >= 100; };

  Rules.prototype.isDraw = function () {
    return this.isStalemate() || this.isInsufficientMaterial() ||
           this.isThreefold() || this.isFiftyMove();
  };
  Rules.prototype.in_draw = Rules.prototype.isDraw;

  Rules.prototype.isGameOver = function () { return this.isCheckmate() || this.isDraw(); };
  Rules.prototype.game_over = Rules.prototype.isGameOver;

  // 결과를 사람이 읽을 수 있게 정리 (종료가 아니면 null)
  Rules.prototype.result = function () {
    if (this.isCheckmate()) {
      return { type: 'checkmate', winner: this.turn === WHITE ? 'b' : 'w', reason: '체크메이트' };
    }
    if (this.isStalemate()) return { type: 'draw', reason: '스테일메이트' };
    if (this.isThreefold()) return { type: 'draw', reason: '3회 반복' };
    if (this.isInsufficientMaterial()) return { type: 'draw', reason: '기물 부족' };
    if (this.isFiftyMove()) return { type: 'draw', reason: '50수 규칙' };
    return null;
  };

  /* ---------- 체크 상태인 쪽의 킹 위치 (하이라이트용) ---------- */
  Rules.prototype.kingSquare64 = function (color) {
    const sq = this.findKing(color === 'w' ? WHITE : BLACK);
    return sq < 0 ? -1 : to64(sq);
  };

  /* ==========================================================
     perft : 규칙 정확성 검증용 (표준 기준값과 비교)
     ========================================================== */
  Rules.prototype.perft = function (depth) {
    // 검색 중에는 반복 국면 추적을 끈다 (속도)
    const prev = this.trackRepetition;
    this.trackRepetition = false;
    const n = this.perft_(depth);
    this.trackRepetition = prev;
    return n;
  };

  Rules.prototype.perft_ = function (depth) {
    if (depth === 0) return 1;
    const list = this.genLegal();
    if (depth === 1) return list.length;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      this.makeMove(list[i]);
      n += this.perft_(depth - 1);
      this.undoMove();
    }
    return n;
  };

  Rules.START_FEN = START_FEN;
  self.Rules = Rules;          // self 로 둔다 → 일반 페이지(window===self)와 Web Worker 양쪽에서 동작
})();
