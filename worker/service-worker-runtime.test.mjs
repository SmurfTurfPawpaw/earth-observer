import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { DOCUMENT_HEADERS } from '../server/hosted/headers.js';
import { publicShellAsset, PUBLIC_SHELL_MAX_BYTES } from '../scripts/offline-shell.mjs';
import { renderServiceWorker } from '../scripts/service-worker-runtime.mjs';
const origin = 'https://example.com', scope = '/earth/', engine = scope + 'cesium/1.138.0/Cesium.js';
const html = '<!doctype html><html><body>Universal public globe</body></html>';
const asset = publicShellAsset({ html, version: 'fixture', scope }), release = 'earth-observer-shell-v3-fixture';
function response(body, path = engine, headers = {}) {
  const value = new Response(body, { headers }); Object.defineProperty(value, 'url', { value: path.startsWith('https:') ? path : origin + path }); return value;
}
function fixed(body = html, headers = {}) {
  return response(body, scope, { ...DOCUMENT_HEADERS, 'content-type': 'text/html', 'cache-control': 'no-cache', 'x-earth-shell-release': 'fixture', 'x-earth-shell-digest': asset.descriptor.htmlDigest, ...headers });
}
function alteredAsset(payload) {
  const body = JSON.stringify(payload), digest = createHash('sha256').update(body).digest('hex');
  return { body, descriptor: { ...asset.descriptor, digest, url: scope + `assets/public-shell-${digest}.json` } };
}
function harness({ fetchImpl, online = true, values = new Map(), putImpl, shell = asset, version = 'fixture', documentIdentity = null, critical = [scope, engine, scope + 'assets/main-one.js'] } = {}) {
  const listeners = new Map(), reads = [], writes = [], fetches = [], timers = new Map(), messages = [], deleted = [];
  let timerId = 0, now = 100000, activated = 0, claimed = 0;
  const path = request => { const url = new URL(typeof request === 'string' ? request : request.url, origin); return url.pathname + url.search; };
  const cache = name => ({
    async match(request) { const route = path(request); reads.push([name, route]); return values.get(name + ':' + route)?.clone(); },
    async put(request, body) { writes.push([name, path(request)]); if (putImpl) await putImpl(request, body); values.set(name + ':' + path(request), body.clone()); },
    async keys() { return [...values.keys()].filter(key => key.startsWith(name + ':')).map(key => new Request(origin + key.slice(name.length + 1))); },
    async delete(request) { return values.delete(name + ':' + path(request)); },
  });
  const self = { navigator: { onLine: online }, addEventListener: (name, fn) => listeners.set(name, fn), async skipWaiting() { activated++; },
    clients: { async get() { return { postMessage(message) { messages.push(message); } }; }, async claim() { claimed++; } } };
  const context = { self, location: { origin }, URL, Request, Response, Headers, AbortController, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, Date: { now: () => now },
    caches: { async open(name) { return cache(name); }, async keys() { return [...new Set([...values.keys()].map(key => key.split(':')[0]))]; }, async delete(name) { deleted.push(name); for (const key of values.keys()) if (key.startsWith(name + ':')) values.delete(key); } },
    fetch(request, options) { fetches.push([request, options]); if (fetchImpl) return fetchImpl(request, options); const route = path(request); return Promise.resolve(route === shell.descriptor.url ? response(shell.body, route, { 'content-type': 'application/json', 'cache-control': 'public, max-age=31536000, immutable' }) : response('public asset', route)); },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(renderServiceWorker({ version, critical, scope, shell: shell.descriptor, documentIdentity }), context);
  function dispatch(route, { mode = 'cors', clientId = 'page', method = 'GET', headers = {} } = {}) {
    const pending = []; let result;
    listeners.get('fetch')({ request: { method, mode, url: route.startsWith('https:') ? route : origin + route, headers: new Headers(headers) }, clientId, resultingClientId: mode === 'navigate' ? clientId : '', respondWith(value) { result = value; }, waitUntil(value) { pending.push(value); } });
    return { get result() { return result; }, pending };
  }
  function lifecycle(name) { let result; listeners.get(name)({ waitUntil(work) { result = work; } }); return result; }
  return { dispatch, install: () => lifecycle('install'), activate: () => lifecycle('activate'), reads, writes, fetches, timers, messages, listeners, values, deleted, get activated() { return activated; }, get claimed() { return claimed; }, advance(ms) { now += ms; } };
}
async function bounded(work) { let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Navigation waited for background work')), 1000); })]); } finally { clearTimeout(timer); } }
async function settled(event) { for (let index = 0; index < event.pending.length; index++) await event.pending[index]; }

test('online essential Cesium remains HTTP-first with no CacheStorage read or duplicate write', async () => {
  const h = harness({ fetchImpl: async () => response('online engine') });
  assert.equal(await (await h.dispatch(engine).result).text(), 'online engine'); assert.equal(h.fetches[0][1].cache, 'default');
  assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.timers.size, 0);
});

test('online navigation adopts current HTTP bytes and never consults or overwrites a warm old document', async () => {
  const current = html + '<p>New release</p>', values = new Map([[release + ':' + scope, fixed()]]);
  const h = harness({ values, fetchImpl: async () => response(current, scope, { 'content-type': 'text/html' }) });
  const event = h.dispatch(scope, { mode: 'navigate' });
  assert.equal(await (await event.result).text(), current); await settled(event);
  assert.equal(h.fetches[0][1].cache, 'no-cache'); assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
  assert.equal(await values.get(release + ':' + scope).clone().text(), html);
});

test('an unresponsive online navigation has a bounded deadline before verified offline fallback', async () => {
  const h = harness({ values: new Map([[release + ':' + scope, fixed()]]), fetchImpl: () => new Promise(() => {}) });
  const event = h.dispatch(scope, { mode: 'navigate' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.fetches.length, 1); assert.equal(h.reads.length, 0); assert.equal(h.timers.size, 1);
  const options = h.fetches[0][1]; [...h.timers.values()][0].fn();
  assert.equal(await (await bounded(event.result)).text(), html); await settled(event);
  assert.equal(options.signal.aborted, true); assert.equal(h.writes.length, 0); assert.match(h.messages[0].message, /server was unavailable/);
});

test('request-specific online HTML passes through unchanged but never replaces the verified universal offline release', async () => {
  const privateHtml = '<script>request-specific-identity</script>', values = new Map([[release + ':' + scope, fixed()]]);
  const h = harness({ values, fetchImpl: async () => response(privateHtml, scope, { 'content-type': 'text/html', 'set-cookie': 'opaque-platform-cookie', 'cache-control': 'private' }) });
  const event = h.dispatch(scope, { mode: 'navigate' }); assert.equal(await (await event.result).text(), privateHtml); await settled(event);
  assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0); assert.equal(await values.get(release + ':' + scope).clone().text(), html);
});

test('intentional access and private server responses cannot be bypassed by a saved public shell', async () => {
  for (const [status, headers] of [[401, {}], [403, {}], [404, {}], [503, { 'cache-control': 'private' }], [503, { 'cache-control': 'no-store' }], [503, { 'set-cookie': 'session=opaque' }], [503, { 'content-type': 'application/json' }]]) {
    const h = harness({ values: new Map([[release + ':' + scope, fixed()]]), fetchImpl: async () => {
      const value = new Response('Server-owned result', { status, headers: { 'content-type': 'text/html', ...headers } }); Object.defineProperty(value, 'url', { value: origin + scope }); return value;
    } });
    const result = await h.dispatch(scope, { mode: 'navigate' }).result;
    assert.equal(result.status, status); assert.equal(await result.text(), 'Server-owned result'); assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
  }
});

test('a public HTML server failure may restore only the matching verified fixed document', async () => {
  const h = harness({ values: new Map([[release + ':' + scope, fixed()]]), fetchImpl: async () => {
    const value = new Response('Unavailable', { status: 503, headers: { 'content-type': 'text/html' } }); Object.defineProperty(value, 'url', { value: origin + scope }); return value;
  } });
  const event = h.dispatch(scope, { mode: 'navigate' }); assert.equal(await (await event.result).text(), html); await settled(event); assert.equal(h.writes.length, 0);
});

test('install replaces root acquisition with fixed JSON and waits for all critical assets before activating', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = harness({ fetchImpl: async request => { const path = typeof request === 'string' ? request : new URL(request.url).pathname; if (path === engine) return gate; return path === asset.descriptor.url ? response(asset.body, path, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'x-user-id': 'never-replayed' }) : response('main', path); } });
  const work = h.install(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.activated, 0); finish(response('engine')); await work; assert.equal(h.activated, 1);
  assert.equal(h.fetches.length, 3); assert.equal(h.fetches.some(([request]) => request === scope || request.url === origin + scope), false);
  const doc = h.values.get(release + ':' + scope); assert.equal(await doc.clone().text(), html);
  for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) assert.equal(doc.headers.get(name), value);
  for (const name of ['content-encoding', 'set-cookie', 'x-user-id', 'etag']) assert.equal(doc.headers.has(name), false);
  assert.equal(doc.headers.get('content-length'), String(Buffer.byteLength(html)));
});

