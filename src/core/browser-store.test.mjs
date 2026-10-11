import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserStore } from './browser-store.js';

function indexedDatabase(initial = []) {
  const records = new Map(initial.map((record) => [record.key, structuredClone(record)]));
  const faults = { read: false, write: false };
  const db = {
    close() {},
    transaction(_name, mode) {
      const transaction = {};
      const request = (work) => {
        const result = {};
        queueMicrotask(() => {
          if (faults[mode === 'readonly' ? 'read' : 'write']) {
            result.onerror?.(); transaction.onabort?.();
          } else {
            result.result = work(); result.onsuccess?.(); transaction.oncomplete?.();
          }
        });
        return result;
      };
      transaction.objectStore = () => ({
        get: (key) => request(() => structuredClone(records.get(key))),
        getAll: () => request(() => structuredClone([...records.values()])),
        put: (record) => request(() => { records.set(record.key, structuredClone(record)); return record.key; }),
        delete: (key) => request(() => records.delete(key)),
        clear: () => request(() => records.clear()),
      });
      return transaction;
    },
  };
  const indexedDB = { open: () => {
    const request = { result: db };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } };
  return { indexedDB, records, faults };
}

test('workspace writes identify persistence and successful writes survive a later read failure', async () => {
  const { indexedDB, records, faults } = indexedDatabase();
  const store = createBrowserStore(indexedDB);
  assert.deepEqual(await store.put('note', { title: 'Saved' }), { persistent: true, storage: 'indexeddb' });
  assert.equal(records.get('note').title, 'Saved');
  faults.read = true;
  assert.equal((await store.get('note')).title, 'Saved');
  assert.equal((await store.all())[0].title, 'Saved');
});

test('failed writes overlay working database reads without hiding persistent records', async () => {
  const { indexedDB, records, faults } = indexedDatabase([{ key: 'existing', title: 'Old' }, { key: 'other', title: 'Other' }]);
  const store = createBrowserStore(indexedDB);
  faults.write = true;
  assert.deepEqual(await store.put('existing', { title: 'Updated in memory' }), { persistent: false, storage: 'memory' });
  await store.put('new', { title: 'New in memory' });
  assert.equal((await store.get('existing')).title, 'Updated in memory');
  assert.deepEqual((await store.all()).map((record) => record.title).sort(), ['New in memory', 'Other', 'Updated in memory']);
  assert.equal(records.get('existing').title, 'Old');
  faults.write = false;
  assert.equal((await store.put('existing', { title: 'Persisted update' })).persistent, true);
  assert.equal((await store.get('existing')).title, 'Persisted update');
});

test('failed deletes and clears cannot resurrect old notes during a session', async () => {
  const { indexedDB, faults } = indexedDatabase([{ key: 'one' }, { key: 'two' }]);
  const store = createBrowserStore(indexedDB);
  await store.all(); faults.write = true;
  assert.equal((await store.delete('one')).persistent, false);
  assert.equal(await store.get('one'), undefined);
  assert.deepEqual((await store.all()).map((record) => record.key), ['two']);
  assert.equal((await store.clear()).persistent, false);
  assert.equal(await store.get('two'), undefined);
  assert.deepEqual(await store.all(), []);
  faults.write = false;
  await store.put('new', { title: 'After clear' });
  assert.deepEqual((await store.all()).map((record) => record.key), ['new']);
  assert.equal((await store.clear()).persistent, true);
  assert.deepEqual(await store.all(), []);
});

test('memory fallback reports temporary storage and preserves mutation order', async () => {
  const store = createBrowserStore(null);
  const written = store.put('note', { title: 'Temporary' });
  const read = store.get('note');
  assert.deepEqual(await written, { persistent: false, storage: 'memory' });
  assert.equal((await read).title, 'Temporary');
  await store.delete('note');
  assert.deepEqual(await store.all(), []);
});

test('blocked databases remain temporary and close a connection that opens later', async () => {
  let request, closed = 0;
  const indexedDB = { open: () => {
    request = {};
    queueMicrotask(() => request.onblocked());
    return request;
  } };
  const store = createBrowserStore(indexedDB);
  assert.equal((await store.put('note', { title: 'Temporary' })).persistent, false);
  request.result = { close: () => closed++ }; request.onsuccess();
  assert.equal(closed, 1);
  assert.equal((await store.get('note')).title, 'Temporary');
});
