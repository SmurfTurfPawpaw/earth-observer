import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MINUTE_DEPLOYMENT = Object.freeze({
  apiOrigin: 'https://api.cloudflare.com', scriptName: 'earth-observer-collector',
  moduleName: 'worker.mjs', compatibilityDate: '2026-10-11', cron: '* * * * *',
  routingFlag: 'global_fetch_strictly_public',
  artifactSha256: '05142ebac2aac381db1a1ed799318d6176c8453cdef3c94b5a5157abc0bf0449',
  legacyArtifactSha256: 'cac8817f512df979a71cb6c1b2c95703c5226c000e5d78be02435d18ac28d803',
  artifactPath: fileURLToPath(new URL('../.qa/cloudflare-minute-trigger-runtime-20261012.mjs', import.meta.url)),
  responseBytes: 96 * 1024, artifactBytes: 32 * 1024, controlBytes: 4096,
  requestMs: 10_000, runMs: 120_000,
});
const P = MINUTE_DEPLOYMENT, TAG = 'earth-minute-trigger-v1';
const HEX = /^[a-f0-9]{64}$/, ACCOUNT = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BOOTSTRAP_VERSION_PREFIX = 'efe3d7d3-';
const KEY = /^[A-Za-z0-9_-]{43,128}$/, TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCodes = new Set(['invalid_control', 'artifact_invalid', 'api_unavailable', 'api_rejected', 'invalid_response',
  'response_limit', 'ownership_conflict', 'configuration_conflict', 'plan_changed', 'readback_failed', 'cancelled']);

function validateControl(value) {
  if (!object(value) || value.schemaVersion !== 1 || !['plan', 'deploy', 'verify', 'inspect-bootstrap', 'upgrade-routing', 'upgrade-runtime'].includes(value.mode) ||
      !ACCOUNT.test(value.accountId) || !TOKEN.test(value.apiToken) ||
      Object.keys(value).some(key => !['schemaVersion', 'mode', 'accountId', 'apiToken', 'planId', 'hmacKey', 'bootstrapProof'].includes(key)) ||
      ['deploy', 'upgrade-routing', 'upgrade-runtime'].includes(value.mode) && !HEX.test(value.planId) ||
      value.mode === 'deploy' && !KEY.test(value.hmacKey) || value.mode !== 'deploy' && value.hmacKey !== undefined ||
      !['deploy', 'upgrade-routing', 'upgrade-runtime'].includes(value.mode) && value.planId !== undefined) fail('invalid_control');
  if (value.bootstrapProof !== undefined) {
    const proof = value.bootstrapProof;
    if (!['plan', 'deploy'].includes(value.mode) || !object(proof) || Object.keys(proof).length !== 3 || !UUID.test(proof.versionId) ||
        !proof.versionId.startsWith(BOOTSTRAP_VERSION_PREFIX) || !HEX.test(proof.sourceSha256) || proof.taskOwnedNoZoneRoutes !== true) fail('invalid_control');
  }
}
function active(promise, signal) {
  if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function boundedBytes(response, signal) {
  const length = response.headers.get('content-length');
  if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > P.responseBytes)) {
    void response.body?.cancel().catch(() => {}); fail('response_limit');
  }
  const reader = response.body.getReader(), parts = []; let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const chunk = await active(reader.read(), signal); signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > P.responseBytes) fail('response_limit'); parts.push(chunk.value);
    }
    return Buffer.concat(parts, bytes);
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
function parsedJson(bytes) {
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!object(value)) fail('invalid_response'); return value; }
  catch { fail('invalid_response'); }
}
function bindingsState(bindings) {
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 2) fail('configuration_conflict');
  const enabled = bindings.filter(binding => binding?.name === 'EARTH_MINUTE_TIMER_ENABLED');
  const secret = bindings.filter(binding => binding?.name === 'EARTH_TRIGGER_HMAC_KEY');
  if (enabled.length !== 1 || enabled[0].type !== 'plain_text' || !['0', '1'].includes(enabled[0].text) || secret.length > 1 ||
      secret.some(binding => binding.type !== 'secret_text') || bindings.length !== enabled.length + secret.length) fail('configuration_conflict');
  return { enabled: enabled[0].text === '1', secretPresent: secret.length === 1 };
}
/** Reviewed existing logging settings only; never turn an operator's logging on. */
export function reviewedMinuteObservability(value) {
  const rate = number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1;
  if (!object(value) || value.enabled !== true || Object.keys(value).some(key => !['enabled', 'head_sampling_rate', 'logs', 'traces', 'redact_query_string'].includes(key)) ||
      value.head_sampling_rate !== undefined && !rate(value.head_sampling_rate) || value.redact_query_string !== undefined && typeof value.redact_query_string !== 'boolean') fail('configuration_conflict');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!['logs', 'traces'].includes(key)) { result[key] = value[key]; continue; }
    const section = value[key];
    if (!object(section) || Object.keys(section).some(field => !['enabled', 'invocation_logs', 'head_sampling_rate', 'persist', 'destinations', 'propagation_policy'].includes(field)) ||
        key === 'logs' && (section.enabled !== true || section.invocation_logs !== true || section.propagation_policy !== undefined) ||
        key === 'traces' && (section.enabled !== false || section.invocation_logs !== undefined) ||
        section.head_sampling_rate !== undefined && !rate(section.head_sampling_rate) || section.persist !== undefined && typeof section.persist !== 'boolean' ||
        section.destinations !== undefined && (!Array.isArray(section.destinations) || section.destinations.length > 1 || section.destinations.some(item => item !== 'cloudflare')) ||
        section.propagation_policy !== undefined && section.propagation_policy !== null && section.propagation_policy !== 'authenticated') fail('configuration_conflict');
    result[key] = Object.fromEntries(Object.keys(section).sort().map(field => [field, Array.isArray(section[field]) ? [...section[field]] : section[field]]));
  }
  return result;
}

