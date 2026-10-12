import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneWork, sceneWorkFor, SCENE_WORK_LIMITS } from './scene-work.js';

function fixture({ onChange } = {}) {
  let time = 0, serial = 0;
  const tasks = new Map(), listeners = new Set(), documentRef = { hidden: false,
    addEventListener(_name, callback) { listeners.add(callback); }, removeEventListener(_name, callback) { listeners.delete(callback); } };
  const work = createSceneWork({ documentRef, now: () => time, onChange,
    schedule(callback) { tasks.set(++serial, callback); return serial; }, cancelSchedule(id) { tasks.delete(id); } });
  return { work, tasks, documentRef, listeners, advance(ms) { time += ms; },
    turn() { const [id, callback] = tasks.entries().next().value || []; if (!callback) return false; tasks.delete(id); callback(); return true; },
    hide() { documentRef.hidden = true; for (const callback of [...listeners]) callback(); } };
}

test('mixed owners share one aggregate four-millisecond task and make fair ordered progress', async t => {
  const f = fixture(), trace = [], promises = [];
  t.after(() => f.work.destroy());
  for (const key of ['fires', 'cameras', 'dams']) {
    const owner = f.work.scope({ key });
    promises.push(owner.prepare([0, 1, 2, 3], (value) => { trace.push(key + value); f.advance(1); return key + value; }));
  }
  assert.equal(f.tasks.size, 1); assert.equal(f.turn(), true);
  assert.deepEqual(trace, ['fires0', 'cameras0', 'dams0', 'fires1']);
  assert.equal(f.work.getState().maxTaskMs, SCENE_WORK_LIMITS.taskBudgetMs);
  while (f.turn()) {}
  assert.deepEqual(await Promise.all(promises), [
    ['fires0', 'fires1', 'fires2', 'fires3'], ['cameras0', 'cameras1', 'cameras2', 'cameras3'], ['dams0', 'dams1', 'dams2', 'dams3']]);
  assert.equal(f.work.getState().totalActivePreparationMs, 12); assert.equal(f.tasks.size, 0);
});

test('oversized indivisible steps and observer overhead are measured without a false hard CPU bound', async t => {
  const observed = []; let f;
  f = fixture({ onChange(state) { observed.push(state); f?.advance(2); } });
  t.after(() => f.work.destroy());
  const owner = f.work.scope({ key: 'indivisible' });
  const result = owner.prepare([1], value => { f.advance(6); return value; });
  f.turn(); assert.deepEqual(await result, [1]);
  assert.equal(owner.getState().workMetrics.activePreparationMs, 6);
  assert.equal(owner.getState().workMetrics.maxPreparationSliceMs, 6);
  assert.equal(owner.getState().workMetrics.nonCooperativeItems, 1);
  assert.ok(f.work.getState().maxTaskMs >= 10, 'task duration includes synchronous observers as well as the item');
  assert.equal(owner.publish(() => { f.advance(7); return 'published'; }), 'published');
  assert.equal(observed.at(-1).workMetrics.commitMs, 7, 'published transition sees the actual commit duration');
  owner.finish(); assert.equal(observed.at(-1).workPhase, 'complete');
  assert.ok(Object.isFrozen(observed.at(-1))); assert.ok(Object.isFrozen(observed.at(-1).workMetrics));
});

test('abort before admission cancels queued work and publication has no side effects', async t => {
  const f = fixture(), controller = new AbortController(); let created = 0, published = 0, discarded = 0;
  t.after(() => f.work.destroy());
  const owner = f.work.scope({ key: 'cancel', signal: controller.signal });
  const result = owner.prepare([1, 2], () => { created++; });
  const rejection = assert.rejects(result, { name: 'AbortError' }); controller.abort(); await rejection;
  assert.equal(f.tasks.size, 0); assert.equal(created, 0);
  assert.throws(() => owner.publish(() => published++, () => discarded++), { name: 'AbortError' });
  assert.equal(published, 0); assert.equal(discarded, 1); assert.equal(owner.getState().workPhase, 'cancelled');
});

test('owner changes between items or after asynchronous native attachment reject late publication', async t => {
  const f = fixture(); let current = true, commits = 0;
  t.after(() => f.work.destroy());
  const first = f.work.scope({ key: 'old', isCurrent: () => current });
  const cancelled = first.prepare([1, 2], value => { current = false; f.advance(1); return value; });
  f.turn(); await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(first.getState().preparedCount, 0);
  current = true;
  const next = f.work.scope({ key: 'attachment', isCurrent: () => current });
  const prepared = next.prepare([1], value => { f.advance(1); return value; }); f.turn(); await prepared;
  const attachment = Promise.withResolvers(); const apply = attachment.promise.then(() => next.publish(() => commits++));
  current = false; attachment.resolve(); await assert.rejects(apply, { name: 'AbortError' }); assert.equal(commits, 0);
});

test('hidden cancellation stays terminal across a visibility return and destruction removes tasks/listeners', async () => {
  const f = fixture(), owner = f.work.scope({ key: 'hidden' });
  const result = owner.prepare([1, 2], value => { f.advance(1); return value; });
  const rejection = assert.rejects(result, { name: 'AbortError' }); f.hide(); await rejection;
  f.documentRef.hidden = false;
  assert.throws(() => owner.prepare([3], value => value), { name: 'AbortError' });
  assert.equal(f.tasks.size, 0); f.work.destroy(); f.work.destroy();
  assert.equal(f.listeners.size, 0); assert.equal(f.work.getState().activeScopes, 0);
  assert.throws(() => f.work.scope({ key: 'late' }), { name: 'AbortError' });
});

test('direct consumers reuse one viewer coordinator; a single finished scope cannot destroy peers', async () => {
  const viewer = {}, tasks = new Map(); let serial = 0;
  const work = sceneWorkFor(viewer, { schedule(callback) { tasks.set(++serial, callback); return serial; }, cancelSchedule(id) { tasks.delete(id); } });
  assert.equal(sceneWorkFor(viewer), work);
  const first = work.scope({ key: 'first' }), second = work.scope({ key: 'second' }); first.finish();
  const prepared = second.prepare([], value => value); assert.deepEqual(await prepared, []);
  assert.equal(second.publish(() => 42), 42); second.finish(); work.destroy();
  assert.equal(work.getState().destroyed, true); assert.equal(work.getState().activeScopes, 0);
});

test('terminal synchronous observers cannot enqueue preparation after destruction or finish', () => {
  for (const empty of [false, true]) {
    let f;
    f = fixture({ onChange(state) { if (state.workPhase === (empty ? 'prepared' : 'queued-prepare')) f.work.destroy(); } });
    const owner = f.work.scope({ key: 'observer-destroy' });
    assert.throws(() => owner.prepare(empty ? [] : [1], value => value), { name: 'AbortError' });
    assert.equal(f.work.getState().queuedPreparations, 0); assert.equal(f.tasks.size, 0); assert.equal(f.work.getState().activeScopes, 0);
  }
});
