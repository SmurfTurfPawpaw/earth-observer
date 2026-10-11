import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collectEarthSources } from '../worker/collector.js';
import { canonicalDiscoveryRecord } from '../src/core/discovery-index.js';
import { createLocalGdeltSource } from './local-gdelt-source.mjs';

export const LOCAL_PUBLISH_URL = 'https://giovannicallebaut.com/earth/api/collector';
export const MAX_LOCAL_ANALYSIS_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024, MAX_PACKET_BYTES = 1200000;
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

function recordsOf(records) {
  if (!Array.isArray(records) || records.length > 500) throw new TypeError('Local metadata exceeds its record bound');
  const normalized = records.map(canonicalDiscoveryRecord);
  if (normalized.some((record) => !record) || new Set(normalized.map((record) => record.id)).size !== normalized.length)
    throw new TypeError('Invalid local source metadata');
  return normalized.sort((a, b) => ordinal(a.id, b.id));
}

const factsOf = (record) => { const { retrievedAt: _retrievedAt, ...facts } = record; return facts; };
/** Portable algorithm: UTF-8 SHA-256 of JSON canonical records, ordinal ID sort, retrievedAt excluded only. */
export const factsDigest = (records) => sha(recordsOf(records).map(factsOf));

function packetOf(packet) {
  if (packet?.schemaVersion !== 1 || typeof packet.collectedAt !== 'string' || !Number.isFinite(Date.parse(packet.collectedAt)) ||
      new Date(packet.collectedAt).toISOString() !== packet.collectedAt || !Array.isArray(packet.payload?.sources) ||
      packet.payload.sources.length > 20 || jsonBytes(packet) > MAX_PACKET_BYTES) throw new TypeError('Invalid portable collection packet');
  return { ...packet, payload: { ...packet.payload, indexRecords: recordsOf(packet.payload.indexRecords) } };
}

function labelsOf(value) {
  if (!Array.isArray(value) || value.length > 12 || value.some((label) => typeof label !== 'string' || !label.trim() || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)))
    throw new TypeError('Invalid derived labels');
  return [...new Set(value.map((label) => label.trim()))];
}

function delta(previous, records) {
  const old = new Map((previous || []).map((record) => [record.id, sha(factsOf(record))]));
  const added = [], revised = [], current = new Set();
  for (const record of records) {
    current.add(record.id);
    if (!old.has(record.id)) added.push(record);
    else if (old.get(record.id) !== sha(factsOf(record))) revised.push(record);
  }
  return { added, revised, withdrawn: [...old.keys()].filter((id) => !current.has(id)) };
}

function topicsOf(records) {
  const counts = new Map();
  for (const record of records) {
    const labels = new Set([...(record.reviewedTopics || []), ...(record.categories || [record.category]), `Source: ${record.sourceId}`]);
    for (const label of labels) if (typeof label === 'string' && label.length <= 80) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].sort(([a, countA], [b, countB]) => countB - countA || ordinal(a, b)).slice(0, 80)
    .map(([label, count]) => ({ label, count }));
}

function analysisOf(packet, changes, cachedLabels, method) {
  const artifact = { schemaVersion: 1, method, createdAt: packet.collectedAt, inputDigest: factsDigest(packet.payload.indexRecords),
    changes: { added: changes.added.length, revised: changes.revised.length, withdrawn: changes.withdrawn.length },
    topics: topicsOf(packet.payload.indexRecords), analysis: [] };
  for (const record of packet.payload.indexRecords) {
    const labels = [...new Set([`Source: ${record.sourceId}`, `Metadata: ${record.kind}`, ...(record.reviewedTopics || []),
      ...(cachedLabels.get(record.id) || [])])].filter((label) => label.length <= 80).slice(0, 12);
    const entry = { id: record.id, labels };
    artifact.analysis.push(entry);
    if (jsonBytes(artifact) > MAX_LOCAL_ANALYSIS_BYTES) { artifact.analysis.pop(); break; }
  }
  if (jsonBytes(artifact) > MAX_LOCAL_ANALYSIS_BYTES) throw new Error('Derived analysis exceeded its byte bound');
  return artifact;
}

