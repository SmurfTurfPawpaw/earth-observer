import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_STORAGE_KEY, TEXT_SIZES, readUiState, writeUiState, createCreditLedger, cacheStatus, layerCreditNotices } from './ui-state.js';

const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
};

test('drawer and toolbar preferences survive desktop reload while mobile starts with a closed drawer', () => {
  const storage = memoryStorage();
  assert.equal(readUiState(storage).sidebarOpen, false);
  assert.equal(writeUiState(storage, { sidebarOpen: false, navbarOpen: true, openCategories: ['Weather', 'Space'] }), true);
  assert.deepEqual(readUiState(storage), { version: 1, sidebarOpen: false, navbarOpen: true, textSize: 'normal', openCategories: ['Weather', 'Space'] });
  writeUiState(storage, { sidebarOpen: true, navbarOpen: false });
  assert.equal(readUiState(storage, { mobile: true }).sidebarOpen, false);
  assert.equal(readUiState(storage).sidebarOpen, true);
});

test('supported text sizes survive reload and mobile use; invalid persisted choices fall back to normal', () => {
  const storage = memoryStorage();
  for (const textSize of TEXT_SIZES) {
    writeUiState(storage, { sidebarOpen: true, textSize });
    assert.equal(readUiState(storage).textSize, textSize);
    assert.equal(readUiState(storage, { mobile: true }).textSize, textSize);
  }
  for (const textSize of [null, 2, {}, 'huge', 'large unexpected', '__proto__']) {
    storage.setItem(UI_STORAGE_KEY, JSON.stringify({ version: 1, textSize }));
    assert.equal(readUiState(storage).textSize, 'normal');
    writeUiState(storage, { textSize });
    assert.equal(JSON.parse(storage.getItem(UI_STORAGE_KEY)).textSize, 'normal');
  }
});

test('invalid or unavailable browser storage never prevents usable controls', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readUiState(blocked).sidebarOpen, false);
  assert.equal(writeUiState(blocked, {}), false);
  const storage = memoryStorage();
  storage.setItem(UI_STORAGE_KEY, '{broken');
  assert.equal(readUiState(storage).navbarOpen, false);
  storage.setItem(UI_STORAGE_KEY, JSON.stringify({ version: 99, sidebarOpen: false }));
  assert.equal(readUiState(storage).sidebarOpen, false);
});

test('a shared legal credit remains displayed until the last active layer releases it', () => {
  const calls = [];
  const ledger = createCreditLedger({ addStaticCredit: (credit) => calls.push(['add', credit]), removeStaticCredit: (credit) => calls.push(['remove', credit]) }, (html, onScreen) => ({ html, onScreen }));
  const first = ledger.retain('© OpenStreetMap contributors');
  const second = ledger.retain('© OpenStreetMap contributors');
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  ledger.release(first);
  assert.equal(calls.length, 1);
  ledger.release(second);
  assert.deepEqual(calls.map(([action]) => action), ['add', 'remove']);
  ledger.release(second);
  assert.equal(calls.length, 2);
});

test('short on-screen and detailed source notices have independent ownership and are removed on teardown', () => {
  const removed = [], added = [];
  const ledger = createCreditLedger({ addStaticCredit: (credit) => added.push(credit), removeStaticCredit: (credit) => removed.push(credit) }, (html, onScreen) => ({ html, onScreen }));
  const inline = ledger.retain('ECMWF notice', true);
  const detailed = ledger.retain('ECMWF notice', false);
  ledger.retain('ECMWF notice', false);
  assert.notEqual(inline, detailed);
  assert.equal(added.length, 2);
  ledger.clear();
  assert.deepEqual(removed, [inline, detailed]);
  ledger.clear();
  assert.equal(removed.length, 2);
});

test('cache labels preserve retrieval time without implying a new source observation', () => {
  const stamp = 1783812000000, format = (value) => new Date(value).toISOString();
  const hit = cacheStatus({ browserCache: 'HIT', browserCachedAt: stamp }, format);
  assert.equal(hit.label, 'Cached');
  assert.equal(hit.detail, `Browser copy retrieved ${format(stamp)}`);
  assert.equal(cacheStatus({ browserCache: 'STALE', browserCachedAt: stamp }, format).label, 'Older cache');
  assert.equal(cacheStatus({ browserCache: 'OFFLINE' }, format).label, 'Offline · cached');
  assert.match(cacheStatus({ browserCache: 'OFFLINE' }).detail, /time unavailable/);
  assert.deepEqual(cacheStatus({ observedAt: stamp }), { label: '', detail: '' });
  assert.doesNotMatch(hit.detail, /observed|fresh/i);
});
test('legal notices omit explanatory placeholders while retaining provider credits and detailed licence notices', () => {
  for (const attribution of ['Attribution is shown for the selected agency', 'Attribution is shown for each approved operator', 'Attribution is shown for the selected source']) assert.deepEqual(layerCreditNotices({ attribution }), []);
  assert.deepEqual(layerCreditNotices({ attribution: 'ECMWF CC BY 4.0', detailedAttribution: 'Full ECMWF licence and liability notice' }), [{ html: 'ECMWF CC BY 4.0', onScreen: true }, { html: 'Full ECMWF licence and liability notice', onScreen: false }]);
  assert.deepEqual(layerCreditNotices({ attribution: 'Open Infrastructure Map · © OpenStreetMap contributors · ODbL' }), [{ html: '© OpenStreetMap contributors · ODbL', onScreen: true }, { html: 'Open Infrastructure Map', onScreen: true }]);
});
