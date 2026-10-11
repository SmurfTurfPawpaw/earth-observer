import { DOCUMENT_HEADERS } from '../server/hosted/headers.js';
import { PUBLIC_SHELL_MAX_BYTES, RELEASE_MARKER_MAX_BYTES } from './offline-shell.mjs';

/** Online scripts use the browser HTTP cache; CacheStorage is the offline safety net. */
export function ofmCacheKind(url) {
  if (url.origin !== 'https://tiles.openfreemap.org' || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname === '/planet') return 'metadata';
  const tile = /^\/planet\/[0-9]{8}_[0-9]{6}_pt\/(0|[1-9][0-9]?)\/(0|[1-9][0-9]{0,4})\/(0|[1-9][0-9]{0,4})\.pbf$/.exec(url.pathname);
  if (!tile) return null;
  const [z, x, y] = tile.slice(1).map(Number);
  return z <= 14 && x < 2 ** z && y < 2 ** z ? 'tile' : null;
}

export function renderServiceWorker({ critical, version, scope, shell = null }) {
  if (shell && (shell.url !== `${scope}assets/public-shell-${shell.digest}.json` || !/^[a-f0-9]{64}$/.test(shell.digest) || !/^[a-f0-9]{64}$/.test(shell.htmlDigest))) throw new Error('Invalid fixed public shell descriptor');
  return `/* Generated cache release ${version}. Public assets only; no API/image submission cache. */
const RELEASE = 'earth-observer-shell-v3-${version}', RUNTIME = 'earth-observer-assets-v2', TILES = 'earth-observer-basemap-v2';
const PRECACHE = ${JSON.stringify(critical)};
const SCOPE = ${JSON.stringify(scope)};
const SHELL = ${JSON.stringify(shell)}, SHELL_RELEASE = ${JSON.stringify(version)}, SHELL_BYTES = ${PUBLIC_SHELL_MAX_BYTES};
const DOCUMENT_HEADERS = ${JSON.stringify(DOCUMENT_HEADERS)};
const COMPLETE = new URL('__earth-shell-complete__', location.origin + SCOPE).href, MARKER_BYTES = ${RELEASE_MARKER_MAX_BYTES};
const OFM = 'earth-observer-ofm-v1', OFM_INDEX = new URL('__earth-ofm-index__', location.origin + SCOPE).href;
const OFM_ENTRIES = 64, OFM_BYTES = 16 * 1024 * 1024;
${ofmCacheKind.toString()}
let ofmLedger, ofmWrites = Promise.resolve(), ofmCopies = 0;
const offlineClients = new Map();
let shellRevalidation, shellCheckedAt = -Infinity, shellAvailable = true;
self.addEventListener('install', event => event.waitUntil((async () => {
  if (!SHELL) throw new Error('The fixed public shell is not configured');
  const cache = await caches.open(RELEASE);
  let complete;
  try { complete = await completeRelease(RELEASE, cache); } catch {
    // A metadata read failure cannot justify deleting a potentially active complete cache.
    throw new Error('Existing offline release metadata is unavailable');
  }
  try {
    const results = await Promise.allSettled(PRECACHE.map(async url => {
      const response = url === SCOPE ? await installedShell() : await fetch(url, {cache:'reload'});
      if(!response.ok || response.redirected || /private|no-store/i.test(response.headers.get('cache-control') || '') || response.headers.has('set-cookie')) throw new Error('Essential public shell asset is unavailable');
      await cache.put(url, response);
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    // This marker is local metadata, never a network acquisition. Only a complete install can write it.
    await cache.put(COMPLETE, new Response(JSON.stringify({schema:1, release:SHELL_RELEASE, critical:PRECACHE, htmlDigest:SHELL.htmlDigest}), {headers:{'content-type':'application/json'}}));
  } catch (error) {
    if (!complete) await caches.delete(RELEASE);
    throw error;
  }
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const versions = (await caches.keys()).filter(key => key.startsWith('earth-observer-shell-'));
  const current = versions.indexOf(RELEASE), older = versions.slice(0, Math.max(0, current));
  const previous = await previousRelease(older);
  for (const key of older) if(key !== previous?.name) await caches.delete(key);
  await self.clients.claim();
})()));
async function remember(name, request, response, limit) {
  if (!(response.ok || response.type === 'opaque') || response.redirected || /private|no-store/i.test(response.headers.get('cache-control') || '') || response.headers.has('set-cookie')) return;
  const copy = response.clone();
  const cache = await caches.open(name); await cache.put(request, copy);
  if (limit) { const keys = await cache.keys(); for (const key of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(key); }
}
function background(event, promise) { event.waitUntil(promise.catch(() => {})); }
function publicShellResponse(response, expectedUrl) {
  return response.status === 200 && !['opaque', 'opaqueredirect', 'error'].includes(response.type) && !response.redirected &&
    (!expectedUrl || response.url === expectedUrl) && !/private|no-store/i.test(response.headers.get('cache-control') || '') && !response.headers.has('set-cookie');
}
function releaseAsset(route) {
  return typeof route === 'string' && !/[?#]/.test(route) && !route.split('/').some(part => part === '.' || part === '..') &&
    (route.startsWith(SCOPE + 'assets/') || route.startsWith(SCOPE + 'cesium/'));
}
async function completeRelease(name, cache) {
  if (!name.startsWith('earth-observer-shell-v3-')) return null;
  const response = await cache.match(COMPLETE);
  if (!response || !publicShellResponse(response) || (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') return null;
  const bytes = await boundedBytes(response, MARKER_BYTES, 3500);
  let value;
  try { value = bytes && JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); } catch { return null; }
  return value && Object.keys(value).sort().join(',') === 'critical,htmlDigest,release,schema' && value.schema === 1 && name === 'earth-observer-shell-v3-' + value.release &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value.release) && /^[a-f0-9]{64}$/.test(value.htmlDigest) && Array.isArray(value.critical) && value.critical.length > 0 && value.critical.length <= 95 &&
    value.critical.includes(SCOPE) && new Set(value.critical).size === value.critical.length && value.critical.every(route => route === SCOPE || releaseAsset(route)) ? value : null;
}
async function previousRelease(names) {
  // CacheStorage names preserve creation order. Do not inspect newer, possibly still-installing caches.
  for (const name of names.slice(-6).reverse()) {
    const cache = await caches.open(name);
    let marker;
    try { marker = await completeRelease(name, cache); } catch {}
    if (marker) return {name, cache, marker};
  }
  return null;
}
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function documentResponse(bytes) {
  return new Response(bytes, { headers: {
    ...DOCUMENT_HEADERS, 'content-type':'text/html; charset=utf-8', 'cache-control':'no-cache',
    'content-length':String(bytes.byteLength), 'x-earth-shell-release':SHELL_RELEASE, 'x-earth-shell-digest':SHELL.htmlDigest,
  }});
}
async function installedShell() {
  const url = new URL(SHELL.url, location.origin).href;
  const response = await network(new Request(url, {credentials:'omit', redirect:'error', mode:'same-origin'}), 'reload');
  if (!publicShellResponse(response, url) || (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('The public shell response is unsafe');
  const bytes = await boundedBytes(response, SHELL_BYTES, 3500);
  if (!bytes || await digest(bytes) !== SHELL.digest) throw new Error('The public shell digest does not match this release');
  const value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
  if (!value || Object.keys(value).sort().join(',') !== 'html,release,schema,scope' || value.schema !== 1 || value.release !== SHELL_RELEASE || value.scope !== SCOPE || typeof value.html !== 'string') throw new Error('The public shell schema does not match this release');
  const html = new TextEncoder().encode(value.html);
  if (html.byteLength > SHELL_BYTES || await digest(html) !== SHELL.htmlDigest) throw new Error('The public document digest does not match this release');
  return documentResponse(html);
}
async function savedShell() {
  if (!SHELL) return null;
  const response = await (await caches.open(RELEASE)).match(SCOPE);
  if (!response || !publicShellResponse(response) || response.headers.get('x-earth-shell-release') !== SHELL_RELEASE || response.headers.get('x-earth-shell-digest') !== SHELL.htmlDigest ||
    (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'text/html' ||
    !Object.entries(DOCUMENT_HEADERS).every(([name, value]) => response.headers.get(name) === value)) return null;
  const bytes = await boundedBytes(response, SHELL_BYTES, 3500);
  return bytes && await digest(bytes) === SHELL.htmlDigest ? documentResponse(bytes) : null;
}
function revalidateShell(event) {
  if (self.navigator?.onLine === false) { reportFallback(event, 'Saved app loaded offline. Live sources may be unavailable.'); return; }
  if (!shellRevalidation && Date.now() - shellCheckedAt >= 30000) {
    shellCheckedAt = Date.now();
    shellRevalidation = (async () => {
      let response;
      try {
        const url = new URL(SCOPE, location.origin).href;
        response = await network(new Request(url, {credentials:'omit', redirect:'error', mode:'same-origin'}), 'no-cache');
        shellAvailable = publicShellResponse(response, url) && (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() === 'text/html';
      } catch { shellAvailable = false; }
      finally {
        // Observe availability only: never read, replay or persist request-specific HTML.
        void response?.body?.cancel().catch(() => {});
        shellRevalidation = null;
      }
      return shellAvailable;
    })();
  }
  background(event, (shellRevalidation || Promise.resolve(shellAvailable)).then(available => {
    if (!available) reportFallback(event, 'Saved app loaded while the server was unavailable. Live sources may be unavailable.');
  }));
}
function publicMapResponse(response) {
  return response.status === 200 && !['opaque', 'opaqueredirect', 'error'].includes(response.type) && !response.redirected &&
    !/private|no-store/i.test(response.headers.get('cache-control') || '') && !response.headers.has('set-cookie');
}
async function boundedBytes(response, limit, timeoutMs = 8000) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  if (Number(response.headers.get('content-length')) > limit) { cancel(); reader.releaseLock(); return null; }
  const chunks = []; let size = 0, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { cancel(); reject(new Error('Public cache copy timed out')); }, timeoutMs); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) { cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch { cancel(); return null; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
async function loadMapLedger(cache) {
  if (ofmLedger) return;
  let entries;
  try {
    const index = await cache.match(OFM_INDEX), bytes = index && await boundedBytes(index, 32 * 1024);
    entries = bytes && JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(entries) || entries.length >= OFM_ENTRIES || !entries.every(([url, record]) => {
      const kind = ofmCacheKind(new URL(url));
      return kind && Number.isInteger(record.bytes) && record.bytes > 0 && record.bytes <= (kind === 'metadata' ? 256 * 1024 : 4 * 1024 * 1024) && Number.isFinite(record.at);
    })) entries = [];
  } catch { entries = []; }
  ofmLedger = new Map(entries || []);
}
async function saveMapCopy(url, bytes, headers) {
  const cache = await caches.open(OFM); await loadMapLedger(cache);
  // A tiny ledger avoids re-reading up to 16 MiB of tile bodies to enforce the budget.
  for (const key of await cache.keys()) if (key.url !== OFM_INDEX && !ofmLedger.has(key.url)) await cache.delete(key);
  ofmLedger.delete(url); ofmLedger.set(url, { bytes: bytes.byteLength, at: Date.now() });
  const indexBytes = () => new TextEncoder().encode(JSON.stringify([...ofmLedger]));
  const totalBytes = () => [...ofmLedger.values()].reduce((sum, record) => sum + record.bytes, 0) + indexBytes().byteLength;
  while (ofmLedger.size + 1 > OFM_ENTRIES || totalBytes() > OFM_BYTES) {
    // Keep the last TileJSON: without it, saved visited tiles cannot initialize offline.
    const oldest = [...ofmLedger.keys()].find(key => ofmCacheKind(new URL(key)) !== 'metadata');
    if (!oldest) return;
    ofmLedger.delete(oldest); await cache.delete(oldest);
  }
  await cache.put(url, new Response(bytes, { headers }));
  await cache.put(OFM_INDEX, new Response(indexBytes(), { headers: { 'content-type': 'application/json' } }));
}
async function rememberMap(request, response, kind) {
  if (ofmCopies >= 8 || !publicMapResponse(response)) return;
  const url = new URL(request.url), contentType = response.headers.get('content-type') || '';
  if (response.url !== url.href || (kind === 'metadata' ? !/json/i.test(contentType) : !['application/vnd.mapbox-vector-tile', 'application/x-protobuf', 'application/protobuf', 'application/octet-stream'].includes(contentType.split(';')[0].trim().toLowerCase()))) return;
  const copy = response.clone(); ofmCopies++;
  try {
    const bytes = await boundedBytes(copy, kind === 'metadata' ? 256 * 1024 : 4 * 1024 * 1024);
    if (!bytes?.byteLength) return;
    if (kind === 'metadata') {
      let metadata;
      try { metadata = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
      const template = metadata?.tiles?.[0];
      if (typeof template !== 'string' || !['{z}', '{x}', '{y}'].every(token => template.includes(token)) ||
        ofmCacheKind(new URL(template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'))) !== 'tile' ||
        Number(metadata.minzoom || 0) !== 0 || !Number.isInteger(metadata.maxzoom) || metadata.maxzoom < 0 || metadata.maxzoom > 14) return;
    }
    const headers = new Headers(response.headers);
    for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) headers.delete(name);
    headers.set('content-length', String(bytes.byteLength)); headers.set('x-earth-map-cached-at', String(Date.now()));
    // Serialize mutations, not network delivery. Failed storage never rejects the live tile.
    ofmWrites = ofmWrites.then(() => saveMapCopy(url.href, bytes, headers)).catch(() => { ofmLedger = null; });
    await ofmWrites;
  } finally { ofmCopies--; }
}
async function network(request, cache = 'default') {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetch(request, {cache, signal:controller.signal}),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('The server did not respond in time')); }, 3500); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function savedAsset(request) {
  const cached = (await (await caches.open(RELEASE)).match(request)) || (await (await caches.open(RUNTIME)).match(request));
  if (cached) return cached;
  const url = new URL(request.url);
  if (url.origin !== location.origin || url.search || url.hash || !releaseAsset(url.pathname)) return null;
  const names = await caches.keys(), current = names.indexOf(RELEASE);
  const previous = await previousRelease(names.slice(0, Math.max(0, current)).filter(name => name.startsWith('earth-observer-shell-v3-')));
  if (!previous?.marker.critical.includes(url.pathname)) return null;
  const asset = await previous.cache.match(request);
  return asset && publicShellResponse(asset) && !(asset.headers.get('content-type') || '').toLowerCase().includes('text/html') ? asset : null;
}
function reportFallback(event, message) {
  const id = event.resultingClientId || event.clientId;
  if (!id) return;
  if (offlineClients.get(id) === message) return;
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
  if(request.mode === 'navigate') {
    // The sole universal document has no query-dependent or private variant. All other routes remain network-owned.
    if(url.origin !== location.origin || url.pathname !== SCOPE || url.search) return;
    event.respondWith((async () => {
      let cached;
      try { cached = await savedShell(); } catch {}
      if (cached) { revalidateShell(event); return cached; }
      let response;
      try {
        if (self.navigator?.onLine === false) throw new Error('Offline');
        response = await network(request);
        if (!response.ok) throw new Error('The document is unavailable');
        return response;
      } catch {
        return response || new Response('Offline. Reconnect for the first visit.', {status:503});
      }
    })()); return;
  }
  const asset = url.origin === location.origin && (url.pathname.startsWith(SCOPE + 'assets/') || url.pathname.startsWith(SCOPE + 'cesium/'));
  const basemap = url.origin === 'https://gibs.earthdata.nasa.gov' && url.pathname.includes('/BlueMarble_ShadedRelief_Bathymetry/');
  const mapKind = request.credentials === 'include' ? null : ofmCacheKind(url);
  if(!asset && !basemap && !mapKind) return;
  event.respondWith((async () => {
    if (mapKind) {
      let response;
      try {
        if (self.navigator?.onLine === false) throw new Error('Offline');
        response = await network(request);
        if (!response.ok) throw new Error('The street map is unavailable');
        background(event, rememberMap(request, response, mapKind)); return response;
      } catch (error) {
        const cached = await (await caches.open(OFM)).match(request);
        if (cached && publicMapResponse(cached)) { reportFallback(event, 'Saved street-map tiles shown where available. Map coverage may be incomplete offline.'); return cached; }
        if (response) return response;
        throw error;
      }
    }
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
