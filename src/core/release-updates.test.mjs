import test from 'node:test';
import assert from 'node:assert/strict';
import { installReleaseUpdates, RELEASE_CHECK_MS, RELEASE_IDENTITY_MS, RELEASE_IDENTITY_ATTEMPTS } from './release-updates.js';

function events() {
  const listeners = new Map();
  return { listeners, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); }, emit(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); } };
}
function fixture({ firstInstall = false, failure = false, documentIdentity = 'a'.repeat(64), workerIdentity = 'b'.repeat(64), replyIdentity = true } = {}) {
  let time = 0, id = 0, reloads = 0, updateCalls = 0; const timers = new Map(), registrations = [];
  const identityRequests = [], old = { scriptURL: 'https://example.com/earth/sw.js' }, next = { scriptURL: old.scriptURL,
    postMessage(value) { identityRequests.push(value); if (replyIdentity) reply({ identity: workerIdentity }); } };
  const registration = { installing: null, async update() { updateCalls++; } };
  const serviceWorker = { ...events(), controller: firstInstall ? null : old, async register(url, options) { registrations.push({ url, options }); if (failure) throw new Error('Offline'); return registration; } };
  const notice = { hidden: true }, draft = { type: 'text', value: '', defaultValue: '' };
  const nodes = { notification: notice, 'earth-timeline': { open: false, dataset: { mode: 'live' } }, 'news-panel': { hidden: true }, selection: { hidden: true } };
  const metas = documentIdentity === null ? [] : [{ getAttribute: () => documentIdentity }];
  const documentRef = { ...events(), hidden: false, activeElement: null, querySelectorAll: selector => selector.startsWith('meta[') ? metas : [draft], getElementById: id => nodes[id] };
  const windowRef = events(), navigatorRef = { onLine: true }, locationRef = { origin: 'https://example.com', href: 'https://example.com/earth/#v=3&lat=50&lon=4', pathname: '/earth/', reload() { reloads++; } };
  const timing = { setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    advance(ms) { time += ms; for (const [id, item] of [...timers]) if (item.at <= time && timers.delete(id)) item.fn(); } };
  function reply(patch = {}, source = next, origin = 'https://example.com') {
    // Native MessageEvent getters hold data/origin. Node has no ServiceWorker
    // MessageEventSource, so only that exact worker reference is a fixture.
    const value = identityRequests.at(-1), event = new MessageEvent('message', { origin, data: { ...value, identity: workerIdentity, ...patch } });
    Object.defineProperty(event, 'source', { value: source }); serviceWorker.emit('message', event);
  }
  const updater = installReleaseUpdates({ serviceWorker, documentRef, windowRef, locationRef, navigatorRef, scope: '/earth/', now: () => time, ...timing });
  return { serviceWorker, documentRef, windowRef, navigatorRef, locationRef, timing, updater, registrations, registration, timers, old, next, draft, notice,
    nodes, metas, identityRequests, reply,
    reloads: () => reloads, updates: () => updateCalls };
}
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

test('an early nonblocking registration bypasses worker-script HTTP cache and adopts one completed replacement without rewriting URL/hash', async () => {
  const f = fixture(); assert.equal(f.registrations.length, 1); await settle();
  assert.deepEqual(f.registrations[0], { url: '/earth/sw.js', options: { scope: '/earth/', updateViaCache: 'none' } });
  const href = f.locationRef.href; f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange'); f.serviceWorker.emit('controllerchange');
  assert.equal(f.reloads(), 1); assert.equal(f.locationRef.href, href); assert.equal(f.timers.size, 0); f.updater.destroy();
});

test('a first installation, unchanged controller, or another worker cannot trigger a boot loop', async () => {
  const fresh = fixture({ firstInstall: true }); await settle(); fresh.serviceWorker.controller = fresh.next; fresh.serviceWorker.emit('controllerchange'); assert.equal(fresh.reloads(), 0); fresh.updater.destroy();
  const f = fixture(); await settle(); f.serviceWorker.emit('controllerchange'); assert.equal(f.reloads(), 0);
  f.serviceWorker.controller = { scriptURL: 'https://example.com/sw.js' }; f.serviceWorker.emit('controllerchange'); assert.equal(f.reloads(), 0); f.updater.destroy();
});

