/**
 * Zoomy Service Worker — version-gated cache + cross-origin isolation.
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
 *  - Every response passes through withCoiHeaders() which injects
 *    Cross-Origin-Embedder-Policy / Cross-Origin-Opener-Policy on same-origin
 *    traffic and Cross-Origin-Resource-Policy on cross-origin traffic.
 *    That enables SharedArrayBuffer in the page, which in turn lets Pyodide
 *    cooperatively cancel a running simulation via setInterruptBuffer —
 *    without having to terminate() + re-boot the worker. GitHub Pages does
 *    not ship those headers, so the SW injects them locally.
 *
 * Result: fast loads when the build is unchanged (cache hits), automatic
 * freshness after deploys (version mismatch triggers refetch), one extra
 * tiny fetch every VERSION_TTL_MS to poll the version, and a cross-origin
 * isolated page so SharedArrayBuffer works.
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

/* Wrap a Response with the headers needed to make the page cross-origin
   isolated. Skips opaque responses (can't be introspected or rewrapped)
   and non-OK responses (we don't want 503 stubs to poison the cache).
   For same-origin: add COOP/COEP so the page reaches crossOriginIsolated.
   For cross-origin: add CORP so require-corp embedding is satisfied. */
function withCoiHeaders(response, isCrossOrigin) {
    if (!response) return response;
    if (response.type === "opaque" || response.type === "opaqueredirect") return response;
    try {
        var h = new Headers(response.headers);
        if (isCrossOrigin) {
            if (!h.has("Cross-Origin-Resource-Policy")) {
                h.set("Cross-Origin-Resource-Policy", "cross-origin");
            }
        } else {
            h.set("Cross-Origin-Embedder-Policy", "require-corp");
            h.set("Cross-Origin-Opener-Policy", "same-origin");
            if (!h.has("Cross-Origin-Resource-Policy")) {
                h.set("Cross-Origin-Resource-Policy", "same-origin");
            }
        }
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: h,
        });
    } catch (e) {
        return response;
    }
}

self.addEventListener("fetch", function (event) {
    var req = event.request;
    if (req.method !== "GET") return;
    var url = new URL(req.url);
    var crossOrigin = url.origin !== self.location.origin;

    /* version.json: always network, never cached — this is the freshness signal */
    if (!crossOrigin && url.pathname.endsWith("/version.json")) {
        event.respondWith(fetch(req, { cache: "no-store" }).then(function (r) {
            return withCoiHeaders(r, false);
        }).catch(function () {
            return withCoiHeaders(new Response(
                '{"version":"offline","commit":"offline"}',
                { headers: { "Content-Type": "application/json" } }
            ), false);
        }));
        return;
    }

    /* Cross-origin (CDN): stale-while-revalidate. COEP require-corp means
       every cross-origin response needs CORP; we inject it on the way out
       so the CDN doesn't have to set it. Backend health checks
       (localhost:8080 / :8000) also come through here — if the network
       fails AND we have no cached copy, we must return a Response (passing
       undefined to respondWith() raises a page error), so fall back to a
       synthetic 503 wrapped with the same CORP header. */
    if (crossOrigin) {
        event.respondWith(caches.open(CDN_CACHE).then(function (cache) {
            return cache.match(req).then(function (cached) {
                var fetched = fetch(req).then(function (response) {
                    if (response.ok) cache.put(req, response.clone());
                    return response;
                }).catch(function () { return cached; });
                /* cached is a Response (or undefined); wrap consistently
                   via Promise.resolve so the single .then below works on
                   both the cache-hit and cache-miss branches. */
                var chosen = cached ? Promise.resolve(cached) :
                    fetched.then(function (r) {
                        return r || new Response("", {
                            status: 503,
                            statusText: "Service Unavailable (SW offline fallback)",
                        });
                    });
                return chosen.then(function (r) { return withCoiHeaders(r, true); });
            });
        }));
        return;
    }

    /* Same-origin: cache-first, cache scoped to current build version. The
       response is rewrapped with COOP/COEP on the way out so the navigation
       reaches crossOriginIsolated without extra round-trips. */
    event.respondWith((async function () {
        var v = await getCurrentVersion();
        var cacheName = CACHE_PREFIX + v;
        var cache = await caches.open(cacheName);
        var cached = await cache.match(req);
        if (cached) return withCoiHeaders(cached, false);
        try {
            var response = await fetch(req);
            if (response.ok) {
                cache.put(req, response.clone());
                /* Prune old-version caches opportunistically */
                pruneStaleCaches(cacheName);
            }
            return withCoiHeaders(response, false);
        } catch (err) {
            /* Offline fallback: try any other cached version */
            var names = await caches.keys();
            for (var i = 0; i < names.length; i++) {
                if (names[i].startsWith(CACHE_PREFIX) && names[i] !== cacheName) {
                    var c = await caches.open(names[i]);
                    var fb = await c.match(req);
                    if (fb) return withCoiHeaders(fb, false);
                }
            }
            throw err;
        }
    })());
});
