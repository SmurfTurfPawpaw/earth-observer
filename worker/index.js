import { DOCUMENT_HEADERS } from '../server/hosted/headers.js';
import { makeRateLimiter } from '../src/sources/rateLimit.js';
import { workerProviders } from './providers.js';
import { createWorkerMiddleware } from './middleware.js';
import { createProviderStore } from './storage.js';
import { createSpaceHandler } from './space.js';
import { createFirmsHandler } from './firms.js';
import { createContextHandler } from './context.js';
import { createWindArtifactHandler } from './wind.js';
import { createWorkerFetch } from './fetch.js';
import { handleDemand } from './demand.js';
import { createHistoryHandler } from './history.js';
import { handleCollection, preparedIntelligenceResponse } from './collection-api.js';
import { handleUpdates } from './collection-updates.js';
import { handleAircraftObservations } from './aircraft-observations.js';
import { createWorldModelHandler } from './world-model.js';
import { createCollectorTriggerHandler } from './collector-trigger.js';
import { createArchiveApiHandler } from './archive-api.js';
import { createWorldSceneHandler } from './world-scene.js';
import { createInvestigationApiHandler } from './investigation-api.js';
import { createPluginApiHandler } from './plugins/api.js';
import { createDocumentInvestigationApiHandler } from './document-investigation-api.js';
import { createObservationApiHandler } from './observation-api.js';
import { createPreparedUsgsApiHandler } from './prepared-usgs-api.js';
import { startCoverageWake, createCoverageStatusHandler } from './coverage-runtime.js';
import { createCoverageDemandHandler } from './coverage-demand.js';
import { createPreparedScenesApiHandler } from './prepared-scenes-api.js';

