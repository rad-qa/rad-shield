// ════════════════════════════════════════════════════════════
// RAD Shield — Service Worker（PWA 離線支援）
// ════════════════════════════════════════════════════════════

const CACHE_NAME = 'rad-shield-v4';

// 需要快取的檔案（離線時仍可開啟）
const CACHE_FILES = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap'
];

// ── 安裝：快取所有靜態檔案 ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_FILES).catch(err => {
        console.warn('部分檔案快取失敗（可忽略）:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── 啟動：清除舊版快取 ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── 請求攔截策略 ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Apps Script API 請求：永遠走網路（不快取）
  if (url.hostname === 'script.google.com') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Google Fonts：網路優先，失敗才用快取
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 其他靜態資源：快取優先，背景更新
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      }).catch(() => null);

      return cached || fetchPromise;
    })
  );
});
