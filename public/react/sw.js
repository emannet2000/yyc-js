/* Cache only the application shell; account API data never enters Cache Storage. */
const CACHE = 'yyc-driver-shell-v3';
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch('/react/', { cache: 'reload' });
      if (!response.ok) throw new Error('Cannot cache application shell.');
      const html = await response.clone().text();
      await cache.put('/react/', response);
      const assets = [...html.matchAll(/(?:src|href)="(\/react\/assets\/[^"#?]+)"/g)].map(
        (match) => match[1],
      );
      await cache.addAll([...assets, '/react/manifest.webmanifest', '/react/icon.svg']);
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith('yyc-driver-shell-') && key !== CACHE)
              .map((key) => caches.delete(key)),
          ),
        ),
    ]),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith('/react/') ||
    url.pathname.endsWith('/sw.js')
  )
    return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (
          response.ok &&
          ['script', 'style', 'document'].includes(request.destination)
        ) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('/react/');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
