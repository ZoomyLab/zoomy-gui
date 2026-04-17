/**
 * Zoomy Service Worker — cache-first for static assets.
 * Bump CACHE_VERSION to force re-download on next visit.
 */
var CACHE_VERSION = "zoomy-v3";  // bump this to force clients to re-fetch assets

var PRECACHE_URLS = [
    "./",
    "index.html",
    "style.css",
    "core.js",
    "param_widgets.js",
    "backend.js",
    "app.js",
    "cards/tabs.json",
    "cards/models/default.json",
    "cards/solvers/default.json",
    "cards/meshes/default.json",
    "cards/meshes/generated.json",
    "cards/visualizations/default.json",
    "cards/visualizations/generated.json"
];

/* Install: precache core assets */
self.addEventListener("install", function (event) {
    event.waitUntil(
        caches.open(CACHE_VERSION).then(function (cache) {
            return cache.addAll(PRECACHE_URLS);
        }).then(function () {
            return self.skipWaiting();
        })
    );
});

/* Activate: clean old caches */
self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names.filter(function (n) { return n !== CACHE_VERSION; })
                     .map(function (n) { return caches.delete(n); })
            );
        }).then(function () {
            return self.clients.claim();
        })
    );
});

/* Fetch: cache-first for same-origin, network-first for CDN */
self.addEventListener("fetch", function (event) {
    var url = new URL(event.request.url);

    /* Skip non-GET and cross-origin API calls */
    if (event.request.method !== "GET") return;

    /* CDN resources (milligram, katex, ace, plotly, mermaid, pyodide): stale-while-revalidate */
    if (url.origin !== self.location.origin) {
        event.respondWith(
            caches.open(CACHE_VERSION).then(function (cache) {
                return cache.match(event.request).then(function (cached) {
                    var fetched = fetch(event.request).then(function (response) {
                        if (response.ok) cache.put(event.request, response.clone());
                        return response;
                    }).catch(function () { return cached; });
                    return cached || fetched;
                });
            })
        );
        return;
    }

    /* Same-origin: stale-while-revalidate (serves cached content fast,
       refreshes cache in background so next load gets the new version) */
    event.respondWith(
        caches.open(CACHE_VERSION).then(function (cache) {
            return cache.match(event.request).then(function (cached) {
                var fetched = fetch(event.request).then(function (response) {
                    if (response.ok) cache.put(event.request, response.clone());
                    return response;
                }).catch(function () { return cached; });
                return cached || fetched;
            });
        })
    );
});
