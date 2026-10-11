import test from 'node:test';
import assert from 'node:assert/strict';
import { installReleaseUpdates, RELEASE_CHECK_MS } from './release-updates.js';

function events() {
  const listeners = new Map();
  return { listeners, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); }, emit(name, event = {}) { for (const fn of listeners.get(name) || []) fn(event); } };
}
function fixture({ firstInstall = false, failure = false } = {}) {
  let time = 0, id = 0, reloads = 0, updateCalls = 0; const timers = new Map(), registrations = [];
  const old = { scriptURL: 'https://example.com/earth/sw.js' }, next = { scriptURL: old.scriptURL };
  const registration = { installing: null, async update() { updateCalls++; } };
  const serviceWorker = { ...events(), controller: firstInstall ? null : old, async register(url, options) { registrations.push({ url, options }); if (failure) throw new Error('Offline'); return registration; } };
  const notice = { hidden: true }, draft = { type: 'text', value: '', defaultValue: '' };
  const documentRef = { ...events(), hidden: false, activeElement: null, querySelectorAll: () => [draft], getElementById: () => notice };
  const windowRef = events(), navigatorRef = { onLine: true }, locationRef = { origin: 'https://example.com', href: 'https://example.com/earth/#v=3&lat=50&lon=4', pathname: '/earth/', reload() { reloads++; } };
  const timing = { setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    advance(ms) { time += ms; for (const [id, item] of [...timers]) if (item.at <= time && timers.delete(id)) item.fn(); } };
  const updater = installReleaseUpdates({ serviceWorker, documentRef, windowRef, locationRef, navigatorRef, scope: '/earth/', ...timing });
  return { serviceWorker, documentRef, windowRef, navigatorRef, locationRef, timing, updater, registrations, registration, timers, old, next, draft, notice,
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
  f.documentRef.activeElement = null; f.draft.value = 'Unstored observation'; f.timing.advance(1000); assert.equal(f.reloads(), 0);
  f.draft.value = ''; f.timing.advance(1000); assert.equal(f.reloads(), 1); f.timing.advance(1000); assert.equal(f.reloads(), 1); f.updater.destroy();
});

test('saved notes held only in tab memory cannot be discarded by automatic adoption', async () => {
  const f = fixture(); await settle(); const status = { textContent: 'Saved for this open tab only: browser storage is unavailable.' };
  f.documentRef.querySelector = () => status; f.serviceWorker.controller = f.next; f.serviceWorker.emit('controllerchange');
  assert.equal(f.reloads(), 0); assert.match(f.notice.textContent, /Export your temporary notes/); f.timing.advance(1000); assert.equal(f.reloads(), 0);
  status.textContent = 'Evidence pack exported.'; f.timing.advance(1000); assert.equal(f.reloads(), 1); f.updater.destroy();
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
