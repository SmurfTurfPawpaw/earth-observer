import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClock, LIVE_CLOCK_TICK_MS } from './live-clock.js';

function fixture(start = Date.parse('2026-10-11T09:00:00.125Z')) {
  let time = start, id = 0;
  const timers = new Map(), listeners = new Set();
  const documentRef = { hidden: false, addEventListener(_type, fn) { listeners.add(fn); }, removeEventListener(_type, fn) { listeners.delete(fn); } };
  return { timers, listeners, documentRef, now: () => time,
    setTimeoutImpl(fn, ms) { timers.set(++id, { fn, at: time + ms }); return id; }, clearTimeoutImpl(id) { timers.delete(id); },
    advance(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time && timers.delete(id)) timer.fn(); },
    visibility(hidden) { documentRef.hidden = hidden; for (const fn of listeners) fn(); },
  };
}

test('Live UTC is second-aligned and catches up from wall time rather than replaying missed ticks', () => {
  const timing = fixture(), updates = [], clock = createLiveClock(timing);
  clock.subscribe((state) => updates.push(state));
  assert.equal(LIVE_CLOCK_TICK_MS, 1000); assert.equal(updates[0].at, '2026-10-11T09:00:00.125Z');
  timing.advance(874); assert.equal(updates.length, 1);
  timing.advance(1); assert.equal(updates.at(-1).at, '2026-10-11T09:00:01.000Z'); assert.equal(timing.timers.size, 1);
  timing.advance(123456); assert.equal(updates.at(-1).at, '2026-10-11T09:02:04.456Z');
  assert.equal(updates.length, 3, 'A delayed timer paints current time once rather than replaying old seconds');
  assert.equal([...timing.timers.values()][0].at, Date.parse('2026-10-11T09:02:05.000Z'));
  clock.destroy(); assert.equal(timing.timers.size, 0); assert.equal(timing.listeners.size, 0);
});

test('hidden clocks stop work, restore real current UTC, and history retains exact milliseconds without a timer', () => {
  const timing = fixture(), updates = [], clock = createLiveClock(timing);
  const unsubscribe = clock.subscribe((state) => updates.push(state));
  timing.visibility(true); assert.equal(timing.timers.size, 0);
  const beforeSleep = updates.length; timing.advance(3600000); assert.equal(updates.length, beforeSleep);
  timing.visibility(false); assert.equal(updates.at(-1).at, '2026-10-11T10:00:00.125Z'); assert.equal(timing.timers.size, 1);
  clock.setTime('2026-10-11T08:42:13.987Z'); assert.equal(timing.timers.size, 0);
  timing.advance(1800000); timing.visibility(true); timing.visibility(false);
  assert.deepEqual(clock.getState(), { mode: 'history', at: '2026-10-11T08:42:13.987Z' });
  assert.equal(timing.timers.size, 0);
  clock.setTime(); assert.equal(updates.at(-1).at, '2026-10-11T10:30:00.125Z'); assert.equal(timing.timers.size, 1);
  assert.throws(() => clock.setTime('not a date'), /valid UTC/);
  const count = updates.length; unsubscribe(); timing.advance(1000); assert.equal(updates.length, count);
  clock.destroy(); timing.visibility(false); assert.equal(timing.timers.size, 0);
});
