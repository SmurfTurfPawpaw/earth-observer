import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneClock } from './scene-clock.js';
import { createSceneWeatherClock } from './scene-weather-clock.js';
import { createWeatherClock } from '../layers/weather/clock.js';

const START = Date.parse('2026-10-11T12:00:00.000Z');
const stamp = (value) => new Date(value).toISOString();
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function environment(t) {
  let wall = START + 120000, mono = 0, serial = 0;
  const timers = new Map();
  const scene = createSceneClock({ now: () => wall, monotonicNow: () => mono, documentRef: null,
    setTimeoutImpl: (callback) => { timers.set(++serial, callback); return serial; }, clearTimeoutImpl: (id) => timers.delete(id), rate: 1 });
  const native = createWeatherClock({ now: () => wall,
    setTimeout: () => { throw new Error('Weather must not start an independent playback timer'); }, clearTimeout() {} });
  const clock = createSceneWeatherClock(native, scene);
  t.after(() => { clock.destroy(); scene.destroy(); });
  return { clock, native, scene, async advance(ms) {
    wall += ms; mono += ms;
    const [id, callback] = timers.entries().next().value || [];
    if (callback) { timers.delete(id); callback(); }
    await settle();
  } };
}

test('one scene clock advances continuously while weather applies only real frame boundaries', async (t) => {
  const env = environment(t), applied = [], times = [stamp(START), stamp(START + 60000)];
  let shown = null, notifications = 0;
  env.clock.register({ id: 'radar', maxGapMs: 300000, getTimes: () => times,
    getShownTime: () => shown, isSuspended: () => false, apply(time) { applied.push(time); shown = time; } });
  await env.clock.setTarget(times[0]); await settle();
  env.clock.subscribe(() => notifications++); env.scene.play(); await settle();
  const work = applied.length, reads = notifications;
  for (let i = 0; i < 50; i++) await env.advance(1000);
  assert.equal(env.scene.getTimeMs(), START + 50000);
  assert.equal(env.clock.getState().target, stamp(START + 50000));
  assert.equal(applied.length, work, 'clock ticks do not perform frame or source work');
  assert.equal(notifications, reads, 'unchanged product controls are not rebuilt each second');
  await env.advance(10000);
  assert.equal(shown, times[1]); assert.equal(applied.length, work + 1);
  assert.equal(env.native.getState().playing, false, 'provider selector owns no playback loop');
});

test('weather controls seek the shared scene and gaps hide frames without a latest-data substitution', async (t) => {
  const env = environment(t), times = [stamp(START), stamp(START + 60000)]; let shown = null;
  env.clock.register({ id: 'radar', maxGapMs: 30000, getTimes: () => times,
    getShownTime: () => shown, isSuspended: () => false, apply(time) { shown = time; } });
  await env.clock.setTarget(stamp(START - 86400000)); await settle();
  assert.equal(shown, null); assert.equal(env.scene.getState().mode, 'history');
  await env.clock.setTarget(stamp(START + 40000)); await settle(); assert.equal(shown, null);
  await env.clock.step(1); await settle();
  assert.equal(env.scene.getTimeMs(), START + 60000); assert.equal(shown, times[1]);
  await env.clock.latest(); await settle();
  assert.equal(env.scene.getState().mode, 'live'); assert.equal(shown, times[1]);
});

test('a newer global seek aborts the old product frame before it can install', async (t) => {
  const env = environment(t), times = [stamp(START), stamp(START + 60000)], waiting = Promise.withResolvers();
  let oldSignal, shown = null;
  env.clock.register({ id: 'radar', maxGapMs: 300000, getTimes: () => times,
    getShownTime: () => shown, isSuspended: () => false,
    async apply(time, { signal }) {
      if (time === times[0]) { oldSignal = signal; await waiting.promise; }
      if (signal.aborted) return false;
      shown = time; return true;
    } });
  const first = env.clock.setTarget(times[0]); await settle(); assert.ok(oldSignal);
  await env.clock.setTarget(times[1]); await settle(); assert.equal(oldSignal.aborted, true);
  waiting.resolve(); await first; await settle(); assert.equal(shown, times[1]);
});
