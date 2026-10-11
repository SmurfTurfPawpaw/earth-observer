/** Device-only workspace/cache storage. No visitor identity or telemetry leaves the browser. */
export function createBrowserStore(indexedDB = globalThis.indexedDB) {
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
    all: () => run(async () => {
      if (cleared) return [...memory.values()];
      const result = await operation('readonly', (store) => store.getAll());
      if (result.ok) {
        const merged = new Map(result.value.map((record) => [record.key, record]));
        for (const key of temporary) if (memory.has(key)) merged.set(key, memory.get(key));
        for (const key of deleted) merged.delete(key);
        memory.clear();
        for (const [key, record] of merged) memory.set(key, record);
      }
      return [...memory.values()];
    }),
    clear: () => run(async () => {
      const result = await operation('readwrite', (store) => store.clear());
      memory.clear(); temporary.clear(); deleted.clear(); cleared = !result.ok;
      return status(result.ok);
    }),
  };
}
