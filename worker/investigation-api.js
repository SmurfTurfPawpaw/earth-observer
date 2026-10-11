import { readInvestigationJobs, readInvestigationArtifact } from './investigation-jobs.js';

export const INVESTIGATION_API_PATH = '/api/investigations';
export const INVESTIGATION_API_LIMITS = Object.freeze({ urlBytes: 2048, responseBytes: 64 * 1024, deadlineMs: 10_000, jobs: 20 });
const EVENT_ID = /^event:usgs:[a-f0-9]{64}$/, JOB_ID = /^investigation:[a-f0-9]{64}$/;
const json = (value, status = 200, headers = {}) => Response.json(value, { status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });

/** Public reads only. No candidate enqueue, lease, source fetch or publication operation is reachable. */
export function createInvestigationApiHandler({ now = Date.now, readJobs = readInvestigationJobs,
  readArtifact = readInvestigationArtifact, deadlineMs = INVESTIGATION_API_LIMITS.deadlineMs } = {}) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > INVESTIGATION_API_LIMITS.deadlineMs)
    throw new TypeError('Use a bounded investigation read deadline');
  return async (request, env = {}) => {
    const url = new URL(request.url), list = url.pathname === INVESTIGATION_API_PATH;
    if (!list && !url.pathname.startsWith(INVESTIGATION_API_PATH + '/')) return null;
    if (request.method !== 'GET') return json({ available: false, error: 'Method Not Allowed' }, 405, { allow: 'GET' });
    if (new TextEncoder().encode(url.href).byteLength > INVESTIGATION_API_LIMITS.urlBytes) return json({ available: false, error: 'Query exceeds its bound' }, 414);
    let input;
    try {
      const allowed = list ? ['eventId', 'limit'] : ['knownAt'];
      for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
        throw new TypeError('Unsupported investigation query');
      if (list) {
        const eventId = url.searchParams.get('eventId'), limit = url.searchParams.get('limit');
        if (eventId !== null && !EVENT_ID.test(eventId) || limit !== null && (!/^[1-9]\d?$/.test(limit) || Number(limit) > INVESTIGATION_API_LIMITS.jobs))
          throw new TypeError('Invalid bounded investigation query');
        input = { ...(eventId !== null ? { eventId } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) };
      } else {
        const segment = url.pathname.slice(INVESTIGATION_API_PATH.length + 1), jobId = decodeURIComponent(segment);
        if (!JOB_ID.test(jobId)) return json({ available: false, error: 'Investigation route not found' }, 404);
        const knownAt = url.searchParams.get('knownAt'); input = { jobId, ...(knownAt !== null ? { knownAt } : {}) };
      }
    } catch { return json({ available: false, error: 'Invalid bounded investigation query' }, 400); }
    let timer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => list ? readJobs(env, input) : readArtifact(env, input, { now })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Read deadline')), deadlineMs); })]);
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > INVESTIGATION_API_LIMITS.responseBytes)
        return json({ available: false, error: 'Investigation read exceeds its bound' }, 503);
      return json(result, result.configured === false ? 503 : !list && result.available !== true ? 404 : 200);
    } catch (error) {
      return json({ available: false, error: error instanceof TypeError ? 'Invalid bounded investigation query' : 'Stored investigation data is unavailable' },
        error instanceof TypeError ? 400 : 503);
    } finally { clearTimeout(timer); }
  };
}
