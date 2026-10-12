import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MINUTE_DEPLOYMENT, readDeploymentArtifact, reviewedMinuteObservability, runMinuteTimerDeployment } from './deploy-api.mjs';

export const PRIVATE_DEPLOY_HANDOFF = Object.freeze({ host: '127.0.0.1', path: '/minute-deploy/token',
  nonceHeader: 'x-earth-deploy-nonce', bodyBytes: 4096, deadlineMs: 120_000, bodyMs: 10_000 });
const P = PRIVATE_DEPLOY_HANDOFF, HEX = /^[a-f0-9]{64}$/, KEY = /^[A-Za-z0-9_-]{43,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/, ACCOUNT = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const fail = () => { throw new Error('Invalid private initialization'); };
const steps = new Set(['admission', 'paused-upload', 'remove-cron', 'disable-public-http', 'paused-readback', 'secret',
  'secret-readback', 'enabled-upload', 'enabled-readback', 'minute-cron', 'final-readback', 'routing-upgrade', 'routing-readback', 'runtime-upgrade', 'runtime-readback']);
const statuses = new Set(['plan', 'bootstrap_inspected', 'configured_pending_runtime_verification', 'not_configured', 'invalid_control', 'artifact_invalid',
  'api_unavailable', 'api_rejected', 'invalid_response', 'response_limit', 'ownership_conflict', 'configuration_conflict',
  'plan_changed', 'readback_failed', 'cancelled', 'routing_upgrade_required', 'runtime_upgrade_required']);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

function initialization(value) {
  if (!object(value) || value.schemaVersion !== 1 || !['plan', 'deploy', 'verify', 'inspect-bootstrap', 'upgrade-routing', 'upgrade-runtime'].includes(value.mode) || !ACCOUNT.test(value.accountId) ||
      !KEY.test(value.hmacKey) || !HEX.test(value.nonce) || !exact(value, ['schemaVersion', 'mode', 'accountId', 'hmacKey', 'nonce',
        ...(['deploy', 'upgrade-routing', 'upgrade-runtime'].includes(value.mode) ? ['planId'] : []), ...(value.bootstrapProof !== undefined ? ['bootstrapProof'] : [])]) ||
      ['deploy', 'upgrade-routing', 'upgrade-runtime'].includes(value.mode) && !HEX.test(value.planId)) fail();
  if (value.bootstrapProof !== undefined && (!['plan', 'deploy'].includes(value.mode) || !exact(value.bootstrapProof, ['versionId', 'sourceSha256', 'taskOwnedNoZoneRoutes']) ||
      !UUID.test(value.bootstrapProof.versionId) || !value.bootstrapProof.versionId.startsWith('efe3d7d3-') || !HEX.test(value.bootstrapProof.sourceSha256) || value.bootstrapProof.taskOwnedNoZoneRoutes !== true)) fail();
  return { ...value };
}
function parsePrivate(bytes, allowedFields, nested = false) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(text);
  const fields = [...text.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s*:/g)].map(match => match[1]);
  const expected = Object.keys(value).length + (nested && object(value.bootstrapProof) ? Object.keys(value.bootstrapProof).length : 0);
  if (fields.length !== expected || new Set(fields).size !== fields.length || fields.some(key => !allowedFields.includes(key))) fail();
  return value;
}
/** Independent whitelist; injected errors/results can never echo credentials. */
export function safeDeploymentSummary(value) {
  const result = { schemaVersion: 1, status: statuses.has(value?.status) ? value.status : 'api_unavailable',
    scriptName: MINUTE_DEPLOYMENT.scriptName, artifactSha256: MINUTE_DEPLOYMENT.artifactSha256,
    freePlanVerified: false, runtimeVerified: false };
  if (Number.isSafeInteger(value?.mutations) && value.mutations >= 0 && value.mutations <= 6) result.mutations = value.mutations;
  if (value?.readbackRequired === true) result.readbackRequired = true;
  for (const field of ['step', 'lastConfirmedStep', 'uncertainStep']) if (steps.has(value?.[field])) result[field] = value[field];
  if (HEX.test(value?.planId)) result.planId = value.planId;
  if (object(value?.resource) && ['owned', 'absent', 'bootstrap'].includes(value.resource.state)) {
    result.resource = { state: value.resource.state };
    for (const field of ['deploymentId', 'versionId', 'latestUploadedVersionId']) if (UUID.test(value.resource[field])) result.resource[field] = value.resource[field];
    for (const field of ['enabled', 'secretPresent', 'publicSubdomain', 'cronEnabled', 'routingReady', 'runtimeReady'])
      if (typeof value.resource[field] === 'boolean') result.resource[field] = value.resource[field];
    if (Array.isArray(value.resource.compatibilityFlags) && (value.resource.compatibilityFlags.length === 0 ||
        value.resource.compatibilityFlags.length === 1 && value.resource.compatibilityFlags[0] === MINUTE_DEPLOYMENT.routingFlag))
      result.resource.compatibilityFlags = [...value.resource.compatibilityFlags];
    if ([MINUTE_DEPLOYMENT.artifactSha256, MINUTE_DEPLOYMENT.legacyArtifactSha256].includes(value.resource.sourceSha256)) result.resource.sourceSha256 = value.resource.sourceSha256;
    if (Number.isSafeInteger(value.resource.sourceBytes) && value.resource.sourceBytes > 0 && value.resource.sourceBytes <= MINUTE_DEPLOYMENT.artifactBytes) result.resource.sourceBytes = value.resource.sourceBytes;
    if (HEX.test(value.resource.observabilityDigest)) result.resource.observabilityDigest = value.resource.observabilityDigest;
    if (value.resource.observability !== undefined) {
      try { result.resource.observability = reviewedMinuteObservability(value.resource.observability); } catch { /* Unknown provider strings never leave RAM. */ }
    }
    if (value.resource.state === 'owned') result.resource.customRoutesVerified = false;
    if (value.resource.state === 'bootstrap') {
      if (HEX.test(value.resource.sourceSha256)) result.resource.sourceSha256 = value.resource.sourceSha256;
      if (/^\d{4}-\d\d-\d\d$/.test(value.resource.compatibilityDate)) result.resource.compatibilityDate = value.resource.compatibilityDate;
      for (const field of ['sourceBytes', 'bindingCount', 'tailConsumerCount', 'scheduleCount', 'customDomainCount'])
        if (Number.isSafeInteger(value.resource[field]) && value.resource[field] >= 0 && value.resource[field] <= 98304) result.resource[field] = value.resource[field];
      for (const field of ['workersDevEnabled', 'previewsEnabled']) if (typeof value.resource[field] === 'boolean') result.resource[field] = value.resource[field];
      result.resource.zoneRoutes = 'unverified';
      if (Array.isArray(value.resource.bindings) && value.resource.bindings.length <= 64 && value.resource.bindings.every(binding =>
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding?.name) && /^[a-z][a-z0-9_]{0,63}$/.test(binding?.type)))
        result.resource.bindings = value.resource.bindings.map(({ name, type }) => ({ name, type }));
    }
  }
  if (Array.isArray(value?.operations) && value.operations.length <= 6 && value.operations.every(step => steps.has(step))) result.operations = value.operations;
  return result;
}

