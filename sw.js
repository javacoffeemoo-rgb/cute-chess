/* ============================================================
   귀여운 체스 — 서비스 워커 (4주차)
   ------------------------------------------------------------
   목적
     · 오프라인에서도 실행 (비행기 모드 · 지하철)
     · 홈 화면에 추가하면 앱처럼 실행 (manifest.webmanifest 와 함께)
   전략
     · 화면(navigate) 요청   : 네트워크 우선 → 실패하면 캐시  (업데이트가 바로 보임)
     · 그 밖의 같은 출처 GET : 캐시 먼저 보여주고 뒤에서 갱신 (stale-while-revalidate)
     · 캐시 키에서 ?t=123 같은 쿼리는 떼어낸다 (개발 중 캐시 폭탄 방지)
   주의
     · file:// 에서는 서비스 워커가 동작하지 않는다 (app.js 가 http(s) 에서만 등록)
     · 규칙/AI 엔진 파일이 바뀌면 VERSION 을 올린다 → 옛 캐시는 activate 에서 삭제된다
   ============================================================ */
'use strict';

const VERSION = 'cute-chess-v1.3';   // 파일이 바뀌면 여기를 올린다 → 옛 캐시는 자동 삭제
const CACHE = VERSION;

// 앱 껍데기 : 이 파일들만 있으면 오프라인에서도 한 판을 둘 수 있다
const SHELL = [
  './',
  './index.html',
  './style.css',
  './pieces.js',
  './app.js',
  './engine/rules.js',
  './engine/search.js',
  './engine/ai-worker.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/* ---------- 설치 : 껍데기를 미리 담아 둔다 ---------- */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 한 파일이 실패해도 설치는 끝나게 한다(addAll 은 하나만 실패해도 전부 실패한다)
    await Promise.all(SHELL.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

/* ---------- 활성화 : 옛 버전 캐시 정리 ---------- */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('cute-chess-') && k !== CACHE)
                          .map(k => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (e) {}
    }
    await self.clients.claim();
  })());
});

// 캐시 키를 안정적으로 만든다 (?t=... 제거)
function cacheKey(request) {
  const url = new URL(request.url);
  url.search = '';
  return url.href;
}

/* ---------- 요청 처리 ---------- */
self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 외부(폰트 CDN 등)는 건드리지 않는다

  // 1) 화면 이동 : 네트워크 우선 (온라인이면 항상 최신, 오프라인이면 캐시)
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(cacheKey(req), fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match(cacheKey(req)))
            || (await cache.match('./index.html'))
            || new Response('오프라인입니다. 한 번 접속한 뒤에는 오프라인에서도 실행됩니다.',
                            { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // 2) 그 밖의 자원 : 캐시 먼저 (빠르고, 오프라인에서도 동작) → 뒤에서 조용히 갱신
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = cacheKey(req);
    const cached = await cache.match(key);

    const network = fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => null);

    if (cached) return cached;                 // 즉시 응답 (뒤에서 갱신 중)
    const res = await network;
    if (res) return res;
    return new Response('', { status: 504, statusText: 'offline' });
  })());
});

/* ---------- 앱에서 보내는 메시지 (개발/디버그용) ---------- */
self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'skip-waiting') self.skipWaiting();
  if (msg.type === 'version' && event.source) event.source.postMessage({ type: 'version', version: VERSION });
});
