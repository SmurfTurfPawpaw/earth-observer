/** Device-only workspace/cache storage. No visitor identity or telemetry leaves the browser. */
export function createBrowserStore(indexedDB = globalThis.indexedDB, { keyRange = globalThis.IDBKeyRange } = {}) {
  let opening;
  const memory = new Map();
  const temporary = new Set(), deleted = new Set();
  let cleared = false, queue = Promise.resolve();
  const database = () => opening ||= new Promise((resolve) => {
    if (!indexedDB) { resolve(null); return; }
    let settled = false;
    const finish = (db) => {
      if (settled) { db?.close(); return; }
      settled = true;
      if (db) db.onversionchange = () => db.close();
      resolve(db);
    };
    try {
      const request = indexedDB.open('earth-observer-workspace', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('records')) request.result.createObjectStore('records', { keyPath: 'key' });
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = request.onblocked = () => finish(null);
    } catch { finish(null); }
  });
  async function operation(mode, work) {
    const db = await database();
    if (!db) return { ok: false };
    return new Promise((resolve) => {
      try {
        const transaction = db.transaction('records', mode);
        const request = work(transaction.objectStore('records'));
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve({ ok: true, value: result });
        request.onerror = transaction.onerror = transaction.onabort = () => resolve({ ok: false });
      } catch { resolve({ ok: false }); }
    });
  }
  // Preserve mutation ordering and overlay temporary changes on later working DB reads.
  // A failed write must never disappear, nor a failed delete resurrect, within this session.
  const run = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const status = (persistent) => ({ persistent, storage: persistent ? 'indexeddb' : 'memory' });
  // IndexedDB compares strings by UTF-16 code units. The next string after a
  // prefix gives an exclusive upper bound, including arbitrarily long suffixes.
  const rangeForPrefix = (prefix) => {
    for (let index = prefix.length - 1; index >= 0; index--) {
      const code = prefix.charCodeAt(index);
      if (code < 0xffff) return keyRange.bound(prefix, prefix.slice(0, index) + String.fromCharCode(code + 1), false, true);
    }
    // Binary keys sort after every string; the smallest binary key excludes
    // non-string records even for a prefix made entirely of \uffff code units.
    return keyRange.bound(prefix, new Uint8Array(0), false, true);
  };
  return {
    get: (key) => run(async () => {
      if (deleted.has(key)) return undefined;
      if (cleared || temporary.has(key)) return memory.get(key);
      const result = await operation('readonly', (store) => store.get(key));
      if (result.ok) {
        if (result.value === undefined) memory.delete(key);
        else memory.set(key, result.value);
        return result.value;
      }
      return memory.get(key);
    }),
    put: (key, value) => run(async () => {
      const record = { ...value, key };
      const result = await operation('readwrite', (store) => store.put(record));
      memory.set(key, record); deleted.delete(key);
      if (result.ok) temporary.delete(key); else temporary.add(key);
      return status(result.ok);
    }),
    delete: (key) => run(async () => {
      const result = await operation('readwrite', (store) => store.delete(key));
      memory.delete(key); temporary.delete(key);
      if (result.ok) deleted.delete(key); else deleted.add(key);
      return status(result.ok);
    }),
    // all() retains its complete-store contract; all('evidence:') reads only
    // matching IndexedDB records, without cloning unrelated photos or bodies.
    all: (prefix = '') => run(async () => {
      if (typeof prefix !== 'string') throw new TypeError('Record prefix must be a string');
      const matches = (key) => !prefix || (typeof key === 'string' && key.startsWith(prefix));
      const values = () => [...memory.values()].filter((record) => matches(record.key));
      if (cleared) return values();
      const result = await operation('readonly', (store) => prefix ? store.getAll(rangeForPrefix(prefix)) : store.getAll());
      if (result.ok) {
        const merged = new Map(result.value.filter((record) => matches(record.key)).map((record) => [record.key, record]));
        for (const key of temporary) if (matches(key) && memory.has(key)) merged.set(key, memory.get(key));
        for (const key of deleted) if (matches(key)) merged.delete(key);
        for (const key of memory.keys()) if (matches(key)) memory.delete(key);
        for (const [key, record] of merged) memory.set(key, record);
      }
      return values();
    }),
    clear: () => run(async () => {
      const result = await operation('readwrite', (store) => store.clear());
      memory.clear(); temporary.clear(); deleted.clear(); cleared = !result.ok;
      return status(result.ok);
    }),
  };
}