/** Fixed-resource deployment. No credential is read from environment, argv or disk. */
export async function runMinuteTimerDeployment(control, { artifactBytes, fetchImpl = fetch, signal: callerSignal,
  requestMs = P.requestMs, runMs = P.runMs } = {}) {
  let step = 'admission', lastConfirmedStep = null, uncertainStep = null, mutations = 0;
  const summary = extra => ({ schemaVersion: 1, scriptName: P.scriptName, artifactSha256: P.artifactSha256,
    freePlanVerified: false, runtimeVerified: false, ...extra });
  let timer;
  try {
    validateControl(control);
    // Node REPL and CUA can pass real byte views across distinct JS realms.
    if (!ArrayBuffer.isView(artifactBytes) || Object.prototype.toString.call(artifactBytes) !== '[object Uint8Array]' ||
        artifactBytes.BYTES_PER_ELEMENT !== 1 || artifactBytes.byteLength < 1 || artifactBytes.byteLength > P.artifactBytes ||
        hash(artifactBytes) !== P.artifactSha256) fail('artifact_invalid');
    if (!Number.isSafeInteger(requestMs) || requestMs < 1 || requestMs > P.requestMs ||
        !Number.isSafeInteger(runMs) || runMs < 1 || runMs > P.runMs) fail('invalid_control');
    const deadline = new AbortController(); timer = setTimeout(() => deadline.abort(), runMs);
    const runSignal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    const root = `${P.apiOrigin}/client/v4/accounts/${control.accountId}/workers/scripts/${P.scriptName}`;
    const allowed = new Set(['/__list__', '/__domains__', '/script-settings', '/settings', '/content/v2', '/deployments?per_page=1', '/versions?per_page=1', '/subdomain', '/schedules', '/secrets', '?bindings_inherit=strict']);
    async function request(suffix, { method = 'GET', body, contentType, content = false } = {}) {
      if (!allowed.has(suffix) && !/^\/versions\/[a-f0-9-]{36}$/.test(suffix)) fail('invalid_control');
      const url = suffix === '/__list__' ? root.slice(0, -P.scriptName.length - 1) : suffix === '/__domains__'
        ? `${P.apiOrigin}/client/v4/accounts/${control.accountId}/workers/domains` : root + suffix;
      const timeout = new AbortController(), boundedSignal = AbortSignal.any([runSignal, timeout.signal]);
      const requestTimer = setTimeout(() => timeout.abort(), requestMs), write = method !== 'GET'; let dispatched = false;
      try {
        boundedSignal.throwIfAborted();
        const headers = { authorization: `Bearer ${control.apiToken}`, accept: content ? '*/*' : 'application/json' };
        if (contentType) headers['content-type'] = contentType;
        const response = await active(Promise.resolve().then(() => {
          boundedSignal.throwIfAborted(); dispatched = true; if (write) mutations++;
          return fetchImpl(url, { method, headers, body, signal: boundedSignal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
        }), boundedSignal);
        if (response.redirected || response.url && response.url !== url) { void response.body?.cancel().catch(() => {}); fail('invalid_response'); }
        const bytes = await boundedBytes(response, boundedSignal);
        if (content && response.ok) return { bytes, contentType: response.headers.get('content-type') || '' };
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) fail('invalid_response');
        const payload = parsedJson(bytes);
        if (!response.ok || payload.success !== true || !Object.hasOwn(payload, 'result') ||
            payload.errors != null && (!Array.isArray(payload.errors) || payload.errors.length !== 0)) {
          // A rejected mutation is still read back before any future resend.
          fail('api_rejected');
        }
        if (suffix === '/__list__' || suffix === '/__domains__') {
          const scripts = payload.result, info = payload.result_info;
          if (!Array.isArray(scripts) || response.headers.has('link') || response.headers.has('x-next-cursor') ||
              payload.has_more !== undefined && payload.has_more !== false || payload.next_cursor != null && payload.next_cursor !== '') fail('invalid_response');
          if (info !== undefined && (!object(info) || info.count !== scripts.length || info.total_count !== scripts.length ||
              info.page !== undefined && info.page !== 1 || info.total_pages !== undefined && ![0, 1].includes(info.total_pages) ||
              info.has_more !== undefined && info.has_more !== false || info.next_cursor != null && info.next_cursor !== '' ||
              Object.keys(info).some(key => !['count', 'total_count', 'page', 'per_page', 'total_pages', 'has_more', 'next_cursor'].includes(key)))) fail('invalid_response');
        }
        return payload.result;
      } catch (error) {
        if (write && dispatched) uncertainStep = step;
        if (runSignal.aborted || callerSignal?.aborted) fail('cancelled');
        if (safeCodes.has(error?.code)) throw error;
        fail('api_unavailable');
      } finally { clearTimeout(requestTimer); }
    }
    async function codeFingerprint(bootstrap = false) {
      const response = await request('/content/v2', { content: true }); let bytes;
      if (/^(?:application|text)\/javascript(?:\+module)?(?:\s*;|$)/i.test(response.contentType)) bytes = response.bytes;
      else if (/^multipart\/form-data\s*;/i.test(response.contentType)) {
        let fields; try { fields = [...(await new Response(response.bytes, { headers: { 'content-type': response.contentType } }).formData()).entries()]; }
        catch { fail('invalid_response'); }
        if (fields.length !== 1 || typeof fields[0][1] === 'string' || fields[0][1].name !== fields[0][0] ||
            (bootstrap ? !/^[A-Za-z0-9_.-]{1,128}$/.test(fields[0][0]) : fields[0][0] !== P.moduleName)) fail('ownership_conflict');
        bytes = new Uint8Array(await fields[0][1].arrayBuffer());
      } else fail('invalid_response');
      return { sourceSha256: hash(bytes), sourceBytes: bytes.byteLength };
    }
    async function inspect(bootstrap = false) {
      // This documented unfiltered list has no pagination parameters. An
      // authenticated complete result, never a generic 404, admits creation.
      const scripts = await request('/__list__');
      if (!Array.isArray(scripts) || scripts.length > 100 || scripts.some(script => !object(script) || typeof script.id !== 'string' ||
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(script.id)) || new Set(scripts.map(script => script.id)).size !== scripts.length) fail('invalid_response');
      if (!scripts.some(script => script.id === P.scriptName)) return { state: 'absent' };
      const settings = await request('/script-settings');
      if (!bootstrap && (!Array.isArray(settings.tags) || settings.tags.length !== 2 || !settings.tags.includes(TAG) ||
          settings.tail_consumers != null && (!Array.isArray(settings.tail_consumers) || settings.tail_consumers.length !== 0) ||
          settings.logpush !== undefined && settings.logpush !== false)) fail('ownership_conflict');
      const fingerprint = await codeFingerprint(bootstrap);
      if (!bootstrap && (![P.artifactSha256, P.legacyArtifactSha256].includes(fingerprint.sourceSha256) ||
          !settings.tags.includes(`sha256:${fingerprint.sourceSha256}`))) fail('ownership_conflict');
      const deployments = await request('/deployments?per_page=1'), deployment = deployments?.deployments?.[0];
      if (!deployment || deployments.deployments.length !== 1 || !UUID.test(deployment.id) || deployment.versions?.length !== 1 ||
          deployment.versions[0].percentage !== 100 || !UUID.test(deployment.versions[0].version_id)) fail('configuration_conflict');
      const version = await request(`/versions/${deployment.versions[0].version_id}`), resources = version?.resources;
      if (bootstrap) {
        const date = resources?.script_runtime?.compatibility_date, bindings = resources?.bindings;
        if (version?.id !== deployment.versions[0].version_id || typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) ||
            !Array.isArray(bindings) || bindings.length > 64 || bindings.some(binding => !object(binding) ||
              !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.name) || !/^[a-z][a-z0-9_]{0,63}$/.test(binding.type)) ||
            settings.tail_consumers != null && !Array.isArray(settings.tail_consumers)) fail('invalid_response');
        const subdomain = await request('/subdomain'), schedules = await request('/schedules'), domains = await request('/__domains__');
        if (typeof subdomain?.enabled !== 'boolean' || typeof subdomain.previews_enabled !== 'boolean' || !Array.isArray(schedules?.schedules) ||
            schedules.schedules.length > 5 || schedules.schedules.some(item => typeof item?.cron !== 'string' || item.cron.length > 128) ||
            !Array.isArray(domains) || domains.length > 100 || domains.some(item => !object(item) || typeof item.service !== 'string')) fail('invalid_response');
        return { state: 'bootstrap', deploymentId: deployment.id, versionId: version.id, ...fingerprint, compatibilityDate: date,
          bindingCount: bindings.length, bindings: bindings.map(({ name, type }) => ({ name, type })),
          tailConsumerCount: settings.tail_consumers?.length ?? 0, scheduleCount: schedules.schedules.length,
          customDomainCount: domains.filter(item => item.service === P.scriptName).length,
          workersDevEnabled: subdomain.enabled, previewsEnabled: subdomain.previews_enabled, zoneRoutes: 'unverified' };
      }
      if (version.id !== deployment.versions[0].version_id || resources?.script_runtime?.compatibility_date !== P.compatibilityDate ||
          !Array.isArray(resources.script?.handlers) || resources.script.handlers.length !== 2 ||
          !resources.script.handlers.includes('scheduled') || !resources.script.handlers.includes('fetch')) fail('configuration_conflict');
      const observability = reviewedMinuteObservability(settings.observability);
      // Strict inheritance resolves against the latest upload, not necessarily
      // the deployed version. Never inherit from an unreviewed staged head.
      const latest = await request('/versions?per_page=1');
      if (!Array.isArray(latest?.items) || latest.items.length !== 1 || latest.items[0]?.id !== version.id) fail('configuration_conflict');
      // Version resources may omit compatibility_flags. The documented current
      // settings reader confirms them only after active and latest heads agree.
      const versionSettings = await request('/settings'), flags = versionSettings?.compatibility_flags;
      const reportedFlags = resources.script_runtime.compatibility_flags;
      if (!Array.isArray(flags) || !(flags.length === 0 || flags.length === 1 && flags[0] === P.routingFlag) ||
          versionSettings.compatibility_date !== undefined && versionSettings.compatibility_date !== P.compatibilityDate ||
          reportedFlags !== undefined && (!Array.isArray(reportedFlags) || JSON.stringify(reportedFlags) !== JSON.stringify(flags)) ||
          JSON.stringify(reviewedMinuteObservability(versionSettings.observability)) !== JSON.stringify(observability)) fail('configuration_conflict');
      const binding = bindingsState(resources.bindings), subdomain = await request('/subdomain'), schedules = await request('/schedules');
      if (typeof subdomain?.enabled !== 'boolean' || typeof subdomain.previews_enabled !== 'boolean' || !Array.isArray(schedules?.schedules) ||
          schedules.schedules.length > 1 || schedules.schedules.some(schedule => schedule.cron !== P.cron)) fail('configuration_conflict');
      return { state: 'owned', deploymentId: deployment.id, versionId: version.id, ...binding,
        ...fingerprint, runtimeReady: fingerprint.sourceSha256 === P.artifactSha256,
        compatibilityFlags: [...flags], routingReady: flags.length === 1, latestUploadedVersionId: latest.items[0].id,
        observability, observabilityDigest: hash(JSON.stringify(observability)),
        publicSubdomain: subdomain.enabled || subdomain.previews_enabled, customRoutesVerified: false, cronEnabled: schedules.schedules.length === 1 };
    }
    const initial = await inspect(control.mode === 'inspect-bootstrap' || control.bootstrapProof !== undefined);
    if (control.mode === 'inspect-bootstrap') return summary({ status: 'bootstrap_inspected', resource: initial, mutations: 0 });
    if (control.bootstrapProof !== undefined && (initial.state !== 'bootstrap' || initial.versionId !== control.bootstrapProof.versionId ||
        initial.sourceSha256 !== control.bootstrapProof.sourceSha256 || initial.bindingCount !== 0 || initial.tailConsumerCount !== 0 ||
        initial.scheduleCount !== 0 || initial.customDomainCount !== 0)) fail('ownership_conflict');
    const planId = hash(JSON.stringify([control.accountId, P.scriptName, P.artifactSha256, initial, control.bootstrapProof ?? null]));
    const otherwiseConfigured = initial.state === 'owned' && initial.enabled && initial.secretPresent && initial.cronEnabled && !initial.publicSubdomain;
    if (otherwiseConfigured && !initial.runtimeReady && !initial.routingReady) fail('configuration_conflict');
    if (control.mode === 'plan') return summary({ status: 'plan', allowed: true, planId, resource: initial,
      operations: otherwiseConfigured ? !initial.runtimeReady ? ['runtime-upgrade'] : initial.routingReady ? [] : ['routing-upgrade'] :
        ['paused-upload', 'remove-cron', 'disable-public-http', 'secret', 'enabled-upload', 'minute-cron'], mutations: 0 });
    if (control.mode === 'verify') return summary({ status: otherwiseConfigured ? !initial.runtimeReady ? 'runtime_upgrade_required' : initial.routingReady
      ? 'configured_pending_runtime_verification' : 'routing_upgrade_required' : 'not_configured', resource: initial, mutations: 0 });
    if (control.planId !== planId) fail('plan_changed');
    if (otherwiseConfigured && initial.routingReady && initial.runtimeReady)
      return summary({ status: 'configured_pending_runtime_verification', resource: initial, mutations: 0 });
    if (control.mode === 'upgrade-routing' && (!otherwiseConfigured || !initial.runtimeReady) ||
        control.mode === 'upgrade-runtime' && (!otherwiseConfigured || !initial.routingReady)) fail('configuration_conflict');
    if (otherwiseConfigured && !initial.runtimeReady) {
      if (control.mode !== 'upgrade-runtime') fail('configuration_conflict');
      step = 'runtime-upgrade'; await upload(true, true); lastConfirmedStep = step;
      step = 'runtime-readback'; const upgraded = await inspect();
      if (!upgraded.runtimeReady || !upgraded.routingReady || !upgraded.enabled || !upgraded.secretPresent || !upgraded.cronEnabled || upgraded.publicSubdomain ||
          upgraded.observabilityDigest !== initial.observabilityDigest) fail('readback_failed');
      return summary({ status: 'configured_pending_runtime_verification', resource: upgraded, mutations });
    }
    if (otherwiseConfigured && !initial.routingReady) {
      step = 'routing-upgrade';
      // Re-upload only the identical pinned module and reviewed metadata. The
      // existing secret is inherited strictly; Cron and routes are untouched.
      await upload(true, true); lastConfirmedStep = step;
      step = 'routing-readback'; const upgraded = await inspect();
      if (!upgraded.runtimeReady || !upgraded.routingReady || !upgraded.enabled || !upgraded.secretPresent || !upgraded.cronEnabled || upgraded.publicSubdomain ||
          upgraded.observabilityDigest !== initial.observabilityDigest) fail('readback_failed');
      return summary({ status: 'configured_pending_runtime_verification', resource: upgraded, mutations });
    }
    async function upload(enabled, inheritSecret) {
      const bindings = [{ name: 'EARTH_MINUTE_TIMER_ENABLED', type: 'plain_text', text: enabled ? '1' : '0' }];
      if (inheritSecret) bindings.push({ name: 'EARTH_TRIGGER_HMAC_KEY', type: 'inherit' });
      const metadata = JSON.stringify({ main_module: P.moduleName, compatibility_date: P.compatibilityDate, compatibility_flags: [P.routingFlag],
        bindings, tags: [TAG, `sha256:${P.artifactSha256}`], observability: initial.state === 'owned' ? initial.observability : { enabled: true }, logpush: false, tail_consumers: [] });
      // Native Node REPL exposes byte bodies even when FormData/Blob globals are
      // absent. These fixed parts preserve the documented module-upload format.
      const boundary = `earth-minute-${P.artifactSha256}-${enabled ? '1' : '0'}`;
      const code = Buffer.from(artifactBytes.buffer, artifactBytes.byteOffset, artifactBytes.byteLength);
      if (code.includes(boundary) || metadata.includes(boundary)) fail('artifact_invalid');
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${P.moduleName}"; filename="${P.moduleName}"\r\nContent-Type: application/javascript+module\r\n\r\n`),
        code, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      if (body.byteLength > P.artifactBytes + 4096) fail('artifact_invalid');
      await request('?bindings_inherit=strict', { method: 'PUT', body,
        contentType: `multipart/form-data; boundary=${boundary}` });
    }
    step = 'paused-upload'; await upload(false, initial.secretPresent === true); lastConfirmedStep = step;
    step = 'remove-cron'; await request('/schedules', { method: 'PUT', body: '[]', contentType: 'application/json' }); lastConfirmedStep = step;
    step = 'disable-public-http'; await request('/subdomain', { method: 'POST', body: '{"enabled":false,"previews_enabled":false}', contentType: 'application/json' }); lastConfirmedStep = step;
    step = 'paused-readback'; const paused = await inspect();
    if (paused.state !== 'owned' || !paused.runtimeReady || !paused.routingReady || paused.enabled || paused.publicSubdomain || paused.cronEnabled) fail('readback_failed'); lastConfirmedStep = step;
    step = 'secret'; await request('/secrets', { method: 'PUT', body: JSON.stringify({ name: 'EARTH_TRIGGER_HMAC_KEY', type: 'secret_text', text: control.hmacKey }),
      contentType: 'application/json' }); lastConfirmedStep = step;
    step = 'secret-readback'; const provisioned = await inspect();
    if (!provisioned.runtimeReady || !provisioned.routingReady || !provisioned.secretPresent || provisioned.enabled || provisioned.publicSubdomain || provisioned.cronEnabled) fail('readback_failed'); lastConfirmedStep = step;
    step = 'enabled-upload'; await upload(true, true); lastConfirmedStep = step;
    step = 'enabled-readback'; const enabled = await inspect();
    if (!enabled.runtimeReady || !enabled.routingReady || !enabled.enabled || !enabled.secretPresent || enabled.publicSubdomain || enabled.cronEnabled) fail('readback_failed'); lastConfirmedStep = step;
    step = 'minute-cron'; await request('/schedules', { method: 'PUT', body: JSON.stringify([{ cron: P.cron }]), contentType: 'application/json' }); lastConfirmedStep = step;
    step = 'final-readback'; const complete = await inspect();
    if (!complete.runtimeReady || !complete.routingReady || !complete.enabled || !complete.secretPresent || complete.publicSubdomain || !complete.cronEnabled) fail('readback_failed');
    return summary({ status: 'configured_pending_runtime_verification', resource: complete, mutations });
  } catch (error) {
    return summary({ status: safeCodes.has(error?.code) ? error.code : 'api_unavailable', step, lastConfirmedStep, uncertainStep,
      readbackRequired: mutations > 0, mutations });
  } finally { clearTimeout(timer); }
}

