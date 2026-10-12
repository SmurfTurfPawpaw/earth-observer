import { SOURCE_CAPABILITIES, getSourceCapability } from '../src/core/source-capabilities.js';
import { getCollectorStatus } from './collector.js';
import { handleCollection } from './collection-api.js';
import { readWorldEvents } from './world-model.js';
import { readPluginEnvelope, readPluginPublications } from './plugins/store.js';
import { PUBLICATION_PLUGIN_IDS } from './plugins/registry.js';
import { worldTime } from '../src/core/world-model.js';
import { makeRateLimiter } from '../src/sources/rateLimit.js';

export const SITE_MCP_PATH = '/mcp';
export const SITE_MCP_PROTOCOL_VERSION = '2026-07-28';
export const SITE_MCP_LIMITS = Object.freeze({ bodyBytes: 16 * 1024, resultBytes: 256 * 1024,
  deadlineMs: 45_000, maxEvents: 50, maxPublications: 40, requestWindowMs: 60_000, requestsPerCaller: 60,
  requestsPerIsolate: 600, collectionIntervalMs: 60_000 });

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO = Object.freeze({ name: 'earth-observer', version: 'foundation-1' });
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (text) => new TextEncoder().encode(text).byteLength;
const keys = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.includes(key));
const empty = { type: 'object', properties: {}, additionalProperties: false };
const cutoff = { type: 'string', maxLength: 40, description: 'UTC knowledge cutoff; only evidence recorded by then is included.' };
const canonicalCutoff = { ...cutoff, maxLength: 24, pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$' };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const tools = [
  { name: 'source_capabilities', description: 'Reviewed source semantics, actual coverage/history/cadence and gaps. No acquisition.', inputSchema: {
    type: 'object', properties: { sourceId: { type: 'string', enum: SOURCE_CAPABILITIES.sources.map(({ id }) => id) } }, additionalProperties: false }, annotations: readOnly },
  { name: 'collection_status', description: 'Read prepared hosted collection dates and operational gaps. A response is not proof of unattended execution.', inputSchema: empty, annotations: readOnly },
  { name: 'list_world_events', description: 'Read bounded retained provisional events at a knowledge cutoff; source facts are not independently verified.', inputSchema: {
    type: 'object', properties: { knownAt: cutoff, limit: { type: 'integer', minimum: 1, maximum: SITE_MCP_LIMITS.maxEvents, default: 20 } }, additionalProperties: false }, annotations: readOnly },
  { name: 'event_detail', description: 'Read one retained event and its evidence references at a knowledge cutoff. No upstream source request.', inputSchema: {
    type: 'object', properties: { id: { type: 'string', pattern: '^event:usgs:[a-f0-9]{64}$', maxLength: 75 }, knownAt: cutoff }, required: ['id'], additionalProperties: false }, annotations: readOnly },
  { name: 'source_dossier', description: 'Read the retained annual Belgium natural-gas origins dossier and its exact evidence receipt. Reporting years are not current supply or shipment routes. No source acquisition.', inputSchema: {
    type: 'object', properties: { dossierId: { type: 'string', enum: ['belgium-natural-gas-origins'] }, knownAt: canonicalCutoff },
    required: ['dossierId'], additionalProperties: false }, annotations: readOnly },
  { name: 'list_publications', description: 'Read retained original ECB or European Commission publication metadata and each item’s own evidence receipt. Publication time and hosted knowledge time are independent; a rolling feed is not a complete archive. No source acquisition.', inputSchema: {
    type: 'object', properties: { pluginId: { type: 'string', enum: [...PUBLICATION_PLUGIN_IDS] }, knownAt: canonicalCutoff,
      at: { ...canonicalCutoff, description: 'UTC source publication cutoff, independent of the hosted knowledge cutoff.' },
      limit: { type: 'integer', minimum: 1, maximum: SITE_MCP_LIMITS.maxPublications, default: 20 } },
    required: ['pluginId'], additionalProperties: false }, annotations: readOnly },
  { name: 'caller_identity', description: 'Return this caller\'s identity state; an optional server-enabled header probe is explicitly unverified and grants no permission. No owner bootstrap or email grants.', inputSchema: empty, annotations: readOnly },
  { name: 'collect_sources', description: 'Owner-only bounded collection of the fixed reviewed registry through the existing authenticated writer. No URL, code or credential inputs.', inputSchema: empty,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
];

function headers(extra = {}) {
  return { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'mcp-protocol-version': SITE_MCP_PROTOCOL_VERSION, ...extra };
}
const response = (value, status = 200, extra) => Response.json(value, { status, headers: headers(extra) });
const protocolError = (id, code, message, status = 200, data) => response({ jsonrpc: '2.0', id,
  error: { code, message, ...(data ? { data } : {}) } }, status);
const complete = (id, result) => {
  const envelope = (value) => ({ jsonrpc: '2.0', id, result: { ...value, resultType: 'complete', _meta: { [INFO_KEY]: SERVER_INFO } } });
  let text = JSON.stringify(envelope(result));
  if (bytes(text) > SITE_MCP_LIMITS.resultBytes) text = JSON.stringify(envelope(toolError('result_too_large', 'Bounded tool response exceeded its limit.')));
  return new Response(text, { headers: headers() });
};
const toolError = (code, message) => ({ content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }], isError: true });

