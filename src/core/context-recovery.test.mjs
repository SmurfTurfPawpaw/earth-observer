import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installContextRecovery } from './context-recovery.js';

function fixture() {
  const canvas = new EventTarget(), calls = [], removals = [];
  const remove = canvas.removeEventListener.bind(canvas);
  canvas.removeEventListener = (...args) => { removals.push(args[0]); remove(...args); };
  let loop = true, destroyed = false;
  const viewer = { scene: { canvas }, get useDefaultRenderLoop() { return loop; }, set useDefaultRenderLoop(value) { assert.equal(destroyed, false, 'Disposed viewer was touched'); loop = value; calls.push(value); } };
  return { viewer, canvas, calls, removals, destroyViewer() { destroyed = true; }, event(type) { const event = new Event(type, { cancelable: true }); canvas.dispatchEvent(event); return event; } };
}

test('loss allows native context restoration and stops the render loop before reporting reload guidance', () => {
  const f = fixture(), errors = [];
  const recovery = installContextRecovery(f.viewer, { onLost(error) { assert.equal(f.viewer.useDefaultRenderLoop, false); assert.equal(recovery.isLost(), true); errors.push(error); } });
  assert.equal(recovery.isLost(), false); assert.equal(f.calls.length, 0);
  const event = f.event('webglcontextlost'); assert.equal(event.defaultPrevented, true);
  assert.equal(errors.length, 1); assert.equal(errors[0].name, 'GraphicsContextError'); assert.equal(errors[0].code, 'EARTH_WEBGL_CONTEXT_LOST'); assert.match(errors[0].message, /Reload to rebuild/);
  recovery.destroy();
});

test('restoration keeps the viewer stopped and the visibility guard latched; it never claims a rebuilt globe', () => {
  const f = fixture(), restored = [], recovery = installContextRecovery(f.viewer, { onRestored: error => restored.push(error) });
  f.event('webglcontextlost');
  f.viewer.useDefaultRenderLoop = true; // Simulate another controller before the restoration event.
  f.event('webglcontextrestored'); assert.equal(f.viewer.useDefaultRenderLoop, false); assert.equal(recovery.isLost(), true);
  assert.equal(restored.length, 1); assert.equal(restored[0].code, 'EARTH_WEBGL_CONTEXT_RESTORED_RELOAD_REQUIRED'); assert.match(restored[0].message, /Reload to rebuild/);
  recovery.destroy();
});

test('duplicate loss/restoration events report each state once while keeping rendering stopped', () => {
  const f = fixture(), states = [], recovery = installContextRecovery(f.viewer, { onLost: () => states.push('lost'), onRestored: () => states.push('restored') });
  assert.equal(f.event('webglcontextlost').defaultPrevented, true); assert.equal(f.event('webglcontextlost').defaultPrevented, true);
  f.event('webglcontextrestored'); f.viewer.useDefaultRenderLoop = true; f.event('webglcontextrestored');
  assert.deepEqual(states, ['lost', 'restored']); assert.equal(f.viewer.useDefaultRenderLoop, false); assert.equal(recovery.isLost(), true);
  recovery.destroy();
});

test('a restoration event without a preceding loss does not stop a healthy viewer or report recovery', () => {
  const f = fixture(), recovery = installContextRecovery(f.viewer, { onRestored() { assert.fail('Unexpected restoration callback'); } });
  f.event('webglcontextrestored'); assert.equal(recovery.isLost(), false); assert.equal(f.viewer.useDefaultRenderLoop, true); assert.equal(f.calls.length, 0);
  recovery.destroy();
});

test('idempotent disposal removes both listeners and late events cannot access a disposed viewer', () => {
  const f = fixture(), recovery = installContextRecovery(f.viewer, { onLost() { assert.fail('Disposed loss callback'); }, onRestored() { assert.fail('Disposed restoration callback'); } });
  recovery.destroy(); recovery.destroy(); f.destroyViewer();
  assert.deepEqual(f.removals, ['webglcontextlost', 'webglcontextrestored']);
  assert.equal(f.event('webglcontextlost').defaultPrevented, false); f.event('webglcontextrestored'); assert.equal(f.calls.length, 0); assert.equal(recovery.isLost(), false);
});

test('disposing after a loss leaves the loop stopped and does not produce a late restoration callback', () => {
  const f = fixture(), recovery = installContextRecovery(f.viewer, { onRestored() { assert.fail('Late restoration callback'); } });
  f.event('webglcontextlost'); recovery.destroy(); f.destroyViewer(); f.event('webglcontextrestored');
  assert.equal(recovery.isLost(), true); assert.equal(f.viewer.useDefaultRenderLoop, false); assert.deepEqual(f.calls, [false]);
});

test('invalid canvas or callback contracts fail before attaching listeners', () => {
  assert.throws(() => installContextRecovery({}), /graphics canvas/);
  assert.throws(() => installContextRecovery(fixture().viewer, { onLost: null }), /callbacks/);
});