test('failed critical assets cannot activate a partially installed release', async () => {
  const h = harness({ fetchImpl: async request => { const path = typeof request === 'string' ? request : new URL(request.url).pathname; if (path === engine) return new Response('missing', { status: 503 }); return response(path === asset.descriptor.url ? asset.body : 'main', path, { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/javascript' }); } });
  await assert.rejects(h.install(), /Essential public shell asset/); assert.equal(h.activated, 0);
  assert.equal([...h.values.keys()].some(key => key.startsWith(release + ':')), false); assert.deepEqual(h.deleted, [release]);
});

test('install refuses private, no-store, redirected, wrong-origin and wrong-type shell responses', async () => {
  const cases = [response(asset.body, asset.descriptor.url, { 'content-type': 'application/json', 'cache-control': 'private' }), response(asset.body, asset.descriptor.url, { 'content-type': 'application/json', 'cache-control': 'no-store' }), response(asset.body, asset.descriptor.url, { 'content-type': 'application/json', 'set-cookie': 'private=1' }), response(asset.body, 'https://other.example' + asset.descriptor.url, { 'content-type': 'application/json' }), response(asset.body, asset.descriptor.url, { 'content-type': 'text/html' })];
  const redirect = response(asset.body, asset.descriptor.url, { 'content-type': 'application/json' }); Object.defineProperty(redirect, 'redirected', { value: true }); cases.push(redirect);
  for (const unsafe of cases) { const h = harness({ critical: [scope], fetchImpl: async () => unsafe }); await assert.rejects(h.install(), /unsafe/); assert.equal(h.activated, 0); assert.equal(h.writes.length, 0); }
});

test('artifact and HTML digests reject altered bytes even when public headers and outer schema are valid', async () => {
  const h = harness({ critical: [scope], fetchImpl: async () => response(asset.body + ' ', asset.descriptor.url, { 'content-type': 'application/json' }) }); await assert.rejects(h.install(), /digest/);
  const changed = harness({ critical: [scope], shell: alteredAsset({ schema: 1, release: 'fixture', scope, html: html + '<script>identity</script>' }) }); await assert.rejects(changed.install(), /document digest/); assert.equal(changed.writes.length, 0);
});

test('exact schema, release and scope are checked after byte validation', async () => {
  const valid = { schema: 1, release: 'fixture', scope, html };
  for (const value of [{ ...valid, schema: 2 }, { ...valid, release: 'other' }, { ...valid, scope: '/' }, { ...valid, user: 'identity' }, { ...valid, html: null }]) { const h = harness({ critical: [scope], shell: alteredAsset(value) }); await assert.rejects(h.install(), /schema/); assert.equal(h.writes.length, 0); assert.equal(h.activated, 0); }
});

test('oversized declared and chunked JSON stay outside the fixed 64 KiB shell budget', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(PUBLIC_SHELL_MAX_BYTES / 2)); controller.enqueue(new Uint8Array(PUBLIC_SHELL_MAX_BYTES / 2 + 1)); controller.close(); } });
  for (const input of [response(asset.body, asset.descriptor.url, { 'content-type': 'application/json', 'content-length': String(PUBLIC_SHELL_MAX_BYTES + 1) }), response(stream, asset.descriptor.url, { 'content-type': 'application/json' })]) { const h = harness({ critical: [scope], fetchImpl: async () => input }); await assert.rejects(h.install(), /digest/); assert.equal(h.writes.length, 0); }
});

