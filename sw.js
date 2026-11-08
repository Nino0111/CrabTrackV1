// ══════════════════════════════════════════════════════════
// sw.js — CrabTrack service worker
// ══════════════════════════════════════════════════════════
// This is what makes CrabTrack an installable app that still opens
// when the Pi is unreachable or there's no Wi-Fi at all.
//
// Two different caching strategies, on purpose:
//   • The app shell (HTML/CSS/JS/icons) → cache-first. Opens instantly,
//     works with zero network.
//   • API calls (/api/...)              → network-first, cache as fallback.
//     You always get fresh sensor values when the Pi is reachable, and
//     the LAST KNOWN readings when it isn't, instead of a blank screen.
//
// Bump CACHE_VERSION whenever you change any shell file, or browsers
// will keep serving the old one.

const CACHE_VERSION = 'crabtrack-v5-captured-analytics';   // v5: analytics charts use persisted scheduled weight captures
const SHELL = [
  './',
  'index.html',
  'nodes.html',
  'admin.html',
  'style.css',
  'script.js',
  'weight-monitor.js',
  'admin.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll fails the whole install if ONE file 404s, so add individually.
      .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // never cache POSTs
  const url = new URL(req.url);

  // Login/session checks must never be answered from cache (an offline Pi
  // must not look like "still signed in").
  if (url.pathname.startsWith('/api/admin/')) return;

  // ── API: network first, fall back to the last good response ──
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then(cached =>
          cached || new Response(
            JSON.stringify({ offline: true, error: 'Pi unreachable and no cached copy available' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          )
        ))
    );
    return;
  }

  // ── Shell: cache first, refresh in the background ──
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// ── Push notifications (only fire if you wire up a push service) ──
self.addEventListener('push', event => {
  let data = { title: 'CrabTrack', body: 'New alert' };
  try { data = { ...data, ...event.data.json() }; } catch (_) { if (event.data) data.body = event.data.text(); }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.tag || 'crabtrack',
    vibrate: [180, 80, 180],
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('nodes.html');
  }));
});

// Let the page trigger a local notification while the app is closed-ish
self.addEventListener('message', event => {
  if (event.data?.type === 'NOTIFY') {
    self.registration.showNotification(event.data.title || 'CrabTrack', {
      body: event.data.body || '',
      icon: 'icons/icon-192.png',
      tag: event.data.tag || 'crabtrack-feeding',
      vibrate: [180, 80, 180],
    });
  }
});