async function inferredLabels(infer, changed, { now, inputDigest, timeoutMs }) {
  if (!infer || !changed.length) return { values: new Map(), status: !infer ? 'disabled' : 'unchanged' };
  const controller = new AbortController(); let timer;
  try {
    const value = await Promise.race([Promise.resolve().then(() => infer(structuredClone(changed), {
      signal: controller.signal, inputDigest, createdAt: new Date(now()).toISOString(),
    })), new Promise((_resolve, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error('Local inference timed out'));
    }, timeoutMs); })]);
    if (!Array.isArray(value) || value.length > changed.length || jsonBytes(value) > MAX_LOCAL_ANALYSIS_BYTES) throw new TypeError('Invalid bounded inference result');
    const admitted = new Set(changed.map((record) => record.id)), values = new Map();
    for (const row of value) {
      if (!row || !admitted.has(row.id) || values.has(row.id) || Object.keys(row).some((key) => !['id', 'labels'].includes(key)))
        throw new TypeError('Inference must reference changed source metadata only');
      values.set(row.id, labelsOf(row.labels));
    }
    return { values, status: 'applied' };
  } catch { return { values: new Map(), status: controller.signal.aborted ? 'timeout' : 'unavailable' }; }
  finally { clearTimeout(timer); }
}

function fallbackPacket(outbox, facts) {
  if (outbox.packet) return packetOf(outbox.packet);
  if (!facts?.packet) return null;
  const sources = outbox.body.sources, bySource = new Map(sources.map((source) => [source.id, source]));
  const direct = new Map(sources.filter((source) => source.id !== 'gdelt' && source.status === 'ready' &&
    typeof source.retrievedAt === 'string' && Number.isFinite(Date.parse(source.retrievedAt))).map((source) => [source.id, source]));
  const records = facts.packet.payload.indexRecords.map((record) => {
    const retrievedAt = direct.get(record.sourceId)?.retrievedAt;
    // GDELT preserves each retained batch's distinct retrieval date.
    return retrievedAt ?
      { ...record, retrievedAt: new Date(retrievedAt).toISOString() } : record;
  });
  return packetOf({ ...facts.packet, collectedAt: outbox.body.collectedAt, payload: {
    ...facts.packet.payload, retrievedAt: outbox.body.collectedAt, sources, indexRecords: records,
    indexCoverage: { ...facts.packet.payload.indexCoverage, sources: facts.packet.payload.indexCoverage.sources.map((source) => {
      const refreshed = direct.get(source.id);
      return refreshed ? { ...source, generation: `${source.id}:${refreshed.retrievedAt}`, status: refreshed.status,
        expiresAt: new Date(Date.parse(refreshed.retrievedAt) + 86400000).toISOString() } :
        { ...source, status: bySource.get(source.id)?.status || source.status };
    }) },
  } });
}

