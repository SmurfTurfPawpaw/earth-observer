/**
 * Reviewed capability metadata, not live availability or a source enable list.
 * Unknown cadence, geometry and history remain unknown. Runtime manifests and
 * retained evidence must further restrict these capabilities for every query.
 * Existing provider-policy.json remains the source-admission authority.
 */
export const SOURCE_CAPABILITY_SCHEMA_VERSION = 1;
export const SOURCE_CAPABILITY_REVISION = 1;

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const WEATHER_BASE = 'https://nowcoast.noaa.gov/geoserver/observations/';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function retainedFeed(spec) {
  const { paths, archive, ...fields } = spec;
  return {
    ...fields,
    implementation: {
      adapter: 'implemented',
      collectorRegistry: true,
      independentTrigger: 'unverified',
      verification: 'Code reviewed at baseline; deployment/runtime health requires separate evidence.',
      paths: ['worker/collector.js', ...paths],
    },
    history: {
      current: 'retained-knowledge-snapshots',
      firstAvailableAt: 'Read the hosted history index; no static start date is promised.',
      asKnownThen: 'Captured source snapshots only; not a complete historical story dossier.',
      upstreamArchive: archive,
      backfillImplemented: false,
      future: 'unsupported',
    },
    interpolation: {
      mode: 'step',
      extrapolation: false,
      note: 'Retain dated evidence between revisions; animate presentation without inventing factual changes.',
    },
  };
}

function weather(spec) {
  const endpoint = `${WEATHER_BASE}${spec.service}/ows`;
  return {
    id: `nowcoast-${spec.product}`,
    name: spec.name,
    kind: 'observation-raster',
    access: { type: 'fixed-https-wms', endpoint, credentials: [] },
    geography: { type: 'advertised-raster-extent', completeness: 'partial', ...spec.geography },
    temporal: {
      validTime: 'Explicit ISO8601 WMS TIME dimension',
      publicationTime: 'unknown',
      captureTime: 'Metadata retrieval is separate from valid image time.',
      knowledgeTime: 'No durable first-known weather history is currently implemented.',
    },
    cadence: {
      providerIntervalMs: spec.intervalMs,
      providerMeaning: spec.cadenceNote,
      checkIntervalMs: spec.product === 'lightning' ? 10 * MINUTE : 2 * MINUTE,
      checkMeaning: 'Current metadata cache/revalidation while requested; not an independent collector.',
      sourceLatencyMs: spec.latencyMs ?? null,
      guaranteed: false,
    },
    bounds: { maxManifestFrames: 13, maxAdmittedFrames: 26, maxFrameAgeMs: 24 * HOUR, maxImageBytes: 16 * 1024 * 1024 },
    history: {
      current: 'provider-advertised-valid-frames',
      firstAvailableAt: 'Resolve from the current manifest, not from nominal cadence.',
      asKnownThen: 'unsupported',
      upstreamArchive: 'Rolling advertised frames; no two-year archive verified for this adapter.',
      backfillImplemented: false,
      future: 'unsupported',
    },
    interpolation: {
      mode: 'step',
      extrapolation: false,
      note: 'Select an actual advertised frame; opacity transitions may smooth display but create no observation.',
    },
    rights: {
      status: 'reviewed-public-display',
      policyProvider: spec.product === 'lightning' ? 'noaa-lightning-density' : 'noaa-nowcoast',
      scope: spec.rightsNote ?? 'Reviewed NOAA government imagery; partner material keeps its own rights.',
      attribution: spec.attribution ?? 'NOAA nowCOAST and the named contributing product sources',
      evidence: ['https://oceanservice.noaa.gov/disclaimer.html', ...(spec.rightsEvidence ?? [])],
    },
    implementation: {
      adapter: 'implemented', collectorRegistry: false, independentTrigger: 'not-implemented',
      verification: 'Official WMS capabilities inspected 2026-10-11; not a hosted scene/integrated replay verification.',
      paths: ['server/providers/weather.js', 'src/layers/weather/source.js', 'src/layers/weather/index.js'],
    },
    documentation: [
      'https://nauticalcharts.noaa.gov/learn/nowcoast.html',
      `${endpoint}?service=WMS&version=1.3.0&request=GetCapabilities`,
      ...(spec.documentation ?? []),
    ],
    gaps: ['No autonomous weather archive.', 'An extent is not proof of valid pixels everywhere.',
      'WMS nearestValue=1 must not silently substitute a different time.', ...spec.gaps],
  };
}