test('stalled JSON bodies have a bounded deadline and cannot install a release', async () => {
  let canceled = false; const body = new ReadableStream({ cancel() { canceled = true; } });
  const h = harness({ critical: [scope], fetchImpl: async () => response(body, asset.descriptor.url, { 'content-type': 'application/json' }) }); const work = h.install(), rejected = assert.rejects(work, /digest/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 3500); [...h.timers.values()][0].fn(); await rejected; assert.equal(canceled, true); assert.equal(h.activated, 0);
});

test('offline universal shell restores without a request and honestly reports offline state', async () => {
  const h = harness({ online: false, values: new Map([[release + ':' + scope, fixed()]]), fetchImpl() { assert.fail('Offline fetch'); } }); const event = h.dispatch(scope, { mode: 'navigate' }); assert.equal(await (await event.result).text(), html); await settled(event); assert.equal(h.fetches.length, 0); assert.match(h.messages[0].message, /Saved app loaded offline/);
});

test('legacy or corrupt HTML is never replayed, including identity-bearing bodies with current-looking markers', async () => {
  for (const invalid of [fixed('private identity'), fixed(html, { 'x-earth-shell-release': 'old' }), fixed(html, { 'content-security-policy': '' }), fixed(html, { 'cache-control': 'private' }), fixed(html, { 'content-type': 'application/json' })]) { const h = harness({ online: false, values: new Map([[release + ':' + scope, invalid]]), fetchImpl() { assert.fail('Offline fetch'); } }); const result = await h.dispatch(scope, { mode: 'navigate' }).result; assert.equal(result.status, 503); assert.match(await result.text(), /Reconnect for the first visit/); }
  const legacy = harness({ values: new Map([['earth-observer-shell-fixture:' + scope, response('visitor-specific legacy HTML', scope)]]), fetchImpl: async () => response('normal current document', scope) }); assert.equal(await (await legacy.dispatch(scope, { mode: 'navigate' }).result).text(), 'normal current document'); assert.equal(legacy.writes.length, 0);
});