function callerId(request) {
  const id = request.headers.get('oai-authenticated-user-id');
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id) ? id : null;
}
function ownerId(env) {
  const id = env.EARTH_OWNER_USER_ID;
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && id.trim() === id && !/[\u0000-\u001f\u007f]/.test(id) ? id : null;
}
function identity(request, env) {
  const trusted = env.EARTH_MCP_TRUST_SITES_IDENTITY === '1';
  const id = trusted ? callerId(request) : null, owner = ownerId(env);
  return { identityTrusted: trusted, signedIn: Boolean(id), siteScopedUserId: id,
    ownerConfigured: Boolean(owner), isOwner: Boolean(id && owner && id === owner),
    ...(env.EARTH_MCP_IDENTITY_PROBE === '1' ? { candidateHeaderId: callerId(request), unverified: true } : {}) };
}
function originAllowed(request) {
  if (!request.headers.has('origin')) return true;
  return request.headers.get('origin') === new URL(request.url).origin;
}

function abortable(promise, signal) {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function body(request, signal) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SITE_MCP_LIMITS.bodyBytes))
    throw Object.assign(new Error('Request body exceeds its limit'), { httpStatus: 413 });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('JSON request body required'), { parseError: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let count = 0, text = '';
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      count += value.byteLength;
      if (count > SITE_MCP_LIMITS.bodyBytes) throw Object.assign(new Error('Request body exceeds its limit'), { httpStatus: 413 });
      text += decoder.decode(value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error.httpStatus || signal.aborted) throw error;
    throw Object.assign(new Error('Invalid JSON'), { parseError: true });
  } finally { reader.releaseLock(); }
}

/** Modern headers/envelope are checked; bare Sites RPC is a compatibility path. */
function protocol(request, call) {
  const meta = call.params?._meta;
  if (meta !== undefined && !record(meta)) return { code: -32602, message: 'Invalid request metadata', status: 400 };
  const version = meta?.[VERSION_KEY], header = request.headers.get('mcp-protocol-version');
  if (version !== undefined && typeof version !== 'string') return { code: -32602, message: 'Invalid protocol version', status: 400 };
  if (version !== undefined && version !== SITE_MCP_PROTOCOL_VERSION || header && header !== SITE_MCP_PROTOCOL_VERSION)
    return { code: -32022, message: 'Unsupported protocol version', data: { supportedVersions: [SITE_MCP_PROTOCOL_VERSION] } };
  if (version !== undefined) {
    if (header !== version || request.headers.get('mcp-method') !== call.method ||
      call.method === 'tools/call' && request.headers.get('mcp-name') !== call.params?.name)
      return { code: -32020, message: 'MCP headers must agree with the modern request', status: 400 };
    if (!record(meta[CLIENT_CAPABILITIES_KEY])) return { code: -32602, message: 'Client capabilities required in the modern envelope', status: 400 };
    const info = meta[CLIENT_INFO_KEY];
    if (info !== undefined && (!record(info) || typeof info.name !== 'string' || !info.name || info.name.length > 128 ||
      typeof info.version !== 'string' || !info.version || info.version.length > 128))
      return { code: -32602, message: 'Invalid client information', status: 400 };
  } else if (request.headers.has('mcp-method') && request.headers.get('mcp-method') !== call.method ||
    request.headers.has('mcp-name') && request.headers.get('mcp-name') !== call.params?.name)
    return { code: -32020, message: 'MCP headers must agree with the request', status: 400 };
  return null;
}

