import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserStore } from './browser-store.js';
import { createEvidenceNotebook } from './evidence.js';

function indexedDatabase(initial = []) {
  const records = new Map(initial.map((record) => [record.key, structuredClone(record)]));
  const faults = { read: false, write: false };
  const reads = [], ranges = [];
  const cloneRecord = (key) => { reads.push(key); return structuredClone(records.get(key)); };
  const keyRange = { bound: (lower, upper, lowerOpen, upperOpen) => ({ lower, upper, lowerOpen, upperOpen,
    includes: (key) => typeof key === 'string' && (lowerOpen ? key > lower : key >= lower) &&
      (typeof upper !== 'string' || (upperOpen ? key < upper : key <= upper)),
  }) };
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
            try { result.result = work(); result.onsuccess?.(); transaction.oncomplete?.(); }
            catch { result.onerror?.(); transaction.onabort?.(); }
          }
        });
        return result;
      };
      transaction.objectStore = () => ({
        get: (key) => request(() => cloneRecord(key)),
        getAll: (range) => request(() => {
          ranges.push(range);
          return [...records.keys()].filter((key) => !range || range.includes(key)).map(cloneRecord);
        }),
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
  return { indexedDB, records, faults, reads, ranges, keyRange };
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

test('prefix reads use a bounded IndexedDB range without cloning unrelated response or scene blobs', async () => {
  const db = indexedDatabase([{ key: 'evidence:one', title: 'First' }, { key: 'evidence:two', title: 'Second' },
    { key: 'evidence;', title: 'Outside the prefix' }]);
  let unrelatedReads = 0;
  for (const key of ['response:flights', 'scene:preview']) db.records.set(key, { key,
    get body() { unrelatedReads++; throw new Error('Unrelated large blob must not be read'); },
  });
  const store = createBrowserStore(db.indexedDB, { keyRange: db.keyRange });
  assert.deepEqual((await store.all('evidence:')).map((record) => record.key), ['evidence:one', 'evidence:two']);
  assert.deepEqual(db.reads, ['evidence:one', 'evidence:two']);
  assert.equal(unrelatedReads, 0);
  assert.equal(db.ranges[0].lower, 'evidence:');
  assert.equal(db.ranges[0].upper, 'evidence;');
  assert.equal(db.ranges[0].upperOpen, true);
  // Calling all() without a prefix still has the original complete-store contract.
  db.records.delete('response:flights'); db.records.delete('scene:preview');
  assert.equal((await store.all()).length, 3);
  assert.equal(db.ranges.at(-1), undefined);
});

test('successful prefix reconciliation removes only its own stale memory records', async () => {
  const db = indexedDatabase([{ key: 'evidence:old', title: 'Old note' }, { key: 'response:flights', body: new ArrayBuffer(8) }]);
  const store = createBrowserStore(db.indexedDB, { keyRange: db.keyRange });
  await store.get('response:flights'); await store.all('evidence:');
  db.records.delete('evidence:old'); db.records.set('evidence:new', { key: 'evidence:new', title: 'New note' });
  assert.deepEqual((await store.all('evidence:')).map((record) => record.key), ['evidence:new']);
  db.faults.read = true;
  assert.equal((await store.get('response:flights')).body.byteLength, 8);
  assert.deepEqual((await store.all('evidence:')).map((record) => record.key), ['evidence:new']);
  assert.deepEqual((await store.all()).map((record) => record.key).sort(), ['evidence:new', 'response:flights']);
});

test('response prefix reads do not retrieve unrelated notebook photographs', async () => {
  const db = indexedDatabase([{ key: 'response:flights', body: new ArrayBuffer(4) }]);
  let photoReads = 0;
  db.records.set('evidence:photo', { key: 'evidence:photo',
    get photo() { photoReads++; throw new Error('Cache pruning must not clone a notebook photograph'); },
  });
  const store = createBrowserStore(db.indexedDB, { keyRange: db.keyRange });
  assert.equal((await store.all('response:'))[0].body.byteLength, 4);
  assert.deepEqual(db.reads, ['response:flights']);
  assert.equal(photoReads, 0);
  assert.equal(db.ranges[0].lower, 'response:');
  assert.equal(db.ranges[0].upper, 'response;');
});

test('prefix reads preserve failed writes and deletes across namespaces and later working DB reads', async () => {
  const db = indexedDatabase([{ key: 'evidence:edited', title: 'Old' }, { key: 'evidence:deleted' }, { key: 'response:deleted' }]);
  const store = createBrowserStore(db.indexedDB, { keyRange: db.keyRange });
  db.faults.write = true;
  const edits = [store.put('evidence:edited', { title: 'Temporary edit' }), store.put('evidence:new', { title: 'Temporary note' }),
    store.put('response:temporary', { body: new ArrayBuffer(4) }), store.delete('evidence:deleted'), store.delete('response:deleted')];
  const scopedRead = store.all('evidence:');
  await Promise.all(edits);
  assert.deepEqual((await scopedRead).map((record) => record.title).sort(), ['Temporary edit', 'Temporary note']);
  assert.deepEqual((await store.all('response:')).map((record) => record.key), ['response:temporary']);
  assert.equal(await store.get('response:deleted'), undefined);
  assert.deepEqual((await store.all()).map((record) => record.key).sort(), ['evidence:edited', 'evidence:new', 'response:temporary']);
  assert.equal(db.records.get('evidence:edited').title, 'Old');
  assert.equal(db.records.has('evidence:deleted'), true);
});

test('prefix memory fallback after failed clear never reads or resurrects old database namespaces', async () => {
  const db = indexedDatabase([{ key: 'evidence:old' }, { key: 'response:old' }]);
  const store = createBrowserStore(db.indexedDB, { keyRange: db.keyRange });
  await store.all(); db.faults.write = true;
  await store.clear(); await store.put('evidence:new', { title: 'Temporary' });
  await store.put('response:new', { body: new ArrayBuffer(4) });
  const readsBefore = db.reads.length;
  assert.deepEqual((await store.all('evidence:')).map((record) => record.key), ['evidence:new']);
  assert.deepEqual((await store.all('response:')).map((record) => record.key), ['response:new']);
  assert.equal(db.reads.length, readsBefore);
  assert.deepEqual((await store.all()).map((record) => record.key).sort(), ['evidence:new', 'response:new']);
});

test('prefix ranges retain maximum Unicode suffixes and memory-only reads preserve ordering', async () => {
  const db = indexedDatabase([{ key: 'evidence:\uffff\uffff' }, { key: '\uffff\uffff:one' }, { key: '\uffff:outside' }]);
  const store = createBrowserStore(db.indexedDB, { keyRange: db.keyRange });
  assert.deepEqual((await store.all('evidence:')).map((record) => record.key), ['evidence:\uffff\uffff']);
  assert.deepEqual((await store.all('\uffff\uffff')).map((record) => record.key), ['\uffff\uffff:one']);
  const temporary = createBrowserStore(null);
  const first = temporary.put('evidence:one', {}), second = temporary.put('response:one', {});
  const read = temporary.all('evidence:');
  const deleted = temporary.delete('evidence:one');
  await Promise.all([first, second, deleted]);
  assert.deepEqual((await read).map((record) => record.key), ['evidence:one']);
  assert.deepEqual(await temporary.all('evidence:'), []);
  assert.deepEqual((await temporary.all()).map((record) => record.key), ['response:one']);
});

test('opening the actual notebook requests only evidence records from IndexedDB', async () => {
  const db = indexedDatabase([{ key: 'evidence:one', title: 'Saved note', note: 'An observation',
    verification: 'User note; unverified', createdAt: '2026-10-11T08:00:00.000Z' }]);
  let unrelatedReads = 0;
  db.records.set('response:large', { key: 'response:large',
    get body() { unrelatedReads++; throw new Error('Notebook must not read a cached response body'); },
  });
  const store = createBrowserStore(db.indexedDB, { keyRange: db.keyRange });
  const calls = [], all = store.all;
  store.all = (prefix) => { calls.push(prefix); return all(prefix); };
  const document = { createElement: (tag) => ({ tag, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
  }) };
  const container = document.createElement('div'); container.ownerDocument = document;
  const notebook = createEvidenceNotebook({ container, store });
  await notebook.open();
  const list = container.children.find((node) => node.className === 'notebook-list');
  assert.equal(list.children[0].children[0].textContent, 'Saved note');
  assert.deepEqual(calls, ['evidence:']);
  assert.deepEqual(db.reads, ['evidence:one']);
  assert.equal(unrelatedReads, 0);
  notebook.destroy();
});
