/* ============================================================
   귀여운 체스 — 기물 SVG 정의
   ------------------------------------------------------------
   · 외부 라이선스 없이 자체 제작 (viewBox 0 0 100 100)
   · "치비" 비율 : 큰 얼굴 + 작은 몸 + 넓은 받침
   · 얼굴 요소    : 눈 + 눈 반짝임 + 볼터치 + 미소
   · 나이트만 옆얼굴(한쪽 눈 큼)로 형태를 구분
   · 색은 style.css 의 CSS 변수로 흑/백 전환
       --body(몸통) --line(외곽선) --eye(눈) --shine(반짝임) --blush(볼)
   ------------------------------------------------------------
   이 파일은 index.html 과 dev/piece-sheet.html 에서 함께 쓴다.
   ============================================================ */
(function () {
  'use strict';

  // 모든 기물이 공유하는 아래쪽 부품
  const BASE   = '<rect class="f" x="21" y="79" width="58" height="12" rx="6"/>';
  const SKIRT  = '<path class="f" d="M36 58 L64 58 C66 68 71 74 73 79 L27 79 C29 74 34 68 36 58 Z"/>';
  const COLLAR = '<rect class="f" x="37" y="52" width="26" height="9" rx="4.5"/>';

  /* ------------------------------------------------------------
     얼굴 부품 — "귀여움"은 여기서 결정된다
     · 눈    : 크게(가로 4.0 / 세로 4.4) + 반짝임 2개(큰 것 좌상단, 작은 것 우하단)
               반짝임 2개가 카와이 표정의 핵심. 큰 것만 있으면 그냥 동그란 눈이 된다.
     · 볼    : 가로로 넓은 타원 (둥근 원보다 훨씬 귀엽다)
     · 입    : 고양이 입(ω) — 위로 볼록한 호 2개
     ------------------------------------------------------------ */
  const head = (cy, r) => `<circle class="f" cx="50" cy="${cy}" r="${r}"/>`;

  const eyes = (cy, dx, rx, ry) => {
    dx = dx || 7.8; rx = rx || 4.0; ry = ry || 4.4;
    const one = cx =>
      `<ellipse class="d" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>` +
      `<ellipse class="s" cx="${(cx - rx * 0.36).toFixed(1)}" cy="${(cy - ry * 0.44).toFixed(1)}" rx="${(rx * 0.44).toFixed(2)}" ry="${(ry * 0.42).toFixed(2)}"/>` +
      `<ellipse class="s" cx="${(cx + rx * 0.44).toFixed(1)}" cy="${(cy + ry * 0.46).toFixed(1)}" rx="${(rx * 0.22).toFixed(2)}" ry="${(ry * 0.21).toFixed(2)}"/>`;
    return one(50 - dx) + one(50 + dx);
  };

  const eye1 = (cx, cy, rx, ry) =>
    `<ellipse class="d" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>` +
    `<ellipse class="s" cx="${(cx - rx * 0.36).toFixed(1)}" cy="${(cy - ry * 0.44).toFixed(1)}" rx="${(rx * 0.44).toFixed(2)}" ry="${(ry * 0.42).toFixed(2)}"/>` +
    `<ellipse class="s" cx="${(cx + rx * 0.44).toFixed(1)}" cy="${(cy + ry * 0.46).toFixed(1)}" rx="${(rx * 0.22).toFixed(2)}" ry="${(ry * 0.21).toFixed(2)}"/>`;

  const blush = (cy, dx) => {
    dx = dx || 12.5;
    return `<ellipse class="bl" cx="${50 - dx}" cy="${cy}" rx="4.3" ry="2.9"/>` +
           `<ellipse class="bl" cx="${50 + dx}" cy="${cy}" rx="4.3" ry="2.9"/>`;
  };

  // 고양이 입 : 아래로 볼록한 호 2개 (◡◡) → 웃는 표정
  const mouth = (cy) => `<path class="st" d="M44 ${cy} q3 4 6 0 q3 4 6 0"/>`;

  const PIECE_SVG = {
    /* 폰 : 삐죽 머리카락 + 맨 얼굴, 제일 동글동글 */
    p: () => BASE + SKIRT + COLLAR +
      '<path class="f" d="M48 24 C47 17 51 12 56 10 C54 16 53 20 52 24 Z"/>' +   // 삐죽머리
      head(40, 19.5) + eyes(38) + blush(46, 13) + mouth(47),

    /* 루크 : 둥근 성벽 모자 + 문 사이 보석 */
    r: () => BASE + SKIRT + COLLAR +
      '<path class="f" d="M29 37 L29 24 C29 21 31 19 34 19 L37 19 L37 28 L45 28 L45 19 L55 19 L55 28 L63 28 L63 19 L66 19 C69 19 71 21 71 24 L71 37 Z"/>' +
      head(45, 18) +
      '<circle class="gm" cx="50" cy="21.5" r="2.4"/>' +
      eyes(43) + blush(50) + mouth(52),

    /* 나이트 : 옆얼굴 조랑말 (주둥이 돌출 + 귀 + 갈기 2줄) */
    n: () => BASE + SKIRT + COLLAR +
      '<path class="f" d="' +
      'M30 62 C25 52 26 36 35 28 ' +          // 목 뒤 → 정수리
      'C40 23 46 20 51 21 ' +                  // 정수리
      'C51 14 54 9 58 9 ' +                    // 귀 올라가기
      'C62 13 63 20 61 24 ' +                  // 귀 내려오기
      'C67 27 73 33 76 41 ' +                  // 이마 → 콧등
      'C79 48 80 52 77 55 ' +                  // 주둥이 끝
      'C73 58 66 57 60 54 ' +                  // 입 → 턱
      'C54 51 50 52 45 56 ' +                  // 목
      'C41 59 39 62 40 62 Z"/>' +              // 가슴
      '<path class="mn" d="M45 26 C37 31 32 40 31 51"/>' +   // 갈기 1
      '<path class="mn" d="M53 27 C48 30 45 34 44 39"/>' +   // 갈기 2
      eye1(63, 39, 4.6, 5.0) +
      '<circle class="d" cx="73" cy="50" r="1.7"/>' +        // 콧구멍
      '<ellipse class="bl" cx="52" cy="50" rx="4" ry="2.7"/>' +  // 볼
      '<path class="st" d="M74 51 q-5 3 -9 1"/>',            // 입

    /* 비숍 : 뾰족 모자 + 꼭대기 보석 + 세로 홈 */
    b: () => BASE + SKIRT +
      '<path class="f" d="M50 13 C60 24 70 34 70 44 C70 51 64 55 57 55 L43 55 C36 55 30 51 30 44 C30 34 40 24 50 13 Z"/>' +
      '<path class="st" d="M50 20 L50 32"/>' +
      head(45, 18) +
      '<circle class="gm" cx="50" cy="9" r="4.2"/>' +
      eyes(43) + blush(50) + mouth(52),

    /* 퀸 : 뾰족 왕관 5개 + 보석 5개 */
    q: () => BASE + SKIRT +
      '<path class="f" d="M31 34 L31 20 L36 26 L41 14 L45 25 L50 12 L55 25 L59 14 L64 26 L69 20 L69 34 Z"/>' +
      head(45, 18) +
      '<circle class="gm" cx="31" cy="19" r="3.4"/><circle class="gm" cx="41" cy="13" r="3.4"/><circle class="gm" cx="50" cy="11" r="3.4"/>' +
      '<circle class="gm" cx="59" cy="13" r="3.4"/><circle class="gm" cx="69" cy="19" r="3.4"/>' +
      eyes(43) + blush(50) + mouth(52),

    /* 킹 : 십자가 왕관 + 십자가 한가운데 보석 */
    k: () => BASE + SKIRT +
      '<rect class="f" x="46.5" y="4" width="7" height="18" rx="3"/>' +
      '<rect class="f" x="39" y="9" width="22" height="7" rx="3"/>' +
      '<rect class="f" x="30" y="20" width="40" height="15" rx="5"/>' +
      head(45, 18) +
      '<circle class="gm" cx="50" cy="12.5" r="3"/>' +
      eyes(43) + blush(50) + mouth(52),
  };

  function pieceHTML(type, color) {
    return '<svg class="piece ' + color + '" viewBox="0 0 100 100" aria-hidden="true">' +
      PIECE_SVG[type]() + '</svg>';
  }

  window.CutePieces = { pieceHTML: pieceHTML, PIECE_SVG: PIECE_SVG };
})();