const sources = [
  retainedFeed({
    id: 'usgs', name: 'USGS earthquake summary', kind: 'observation',
    access: { type: 'fixed-https-json', endpoint: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson', credentials: [] },
    geography: { type: 'source-points', completeness: 'bounded-sample', resolution: 'Provider hypocenter coordinates and measurement uncertainty; no inferred country.' },
    temporal: { validTime: 'observedAt: earthquake origin', revisionTime: 'updatedAt: source modification', publicationTime: 'unknown', captureTime: 'retrievedAt; hosted capture is separate' },
    cadence: { providerIntervalMs: MINUTE, providerMeaning: 'Summary regeneration, not earthquake occurrence or scientific review frequency.', checkIntervalMs: MINUTE, sourceLatencyMs: null, guaranteed: false },
    bounds: { maxRecords: 100, windowDays: 7, minimumMagnitude: 4.5 },
    archive: 'Official catalog supports date-range queries; older revision/knowledge state requires retained evidence.',
    rights: { status: 'reviewed-public-display', policyProvider: 'usgs', scope: 'USGS-produced data; marked third-party content is separate.', attribution: 'U.S. Geological Survey', evidence: ['https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted'] },
    documentation: ['https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php', 'https://earthquake.usgs.gov/fdsnws/event/1/'],
    paths: ['server/hosted/intelligence-sources.js'],
    gaps: ['Magnitude threshold and 100-record limit exclude events.', 'Catalog backfill today is a reconstruction, not proof of what was known then.', 'Missing from a bounded sample is not a retraction.'],
  }),
  retainedFeed({
    id: 'gdacs', name: 'GDACS disaster notices', kind: 'modeled-impact-notice',
    access: { type: 'fixed-https-json', endpoint: 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH', credentials: [] },
    geography: { type: 'source-points-and-country-references', completeness: 'bounded-sample', resolution: 'Indicative event geometry and modeled affected countries; not verified incident boundaries.' },
    temporal: { validTime: 'observedAt/eventEndAt: source interval', revisionTime: 'updatedAt: GDACS modification', publicationTime: 'unknown', captureTime: 'retrievedAt; hosted capture is separate' },
    cadence: { providerIntervalMs: null, providerMeaning: 'Notices and episode revisions; no fixed publication guarantee.', checkIntervalMs: MINUTE, sourceLatencyMs: null, guaranteed: false },
    bounds: { maxRecords: 100, windowDays: 7, eventTypes: ['EQ', 'TC', 'FL', 'VO', 'WF', 'DR'] },
    archive: 'Official API documents custom date ranges; historical episode completeness has not been verified here.',
    rights: { status: 'reviewed-public-display', policyProvider: 'gdacs', scope: 'GDACS data integration with source credit; external resources retain their own rights.', attribution: 'Global Disaster Alert and Coordination System, GDACS', evidence: ['https://data.gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf', 'https://data.gdacs.org/About/termofuse.aspx'] },
    documentation: ['https://www.gdacs.org/gdacsapi/swagger/index.html'],
    paths: ['server/hosted/intelligence-sources.js'],
    gaps: ['Automatic modeled impacts require independent confirmation.', 'No guarantee of timely, complete notices.', 'The adapter does not collect all GDACS resources or hazards.'],
  }),
  retainedFeed({
    id: 'eonet', name: 'NASA EONET curated references', kind: 'curated-reference',
    access: { type: 'fixed-https-json', endpoint: 'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires,severeStorms,volcanoes&status=all&days=7&limit=60', credentials: [] },
    geography: { type: 'no-retained-incident-geometry', completeness: 'bounded-sample', resolution: 'Adapter deliberately excludes source coordinates and inferred countries.' },
    temporal: { validTime: 'sourceGeometryAt/closedAt: approximate source geometry/end dates', publicationTime: 'unknown', captureTime: 'retrievedAt; hosted capture is separate' },
    cadence: { providerIntervalMs: null, providerMeaning: 'Selective curation; not a continuous incident or publication stream.', checkIntervalMs: MINUTE, sourceLatencyMs: null, guaranteed: false },
    bounds: { maxRecords: 60, windowDays: 7, categories: ['wildfires', 'severeStorms', 'volcanoes'] },
    archive: 'API supports start/end and open/closed selection; extents are approximate, not an authoritative incident archive.',
    rights: { status: 'reviewed-public-display', policyProvider: 'nasa-eonet', scope: 'Bounded metadata for visualization/general information; no linked publisher text, pictures or inferred locations.', attribution: 'NASA EONET and referenced sources', evidence: ['https://eonet.gsfc.nasa.gov/what-is-eonet'] },
    documentation: ['https://eonet.gsfc.nasa.gov/docs/v3'],
    paths: ['server/hosted/eonet-snapshot.js'],
    gaps: ['No incident point can be placed from this adapter.', 'Geometry dates may precede the seven-day query window.', 'Curated references are not independent corroboration.'],
  }),
  retainedFeed({
    id: 'gdelt', name: 'GDELT topic and publisher-link discovery', kind: 'discovery-metadata',
    access: { type: 'fixed-project-release', endpoint: 'https://github.com/SmurfTurfPawpaw/earth-observer/releases/download/intelligence-data/gdelt.snapshot.json', credentials: [] },
    geography: { type: 'country-mentions-only', completeness: 'bounded-sample', resolution: 'Mentioned country is context; neither publisher country nor a country centroid is an incident point.' },
    temporal: { validTime: 'indexedAt: GDELT index/batch time, not incident time', publicationTime: 'unknown', captureTime: 'Retain source batch, generation and actual acquisition separately.' },
    cadence: { providerIntervalMs: 15 * MINUTE, providerMeaning: 'GKG batch cadence; release creation has a separate runtime and may be delayed/skipped.', checkIntervalMs: MINUTE, sourceLatencyMs: null, guaranteed: false },
    bounds: { maxRecords: 240, maxSnapshotBytes: 1024 * 1024, categories: ['geopolitics', 'economy', 'disasters'] },
    archive: 'Official bulk archives/codebooks are available; current pipeline consumes one latest bounded batch, without catch-up.',
    rights: { status: 'reviewed-public-display', policyProvider: 'gdelt-metadata', scope: 'GDELT-released datasets may be reused with citation/link; original articles and images retain publisher rights.', attribution: 'The GDELT Project, https://www.gdeltproject.org/', evidence: ['https://gdeltproject.org/about.html'] },
    documentation: ['https://gdeltproject.org/data.html', 'https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/'],
    paths: ['server/hosted/gdelt-snapshot.js', 'server/hosted/gdelt-gkg.js', 'scripts/gdelt-snapshot.mjs'],
    gaps: ['Hosted Worker does not decode bulk GKG ZIP files.', 'No full article text or source-truth verification.', 'Repeated reports may be syndicated copies.', 'Two-year backfill and missed-batch recovery are not implemented.'],
  }),
  {
    id: 'astronomy', name: 'Calculated Sun, Moon and day/night lighting', kind: 'calculated',
    access: { type: 'local-calculation', endpoint: null, credentials: [] },
    geography: { type: 'global-calculation', completeness: 'model-dependent', resolution: 'Cesium astronomical positions and visual lighting; not instrument measurements.' },
    temporal: { validTime: 'Selected scene UTC', publicationTime: 'not-applicable', captureTime: 'not-applicable' },
    cadence: { providerIntervalMs: null, providerMeaning: 'Evaluate the model at scene time.', checkIntervalMs: null, sourceLatencyMs: 0, guaranteed: false },
    bounds: { supportedAccuracyRange: null },
    history: { current: 'calculated-at-time', firstAvailableAt: 'Model evaluation, not a collected archive.', asKnownThen: 'not-applicable', upstreamArchive: 'not-applicable', backfillImplemented: false, future: 'calculated' },
    interpolation: { mode: 'calculated', extrapolation: false, note: 'Evaluate at chosen UTC without a network request; the model does not forecast events.' },
    rights: { status: 'reviewed-public-display', policyProvider: 'cesium-library', scope: 'Existing CesiumJS library and model; preserve third-party notices.', attribution: 'CesiumJS', evidence: ['https://cesium.com/learn/cesiumjs/ref-doc/Simon1994PlanetaryPositions.html'] },
    implementation: { adapter: 'implemented', collectorRegistry: false, independentTrigger: 'not-applicable', verification: 'Code reviewed; shared playback integration is a separate foundation phase.', paths: ['src/core/astronomy.js', 'src/core/live-clock.js'] },
    documentation: ['https://cesium.com/learn/cesiumjs/ref-doc/Simon1994PlanetaryPositions.html'],
    gaps: ['No numerical precision or astronomical accuracy range verified here.', 'Visual night brightness includes a usability floor.', 'Satellite orbits require their own element epoch/model contract.'],
  },
  weather({ product: 'radar', service: 'weather_radar', name: 'NOAA CONUS radar reflectivity', intervalMs: 4 * MINUTE,
    cadenceNote: 'Approximately four-minute MRMS mosaic updates.',
    geography: { nominalCoverage: 'Contiguous United States', resolution: 'Approximately 1 km; reflectivity in dBZ, not rainfall totals.' },
    gaps: ['Radar gaps do not establish absence of precipitation.'] }),
  weather({ product: 'lightning', service: 'lightning_detection', name: 'NOAA lightning strike density', intervalMs: 15 * MINUTE,
    cadenceNote: 'Fifteen-minute density accumulation, approximately fifteen-minute publication.',
    geography: { nominalCoverage: 'Pacific/Americas, 110 E across the dateline to 0 W, approximately 25 S to 80 N', resolution: '8 km cells; strikes/km²/min scaled by 10³.' },
    rightsNote: 'NOAA-derived Level 5 density is appropriate for public distribution; raw Vaisala detections are outside this permission.',
    attribution: 'NOAA/NWS nowCOAST; derived from Vaisala NLDN/GLD360',
    rightsEvidence: ['https://ocean.weather.gov/lightning/lightning_pdd.php'],
    gaps: ['Not global coverage or individual strike positions.'] }),
  weather({ product: 'clouds', service: 'satellite', name: 'NOAA global longwave infrared mosaic', intervalMs: HOUR,
    latencyMs: { minimum: 2 * HOUR, maximum: 3 * HOUR },
    cadenceNote: 'Hourly GMGSI product with documented two-to-three-hour source latency.',
    geography: { nominalCoverage: 'Near-global mosaic; nominal OSPO coverage 60 S to 60 N differs from advertised raster bounds.', resolution: 'Approximately 3 km; cloud and surface thermal patterns, not a cloud-only mask.' },
    documentation: ['https://www.ospo.noaa.gov/products/imagery/gmgsi/'],
    gaps: ['Polar/composite gaps remain gaps; raster bounds do not prove valid-pixel coverage.'] }),
  weather({ product: 'clouds-regional', service: 'satellite', name: 'NOAA GOES regional infrared mosaic', intervalMs: 5 * MINUTE,
    cadenceNote: 'Five-minute GOES East/West infrared product.',
    geography: { nominalCoverage: 'GOES East/West regional Americas extent; resolve current advertised bounds.', resolution: 'Approximately 2 km Band 14; cloud and surface thermal patterns.' },
    gaps: ['Not global imagery.'] }),
];

export const SOURCE_CAPABILITIES = freeze({
  schemaVersion: SOURCE_CAPABILITY_SCHEMA_VERSION,
  revision: SOURCE_CAPABILITY_REVISION,
  reviewedAt: '2026-10-11',
  codeBaseline: '822d73a',
  scope: 'Foundation code/source audit; not a deployment or uptime assertion.',
  sources,
});

const byId = new Map(sources.map((source) => [source.id, source]));
export function getSourceCapability(id) {
  return typeof id === 'string' ? byId.get(id) ?? null : null;
}
export function listSourceCapabilities() {
  return SOURCE_CAPABILITIES.sources;
}