/** A nonce-protected, one-use loopback transport. It never grants an account permission. */
export async function startPrivateDeployHandoff(value, { deploy = runMinuteTimerDeployment, artifactLoader = readDeploymentArtifact,
  logger = () => {}, signal: callerSignal, deadlineMs = P.deadlineMs, bodyMs = P.bodyMs } = {}) {
  const init = initialization(value);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > P.deadlineMs ||
      !Number.isSafeInteger(bodyMs) || bodyMs < 1 || bodyMs > P.bodyMs || callerSignal?.aborted) fail();
  const abort = new AbortController(), sockets = new Set(); let consumed = false, finished = false, port = null, timer;
  let settle; const completion = new Promise(resolve => { settle = resolve; });
  const output = result => { try { logger(result); } catch { /* Logging is optional and never changes admission. */ } };
  function finish(result) {
    if (finished) return; finished = true; clearTimeout(timer); callerSignal?.removeEventListener('abort', cancelled);
    init.hmacKey = null; init.nonce = null; init.accountId = null;
    server.close(); server.closeAllConnections(); for (const socket of sockets) socket.destroy();
    const safe = safeDeploymentSummary(result); output({ status: 'closed', result: safe }); settle(safe);
  }
  const cancelled = () => { abort.abort(); finish({ status: 'cancelled', readbackRequired: consumed }); };
  function reply(response, status, value) {
    if (response.destroyed || response.writableEnded) return Promise.resolve();
    return new Promise(resolve => {
      response.once('close', resolve);
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', connection: 'close' });
      response.end(JSON.stringify(value), resolve);
    });
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: P.bodyMs, headersTimeout: 5000 }, async (request, response) => {
    const reject = status => { void reply(response, status, { schemaVersion: 1, status: 'rejected' }).then(() => request.destroy()); };
    const headerCount = name => request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name).length;
    const candidate = request.headers[P.nonceHeader];
    if (consumed || finished) return reject(409);
    if (request.socket.remoteAddress !== P.host || request.socket.localAddress !== P.host || request.headers.host !== `${P.host}:${port}` ||
        headerCount('host') !== 1 || headerCount(P.nonceHeader) !== 1 || typeof candidate !== 'string' || !HEX.test(candidate) ||
        !timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(init.nonce, 'hex'))) return reject(403);
    if (request.method !== 'POST' || request.url !== P.path || Object.hasOwn(request.headers, 'origin') ||
        Object.keys(request.headers).some(name => name.startsWith('access-control-')) ||
        headerCount('content-type') !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '') ||
        request.headers['content-encoding'] !== undefined) return reject(400);
    const declared = request.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > P.bodyBytes)) return reject(413);
    let bytes = 0, token = null, control = null; const parts = [];
    const bodyTimer = setTimeout(() => request.destroy(), Math.min(bodyMs, deadlineMs));
    try {
      for await (const part of request) { bytes += part.byteLength; if (bytes > P.bodyBytes) { reject(413); return; } parts.push(part); }
      const payload = parsePrivate(Buffer.concat(parts, bytes), ['schemaVersion', 'apiToken']);
      if (!exact(payload, ['schemaVersion', 'apiToken']) || payload.schemaVersion !== 1 || !TOKEN.test(payload.apiToken)) { reject(400); return; }
      if (consumed || finished || abort.signal.aborted) { reject(409); return; }
      consumed = true; clearTimeout(bodyTimer); token = payload.apiToken; payload.apiToken = null;
      // Stop accepting connections before invoking any authenticated operation.
      server.close(); server.closeIdleConnections(); for (const socket of sockets) if (socket !== request.socket) socket.destroy();
      control = { schemaVersion: 1, mode: init.mode, accountId: init.accountId, apiToken: token,
        ...(init.mode === 'deploy' ? { planId: init.planId, hmacKey: init.hmacKey } : {}),
        ...(['upgrade-routing', 'upgrade-runtime'].includes(init.mode) ? { planId: init.planId } : {}),
        ...(init.bootstrapProof !== undefined ? { bootstrapProof: init.bootstrapProof } : {}) };
      const artifactBytes = await artifactLoader();
      if (abort.signal.aborted || finished) return;
      const result = safeDeploymentSummary(await deploy(control, { artifactBytes, signal: abort.signal }));
      if (finished) return;
      await reply(response, 200, { schemaVersion: 1, status: 'accepted', result }); finish(result);
    } catch {
      if (consumed) {
        const result = safeDeploymentSummary({ status: abort.signal.aborted ? 'cancelled' : 'api_unavailable', readbackRequired: ['deploy', 'upgrade-routing', 'upgrade-runtime'].includes(init.mode) });
        if (!finished) { await reply(response, 200, { schemaVersion: 1, status: 'accepted', result }); finish(result); }
      } else reject(400);
    } finally { clearTimeout(bodyTimer); for (const part of parts) part.fill(0); token = null; if (control) { control.apiToken = null; control.hmacKey = null; } }
  });
  server.maxConnections = 4; server.keepAliveTimeout = 1; server.maxRequestsPerSocket = 1;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, P.host, resolve); });
  port = server.address().port;
  callerSignal?.addEventListener('abort', cancelled, { once: true });
  timer = setTimeout(cancelled, deadlineMs);
  output({ schemaVersion: 1, status: 'ready', host: P.host, port, expiresInMs: deadlineMs });
  return { port, finished: completion, close: cancelled };
}