test('an update waits for focused text and unsaved notebook values instead of discarding a draft', async () => {
  const f = fixture(); await settle(); f.documentRef.activeElement = { closest: () => ({}) }; f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange');
  assert.equal(f.reloads(), 0); assert.equal(f.notice.hidden, false); assert.match(f.notice.textContent, /Finish or save/);
  f.documentRef.activeElement = null; f.draft.value = 'Unstored observation'; f.documentRef.emit('focusout'); f.timing.advance(0); assert.equal(f.reloads(), 0);
  f.draft.value = ''; f.documentRef.emit('input'); f.timing.advance(0); assert.equal(f.reloads(), 1); f.timing.advance(1000); assert.equal(f.reloads(), 1); f.updater.destroy();
});

test('saved notes held only in tab memory cannot be discarded by automatic adoption', async () => {
  const f = fixture(); await settle(); const status = { textContent: 'Saved for this open tab only: browser storage is unavailable.' };
  f.documentRef.querySelector = () => status; f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange');
  assert.equal(f.reloads(), 0); assert.match(f.notice.textContent, /Export your temporary notes/); f.timing.advance(1000); assert.equal(f.reloads(), 0);
  status.textContent = 'Evidence pack exported.'; f.documentRef.emit('change'); f.timing.advance(0); assert.equal(f.reloads(), 1); f.updater.destroy();
});

test('background checks are bounded, hidden/offline pages stop work, and a completed hidden update waits for visibility', async () => {
  const f = fixture(); await settle(); f.timing.advance(RELEASE_CHECK_MS); await settle(); assert.equal(f.updates(), 1);
  f.documentRef.hidden = true; f.documentRef.emit('visibilitychange'); assert.equal(f.timers.size, 0); f.timing.advance(RELEASE_CHECK_MS); assert.equal(f.updates(), 1);
  f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange'); assert.equal(f.reloads(), 0);
  f.documentRef.hidden = false; f.documentRef.emit('visibilitychange'); assert.equal(f.reloads(), 1); f.updater.destroy();
  const offline = fixture(); await settle(); offline.navigatorRef.onLine = false; offline.timing.advance(RELEASE_CHECK_MS); await settle(); assert.equal(offline.updates(), 0);
  offline.navigatorRef.onLine = true; offline.windowRef.emit('online'); await settle(); assert.equal(offline.updates(), 1); offline.updater.destroy();
});

test('registration failures preserve the running document and disposal owns only listeners and timers', async () => {
  const f = fixture({ failure: true }); await settle(); assert.equal(f.reloads(), 0); assert.equal(f.timers.size, 1);
  f.windowRef.emit('pagehide', { persisted: true }); assert.equal(f.timers.size, 0);
  f.windowRef.emit('pageshow', { persisted: true }); await settle(); assert.equal(f.registrations.length, 2);
  f.updater.destroy(); assert.equal(f.timers.size, 0); assert.equal(f.serviceWorker.listeners.get('controllerchange').size, 0);
  f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange'); assert.equal(f.reloads(), 0);
});

test('an already-current online document ignores controller replacement, including backend-only releases, while genuine older UI adopts once', async () => {
  const current = fixture({ workerIdentity: 'a'.repeat(64) }); await settle();
  current.serviceWorker.controller = current.next; current.serviceWorker.emit('controllerchange'); current.serviceWorker.emit('controllerchange');
  assert.equal(current.reloads(), 0); assert.equal(current.identityRequests.length, 1); assert.equal(current.notice.hidden, true);
  assert.equal(current.timers.size, 1, 'only the ordinary five-minute release check remains'); current.updater.destroy();
  const older = fixture(); await settle(); older.serviceWorker.controller = older.next; older.serviceWorker.emit('controllerchange');
  assert.equal(older.reloads(), 1); assert.equal(older.timers.size, 0); older.updater.destroy();
});

