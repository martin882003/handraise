const CACHE_PREFIX = 'handraise-shell-';
const CACHE = `${CACHE_PREFIX}v4`;

self.addEventListener('install', (event) => {
  // Carry the last usable shell forward before activating. The shell always
  // re-checks readiness and renders an explicit offline client state, so an old
  // cached document can never pretend that the server is reachable.
  event.waitUntil((async () => {
    const current = await caches.open(CACHE);
    const previous = (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE);
    for (const key of previous) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) {
        if (await current.match(request)) continue;
        const response = await cache.match(request);
        if (response) await current.put(request, response);
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
          return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Handraise · Server unavailable</title><style>html{font-family:system-ui;background:#f4f4f8;color:#17171c}body{min-height:100vh;margin:0;display:grid;place-items:center}main{max-width:32rem;padding:2rem}p{line-height:1.55;color:#626272}button{padding:.7rem 1rem;border:1px solid #777;border-radius:.6rem;background:white}</style></head><body><main><h1>Handraise server unavailable</h1><p>This cached client cannot reach the server. Server-backed actions are unavailable until it reconnects.</p><button onclick="location.reload()">Try again</button></main></body></html>`, {
            status: 503,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        }
        return Response.error();
      }),
  );
});