async function hiddenInitialization(stream) {
  if (!stream.isTTY || typeof stream.setRawMode !== 'function') fail();
  stream.setRawMode(true); stream.resume();
  let timer, parts = [], bytes = 0;
  try {
    return await new Promise((resolve, reject) => {
      const stop = () => { stream.off('data', data); stream.off('error', error); clearTimeout(timer); };
      const error = () => { stop(); reject(new Error('Invalid private initialization')); };
      const data = part => {
        if (part.includes(3)) { error(); return; }
        const end = part.indexOf(10), selected = end === -1 ? part : part.subarray(0, end);
        bytes += selected.length; if (bytes > P.bodyBytes || end !== -1 && part.subarray(end + 1).some(byte => ![10, 13].includes(byte))) { error(); return; }
        parts.push(Buffer.from(selected));
        if (end !== -1) {
          stop(); try { resolve(initialization(parsePrivate(Buffer.concat(parts, bytes), ['schemaVersion', 'mode', 'accountId', 'hmacKey', 'nonce', 'planId',
            'bootstrapProof', 'versionId', 'sourceSha256', 'taskOwnedNoZoneRoutes'], true))); }
          catch { reject(new Error('Invalid private initialization')); }
        }
      };
      stream.on('data', data); stream.once('error', error); timer = setTimeout(error, P.deadlineMs);
    });
  } finally { for (const part of parts) part.fill(0); parts = []; stream.setRawMode(false); stream.pause(); }
}
if (typeof process !== 'undefined' && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let init; const startedAt = Date.now();
  try {
    if (process.argv.length !== 2) fail();
    process.stdout.write('{"schemaVersion":1,"status":"awaiting_private_initialization"}\n');
    init = await hiddenInitialization(process.stdin);
    const remaining = P.deadlineMs - (Date.now() - startedAt);
    if (remaining < 1) fail();
    const relay = await startPrivateDeployHandoff(init, { deadlineMs: remaining, logger: value => process.stdout.write(JSON.stringify(value) + '\n') });
    const result = await relay.finished;
    process.exitCode = ['plan', 'bootstrap_inspected', 'configured_pending_runtime_verification'].includes(result.status) ? 0 : 1;
  } catch { process.stdout.write('{"schemaVersion":1,"status":"private_handoff_unavailable"}\n'); process.exitCode = 1; }
  finally { if (init) { init.hmacKey = null; init.nonce = null; init.accountId = null; } }
}