test('a verified older UI preserves Context, selected dossiers, expanded calendar and both playing or paused historical exploration until closing/Live', async () => {
  for (const mode of ['context', 'selection', 'calendar', 'playing', 'paused']) {
    const f = fixture(); await settle(); const calendar = f.nodes['earth-timeline'];
    if (mode === 'context') f.nodes['news-panel'].hidden = false;
    else if (mode === 'selection') f.nodes.selection.hidden = false;
    else if (mode === 'calendar') calendar.open = true;
    else { calendar.dataset.mode = 'history'; calendar.dataset.playing = String(mode === 'playing'); }
    f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange'); assert.equal(f.reloads(), 0, mode);
    assert.match(f.notice.textContent, /Close the open context or calendar/); assert.equal(f.timers.size, 1, 'no permanent adoption polling');
    f.nodes['news-panel'].hidden = true; f.nodes.selection.hidden = true; calendar.open = false;
    if (['playing', 'paused'].includes(mode)) {
      f.documentRef.emit('toggle'); f.timing.advance(0); assert.equal(f.reloads(), 0, 'closing the calendar alone preserves historical time');
      calendar.dataset.mode = 'live'; f.windowRef.emit('earth-observer:timechange');
    } else f.documentRef.emit(mode === 'calendar' ? 'toggle' : 'earth-observer:panel');
    f.timing.advance(0); assert.equal(f.reloads(), 1); f.updater.destroy();
  }
});

test('native identity messages require exact current controller, request, scope, origin, bounded fields and deadline; unknown stays quiet', async () => {
  const f = fixture({ replyIdentity: false, workerIdentity: 'a'.repeat(64) }); await settle();
  f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange');
  for (const [patch, source, origin] of [[{}, f.old], [{ requestId: 'f'.repeat(32) }], [{ scope: '/' }], [{ identity: ['a'.repeat(64)] }],
    [{ identity: 'invalid' }], [{ extra: 'unreviewed' }], [{ schemaVersion: 2 }], [{ type: 'foreign' }], [{}, f.next, 'https://elsewhere.example']]) f.reply(patch, source, origin);
  assert.equal(f.reloads(), 0); assert.equal(f.timers.size, 2); f.reply(); assert.equal(f.reloads(), 0); assert.equal(f.timers.size, 1); f.updater.destroy();
  for (const options of [{ replyIdentity: false }, { documentIdentity: null }, { documentIdentity: 'invalid' }]) {
    const unknown = fixture(options); await settle(); unknown.serviceWorker.controller = unknown.next; unknown.serviceWorker.emit('controllerchange');
    unknown.timing.advance(RELEASE_IDENTITY_MS); assert.equal(unknown.reloads(), 0); assert.equal(unknown.notice.hidden, true);
    unknown.reply(); unknown.serviceWorker.emit('controllerchange'); unknown.documentRef.emit('change'); unknown.timing.advance(1000);
    assert.equal(unknown.reloads(), 0); assert.equal(unknown.identityRequests.length, 1); assert.equal(unknown.timers.size, 1); unknown.updater.destroy();
  }
});

test('a missed reply recovers on a bounded same-controller check and same UI never shows a speculative notice', async () => {
  const f = fixture({ replyIdentity: false, workerIdentity: 'a'.repeat(64) }); await settle();
  f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange'); const first = f.identityRequests[0];
  f.timing.advance(RELEASE_IDENTITY_MS); assert.equal(f.notice.hidden, true); assert.equal(f.reloads(), 0);
  f.next.postMessage = value => { f.identityRequests.push(value); f.reply(); };
  f.timing.advance(RELEASE_CHECK_MS); await settle();
  assert.equal(f.identityRequests.length, 2); assert.notEqual(f.identityRequests[1].requestId, first.requestId);
  assert.equal(f.reloads(), 0); assert.equal(f.notice.hidden, true);
  f.timing.advance(RELEASE_CHECK_MS); await settle(); assert.equal(f.identityRequests.length, 2, 'Verified controller needs no repeated identity exchange');
  f.updater.destroy();
});