test('non-root, query, cross-origin, auth, API and write navigations stay outside shell and asset fallback', () => {
  const h = harness({ fetchImpl() { assert.fail('Protected interception'); } });
  for (const path of ['/earth/private', '/earth/index.html', '/earth/assets/private.html', '/earth/?account=private', '/api/evidence/session', '/earth/api/evidence/moderation', '/signin-with-chatgpt', 'https://other.example/earth/']) assert.equal(h.dispatch(path, { mode: 'navigate' }).result, undefined, path);
  assert.equal(h.dispatch(scope, { mode: 'navigate', headers: { authorization: 'Bearer private' } }).result, undefined); assert.equal(h.dispatch(scope, { mode: 'navigate', method: 'POST' }).result, undefined); assert.equal(h.reads.length, 0);
});

test('missing verified shell leaves normal online private HTML untouched and never stores it', async () => {
  for (const headers of [{ 'cache-control': 'private' }, { 'cache-control': 'no-store' }, { 'set-cookie': 'secret=1' }]) { const h = harness({ fetchImpl: async () => response('normal network HTML', scope, { 'content-type': 'text/html', ...headers }) }); const event = h.dispatch(scope, { mode: 'navigate' }); assert.equal(await (await event.result).text(), 'normal network HTML'); await settled(event); assert.equal(h.writes.length, 0); }
});

