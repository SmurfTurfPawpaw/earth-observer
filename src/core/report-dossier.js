import { canonicalDiscoveryRecord } from './discovery-index.js';
import { worldRevision, worldHash, createWorldSourceItem, provisionalWorldEvent, worldTime } from './world-model.js';
import { matchingWorldEvent } from './world-dossier-bridge.js';

const MAX_BYTES = 256 * 1024;

/** A displayed source record must resolve to its exact retained factual revision. */
export async function retainedReportReference(value) {
  const record = canonicalDiscoveryRecord(value);
  if (!record || record.sourceId !== 'usgs' || record.kind !== 'hazard-report' || record.eventType !== 'EQ' ||
      !/^usgs:[a-zA-Z0-9_-]{1,100}$/.test(record.id) || !record.observedAt || !Number.isFinite(record.magnitude) ||
      !Number.isFinite(record.lat) || !Number.isFinite(record.lon) || !/^https:\/\/earthquake\.usgs\.gov\//.test(record.url)) return null;
  const revision = await worldRevision(record);
  return { record, revision: revision.revision, id: `event:usgs:${revision.itemId.slice(5)}`,
    selected: { usgsId: record.id.slice(5), mag: record.magnitude, time: Date.parse(record.observedAt), lat: record.lat, lon: record.lon } };
}

async function readBounded(response, signal) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Stored report exceeds the reading budget.');
  }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Stored report body is unavailable.');
  const parts = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error('Stored report exceeds the reading budget.');
      parts.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Explicit report inspection reads stored evidence only. It does not change time or layers. */
export function createReportDossierController({ fetchImpl = globalThis.fetch, getScene, getSelection, getNavigationKey = () => '',
  onOpen, onError = () => {}, url = `${import.meta.env?.BASE_URL || '/'}api/world/events` } = {}) {
  if (typeof getScene !== 'function' || typeof getSelection !== 'function' || typeof onOpen !== 'function')
    throw new TypeError('Report inspection needs scene, selection and dossier callbacks');
  let destroyed = false, generation = 0, request;
  function cancel() { ++generation; request?.abort(); request = undefined; }
  return {
    cancel,
    async open(report) {
      if (destroyed) return false;
      cancel(); const owner = generation, scene = getScene(), selection = getSelection(), navigation = getNavigationKey();
      const controller = new AbortController(); request = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
      const current = (allowTimeout = false) => !destroyed && owner === generation && !controller.signal.aborted && (allowTimeout || !signal.aborted) &&
        getNavigationKey() === navigation && getSelection() === selection &&
        getScene().mode === scene.mode && (scene.mode !== 'history' || getScene().at === scene.at);
      try {
        const reference = await retainedReportReference(report); if (!current()) return false;
        if (!reference) throw new Error('This report has no supported retained event dossier.');
        const response = await fetchImpl(`${url}/${reference.id}`, { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error(response.status === 404 ? 'This report is outside the current retained source sample. Its original source remains available.' : 'Stored report evidence is temporarily unavailable.');
        }
        const payload = await readBounded(response, signal); if (!current()) return false;
        const event = matchingWorldEvent(payload.event, reference.selected, { id: reference.id, revision: reference.revision });
        if (payload.schemaVersion !== 1 || payload.configured !== true || payload.available !== true || !event ||
            event.evidence?.itemId !== `item:${reference.id.slice(11)}` || event.evidence.sourceId !== 'usgs' || event.source.url !== reference.record.url)
          throw new Error('This report was revised. Refresh the source list before opening its updated evidence.');
        const expected = provisionalWorldEvent(await createWorldSourceItem(reference.record, { snapshotId: event.evidence.snapshotId,
          capturedAt: event.knowledge.firstCapturedAt, recordedAt: event.knowledge.firstRecordedAt }));
        // The same factual revision can have been captured earlier. Preserve its
        // original retrieval clock, while verifying every displayed source fact.
        if (event.sourceTimes?.retrievedAt !== null && worldTime(event.sourceTimes?.retrievedAt) !== event.sourceTimes.retrievedAt)
          throw new Error('Stored report evidence has an invalid source date.');
        expected.sourceTimes.retrievedAt = event.sourceTimes.retrievedAt;
        const { capture: _capture, ...projection } = event;
        if (await worldHash(expected) !== await worldHash(projection))
          throw new Error('Stored report evidence does not match the displayed source facts.');
        if (!current()) return false;
        request = undefined;
        onOpen(event);
        return true;
      } catch (error) {
        if (current(true)) onError(signal.aborted ? 'Stored report evidence timed out. Try again.' : error.message || 'Stored report evidence could not open.');
        return false;
      } finally { if (owner === generation) request = undefined; }
    },
    destroy() { if (destroyed) return; destroyed = true; cancel(); },
  };
}
