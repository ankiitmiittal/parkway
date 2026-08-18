/* ==========================================================================
   sw.js - offline support.

   Parks have famously bad signal, which is exactly when you need the plan.
   Once loaded, the whole app runs from cache: the optimizer, the questions,
   the comparisons and your saved park all work with no connection at all.

   Two things are deliberately NEVER cached:
     - api.anthropic.com  (photo parsing, steering)
     - queue-times.com    (live queue times)
   A stale queue time is worse than no queue time, so those are network-only
   and fail loudly rather than quietly serving yesterday's numbers.

   Note: service workers require https:// or localhost. Opening index.html
   from file:// works fine, it just has no offline layer (it is already local).

   RELEASING A CHANGE: bump CACHE below. That is what invalidates the shell.
   ========================================================================== */

var CACHE = 'parkway-v10';

// Cached without their ?v= query (lookups use ignoreSearch), so bumping the
// asset version in index.html does not need to be mirrored here.
var SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'css/app.css',
  'js/model.js',
  'js/optimizer.js',
  'js/questions.js',
  'js/duels.js',
  'js/vision.js',
  'js/waits.js',
  'js/ui.js',
  'js/app.js'
];

// Nice to have, but must not fail the install if absent.
var OPTIONAL = ['park.json', 'icon-180.png'];

// Hosts whose responses must always come from the network.
var LIVE_HOSTS = ['api.anthropic.com', 'queue-times.com'];

// Same-origin paths that are live data, not app shell. The queue-times proxy
// lives on our own origin, so the hostname check above would not catch it and
// we would end up serving yesterday's queue lengths out of cache.
var LIVE_PATHS = [/^\/\.netlify\/functions\//, /^\/api\//];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // cache: 'reload' so a release never picks up a stale HTTP-cached copy.
      var required = SHELL.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' })).then(function (res) {
          if (!res.ok) throw new Error('precache failed: ' + url);
          return cache.put(url, res);
        });
      });
      var optional = OPTIONAL.map(function (url) {
        return fetch(new Request(url, { cache: 'reload' }))
          .then(function (res) { return res.ok ? cache.put(url, res) : null; })
          .catch(function () { return null; });
      });
      return Promise.all(required.concat(optional));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Live data: straight to the network, never cached, never substituted.
  if (LIVE_HOSTS.indexOf(url.hostname) >= 0) return;

  // Anything else off-origin is none of our business.
  if (url.origin !== self.location.origin) return;

  // Same-origin, but live data: never cached, never served stale.
  for (var i = 0; i < LIVE_PATHS.length; i++) {
    if (LIVE_PATHS[i].test(url.pathname)) return;
  }

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        // Refresh in the background so the next load is current.
        var fresh = fetch(req).then(function (res) {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        }).catch(function () { return null; });

        if (hit) return hit;

        return fresh.then(function (res) {
          if (res) return res;
          // Offline and uncached: for a page request, hand back the app shell.
          if (req.mode === 'navigate') {
            return cache.match('index.html', { ignoreSearch: true });
          }
          return new Response('', { status: 504, statusText: 'Offline' });
        });
      });
    })
  );
});
