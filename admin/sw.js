/* ══════════════════════════════════════════════════════════════════
   PBIS LEGACY NIGHT — offline service worker
   ──────────────────────────────────────────────────────────────────
   Purpose: if the venue network drops, opening the dashboard must
   still work rather than showing a browser error page. Combined with
   the guest-list snapshot already held in localStorage, that means a
   staff member can close the tab, reopen it with no signal at all,
   and still check people in — with writes queued and sent later.

   THE STRATEGY IS NETWORK-FIRST, DELIBERATELY.

   The obvious approach — serve from cache, update in the background —
   is faster but carries a trap that matters enormously here: after
   shipping a fix, staff can keep running yesterday's code without
   knowing. On an event with one immovable date, silently stale code
   is far more dangerous than a slightly slower load.

   So: when online, the network always wins and the cache is refreshed
   behind it. The cache is only ever read when the network genuinely
   fails. There is no version of this where someone runs old code
   while connected.

   API calls to Apps Script are never cached — check-in data must
   never be served from a stale copy. Those requests pass straight
   through, and the dashboard's own retry queue handles failures.
════════════════════════════════════════════════════════════════════ */

const CACHE = 'legacy-night-v1';

// Only same-origin page assets. Everything else is passed through.
const PRECACHE = [
  './',
  './index.html',
];

self.addEventListener('install', function (event) {
  // Take over as soon as possible so a fix reaches staff on the next
  // load rather than waiting for every tab to close.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Failures here must not block installation — a missing entry
      // should degrade to "no offline copy", never to "no worker".
      return Promise.allSettled(PRECACHE.map(function (u) { return cache.add(u); }));
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);   // drop old versions
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;

  // Never interfere with anything but plain GETs.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Apps Script, Google Fonts and any other origin: straight through.
  // Guest data must never come from a cache, and font/CDN requests
  // have their own caching that works better than ours would.
  if (url.origin !== self.location.origin) return;

  // Ignore the display-mode query strings so ?kiosk=1 and ?monitor=1
  // resolve to the same cached document as the plain page.
  event.respondWith(
    fetch(req)
      .then(function (res) {
        // Refresh the cached copy whenever a real response arrives.
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        // Offline: fall back to whatever we have, ignoring the query
        // string so every mode still opens.
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          if (hit) return hit;
          // Last resort for a navigation, so the app shell still loads.
          if (req.mode === 'navigate') {
            return caches.match('./index.html', { ignoreSearch: true });
          }
          return Response.error();
        });
      })
  );
});