const secured = (response) => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(DOCUMENT_HEADERS)) {
    // Enforce the application policy alongside a stricter reviewed leaf policy.
    // Replacing it would discard the sandbox on retained original attachments.
    if (name.toLowerCase() === 'content-security-policy' && headers.has(name)) headers.append(name, value);
    else headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers,
    ...(headers.has('content-encoding') ? { encodeBody: 'manual' } : {}) });
};
const jsonError = (error, status) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Mountable /earth runtime; a null result leaves the personal site's other routes alone. */
export function createEarthRuntime({ prefix = '/earth/', fetchImpl = (...args) => fetch(...args), providers, handlers = [],
  cache = globalThis.caches?.default, now = Date.now } = {}) {
  if (!/^\/[a-z0-9/_-]*\/$/i.test(prefix)) throw new TypeError('A directory prefix is required');
  const providerFetch = createWorkerFetch(fetchImpl);
  const handleTrigger = createCollectorTriggerHandler({ now, fetchImpl: providerFetch, coverageWake: startCoverageWake });
  const handleArchive = createArchiveApiHandler({ now });
  const handleInvestigations = createInvestigationApiHandler({ now });
  const handlePluginApi = createPluginApiHandler({ now });
  const handleDocumentApi = createDocumentInvestigationApiHandler({ now });
  const handleObservationApi = createObservationApiHandler({ now });
  const handlePreparedScene = createPreparedUsgsApiHandler({ now });
  const handleGenericPreparedScene = createPreparedScenesApiHandler({ now });
  const handleCoverageStatus = createCoverageStatusHandler({ now });
  const handleCoverageDemand = createCoverageDemandHandler({ now });
  let state;
  const admit = makeRateLimiter({ windowMs: 60000, max: 240, globalMax: 4000 });
  const services = (env) => state ||= {
    middleware: createWorkerMiddleware(providers || workerProviders({ fetchImpl: providerFetch, env, now })),
    handlers: [createSpaceHandler({ fetchImpl: providerFetch, env, now, store: createProviderStore(env) }), createFirmsHandler({ fetchImpl: providerFetch, env, now }),
      createContextHandler({ fetchImpl: providerFetch, env, now }), createWindArtifactHandler({ fetchImpl: providerFetch, env, now })],
  };
  return {
    async fetch(request, env = {}, ctx = {}, assetsFetch) {
      const url = new URL(request.url);
      if (url.pathname === prefix.slice(0, -1)) {
        url.pathname = prefix;
        return new Response(null, { status: 308, headers: { location: url.href } });
      }
      if (!url.pathname.startsWith(prefix)) return null;
      const localPath = '/' + url.pathname.slice(prefix.length);
      if (localPath === '/healthz') return secured(new Response('{"status":"ok"}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }));
      if (!localPath.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(request.method)) return secured(jsonError('Method Not Allowed', 405));
        const serve = assetsFetch || (env.ASSETS?.fetch && ((asset) => env.ASSETS.fetch(asset)));
        return secured(serve ? await serve(request) : jsonError('Asset binding is not configured', 503));
      }
      if (url.href.length > 32768) return secured(jsonError('Request URL too long', 414));
      if (!admit(request.headers.get('cf-connecting-ip') || 'unknown')) return secured(new Response('{"error":"Request limit reached"}', { status: 429, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' } }));
      url.pathname = localPath;
      const internal = new Request(url, request);
      try {
        const updates = handleUpdates(internal, env);
        if (updates) return secured(updates);
        const triggered = await handleTrigger(internal, env, ctx);
        if (triggered) return secured(triggered);
        const coverage = await handleCoverageStatus(internal, env);
        if (coverage) return secured(coverage);
        const functionalInterest = await handleCoverageDemand(internal, env);
        if (functionalInterest) return secured(functionalInterest);
        const collection = await handleCollection(internal, env, ctx, { now, fetchImpl: providerFetch });
        if (collection) return secured(collection);
        const aircraft = await handleAircraftObservations(internal, env, { now });
        if (aircraft) return secured(aircraft);
        const history = await createHistoryHandler({ env, now })(internal);
        if (history) return secured(history);
        const archive = await handleArchive(internal, env, ctx);
        if (archive) return secured(archive);
        const scene = await createWorldSceneHandler({ env, now })(internal);
        if (scene) return secured(scene);
        const investigations = await handleInvestigations(internal, env);
        if (investigations) return secured(investigations);
        const plugin = await handlePluginApi(internal, env);
        if (plugin) return secured(plugin);
        const document = await handleDocumentApi(internal, env, ctx);
        if (document) return secured(document);
        const observations = await handleObservationApi(internal, env);
        if (observations) return secured(observations);
        const preparedScene = await handlePreparedScene(internal, env);
        if (preparedScene) return secured(preparedScene);
        const genericPreparedScene = await handleGenericPreparedScene(internal, env);
        if (genericPreparedScene) return secured(genericPreparedScene);
        const world = await createWorldModelHandler({ env, now })(internal);
        if (world) return secured(world);
        // Aggregate actions own their methods and never enter public provider caches.
        const demandResponse = await handleDemand(internal, env, { now });
        if (demandResponse) return secured(demandResponse);
        // Authenticated extension handlers own their methods and body admission.
        for (const handle of handlers) { const response = await handle(internal, env, ctx); if (response) return secured(response); }
        if (internal.method !== 'GET' && !(internal.method === 'POST' && localPath === '/api/overpass')) return secured(jsonError('Method Not Allowed', 405));
        const revalidate = /(?:^|,)\s*(?:no-cache|no-store|max-age\s*=\s*0)(?:\s*,|\s*$)/i.test(internal.headers.get('cache-control') || '');
        const cacheable = internal.method === 'GET' && !internal.headers.has('authorization') && !internal.headers.has('cookie') && !revalidate;
        const cacheKey = new Request(url.href);
        if (cacheable && cache) {
          let hit;
          try { hit = await cache.match(cacheKey); } catch {}
          if (hit) {
            const headers = new Headers(hit.headers), at = Number(headers.get('x-earth-cached-at'));
            const elapsed = Number.isFinite(at) ? Math.max(0, now() - at) : 0;
            if (headers.has('x-feed-age-ms')) headers.set('x-feed-age-ms', String(elapsed + (Number(headers.get('x-feed-age-ms')) || 0)));
            return secured(new Response(hit.body, { status: hit.status, headers }));
          }
        }
        let response = await preparedIntelligenceResponse(internal, env, { now });
        if (!response) {
          const current = services(env);
          for (const handle of current.handlers) { response = await handle(internal); if (response) break; }
          response ||= await current.middleware.handle(internal);
        }
        const control = response.headers.get('cache-control') || '';
        const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(control)?.[1]);
        if (cacheable && cache && response.ok && maxAge > 0 && /public/i.test(control) && !/private|no-store/i.test(control) && !response.headers.has('set-cookie')) {
          try {
            const copy = response.clone(), headers = new Headers(copy.headers); headers.set('x-earth-cached-at', String(now()));
            const save = Promise.resolve(cache.put(cacheKey, new Response(copy.body, { status: copy.status, headers }))).catch(() => {});
            if (ctx.waitUntil) ctx.waitUntil(save); else await save;
          } catch {} // Edge-cache failures do not change the provider's response.
        }
        return secured(response);
      } catch (error) {
        if (request.signal.aborted) throw error;
        return secured(jsonError('Earth observation source unavailable', 503));
      }
    },
    close() { state?.middleware.close(); state = null; },
  };
}

const runtime = createEarthRuntime();
export default { async fetch(request, env, ctx) { return await runtime.fetch(request, env, ctx) || new Response('Not Found', { status: 404 }); } };
