/** Online scripts use the browser HTTP cache; CacheStorage is the offline safety net. */
export function renderServiceWorker({ critical, version, scope }) {
  return `/* Generated cache release ${version}. Public assets only; no API/image submission cache. */
const RELEASE = 'earth-observer-shell-${version}', RUNTIME = 'earth-observer-assets-v2', TILES = 'earth-observer-basemap-v2';
const PRECACHE = ${JSON.stringify(critical)};
const SCOPE = ${JSON.stringify(scope)};
const offlineClients = new Map();
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(RELEASE);
  await Promise.all(PRECACHE.map(async url => { const response = await fetch(url, {cache:'reload'}); if(!response.ok || response.redirected || /private|no-store/i.test(response.headers.get('cache-control') || '') || response.headers.has('set-cookie')) throw new Error('Essential public shell asset is unavailable'); await cache.put(url, response); }));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const versions = (await caches.keys()).filter(key => key.startsWith('earth-observer-shell-'));
  for (const key of versions.slice(0, -2)) if(key !== RELEASE) await caches.delete(key);
  await self.clients.claim();
})()));
async function remember(name, request, response, limit) {
  if (!(response.ok || response.type === 'opaque') || response.redirected || /private|no-store/i.test(response.headers.get('cache-control') || '') || response.headers.has('set-cookie')) return;
  const copy = response.clone();
  const cache = await caches.open(name); await cache.put(request, copy);
  if (limit) { const keys = await cache.keys(); for (const key of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(key); }
}
function background(event, promise) { event.waitUntil(promise.catch(() => {})); }
async function network(request) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetch(request, {cache:'default', signal:controller.signal}),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('The server did not respond in time')); }, 3500); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function savedAsset(request) {
  return (await (await caches.open(RELEASE)).match(request)) || (await (await caches.open(RUNTIME)).match(request));
}
function reportFallback(event, message) {
  const id = event.resultingClientId || event.clientId;
  if (!id) return;
  offlineClients.set(id, message);
  if (offlineClients.size > 64) offlineClients.delete(offlineClients.keys().next().value);
  background(event, self.clients.get(id).then(client => client?.postMessage({type:'earth-observer:shell-status', message})));
}
self.addEventListener('message', event => {
  if (event.data?.type === 'earth-observer:shell-status' && event.source?.id) {
    const message = offlineClients.get(event.source.id);
    if (message) event.source.postMessage({type:'earth-observer:shell-status', message});
  }
});
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if(request.method !== 'GET' || request.headers.has('authorization') || url.pathname.startsWith('/api/') || url.pathname.startsWith(SCOPE + 'api/')) return;
  if(request.mode === 'navigate' && url.origin === location.origin && url.pathname.startsWith(SCOPE)) {
    event.respondWith((async () => {
      let response;
      try {
        if (self.navigator?.onLine === false) throw new Error('Offline');
        response = await network(request);
        if (!response.ok) throw new Error('The document is unavailable');
        if(!response.redirected && new URL(response.url).pathname.startsWith(SCOPE) && (response.headers.get('content-type') || '').toLowerCase().includes('text/html')) background(event, remember(RELEASE, SCOPE, response));
        return response;
      } catch {
        const cached = await (await caches.open(RELEASE)).match(SCOPE);
        if (cached) { reportFallback(event, 'Saved app loaded while the server was unavailable. Live sources may be unavailable.'); return cached; }
        return response || new Response('Offline. Reconnect for the first visit.', {status:503});
      }
    })()); return;
  }
  const asset = url.origin === location.origin && (url.pathname.startsWith(SCOPE + 'assets/') || url.pathname.startsWith(SCOPE + 'cesium/'));
  const basemap = url.origin === 'https://gibs.earthdata.nasa.gov' && url.pathname.includes('/BlueMarble_ShadedRelief_Bathymetry/');
  if(!asset && !basemap) return;
  event.respondWith((async () => {
    if (basemap) {
      const cached = await (await caches.open(TILES)).match(request); if(cached) return cached;
      const response = await fetch(request); background(event, remember(TILES, request, response, 120)); return response;
    }
    let response;
    try {
      if (self.navigator?.onLine === false) throw new Error('Offline');
      response = await network(request);
      if (!response.ok) throw new Error('The app asset is unavailable');
      // Essential assets are already installed atomically. Do not rewrite the large engine on every reload.
      if (!PRECACHE.includes(url.pathname)) background(event, remember(RUNTIME, request, response, 180));
      return response;
    } catch (error) {
      const cached = await savedAsset(request);
      if(cached) { reportFallback(event, 'Some app files were restored from offline storage. Live sources may be unavailable.'); return cached; }
      if (response) return response;
      throw error;
    }
  })());
});
`;
}