test('unresponsive first navigation aborts at the network deadline without unverified fallback', async () => {
  const h = harness({ fetchImpl: () => new Promise(() => {}) }); const event = h.dispatch(scope, { mode: 'navigate' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.timers.size, 1); [...h.timers.values()][0].fn(); assert.equal((await event.result).status, 503); assert.equal(h.fetches[0][1].signal.aborted, true);
});

test('offline engine and optional assets preserve the existing cache safety net and status handshake', async () => {
  const optional = scope + 'assets/optional-one.js', h = harness({ online: false, values: new Map([[release + ':' + engine, response('offline engine')], ['earth-observer-assets-v2:' + optional, response('saved optional', optional)]]), fetchImpl() { assert.fail('Offline fetch'); } });
  const event = h.dispatch(engine); assert.equal(await (await event.result).text(), 'offline engine'); await settled(event); assert.equal(await (await h.dispatch(optional).result).text(), 'saved optional'); assert.equal(h.fetches.length, 0); assert.match(h.messages[0].message, /offline storage/);
  const handshake = []; h.listeners.get('message')({ data: { type: 'earth-observer:shell-status' }, source: { id: 'page', postMessage(message) { handshake.push(message); } } }); assert.equal(handshake[0].message, h.messages[0].message);
});

test('document identity responds only to the requesting in-scope window with fixed public identity, no acquisition, cache access or private payload', () => {
  const identity = 'a'.repeat(64), h = harness({ documentIdentity: identity }), replies = [];
  const request = { type: 'earth-observer:document-identity', schemaVersion: 1, requestId: 'b'.repeat(32), scope };
  const client = { id: 'page', type: 'window', url: origin + scope + '#v=3&lat=50', postMessage(value) { replies.push(value); } };
  const message = (data = request, source = client, from = origin) => h.listeners.get('message')({ data, source, origin: from });
  message(); assert.equal(replies.length, 1); assert.equal(JSON.stringify(replies[0]), JSON.stringify({ ...request, identity }));
  for (const [data, source, from] of [[{ ...request, scope: '/' }, client], [{ ...request, requestId: 'wrong' }, client], [{ ...request, secret: 'private' }, client],
    [request, { ...client, type: 'serviceworker' }], [request, { ...client, url: origin + '/earth/private' }], [request, { ...client, url: origin + scope + '?session=private' }],
    [request, { ...client, url: 'https://other.example/earth/' }], [request, client, 'https://other.example']]) message(data, source, from);
  assert.equal(replies.length, 1); assert.equal(h.fetches.length, 0); assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
  const legacy = harness(); legacy.listeners.get('message')({ data: request, source: client, origin }); assert.equal(replies.length, 1);
  assert.throws(() => renderServiceWorker({ critical: [scope], version: 'fixture', scope, documentIdentity: [identity] }), /fixed document identity/);
});

test('a complete new release retains one matching offline document without persisting newer request-specific navigation', async () => {
  const values = new Map(), nextHtml = html.replace('public globe', 'updated public globe');
  await harness({ values }).install();
  const requestHtml = nextHtml + '<script>request-specific</script>';
  const old = harness({ values, fetchImpl: async () => response(requestHtml, scope, { 'content-type': 'text/html' }) });
  const oldEvent = old.dispatch(scope, { mode: 'navigate' }); assert.equal(await (await oldEvent.result).text(), requestHtml); await settled(oldEvent);
  const nextShell = publicShellAsset({ html: nextHtml, version: 'next', scope });
  const next = harness({ values, version: 'next', shell: nextShell }); await next.install(); await next.activate();
  assert.equal(next.activated, 1); assert.equal(next.claimed, 1);
  const offline = harness({ values, version: 'next', shell: nextShell, online: false });
  const event = offline.dispatch(scope, { mode: 'navigate' }); assert.equal(await (await event.result).text(), nextHtml); await settled(event);
  assert.equal(await values.get(release + ':' + scope).clone().text(), html); assert.equal(next.deleted.length, 0);
});

test('completion metadata appears only after all successful writes and adds no network acquisition', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const h = harness({ putImpl: request => request === engine ? gate : undefined });
  const work = h.install(); await new Promise(resolve => setImmediate(resolve));
  assert.equal([...h.values.keys()].some(key => key.endsWith('__earth-shell-complete__')), false); assert.equal(h.activated, 0);
  finish(); await work;
  const marker = h.values.get(release + ':/earth/__earth-shell-complete__');
  assert.deepEqual(await marker.clone().json(), { schema: 1, release: 'fixture', critical: [scope, engine, scope + 'assets/main-one.js'], htmlDigest: asset.descriptor.htmlDigest });
  assert.equal(h.fetches.length, 3);
});

