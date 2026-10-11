import { unlink, writeFile } from 'node:fs/promises';
import { prepareOfflineShell, OFFLINE_MANIFEST } from './offline-shell.mjs';
const scope = process.env.EARTH_BASE_PATH || '/';
const { critical, version, bytes } = await prepareOfflineShell({ scope });
await writeFile('dist/sw.js', `/* Generated cache release ${version}. Public assets only; no API/image submission cache. */
const RELEASE = 'earth-observer-shell-${version}', RUNTIME = 'earth-observer-assets-v2', TILES = 'earth-observer-basemap-v2';
const PRECACHE = ${JSON.stringify(critical)};
const SCOPE = ${JSON.stringify(scope)};
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
  const cache = await caches.open(name); await cache.put(request, response.clone());
  const keys = await cache.keys(); for (const key of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(key);
}
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if(request.method !== 'GET' || request.headers.has('authorization') || url.pathname.startsWith('/api/') || url.pathname.startsWith(SCOPE + 'api/')) return;
  if(request.mode === 'navigate' && url.origin === location.origin && url.pathname.startsWith(SCOPE)) {
    event.respondWith((async () => {
      try { const response = await fetch(request); if(response.ok && !response.redirected && new URL(response.url).pathname.startsWith(SCOPE) && (response.headers.get('content-type') || '').toLowerCase().includes('text/html') && !/private|no-store/i.test(response.headers.get('cache-control') || '') && !response.headers.has('set-cookie')) await (await caches.open(RELEASE)).put(SCOPE, response.clone()); return response; }
      catch { return (await caches.match(SCOPE)) || new Response('Offline. Reconnect for the first visit.', {status:503}); }
    })()); return;
  }
  const asset = url.origin === location.origin && (url.pathname.startsWith(SCOPE + 'assets/') || url.pathname.startsWith(SCOPE + 'cesium/'));
  const basemap = url.origin === 'https://gibs.earthdata.nasa.gov' && url.pathname.includes('/BlueMarble_ShadedRelief_Bathymetry/');
  if(!asset && !basemap) return;
  event.respondWith((async () => {
    const cached = await caches.match(request); if(cached) return cached;
    const response = await fetch(request); event.waitUntil(remember(basemap ? TILES : RUNTIME, request, response, basemap ? 120 : 180)); return response;
  })());
});
`);
await unlink('dist/' + OFFLINE_MANIFEST);
console.log(`Prepared offline shell: ${critical.length} public assets, ${bytes} bytes; optional dynamic layers excluded.`);
