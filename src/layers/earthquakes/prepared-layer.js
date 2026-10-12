import { createPreparedSceneLayer } from '../../core/prepared-scene-layer.js';
import { createRegionalSceneClient } from '../../core/regional-scene-client.js';
import { depthColor, mapAnalystRecord } from './model.js';

export const PREPARED_EARTHQUAKES_DESCRIPTOR = Object.freeze({
  sourceKey: 'earthquakes', id: 'earthquakes', name: 'Seismic reports (24h)', icon: '🌋', sourceLabel: 'USGS', symbol: 'seismic',
  countLabel: 'reports', locationLabel: 'reported seismic locations', coverageLabel: 'M2.5+ · rolling 24 hours',
  title: feature => feature.record.sourceTitle || `M${feature.record.mag.toFixed(1)} · ${feature.record.place}`,
  position: feature => Object.hasOwn(feature, 'geometry') ? feature.geometry && [feature.geometry.lon, feature.geometry.lat] :
    [feature.record.lon, feature.record.lat],
  color: feature => depthColor(feature.record.depthKm ?? 0),
  detail: feature => `${new Date(feature.record.time).toISOString()} · source ${feature.record.eventType || 'type unknown'}`,
  entityProperties: (feature, view) => ({ usgsId: feature.record.usgsId, mag: feature.record.mag, place: feature.record.place,
    time: feature.record.time, depth: feature.record.depthKm, sourceUrl: feature.record.sourceUrl, updatedAt: feature.record.updatedAt,
    eventType: feature.record.eventType, reviewStatus: feature.record.reviewStatus, sourceTitle: feature.record.sourceTitle,
    sourceReceiptId: view.source.receiptId, sourceFeatureRevision: feature.revision, sourceFence: view.source.fence,
    sourceRecordedAt: view.source.recordedAt, sourceCapturedAt: view.source.capturedAt, sourceKnowledgeMeaning: view.source.knowledgeMeaning,
    ...(feature.sourceAssessment ? { sourceAssessment: feature.sourceAssessment } : {}) }),
  analystRecord: (feature, index) => mapAnalystRecord({ id: feature.record.usgsId, mag: feature.record.mag, place: feature.record.place,
    time: feature.record.time, depth: feature.record.depthKm, lat: feature.record.lat, lon: feature.record.lon }, index),
  stats: view => ({ lastUpdate: Date.parse(view.source.recordedAt), status: view.check?.status || null,
    receipt: { id: view.source.receiptId, fence: view.source.fence, recordedAt: view.source.recordedAt, capturedAt: view.source.capturedAt,
      factsDigest: view.source.factsDigest, rawSha256: view.source.rawSha256, artifactSha256: view.source.artifactSha256, sourceUpdatedAt: view.source.sourceGeneratedAt },
    checkedAt: view.check?.checkedAt || null, lastSuccessfulAt: view.check?.lastSuccessfulAt || null, sourceGeneratedAt: view.check?.sourceGeneratedAt || null,
    retainedSourceGeneratedAt: view.source.sourceGeneratedAt }),
});

/** Compatibility defaults to the original stored USGS route; the factory opts into generic delivery. */
export function createPreparedEarthquakesLayer({ client, generic = false, ...options } = {}) {
  return createPreparedSceneLayer({ ...options, descriptor: PREPARED_EARTHQUAKES_DESCRIPTOR,
    client: client || createRegionalSceneClient(generic ? { sourceKey: 'earthquakes' } : {}) });
}