function argumentsFor(name, input, now) {
  const value = input === undefined ? {} : input;
  const accepted = { source_capabilities: ['sourceId'], collection_status: [], caller_identity: [], collect_sources: [],
    list_world_events: ['knownAt', 'limit'], event_detail: ['id', 'knownAt'], source_dossier: ['dossierId', 'knownAt'],
    list_publications: ['pluginId', 'at', 'knownAt', 'limit'] };
  if (!Object.hasOwn(accepted, name) || !keys(value, accepted[name])) return null;
  if (name === 'source_capabilities' && value.sourceId !== undefined && !getSourceCapability(value.sourceId)) return null;
  if (value.knownAt !== undefined) {
    try { worldTime(value.knownAt); } catch { return null; }
    if (Date.parse(value.knownAt) > now() + 300_000) return null;
  }
  if (name === 'list_world_events' && value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > SITE_MCP_LIMITS.maxEvents)) return null;
  if (name === 'event_detail' && !/^event:usgs:[a-f0-9]{64}$/.test(value.id || '')) return null;
  if (name === 'source_dossier' && value.dossierId !== 'belgium-natural-gas-origins' || name === 'list_publications' && !PUBLICATION_PLUGIN_IDS.includes(value.pluginId)) return null;
  if (name === 'source_dossier' || name === 'list_publications') {
    for (const field of ['knownAt', ...(name === 'list_publications' ? ['at'] : [])]) if (value[field] !== undefined) {
      try { if (typeof value[field] !== 'string' || worldTime(value[field]) !== value[field] || Date.parse(value[field]) > now() + 300_000) return null; } catch { return null; }
    }
    if (name === 'list_publications' && value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > SITE_MCP_LIMITS.maxPublications)) return null;
  }
  return value;
}

