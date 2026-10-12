/** Persistent provider cache and attempt policy. No visitor records are stored. */
export function createProviderStore(env = {}) {
  const bucket = env.EARTH_STORE;
  const objectKey = (key) => `providers/${encodeURIComponent(key)}.json`;
  if (bucket?.get && bucket?.put) return {
    async get(key) { const object = await bucket.get(objectKey(key)); return object ? object.json() : null; },
    put: (key, value) => bucket.put(objectKey(key), JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }),
    async getVersioned(key) {
      const object = await bucket.get(objectKey(key));
      if (!object) return { value: null, version: null };
      if (typeof object.etag !== 'string' || !object.etag) throw new Error('Missing provider object version');
      return { value: await object.json(), version: object.etag };
    },
    async putIfVersion(key, value, version) {
      if (version !== null && (typeof version !== 'string' || !version)) throw new Error('Invalid provider object version');
      const saved = await bucket.put(objectKey(key), JSON.stringify(value), {
        onlyIf: version === null ? new Headers({ 'if-none-match': '*' }) : { etagMatches: version },
        httpMetadata: { contentType: 'application/json' },
      });
      // A literal null is a failed condition; an absent result is not proof of a commit.
      return saved === null ? false : saved && typeof saved.etag === 'string' && saved.etag ? true : undefined;
    },
    async claim(key, at, wait) {
      const path = objectKey(`attempt:${key}`), previous = await bucket.get(path);
      const value = previous ? await previous.json() : null;
      if (value?.until > at) return false;
      const saved = await bucket.put(path, JSON.stringify({ until: at + wait, expiresAt: at + wait }), {
        onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ 'if-none-match': '*' }),
        httpMetadata: { contentType: 'application/json' },
      });
      return saved !== null;
    },
  };
  if (env.EARTH_CACHE?.get && env.EARTH_CACHE?.put) return {
    get: async (key) => { const value = await env.EARTH_CACHE.get(key); return value == null ? null : JSON.parse(value); },
    put: (key, value) => env.EARTH_CACHE.put(key, JSON.stringify(value)),
    async claim(key, at, wait) {
      const previous = await this.get(`attempt:${key}`);
      if (previous?.until > at) return false;
      await this.put(`attempt:${key}`, { until: at + wait, expiresAt: at + wait }); return true;
    },
  };
  return null;
}
