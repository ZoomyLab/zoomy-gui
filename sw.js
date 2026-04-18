/**
 * Zoomy Service Worker — version-gated cache.
 *
 * Strategy:
 *  - Determine the current build version once (cached in SW memory, refreshed
 *    every VERSION_TTL_MS).
 *  - Same-origin requests: serve from the cache scoped to that version.
 *    On cache miss, fetch from network and store under the versioned cache.
 *    When the version changes, older versions' caches are pruned and the
 *    new cache populates naturally as files are requested.
 *  - version.json itself is always fetched from the network, never cached.
 *  - Cross-origin (CDN) requests: stale-while-revalidate in a shared CDN cache.
 *
 * Result: fast loads when the build is unchanged (cache hits), automatic
 * freshness after deploys (version mismatch triggers refetch), one extra
 * tiny fetch every VERSION_TTL_MS to poll the version.
 */

var CACHE_PREFIX = "zoomy-";
var CDN_CACHE = "zoomy-cdn";
var VERSION_TTL_MS = 60 * 1000;   // re-check version at most every minute

var _currentVersion = null;
var _versionCheckedAt = 0;

async function getCurrentVersion() {
    var now = Date.now();
    if (_currentVersion && now - _versionCheckedAt < VERSION_TTL_MS) {
        return _currentVersion;
    }
    try {
        var resp = await fetch("version.json?t=" + now, { cache: "no-store" });
        if (resp.ok) {
            var data = await resp.json();
            _currentVersion = (data.commit || data.version || "unknown").substring(0, 12);
        }
    } catch (e) {
        /* offline: keep existing _currentVersion if any */
        if (!_currentVersion) _currentVersion = "offline";
    }
    _versionCheckedAt = now;
    return _currentVersion;
}

async function pruneStaleCaches(currentCacheName) {
    var names = await caches.keys();
    await Promise.all(names.map(function (n) {
        if (n.startsWith(CACHE_PREFIX) && n !== currentCacheName && n !== CDN_CACHE) {
            return caches.delete(n);
        }
    }));
}

self.addEventListener("install", function (event) {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
    event.waitUntil((async function () {
        var v = await getCurrentVersion();
        await pruneStaleCaches(CACHE_PREFIX + v);
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", function (event) {
    var req = event.request;
    if (req.method !== "GET") return;
    var url = new URL(req.url);

    /* version.json: always network, never cached — this is the freshness signal */
    if (url.origin === self.location.origin && url.pathname.endsWith("/version.json")) {
        event.respondWith(fetch(req, { cache: "no-store" }).catch(function () {
            return new Response('{"version":"offline","commit":"offline"}',
                                { headers: { "Content-Type": "application/json" } });
        }));
        return;
    }

    /* Cross-origin (CDN): stale-while-revalidate.
       Backend health checks (localhost:8080 / :8000) also come through
       here. If the network fetch fails AND we have no cached copy, we
       must return a Response — passing `undefined` to respondWith()
       triggers a SW error in the page. Fall back to a synthetic 503. */
    if (url.origin !== self.location.origin) {
        event.respondWith(caches.open(CDN_CACHE).then(function (cache) {
            return cache.match(req).then(function (cached) {
                var fetched = fetch(req).then(function (response) {
                    if (response.ok) cache.put(req, response.clone());
                    return response;
                }).catch(function () { return cached; });
                return cached || fetched.then(function (r) {
                    return r || new Response("", {
                        status: 503,
                        statusText: "Service Unavailable (SW offline fallback)",
                    });
                });
            });
        }));
        return;
    }

    /* Same-origin: cache-first, cache scoped to current build version. */
    event.respondWith((async function () {
        var v = await getCurrentVersion();
        var cacheName = CACHE_PREFIX + v;
        var cache = await caches.open(cacheName);
        var cached = await cache.match(req);
        if (cached) return cached;
        try {
            var response = await fetch(req);
            if (response.ok) {
                cache.put(req, response.clone());
                /* Prune old-version caches opportunistically */
                pruneStaleCaches(cacheName);
            }
            return response;
        } catch (err) {
            /* Offline fallback: try any other cached version */
            var names = await caches.keys();
            for (var i = 0; i < names.length; i++) {
                if (names[i].startsWith(CACHE_PREFIX) && names[i] !== cacheName) {
                    var c = await caches.open(names[i]);
                    var fb = await c.match(req);
                    if (fb) return fb;
                }
            }
            throw err;
        }
    })());
});