function toolData(value) {
  const text = JSON.stringify(value);
  // Both human-readable text and structured content are returned, so reserve
  // room for the duplicated representation and RPC bookkeeping.
  if (typeof text !== 'string' || bytes(text) > SITE_MCP_LIMITS.resultBytes / 3)
    return toolError('result_too_large', 'The stored result exceeds the bounded tool response; narrow the query.');
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

/**
 * Mount at the Site's root /mcp before Earth prefix normalization. No SDK/session
 * state, outbound callbacks, arbitrary resource URLs or parallel storage engine.
 */
export function createSiteMcpHandler({ now = Date.now, fetchImpl = (...args) => fetch(...args),
  readCollectionStatus = getCollectorStatus, readEvents = readWorldEvents, collectionHandler = handleCollection,
  readSourceDossier = readPluginEnvelope, readPublications = readPluginPublications,
  deadlineMs = SITE_MCP_LIMITS.deadlineMs } = {}) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > SITE_MCP_LIMITS.deadlineMs) throw new TypeError('Use a bounded MCP deadline');
  const admit = makeRateLimiter({ windowMs: SITE_MCP_LIMITS.requestWindowMs, max: SITE_MCP_LIMITS.requestsPerCaller,
    globalMax: SITE_MCP_LIMITS.requestsPerIsolate });
  const collections = new WeakMap();

  async function invoke(name, args, request, env, ctx, signal) {
    signal.throwIfAborted();
    if (name === 'source_capabilities') return toolData(args.sourceId ? getSourceCapability(args.sourceId) : SOURCE_CAPABILITIES);
    if (name === 'caller_identity') return toolData(identity(request, env));
    if (name === 'collection_status') return toolData(await abortable(readCollectionStatus(env, { now }), signal));
    if (name === 'source_dossier' || name === 'list_publications') {
      const value = await abortable(name === 'source_dossier'
        ? readSourceDossier(env, 'eurostat-gas-origins-v1', { knownAt: args.knownAt ?? null, now })
        : readPublications(env, args.pluginId, { at: args.at ?? null, knownAt: args.knownAt ?? null, limit: args.limit ?? 20, now }), signal);
      signal.throwIfAborted(); return toolData(value);
    }
    if (name === 'list_world_events' || name === 'event_detail') {
      const value = await abortable(readEvents(env, { ...args, limit: name === 'event_detail' ? 1 : args.limit ?? 20 }, { now }), signal);
      signal.throwIfAborted();
      if (!value?.available) return toolError('stored_data_unavailable', 'The retained world evidence index is not available.');
      if (name === 'event_detail') {
        if (!value.events?.length) return toolError('event_not_present', 'No event in the selected retained snapshot; this does not establish it ended.');
        return toolData({ ...value, event: value.events[0] });
      }
      return toolData(value);
    }
    const caller = identity(request, env);
    if (!caller.isOwner || request.headers.has('origin')) return toolError('owner_required', 'Collection requires the configured owner through trusted Sites identity, without browser Origin.');
    const token = env.EARTH_COLLECTOR_TOKEN;
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(token)) return toolError('writer_unavailable', 'The existing server writer is not configured.');
    const previous = collections.get(env);
    if (previous?.pending || previous && now() < previous.nextAllowedAt) return toolError('collection_busy', 'Collection is in progress or within the minute admission window. Read collection_status before retrying.');
    const entry = { pending: true, nextAllowedAt: now() + SITE_MCP_LIMITS.collectionIntervalMs };
    collections.set(env, entry);
    const internal = new Request('https://earth-observer.internal/api/collector', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"action":"collect"}', signal });
    const scopedFetch = (url, options = {}) => fetchImpl(url, { ...options,
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal });
    const operation = Promise.resolve().then(() => { signal.throwIfAborted();
      return collectionHandler(internal, env, ctx, { now, fetchImpl: scopedFetch });
    }).finally(() => { entry.pending = false; });
    const result = await abortable(operation, signal);
    signal.throwIfAborted();
    if (!(result instanceof Response)) return toolError('writer_unavailable', 'The existing collector did not accept the operation.');
    const payload = await body(result, signal);
    if (!result.ok) return toolError('collection_unavailable', 'Collection did not complete successfully. Read stored status before retrying; existing evidence is retained.');
    return toolData({ configured: Boolean(payload.configured), stored: Boolean(payload.stored),
      collectedAt: typeof payload.collectedAt === 'string' && payload.collectedAt.length <= 40 ? payload.collectedAt : null,
      updatesPublished: Boolean(payload.updatesPublished), plugins: ['usgs', 'gdacs', 'eonet', 'gdelt'],
      note: 'This bounded invocation is not proof that an unattended schedule is running.' });
  }

  return async function handleSiteMcp(request, env = {}, ctx = {}) {
    if (new URL(request.url).pathname !== SITE_MCP_PATH) return null;
    if (request.method !== 'POST') return response({ error: 'Method Not Allowed' }, 405, { allow: 'POST' });
    if (!originAllowed(request)) return response({ error: 'Invalid Origin' }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return response({ error: 'JSON content type required' }, 415);
    const key = env.EARTH_MCP_TRUST_SITES_IDENTITY === '1' && callerId(request) || request.headers.get('cf-connecting-ip') || 'anonymous';
    if (!admit(key)) return response({ error: 'Request limit reached' }, 429, { 'retry-after': '60' });
    const controller = new AbortController();
    const aborted = () => controller.abort(new Error('Request canceled'));
    if (request.signal.aborted) aborted(); else request.signal.addEventListener('abort', aborted, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('MCP request deadline exceeded')), deadlineMs);
    let id = null;
    try {
      const call = await body(request, controller.signal);
      if (!keys(call, ['jsonrpc', 'id', 'method', 'params']) || call.jsonrpc !== '2.0' || typeof call.method !== 'string' ||
        call.method.length > 100 || !(typeof call.id === 'string' && call.id.length <= 128 || Number.isSafeInteger(call.id)) ||
        call.params !== undefined && !record(call.params)) return protocolError(null, -32600, 'Use one bounded JSON-RPC request with an ID', 400);
      id = call.id;
      const failure = protocol(request, call);
      if (failure) return protocolError(id, failure.code, failure.message, failure.status, failure.data);
      const params = call.params || {};
      if (call.method === 'server/discover' || call.method === 'tools/list') {
        if (!keys(params, ['_meta'])) return protocolError(id, -32602, 'Unsupported method parameters', 400);
        return complete(id, call.method === 'server/discover' ? {
          supportedVersions: [SITE_MCP_PROTOCOL_VERSION], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private',
        } : { tools, ttlMs: 0, cacheScope: 'private' });
      }
      if (call.method !== 'tools/call') return protocolError(id, -32601, 'Method not found');
      if (!keys(params, ['name', 'arguments', '_meta']) || typeof params.name !== 'string') return protocolError(id, -32602, 'Invalid tool parameters', 400);
      if (!tools.some((tool) => tool.name === params.name)) return complete(id, toolError('unknown_tool', 'Tool not found'));
      const args = argumentsFor(params.name, params.arguments, now);
      if (!args) return complete(id, toolError('invalid_arguments', 'Use the bounded tool schema; URLs, code and credentials are not accepted.'));
      const result = await invoke(params.name, args, request, env, ctx, controller.signal);
      controller.signal.throwIfAborted();
      return complete(id, result);
    } catch (error) {
      if (controller.signal.aborted) return complete(id, toolError('request_deadline', 'Request canceled or deadline reached. A started write may have committed; read collection_status before retrying.'));
      if (error.httpStatus) return protocolError(id, -32600, 'Request body exceeds its limit', error.httpStatus);
      if (error.parseError) return protocolError(id, -32700, 'Invalid JSON', 400);
      return complete(id, toolError('operation_unavailable', 'The bounded hosted operation is unavailable; existing evidence is retained.'));
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', aborted);
    }
  };
}