export async function readDeploymentArtifact() {
  let handle;
  try {
    handle = await open(P.artifactPath, 'r'); const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > P.artifactBytes) fail('artifact_invalid');
    const bytes = await handle.readFile(); if (bytes.byteLength > P.artifactBytes || hash(bytes) !== P.artifactSha256) fail('artifact_invalid');
    return bytes;
  } catch { fail('artifact_invalid'); } finally { await handle?.close(); }
}
async function readControl(stream) {
  const chunks = []; let length = 0;
  for await (const chunk of stream) { length += chunk.length; if (length > P.controlBytes) fail('invalid_control'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks, length), value = parsedJson(bytes);
  const fields = [...bytes.toString('utf8').matchAll(/"(schemaVersion|mode|accountId|apiToken|planId|hmacKey|bootstrapProof)"\s*:/g)].map(match => match[1]);
  if (new Set(fields).size !== fields.length) fail('invalid_control');
  return value;
}
if (typeof process !== 'undefined' && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let result, control;
  try {
    if (process.argv.length !== 2 || process.stdin.isTTY) fail('invalid_control');
    const timeout = setTimeout(() => process.stdin.destroy(Object.assign(new Error('invalid_control'), { code: 'invalid_control' })), 10_000);
    try { control = await readControl(process.stdin); } finally { clearTimeout(timeout); }
    const artifactBytes = await readDeploymentArtifact(); result = await runMinuteTimerDeployment(control, { artifactBytes });
  } catch { result = { schemaVersion: 1, status: 'invalid_control', freePlanVerified: false, runtimeVerified: false, mutations: 0 }; }
  finally { if (control) { control.apiToken = null; control.hmacKey = null; } }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = ['plan', 'bootstrap_inspected', 'configured_pending_runtime_verification'].includes(result.status) ? 0 : 1;
}
