import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationState, preparationLabel } from './preparation-state.js';
test('requested work is counted once across admission, failure and History suspension', () => {
  const counts = preparationState({
    first: { enabled: true, status: 'ready', settledEnabled: true },
    admission: { enabled: true, status: 'loading', activating: true },
    pending: { enabled: true, status: 'queued', queued: true },
    failed: { enabled: true, status: 'error', settledEnabled: false, error: 'Unavailable' },
    historical: { enabled: true, status: 'paused', timelinePaused: true },
    retained: { enabled: true, status: 'ready', settledEnabled: true, refreshing: true, error: 'Revalidation failed' },
    off: { enabled: false, status: 'error' },
  });
  assert.deepEqual(counts, { selected: 6, ready: 2, loading: 1, queued: 1, unavailable: 1, paused: 1, refreshing: 1, degraded: 1 });
  assert.equal(preparationLabel(counts), '2/6 layers ready · 1 loading · 1 queued · 1 refreshing · 1 unavailable · 1 paused · 1 with older data');
  assert.equal(counts.selected, counts.ready + counts.loading + counts.queued + counts.unavailable + counts.paused);
});
test('unknown requested state stays waiting; empty completed sources are ready without claiming records', () => {
  assert.equal(preparationState({ pending: { enabled: true }, empty: { enabled: true, status: 'ready', count: 0 } }).queued, 1);
  assert.equal(preparationState({ empty: { enabled: true, status: 'ready', count: 0 } }).ready, 1);
  assert.equal(preparationLabel(preparationState({})), '');
  assert.equal(preparationState({ old: { enabled: true, status: 'ready', stale: true }, degraded: { enabled: true, status: 'ready', degraded: true } }).degraded, 2);
});
