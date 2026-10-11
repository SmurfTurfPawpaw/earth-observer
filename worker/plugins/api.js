import { readPluginEnvelope, readPluginPublications } from './store.js';

const json = (data, status = 200, headers = {}) => Response.json(data, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
export function createPluginApiHandler({ now = Date.now } = {}) {
  return async (request, env) => {
    const url = new URL(request.url), dataset = url.pathname === '/api/dossiers/belgium-natural-gas-origins';
    if (!dataset && url.pathname !== '/api/publications') return null;
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405, { allow: 'GET' });
    const allowed = dataset ? ['knownAt'] : ['plugin', 'limit', 'at', 'knownAt'];
    if (url.search.length > 512 || [...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1))
      return json({ error: 'Use a bounded stored source query' }, 400);
    try {
      const knownAt = url.searchParams.get('knownAt');
      if (dataset) return json(await readPluginEnvelope(env, 'eurostat-gas-origins-v1', { knownAt, now }));
      const plugin = url.searchParams.get('plugin') ?? 'ecb-press-v1', rawLimit = url.searchParams.get('limit');
      if (plugin !== 'ecb-press-v1' || rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) throw new TypeError('Invalid reviewed publication scope');
      return json(await readPluginPublications(env, plugin, { knownAt, at: url.searchParams.get('at'), limit: rawLimit === null ? 20 : Number(rawLimit), now }));
    } catch (error) {
      return json({ error: error instanceof TypeError ? 'Use canonical UTC dates and a reviewed bounded source query' : 'Stored source context unavailable' }, error instanceof TypeError ? 400 : 503);
    }
  };
}
