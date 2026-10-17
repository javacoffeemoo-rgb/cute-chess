/* ============================================================
   귀여운 체스 — AI 두뇌 (Web Worker)
   ------------------------------------------------------------
   왜 Worker 인가
     Lv.4~5 는 1초 넘게 생각한다. 메인 스레드에서 돌리면
     그 동안 화면이 얼어붙어(입력·애니메이션 정지) 폰에서는
     "앱이 멈춘 것"처럼 보인다. Worker 로 분리하면 화면은 살아 있다.

   통신
     ← { type:'search', id, fen, level, repeats }
     → { type:'move', id, move, depth, nodes, ms }
        move = null 이면 둘 수 있는 수가 없다(체크메이트/스테일메이트)

   로딩
     importScripts('rules.js', 'search.js')
       · 경로는 이 파일(engine/ai-worker.js) 기준 → engine/rules.js
       · 두 파일 모두 window / self 에 붙이므로 여기서도 그대로 보인다
   ============================================================ */
'use strict';

importScripts('rules.js', 'search.js');

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type !== 'search') return;

  const t0 = Date.now();
  let move = null;
  let error = null;

  try {
    move = self.CuteEngine.chooseMove(msg.fen, msg.level, {
      repeats: msg.repeats || null,
      timeLimit: msg.timeLimit || 0,
    });
  } catch (ex) {
    error = String((ex && ex.message) || ex);
  }

  self.postMessage({
    type: 'move',
    id: msg.id,
    move: move,
    depth: move ? move.depth : 0,          // 앱이 "5수까지 탐색 · 12,345국면 · 1543ms" 로 보여준다
    nodes: move ? move.nodes : 0,
    blunder: move ? !!move.blunder : false,
    book: move ? !!move.book : false,       // 5주차 : 오프닝 북에서 고른 수
    choices: move ? (move.choices || 1) : 1,// 5주차 : 고를 수 있었던 후보 수
    error: error,
    ms: Date.now() - t0,
  });
};

// Worker 가 살아 있음을 알린다 (앱이 "폴백 필요" 판단에 사용)
self.postMessage({ type: 'ready' });
