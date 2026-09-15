/* ══════════════════════════════════════════════════════════════════
   PBIS LEGACY NIGHT — offline service worker
   ──────────────────────────────────────────────────────────────────
   Purpose: if the venue network drops, opening the dashboard must
   still work rather than showing a browser error page. Combined with
   the guest-list snapshot in localStorage and the pending-check-in
   queue, a staff member can close the tab, reopen it with no signal
   at all, and still check people in — with writes queued and sent
   later.

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

   NOTE ON THE QR LIBRARIES. This worker does not cache cross-origin
   requests, which previously meant a device reloaded offline got the
   cached page and then silently failed to fetch jsQR from its CDN —
   camera open, video running, nothing ever decoding. That is the
   worst failure possible at a door, because it looks like the guest's
   pass is bad. Both QR libraries are now inlined in the dashboard
   itself, so they are part of the cached document and there is
   nothing left to fetch.
════════════════════════════════════════════════════════════════════ */

/* Bump this string on every deploy that changes cached assets. The
   activate handler deletes every cache that isn't the current name,
   so a bump guarantees stale copies are dropped rather than lingering
   alongside the new ones. */
const CACHE = 'legacy-night-v2';

/* Only the scope root is precached by name.

   The previous version also precached './index.html' by hand. That is
   a guess about the deployed filename: this dashboard is built as
   index-68.html and may be published under any name. A precache entry
   that 404s is silently dropped, so the guess cost nothing when wrong
   — but it also bought nothing, and it made the navigation fallback
   below point at a file that might be the PUBLIC page rather than the
   dashboard, which is actively misleading at a door.

   Everything the dashboard actually loads is cached at runtime on the
   first successful online load instead, whatever it happens to be
   called. */
const PRECACHE = ['./'];

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

/* Offline fallback for a page load, in order of preference:
     1. this exact page, ignoring ?kiosk=1 / ?monitor=1
     2. the scope root
     3. any cached HTML document we hold
   Step 3 matters because it is the difference between a door device
   opening SOMETHING usable and showing a browser error page. */
function offlineNavigationFallback(req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return cache.match('./', { ignoreSearch: true }).then(function (root) {
        if (root) return root;
        return cache.keys().then(function (reqs) {
          for (var i = 0; i < reqs.length; i++) {
            if (reqs[i].mode === 'navigate' || /\.html?($|\?)/i.test(reqs[i].url)) {
              return cache.match(reqs[i]);
            }
          }
          return Response.error();
        });
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  const req = event.request;

  // Never interfere with anything but plain GETs.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Apps Script, Google Fonts and any other origin: straight through.
  // Guest data must never come from a cache, and font/CDN requests
  // have their own caching that works better than ours would.
  if (url.origin !== self.location.origin) return;

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
        if (req.mode === 'navigate') return offlineNavigationFallback(req);
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || Response.error();
        });
      })
  );
});