test('failed installs wait for late writes before cleanup, so a partial release cannot reappear after deletion', async () => {
  let finish; const gate = new Promise(resolve => { finish = resolve; }), late = scope + 'assets/main-late.js';
  const h = harness({ critical: [scope, engine, late], putImpl: request => request === late ? gate : undefined,
    fetchImpl: async request => { const path = typeof request === 'string' ? request : new URL(request.url).pathname; return path === engine ? new Response('failed', { status: 503 }) : response(path === asset.descriptor.url ? asset.body : 'main', path, { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/javascript' }); } });
  const work = h.install(), rejected = assert.rejects(work, /Essential public shell asset/); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.deleted.length, 0); assert.equal(h.activated, 0); assert.equal([...h.values.keys()].some(key => key.endsWith('__earth-shell-complete__')), false);
  finish(); await rejected; assert.deepEqual(h.deleted, [release]); assert.equal(h.values.size, 0);
});

test('a marker write failure removes the new partial cache, while a failed reinstall preserves known complete assets', async () => {
  const failure = harness({ putImpl: request => { if (String(request).endsWith('__earth-shell-complete__')) throw new Error('Storage quota'); } });
  await assert.rejects(failure.install(), /Storage quota/); assert.equal(failure.values.size, 0); assert.equal(failure.activated, 0);
  const values = new Map(), initial = harness({ values }); await initial.install();
  const repair = harness({ values, fetchImpl: async request => { const path = typeof request === 'string' ? request : new URL(request.url).pathname; return path === engine ? new Response('unavailable', { status: 503 }) : response(path === asset.descriptor.url ? asset.body : 'main', path, { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/javascript' }); } });
  await assert.rejects(repair.install(), /Essential public shell asset/); assert.equal(repair.deleted.length, 0);
  assert.equal(await values.get(release + ':' + engine).clone().text(), 'public asset'); assert.equal(values.has(release + ':/earth/__earth-shell-complete__'), true);
});

test('an updated worker restores an exact old app chunk from one complete prior release after network 404', async () => {
  const oldChunk = scope + 'assets/main-old.js', currentChunk = scope + 'assets/main-current.js', values = new Map();
  await harness({ values, critical: [scope, engine, oldChunk] }).install();
  const current = harness({ values, version: 'current', critical: [scope, engine, currentChunk], shell: publicShellAsset({ html: html + 'new', version: 'current', scope }) });
  await current.install(); await current.activate();
  const worker = harness({ values, version: 'current', shell: publicShellAsset({ html: html + 'new', version: 'current', scope }), fetchImpl: async () => new Response('not found', { status: 404 }) });
  assert.equal(await (await worker.dispatch(oldChunk).result).text(), 'public asset'); assert.equal(worker.fetches.length, 1); assert.equal(worker.writes.length, 0);
  assert.equal((await worker.dispatch(oldChunk + '?private=value').result).status, 404);
  assert.equal((await worker.dispatch(scope + 'assets/not-in-prior.js').result).status, 404);
  assert.equal(worker.dispatch(oldChunk, { headers: { authorization: 'Bearer private' } }).result, undefined);
  assert.equal(worker.dispatch(oldChunk, { mode: 'navigate' }).result, undefined);
  values.delete('earth-observer-shell-v3-current:' + scope);
  assert.equal((await worker.dispatch(scope, { mode: 'navigate' }).result).status, 404); // Prior HTML cannot restore the document.
});

test('prior asset fallback refuses unmarked or malformed releases and HTML stored under an app chunk path', async () => {
  const oldChunk = scope + 'assets/main-old.js', currentAsset = publicShellAsset({ html: html + 'new', version: 'current', scope });
  for (const change of ['missing-marker', 'wrong-release', 'api-route', 'html-asset', 'private-asset']) {
    const values = new Map(); await harness({ values, critical: [scope, engine, oldChunk] }).install();
    const markerKey = release + ':/earth/__earth-shell-complete__';
    if (change === 'missing-marker') values.delete(markerKey);
    if (change === 'wrong-release' || change === 'api-route') {
      const marker = await values.get(markerKey).clone().json();
      if (change === 'wrong-release') marker.release = 'unknown'; else marker.critical.push(scope + 'api/evidence/session');
      values.set(markerKey, new Response(JSON.stringify(marker), { headers: { 'content-type': 'application/json' } }));
    }
    if (change === 'html-asset') values.set(release + ':' + oldChunk, response('private HTML', oldChunk, { 'content-type': 'text/html' }));
    if (change === 'private-asset') values.set(release + ':' + oldChunk, response('private asset', oldChunk, { 'content-type': 'application/javascript', 'cache-control': 'private' }));
    const current = harness({ values, version: 'current', shell: currentAsset }); await current.install();
    const worker = harness({ values, version: 'current', shell: currentAsset, fetchImpl: async () => new Response('not found', { status: 404 }) });
    assert.equal((await worker.dispatch(oldChunk).result).status, 404, change);
  }
});

test('activation keeps exactly current plus one complete prior release and prunes failed/legacy/older caches', async () => {
  const values = new Map();
  for (const version of ['one', 'two']) {
    const h = harness({ values, version, shell: publicShellAsset({ html: html + version, version, scope }) }); await h.install(); await h.activate();
  }
  values.set('earth-observer-shell-v3-partial:' + engine, response('partial')); values.set('earth-observer-shell-legacy:' + scope, response('visitor HTML', scope));
  const current = harness({ values, version: 'three', shell: publicShellAsset({ html: html + 'three', version: 'three', scope }) }); await current.install(); await current.activate();
  assert.deepEqual([...new Set([...values.keys()].map(key => key.split(':')[0]))].sort(), ['earth-observer-shell-v3-three', 'earth-observer-shell-v3-two']);
  assert.equal(current.fetches.length, 3);
});