/** Laptop processing precedes the private hosted writer; no inference model or plugin is downloaded. */
export function createLocalPipeline({ fetchImpl = fetch, now = Date.now,
  stateDirectory = path.resolve('.cache/collector'), infer, inferTimeoutMs = 10000, publishUrl, publishCredential,
  gdeltMode = 'owned-release', getSignal } = {}) {
  const directory = path.resolve(stateDirectory);
  if (!['owned-release', 'local-gkg'].includes(gdeltMode) || getSignal !== undefined && typeof getSignal !== 'function')
    throw new TypeError('Use a reviewed local GDELT mode and cancellation interface');
  if (publishUrl && publishUrl !== LOCAL_PUBLISH_URL) throw new TypeError('Use the fixed owned HTTPS publish endpoint');
  if (publishCredential !== undefined && !/^[a-zA-Z0-9_-]{32,256}$/.test(publishCredential)) throw new TypeError('Invalid publish credential format');
  const publishing = Boolean(publishUrl && publishCredential), collectorEnv = {};
  const localGdelt = gdeltMode === 'local-gkg' ? createLocalGdeltSource({ fetchImpl, now, stateDirectory: path.join(directory, 'gdelt') }) : null;
  const snapshotReader = localGdelt ? (filters) => localGdelt.read(filters, { signal: getSignal?.() }) : undefined;
  const inferDeadline = Math.max(10, Math.min(60000, Number.isFinite(inferTimeoutMs) ? inferTimeoutMs : 10000));
  let facts = null, clock = { schemaVersion: 1, lastCycleAt: null, lastCapturedAt: null, lastPublishedAt: null,
    lastPublishedDigest: null, lastPublishedGdeltGeneration: null }, outbox = null;
  let initialized, serial = Promise.resolve(), temporary = 0;
  const file = (name) => path.join(directory, name);
  async function read(name) {
    try {
      const target = file(name), info = await stat(target);
      if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error('Local state exceeds its bound');
      return JSON.parse(await readFile(target, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Owned local pipeline state is unavailable or invalid'); }
  }
  async function save(name, value) {
    if (jsonBytes(value) > MAX_STATE_BYTES) throw new Error('Local pipeline state exceeds its byte bound');
    await mkdir(directory, { recursive: true });
    const destination = file(name), pendingFile = `${destination}.${process.pid}.${++temporary}.tmp`;
    await writeFile(pendingFile, `${JSON.stringify(value)}\n`, { mode: 0o600 }); await rename(pendingFile, destination);
  }
  const initialize = () => initialized ||= (async () => {
    await mkdir(directory, { recursive: true });
    const loadedFacts = await read('facts.json'), loadedClock = await read('clock.json'), loadedOutbox = await read('outbox.json');
    if (loadedFacts) {
      const packet = packetOf(loadedFacts.packet);
      if (loadedFacts.schemaVersion !== 1 || loadedFacts.inputDigest !== factsDigest(packet.payload.indexRecords) || !Array.isArray(loadedFacts.labels))
        throw new Error('Local facts integrity validation failed');
      facts = { ...loadedFacts, packet, labels: loadedFacts.labels.map((row) => ({ id: row.id, labels: labelsOf(row.labels) })) };
    }
    if (loadedClock?.schemaVersion === 1) clock = { ...clock, ...loadedClock };
    if (loadedOutbox) {
      if (loadedOutbox.schemaVersion !== 1 || !['publish', 'heartbeat'].includes(loadedOutbox.body?.action) ||
          !Number.isFinite(loadedOutbox.nextRetryAt) || !Number.isInteger(loadedOutbox.failures) || loadedOutbox.failures < 0 || loadedOutbox.failures > 10)
        throw new Error('Local outbox integrity validation failed');
      outbox = loadedOutbox;
      if (outbox.body.action === 'publish') {
        const packet = packetOf(outbox.body.packet), digest = factsDigest(packet.payload.indexRecords);
        if (outbox.body.analysis?.inputDigest !== digest || outbox.body.analysis?.createdAt !== packet.collectedAt || jsonBytes(outbox.body.analysis) > MAX_LOCAL_ANALYSIS_BYTES)
          throw new Error('Pending local analysis integrity validation failed');
        // Recover a crash between queuing publication and committing the local facts file.
        if (!facts || packet.collectedAt >= facts.packet.collectedAt && digest !== facts.inputDigest) {
          const labels = (outbox.localLabels || []).map((row) => ({ id: row.id, labels: labelsOf(row.labels) }));
          facts = { schemaVersion: 1, inputDigest: digest, packet, labels, processedAt: packet.collectedAt };
          await save('facts.json', facts);
        }
      }
    }
  })();
  const runSerial = (task) => {
    const work = serial.catch(() => {}).then(async () => { await initialize(); return task(); }); serial = work; return work;
  };
  const summary = (status, extra = {}) => ({ status, outcome: status, published: false,
    recordCount: facts?.packet.payload.indexRecords.length || 0, queued: Boolean(outbox),
    retryAt: outbox?.nextRetryAt ? new Date(outbox.nextRetryAt).toISOString() : null, ...extra });

  async function post(body) {
    if (jsonBytes(body) > 1536 * 1024) return { ok: false, status: 413, retryMs: 3600000 };
    try {
      const response = await fetchImpl(LOCAL_PUBLISH_URL, { method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${publishCredential}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      const retry = response.headers.get('retry-after');
      const delay = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry || '') - now();
      const retryMs = Number.isFinite(delay) ? Math.max(0, Math.min(86400000, delay)) : 0;
      if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, retryMs }; }
      const reader = response.body?.getReader(); let text = '', count = 0; const decoder = new TextDecoder();
      if (!reader) return { ok: false, status: 502, retryMs };
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        count += value.byteLength; if (count > 8192) { await reader.cancel(); return { ok: false, status: 502, retryMs }; }
        text += decoder.decode(value, { stream: true });
      }
      const value = JSON.parse(text + decoder.decode());
      return { ok: Boolean(value?.stored || value?.published || value?.ok), status: response.status, retryMs };
    } catch { return { ok: false, status: 0, retryMs: 0 }; }
  }

  async function flush(currentPacket, currentAnalysis) {
    if (!outbox) return summary('idle');
    if (!publishing) return summary('queued');
    if (outbox.nextRetryAt > now()) return summary('backoff');
    let result = await post(outbox.body);
    if (!result.ok && result.status === 409 && outbox.body.action === 'heartbeat') {
      const packet = currentPacket || fallbackPacket(outbox, facts);
      if (packet) {
        const empty = { added: [], revised: [], withdrawn: [] }, cached = new Map((facts?.labels || []).map((row) => [row.id, row.labels]));
        const analysis = currentAnalysis || analysisOf(packet, empty, cached, 'deterministic-metadata-with-retained-local-labels');
        outbox = { ...outbox, body: { action: 'publish', packet, analysis }, localLabels: facts?.labels || [] }; await save('outbox.json', outbox);
        result = await post(outbox.body);
      }
    }
    if (result.ok) {
      clock.lastPublishedAt = outbox.body.action === 'publish' ? outbox.body.packet.collectedAt : outbox.body.collectedAt;
      clock.lastPublishedDigest = outbox.body.action === 'publish' ? outbox.body.analysis.inputDigest : outbox.body.inputDigest;
      if (outbox.body.action === 'publish') clock.lastPublishedGdeltGeneration =
        outbox.body.packet.payload.sources.find((source) => source.id === 'gdelt')?.generatedAt || null;
      await save('clock.json', clock);
      await unlink(file('outbox.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; }); outbox = null;
      return summary('published', { published: true });
    }
    const failures = Math.min(outbox.failures + 1, 10);
    const policy = [400, 401, 403, 413].includes(result.status) ? 3600000 : Math.min(60000 * 2 ** (failures - 1), 3600000);
    outbox = { ...outbox, failures, nextRetryAt: now() + Math.max(policy, result.retryMs) };
    if (currentPacket && outbox.body.action === 'heartbeat') outbox.packet = currentPacket;
    await save('outbox.json', outbox);
    return summary('queued');
  }

  return {
    cycle: () => runSerial(async () => {
      if (outbox) {
        const pending = await flush();
        if (outbox) return pending;
      }
      getSignal?.()?.throwIfAborted();
      const acquisition = await collectEarthSources(collectorEnv, {}, { fetchImpl, now, snapshotReader });
      getSignal?.()?.throwIfAborted();
      const packet = packetOf(acquisition.packet), records = packet.payload.indexRecords;
      const previous = facts?.packet.payload.indexRecords || [], changes = delta(previous, records), inputDigest = factsDigest(records);
      const cached = new Map((facts?.labels || []).map((row) => [row.id, row.labels]));
      for (const record of [...changes.added, ...changes.revised]) cached.delete(record.id);
      for (const id of changes.withdrawn) cached.delete(id);
      const inference = await inferredLabels(infer, [...changes.added, ...changes.revised], { now, inputDigest, timeoutMs: inferDeadline });
      for (const [id, labels] of inference.values) cached.set(id, labels);
      const method = [...cached.values()].some((labels) => labels.length) ? 'deterministic-metadata-with-optional-local-derived-labels' : 'deterministic-source-metadata';
      const analysis = analysisOf(packet, changes, cached, method), changed = inputDigest !== facts?.inputDigest;
      if (publishing) {
        const gdeltGeneration = packet.payload.sources.find((source) => source.id === 'gdelt')?.generatedAt || null;
        // A processed batch can change coverage without changing selected IDs. Publish that real provenance in full.
        const unchangedGdeltCoverage = gdeltMode !== 'local-gkg' || clock.lastPublishedGdeltGeneration === gdeltGeneration;
        const body = clock.lastPublishedDigest === inputDigest && unchangedGdeltCoverage ? { action: 'heartbeat', collectedAt: packet.collectedAt,
          sources: packet.payload.sources, inputDigest } : { action: 'publish', packet, analysis };
        outbox = { schemaVersion: 1, body, failures: 0, nextRetryAt: 0,
          ...(body.action === 'publish' ? { localLabels: [...cached].map(([id, labels]) => ({ id, labels })) } : {}) };
        await save('outbox.json', outbox);
      }
      if (changed) {
        facts = { schemaVersion: 1, inputDigest, packet, labels: [...cached].map(([id, labels]) => ({ id, labels })), processedAt: packet.collectedAt };
        await save('facts.json', facts);
      }
      clock.lastCycleAt = new Date(now()).toISOString(); clock.lastCapturedAt = packet.collectedAt; await save('clock.json', clock);
      const publication = publishing ? await flush(packet, analysis) : summary('ready-local');
      return { ...publication, packet, analysis, inputDigest, capturedAt: packet.collectedAt, changedRecords: changes.added.length + changes.revised.length,
        revisedRecords: changes.revised.length, withdrawnRecords: changes.withdrawn.length, analysisCount: analysis.analysis.length,
        sourceCount: packet.payload.sources.length, readySources: packet.payload.sources.filter((source) => source.status === 'ready').length,
        staleSources: packet.payload.sources.filter((source) => source.status === 'stale').length,
        unavailableSources: packet.payload.sources.filter((source) => source.status === 'unavailable').length, inferenceStatus: inference.status };
    }),
    flushOutbox: () => runSerial(() => flush()),
    status: () => runSerial(async () => ({ ...summary(outbox ? 'queued' : 'idle'), configured: publishing, stateDirectory: directory,
      inputDigest: facts?.inputDigest || null, ...clock, gdeltMode, ...(localGdelt ? { gdelt: await localGdelt.status() } : {}) })),
    close: () => localGdelt?.close(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const credential = process.env.EARTH_COLLECTION_SECRET || process.env.EARTH_COLLECTOR_TOKEN;
  const pipeline = createLocalPipeline({ stateDirectory: process.argv[2] || '.cache/collector', gdeltMode: 'local-gkg',
    ...(credential ? { publishUrl: LOCAL_PUBLISH_URL, publishCredential: credential } : {}) });
  pipeline.cycle().then((result) => console.log(JSON.stringify({ status: result.status, published: result.published,
    capturedAt: result.capturedAt, recordCount: result.recordCount, changedRecords: result.changedRecords, revisedRecords: result.revisedRecords,
    analysisCount: result.analysisCount, sourceCount: result.sourceCount, retryAt: result.retryAt })))
    .catch(() => { console.error('Local processing could not complete; no source dates or pending outbox were discarded.'); process.exitCode = 1; });
}
