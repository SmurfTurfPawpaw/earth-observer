import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceStore, validatePlaceView, PLACES_STORAGE_KEY, MAX_SAVED_PLACES } from './places.js';
const view = { lat: 50.8503, lon: 4.3517, alt: 45000, heading: 15, pitch: -70, roll: 0 };
const storage = () => { const data = new Map(); return { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) }; };

test('named views round-trip locally, rename keeps the saved camera and stable id, delete persists', () => {
  const memory = storage(), store = createPlaceStore(memory, { now: () => 1000, createId: () => 'brussels' });
  const saved = store.save(' Brussels ', view);
  assert.equal(saved.name, 'Brussels');
  saved.view.lat = 0;
  assert.equal(store.get(saved.id).view.lat, view.lat);
  assert.deepEqual(createPlaceStore(memory).get(saved.id).view, view);
  store.rename(saved.id, 'Home area');
  const renamed = createPlaceStore(memory).get(saved.id);
  assert.equal(renamed.name, 'Home area');
  assert.deepEqual(renamed.view, view);
  assert.equal(renamed.createdAt, 1000);
  assert.equal(store.remove(saved.id), true);
  assert.equal(createPlaceStore(memory).list().length, 0);
  assert.equal(store.remove(saved.id), false);
});

test('invalid stored camera values never become a fallback destination or navigation record', () => {
  for (const bad of [{ lat: 91 }, { lon: -181 }, { alt: -1 }, { heading: Infinity }, { pitch: 20 }, { roll: 300 }, { lat: '50' }]) assert.equal(validatePlaceView({ ...view, ...bad }), null);
  const memory = storage();
  memory.setItem(PLACES_STORAGE_KEY, JSON.stringify({ version: 1, places: [{ id: 'bad', name: 'Wrong', view: { ...view, lat: 91 } }] }));
  assert.equal(createPlaceStore(memory).get('bad'), null);
  assert.throws(() => createPlaceStore(memory).save('Bad', { ...view, alt: 0 }), /cannot be saved/);
});

test('blocked writes retain the previous list and never claim a durable save', () => {
  const memory = storage(), first = createPlaceStore(memory, { createId: () => 'one' }); first.save('One', view);
  const blocked = { getItem: memory.getItem, setItem() { throw new Error('quota'); } };
  const store = createPlaceStore(blocked, { createId: () => 'two' });
  assert.throws(() => store.save('Two', view), /could not be saved/);
  assert.equal(store.list().length, 1);
  assert.throws(() => store.remove('one'), /could not be saved/);
  assert.equal(store.get('one').name, 'One');
  assert.throws(() => createPlaceStore(null).save('One', view), /Copy a view link/);
});

test('unreadable or newer saved documents are preserved instead of replaced with defaults', () => {
  for (const raw of ['{broken', JSON.stringify({ version: 9, places: [] })]) {
    const memory = storage(); memory.setItem(PLACES_STORAGE_KEY, raw);
    const store = createPlaceStore(memory);
    assert.throws(() => store.save('New', view), /preserved/);
    assert.equal(memory.getItem(PLACES_STORAGE_KEY), raw);
  }
});

test('the view list is bounded and duplicate stored ids cannot create ambiguous recall', () => {
  let next = 0; const memory = storage(), store = createPlaceStore(memory, { createId: () => `view-${next++}` });
  for (let index = 0; index < MAX_SAVED_PLACES; index++) store.save(`View ${index}`, view);
  assert.throws(() => store.save('Overflow', view), /Remove one/);
  assert.equal(createPlaceStore(memory).list().length, MAX_SAVED_PLACES);
  const record = store.list()[0]; memory.setItem(PLACES_STORAGE_KEY, JSON.stringify({ version: 1, places: [record, { ...record, name: 'Duplicate' }] }));
  assert.equal(createPlaceStore(memory).list().length, 1);
});