test('unresponsive identity attempts stop at two and hidden/offline retry waits without clearing another error', async () => {
  const f = fixture({ replyIdentity: false }); await settle(); f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange');
  f.notice.textContent = 'A retained source could not load.'; f.notice.hidden = false;
  f.timing.advance(RELEASE_IDENTITY_MS); assert.equal(f.notice.hidden, false); assert.equal(f.reloads(), 0);
  f.documentRef.hidden = true; f.documentRef.emit('visibilitychange'); f.timing.advance(RELEASE_CHECK_MS); await settle();
  assert.equal(f.identityRequests.length, 1); assert.equal(f.updates(), 0);
  f.documentRef.hidden = false; f.navigatorRef.onLine = false; f.documentRef.emit('visibilitychange'); await settle();
  assert.equal(f.identityRequests.length, 1); assert.equal(f.reloads(), 0);
  f.navigatorRef.onLine = true; f.windowRef.emit('online'); await settle(); assert.equal(f.identityRequests.length, RELEASE_IDENTITY_ATTEMPTS);
  f.timing.advance(RELEASE_IDENTITY_MS);
  for (let check = 0; check < 3; check++) { f.timing.advance(RELEASE_CHECK_MS); await settle(); }
  assert.equal(f.identityRequests.length, 2); assert.equal(f.reloads(), 0);
  assert.equal(f.notice.hidden, false); assert.equal(f.notice.textContent, 'A retained source could not load.');
  f.updater.destroy(); assert.equal(f.notice.hidden, false); assert.equal(f.timers.size, 0);
});

test('controller swaps cancel older replies and same-UI confirmation removes only updater-owned notice', async () => {
  for (const otherError of [false, true]) {
    const f = fixture(); await settle(); f.draft.value = 'Retain this investigation';
    f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange'); assert.equal(f.notice.hidden, false); assert.equal(f.reloads(), 0);
    if (otherError) f.notice.textContent = 'The map source is unavailable.';
    const replacement = { scriptURL: f.next.scriptURL, postMessage(value) { f.identityRequests.push(value); } };
    f.serviceWorker.controller = replacement; f.serviceWorker.emit('controllerchange');
    f.reply({ identity: 'b'.repeat(64) }, f.next); assert.equal(f.reloads(), 0, 'Previous owned worker cannot confirm current UI');
    f.reply({ identity: 'a'.repeat(64) }, replacement);
    assert.equal(f.draft.value, 'Retain this investigation'); assert.equal(f.reloads(), 0);
    assert.equal(f.notice.hidden, !otherError);
    if (otherError) assert.equal(f.notice.textContent, 'The map source is unavailable.');
    f.updater.destroy();
  }
});

test('first installation becomes a baseline and a later verified update still preserves offline exploration', async () => {
  const f = fixture({ firstInstall: true }); await settle(); f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange');
  assert.equal(f.reloads(), 0); assert.equal(f.identityRequests.length, 0);
  const replacement = { scriptURL: f.next.scriptURL, postMessage(value) { f.identityRequests.push(value); f.reply({}, replacement); } };
  f.navigatorRef.onLine = false; f.serviceWorker.controller = replacement; f.serviceWorker.emit('controllerchange');
  assert.equal(f.identityRequests.length, 1); assert.equal(f.reloads(), 0, 'Verified different UI cannot force an offline navigation');
  f.nodes['earth-timeline'].dataset.mode = 'history'; f.navigatorRef.onLine = true; f.windowRef.emit('online'); await settle();
  assert.equal(f.reloads(), 0); assert.match(f.notice.textContent, /return to Live/);
  f.nodes['earth-timeline'].dataset.mode = 'live'; f.windowRef.emit('earth-observer:timechange'); f.timing.advance(0);
  assert.equal(f.reloads(), 1); f.updater.destroy();
});
