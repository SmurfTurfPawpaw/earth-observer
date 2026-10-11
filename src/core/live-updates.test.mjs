import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveUpdates, collectionRevision } from './live-updates.js';

const revision = (at = '2026-10-11T13:00:00.000Z') => ({ schemaVersion: 1, collectedAt: at,
  inputDigest: 'a'.repeat(64), recordCount: 350, revision: `${at}:${'a'.repeat(64)}` });
function fixture() {
  const streams = [], timers = new Map(), doc = new EventTarget(), win = new EventTarget(); let timerId = 0, online = true;
  class Source extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; streams.push(this); }
    close() { this.closed = true; }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(value, kind = 'collection') { this.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(value) })); }
    fail(terminal = false) { this.readyState = terminal ? 2 : 0; this.dispatchEvent(new Event('error')); }
  }
  doc.hidden = false;
  const updates = createLiveUpdates({ url: '/earth/api/updates', EventSourceImpl: Source, documentRef: doc,
    windowRef: win, online: () => online, setTimeoutImpl(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeoutImpl(id) { timers.delete(id); } });
  return { updates, streams, timers, doc, win, offline() { online = false; win.dispatchEvent(new Event('offline')); },
    reconnect() { online = true; win.dispatchEvent(new Event('online')); } };
}

test('one continuous connection fans out revisions, rejects invalid/regressed metadata, and resumes newest data', () => {
  const f = fixture(), seen = [], other = [];
  f.updates.subscribe((value) => seen.push(value)); f.updates.subscribe((value) => other.push(value));
  f.updates.start(); f.updates.start(); assert.equal(f.streams.length, 1);
  const first = f.streams[0]; assert.equal(first.url, '/earth/api/updates'); first.open();
  first.send(revision()); first.send(revision());
  first.send({ ...revision(), revision: 'wrong' }); first.send(revision('2026-10-11T12:59:00.000Z'));
  assert.equal(seen.filter(({ type }) => type === 'collection').length, 1); assert.deepEqual(seen, other);
  first.fail(); assert.equal(f.streams.length, 1); assert.equal(f.timers.size, 0, 'Native reconnect owns a recoverable stream');
  first.open(); first.send(revision('2026-10-11T13:01:00.000Z'));
  const resumed = []; f.updates.subscribe((value) => resumed.push(value));
  assert.equal(resumed[0].status, 'connected'); assert.equal(resumed[1].collectedAt, '2026-10-11T13:01:00.000Z');
  assert.equal(collectionRevision({ ...revision(), recordCount: 501 }), null);
  f.updates.destroy(); assert.equal(first.closed, true);
});

test('hidden/offline/destroy dispose transports and reject late events; terminal failures retry without overlap', () => {
  const f = fixture(), seen = []; f.updates.subscribe((value) => seen.push(value)); f.updates.start();
  const first = f.streams[0]; first.open(); first.fail(true);
  assert.equal(first.closed, true); assert.equal(f.timers.size, 1);
  f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(f.timers.size, 0);
  first.send(revision()); assert.equal(seen.some(({ type }) => type === 'collection'), false);
  f.doc.hidden = false; f.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(f.streams.length, 2);
  f.offline(); assert.equal(f.streams[1].closed, true); assert.equal(f.updates.getState().status, 'offline');
  f.reconnect(); assert.equal(f.streams.length, 3); f.streams[2].fail(true);
  const retry = [...f.timers.values()][0]; f.timers.clear(); retry.fn(); assert.equal(f.streams.length, 4);
  f.updates.destroy(); f.reconnect(); f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.streams.length, 4); assert.equal(f.streams[3].closed, true); assert.equal(f.timers.size, 0);
});

test('aircraft revisions have independent monotonic dates and bounds without refreshing intelligence consumers', () => {
  const f = fixture(), seen = [];
  f.updates.subscribe((event) => seen.push(event)); f.updates.start();
  const stream = f.streams[0]; stream.open(); stream.send(revision());
  const earlier = { ...revision('2026-10-11T12:59:00.000Z'), recordCount: 1200 };
  stream.send(earlier, 'aircraft'); stream.send(earlier, 'aircraft');
  stream.send({ ...earlier, inputDigest: 'b'.repeat(64), revision: `${earlier.collectedAt}:${'b'.repeat(64)}` }, 'aircraft');
  stream.send({ ...revision('2026-10-11T12:58:00.000Z'), recordCount: 1200 }, 'aircraft');
  stream.send({ ...revision('2026-10-11T13:02:00.000Z'), recordCount: 2001 }, 'aircraft');
  assert.equal(seen.filter(({ type }) => type === 'collection').length, 1);
  assert.equal(seen.filter(({ type }) => type === 'aircraft').length, 1);
  const resumed = []; f.updates.subscribe((event) => resumed.push(event));
  assert.deepEqual(resumed.map(({ type }) => type), ['status', 'collection', 'aircraft']);
  assert.equal(resumed[2].collectedAt, earlier.collectedAt);
  assert.equal(f.updates.getState().aircraft.recordCount, 1200);
  f.updates.destroy();
});
