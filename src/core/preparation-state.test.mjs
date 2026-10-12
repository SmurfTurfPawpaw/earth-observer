import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationState, preparationLabel, layerWorkLabel } from './preparation-state.js';
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

test('preparation progress retains displayed readiness and admits only exact bounded pass counts', () => {
  const active = { enabled: true, status: 'ready', settledEnabled: true, refreshing: true,
    count: 41, lastUpdate: 1234, workPhase: 'preparing', preparedCount: 250, preparationTotal: 1000 };
  assert.equal(layerWorkLabel(active), `Preparing data · ${(250).toLocaleString()} / ${(1000).toLocaleString()} records`);
  assert.equal(preparationState({ active }).ready, 1);
  assert.equal(preparationState({ active }).refreshing, 1);
  for (const values of [{ preparedCount: -1 }, { preparedCount: 1001 }, { preparationTotal: null },
    { preparationTotal: Infinity }, { preparedCount: .5 }])
    assert.equal(layerWorkLabel({ ...active, ...values }), 'Preparing data…');
  for (const values of [{ enabled: false }, { timelinePaused: true }, { status: 'paused' },
    { workPhase: 'complete' }, { workPhase: 'cancelled' }, { workPhase: 'error' }])
    assert.equal(layerWorkLabel({ ...active, ...values }), '');
  assert.equal(layerWorkLabel({ ...active, workPhase: 'prepared' }), 'Data prepared · applying update');
});
