import * as Cesium from 'cesium';
import { createPreparedSceneLayer } from '../../core/prepared-scene-layer.js';
import { createRegionalSceneClient } from '../../core/regional-scene-client.js';
import { gdacsAlertColor } from '../../core/map-symbols.js';
import { gdacsNoticeType } from '../../core/gdacs-dossier.js';
import { extractCameraFocusDemand } from '../../core/focus-demand.js';

const source = Object.freeze({ id: 'gdacs', name: 'Global Disaster Alert and Coordination System', url: 'https://www.gdacs.org/',
  attribution: 'Global Disaster Alert and Coordination System, GDACS' });
const coverage = Object.freeze({ mode: 'retained-seven-day-notice-sample', windowDays: 7, maxRecords: 100,
  completeRetainedCohort: true, completeProviderArchive: false });
const operational = Object.freeze({ status: 'unknown', checkedAt: null });
const history = Object.freeze({ replay: false, future: false });
const cohort = view => ({ sourceId: 'gdacs', snapshotId: view.source.snapshotId, bodySha256: view.source.bodySha256,
  capturedAt: view.source.capturedAt, publishedAt: view.source.publishedAt, recordCount: view.scene.counts.sourceTotal,
  meaning: 'One completed retained normalized source cohort' });

export const PREPARED_GDACS_DESCRIPTOR = Object.freeze({
  sourceKey: 'gdacs', id: 'gdacs-notices', name: 'Disaster notices · GDACS', sourceLabel: 'GDACS', symbol: 'notice',
  countLabel: 'notices', locationLabel: 'indicative notice locations', coverageLabel: 'GDACS seven-day notice sample · freshness unknown',
  entityId: feature => `gdacs-notice:${feature.id}`, title: feature => feature.record?.title ?? feature.title,
  position: feature => feature.geometry && [feature.geometry.lon, feature.geometry.lat],
  color: feature => Cesium.Color.fromCssColorString(gdacsAlertColor(feature.record?.alertLevel ?? feature.sourceAssessment?.level)),
  clusterTitle: cell => `${cell.count} ${{ seismic: 'seismic', flood: 'flood', cyclone: 'cyclone', volcano: 'volcano', wildfire: 'wildfire',
    drought: 'drought', notice: 'other' }[cell.symbol] || 'other'} ${cell.count === 1 ? 'notice' : 'notices'}`,
  detail: feature => `${gdacsNoticeType(feature.record?.eventType ?? feature.display?.sourceType)} · ${feature.geometry ? 'Indicative location' : 'Location not reported'} · source revised ${feature.record?.updatedAt ?? feature.display?.updatedAt ?? 'date unknown'}`,
  inspectParameter: values => values?.inspectItem,
  entityProperties: (feature, view) => ({ _gdacsNotice: { schemaVersion: 1, version: view.source.version, source,
    item: { ...feature.provenance, record: feature.record }, cohort: cohort(view), coverage, operational, history },
    ...(feature.sourceAssessment ? { sourceAssessment: feature.sourceAssessment } : {}) }),
  stats: view => ({ lastUpdate: Date.parse(view.source.publishedAt), status: 'unknown', checkedAt: null, sourceGeneratedAt: null,
    sourceGenerationAgeMs: null, sourceAgeMs: null, observedAt: null, cohort: cohort(view) }),
});

export function createPreparedGdacsLayer({ client, focus = false, ...options } = {}) {
  return createPreparedSceneLayer({ ...(focus ? { getDemand: viewer => extractCameraFocusDemand(viewer, Cesium) } : {}),
    ...options, descriptor: PREPARED_GDACS_DESCRIPTOR,
    client: client || createRegionalSceneClient({ sourceKey: 'gdacs' }) });
}
