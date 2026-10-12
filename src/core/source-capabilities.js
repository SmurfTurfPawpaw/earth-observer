/**
 * Reviewed capability metadata, not live availability or a source enable list.
 * Unknown cadence, geometry and history remain unknown. Runtime manifests and
 * retained evidence must further restrict these capabilities for every query.
 * Map/proxy admission remains in provider-policy.json; typed sources use their
 * separate reviewed plugin registry. This ledger activates neither.
 */
export const SOURCE_CAPABILITY_SCHEMA_VERSION = 1;
export const SOURCE_CAPABILITY_REVISION = 5;

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
  const { paths, archive, archiveScope, ...fields } = spec;
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
      asKnownThen: archiveScope ? 'Completed hosted archive receipts at the selected cutoff; not a reproduction of all provider knowledge at that date.' : 'Captured source snapshots only; not a complete historical story dossier.',
      upstreamArchive: archive,
      backfillImplemented: Boolean(archiveScope),
      ...(archiveScope ? { archiveScope, reconstruction: 'Current retained source corrections selected by earthquake origin time; actual completed coverage and gaps come from /api/world/scene.' } : {}),
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

function typedPlugin(spec) {
  const { paths, upstreamArchive, ...fields } = spec;
  return { ...fields, incidentLayer: false,
    implementation: { adapter: 'implemented', collectorRegistry: false, typedPluginRegistry: true,
      independentTrigger: 'unverified', verification: 'Bounded source access and focused local checks verified; hosted plugin receipts and sustained unattended runtime require separate evidence.',
      paths: ['worker/plugins/registry.js', 'worker/plugins/store.js', ...paths] },
    history: { current: 'retained-typed-plugin-receipts', firstAvailableAt: 'Actual completed plugin publication receipt; source dates never backdate hosted knowledge.',
      asKnownThen: 'Completed retained receipts at a selected knowledge cutoff; not a reconstruction of all publisher knowledge.',
      upstreamArchive, backfillImplemented: false, future: 'unsupported' },
    interpolation: { mode: 'step', extrapolation: false, note: 'Keep original dated source facts until a changed revision completes; checks do not invent measurements or publications.' } };
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
    archiveScope: 'usgs-catalog-m4.5-v1',
    rights: { status: 'reviewed-public-display', policyProvider: 'usgs', scope: 'USGS-produced data; marked third-party content is separate.', attribution: 'U.S. Geological Survey', evidence: ['https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted'] },
    documentation: ['https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php', 'https://earthquake.usgs.gov/fdsnws/event/1/'],
    paths: ['server/hosted/intelligence-sources.js', 'worker/world-archive.js', 'worker/world-scene.js', 'scripts/usgs-archive-import.mjs'],
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
    bounds: { maxRecords: 240, maxSnapshotBytes: 1024 * 1024, categories: ['geopolitics', 'economy', 'disasters'],
      optionalCatchup: { enabledByDefault: false, horizonMs: 24 * HOUR, maxHistoricalBatches: 2,
        maxArchivesPerRun: 3, compressedBytesPerRun: 48 * 1024 * 1024,
        expandedBytesPerRun: 384 * 1024 * 1024, deadlineMs: 45000 } },
    archive: 'Official bulk archives/codebooks are available. The latest-first producer includes opt-in bounded repair of explicit missed batches within its retained 24-hour span; this is not a two-year discovery archive.',
    rights: { status: 'reviewed-public-display', policyProvider: 'gdelt-metadata', scope: 'GDELT-released datasets may be reused with citation/link; original articles and images retain publisher rights.', attribution: 'The GDELT Project, https://www.gdeltproject.org/', evidence: ['https://gdeltproject.org/about.html'] },
    documentation: ['https://gdeltproject.org/data.html', 'https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/'],
    paths: ['server/hosted/gdelt-snapshot.js', 'server/hosted/gdelt-gkg.js', 'scripts/gdelt-snapshot.mjs'],
    gaps: ['Hosted Worker does not decode bulk GKG ZIP files.', 'No full article text or source-truth verification.', 'Repeated reports may be syndicated copies.', 'Two-year discovery backfill is not implemented. Optional missed-batch recovery requires a verified producer run and completed batch receipts; its mere presence in code does not fill gaps.'],
  }),
  typedPlugin({
    id: 'ecb-press-v1', pluginId: 'ecb-press-v1', scopeId: 'ecb-institutional-press-en-v1', sourceId: 'ecb', name: 'ECB institutional press releases', kind: 'publication-feed',
    access: { type: 'fixed-https-rss', endpoint: 'https://www.ecb.europa.eu/rss/press.html', credentials: [], publicRead: '/api/publications' },
    geography: { type: 'publisher-jurisdiction-context', completeness: 'bounded-publisher-scope', resolution: 'ECB publisher remit is euro-area jurisdiction context, not incident coordinates or proof of where each publication applies.' },
    temporal: { validTime: 'Publication metadata, not incident time or a survey observation period.', publicationTime: 'Original RSS pubDate with explicit timezone, raw declaration and second precision.',
      captureTime: 'Original feed bytes and actual acquisition are separate from source publication.', knowledgeTime: 'First completed database receipt; feed disappearance does not withdraw retained original items.' },
    cadence: { providerIntervalMs: null, providerMeaning: 'Institutional publications are irregular; no delivery or freshness guarantee.', checkIntervalMs: 5 * MINUTE,
      checkMeaning: 'Due conditional source checks on authenticated collector wakes; public reads never collect. A due interval does not prove an always-on runner.', sourceLatencyMs: null, guaranteed: false },
    bounds: { maxRecords: 32, maxFeedItems: 100, maxResponseBytes: 524288, maxArtifactBytes: 65536, deadlineMs: 20000 },
    upstreamArchive: 'Rolling current RSS sample only. No historical publication crawl/backfill is implemented; retained originals accumulate only after actual acquisition.',
    rights: { status: 'reviewed-public-display', policyProvider: 'ecb-institutional-publications', attribution: 'European Central Bank',
      scope: 'Accurately attributed institutional title/link/publication metadata. Named-author speeches, interviews, research papers and images are excluded. Modification must be disclosed; separate rules apply to sold information and framing.',
      evidence: ['https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html',
        'https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr261007~6447350434.en.html'] },
    documentation: ['https://www.ecb.europa.eu/home/html/rss.en.html'], paths: ['worker/plugins/ecb-press.js', 'src/core/plugin-evidence.js'],
    gaps: ['Only institutional /press/pr/date/ English releases are selected; source feed access is not a complete news archive.',
      'The initial codec retains publication metadata, not article HTML or extracted survey claims.', 'One institutional assertion is not independent corroboration.',
      'Relative future expectations require their own source reference period; publication dates do not supply that period.'],
  }),
  typedPlugin({
    id: 'eurostat-gas-origins-v1', pluginId: 'eurostat-gas-origins-v1', scopeId: 'belgium-natural-gas-origins', sourceId: 'eurostat', name: 'Belgium natural-gas import origins', kind: 'dataset',
    access: { type: 'fixed-https-json-stat', endpoint: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_ti_gas?lang=EN&freq=A&geo=BE&siec=G3000&unit=TJ_GCV&sinceTimePeriod=2024',
      credentials: [], publicRead: '/api/dossiers/belgium-natural-gas-origins' },
    geography: { type: 'reporting-country-and-partner-codes', completeness: 'fixed-statistical-scope', resolution: 'Belgium annual import origins by source partner/codelist. Origins, aggregates and unknowns are not shipment routes, ports, pipelines or incident locations.' },
    temporal: { validTime: 'Annual source observation periods, year precision; this is not present-day gas supply.', publicationTime: 'Exact publication date for each observed value is unknown.',
      captureTime: 'Untouched JSON-stat bytes and actual collection time.', knowledgeTime: 'Completed hosted receipts preserve revisions; API global updated time is operational and cannot create a statistical revision alone.' },
    cadence: { providerIntervalMs: null, providerMeaning: 'Annual observations with irregular source revisions; six-hour checking is not six-hour measurement.', checkIntervalMs: 6 * HOUR,
      checkMeaning: 'Due conditional source checks on authenticated collector wakes; no visitor acquisition or always-on runtime guarantee.', sourceLatencyMs: null, guaranteed: false },
    bounds: { maxRecords: 1, maxPartners: 256, maxPeriods: 8, maxCells: 2048, maxResponseBytes: 524288, maxArtifactBytes: 65536, deadlineMs: 20000,
      reportingCountry: 'BE', frequency: 'A', product: 'G3000', unit: 'TJ_GCV', referenceYearsFrom: '2024' },
    upstreamArchive: 'The fixed query returns reported annual values since 2024 when available. It does not supply the historical knowledge/revision state or continuous observations between years.',
    rights: { status: 'reviewed-public-display', policyProvider: 'eurostat-statistical-data',
      scope: 'Source-credited statistical values, codes, labels and flags; identify derived shares and respect individual/third-party exceptions.',
      attribution: 'Source: Eurostat, nrg_ti_gas. Shares calculated by Earth Observer; source quantities and flags retained.',
      evidence: ['https://ec.europa.eu/eurostat/about-us/communicating-disseminating-statistics'] },
    documentation: ['https://ec.europa.eu/eurostat/databrowser/view/nrg_ti_gas/default/table',
      'https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines/api-statistics'],
    paths: ['server/hosted/eurostat-gas-origins.js', 'src/core/eurostat-gas-origins.js', 'src/core/plugin-evidence.js'],
    gaps: ['Initial verified query returned 2024 annual data; no invented 2025/2026 observations.',
      'Missing/suppressed values stay missing rather than zero.', 'Supported origin shares do not establish current dependence, route, disruption probability or causation.',
      'No live pricing, trade-flow stream or future model is implemented.'],
  }),
  typedPlugin({
    id: 'ec-press-v1', pluginId: 'ec-press-v1', scopeId: 'ec-presscorner-en-metadata-v1', sourceId: 'european-commission',
    name: 'European Commission publication metadata', kind: 'publication-feed',
    access: { type: 'fixed-https-rss', endpoint: 'https://ec.europa.eu/commission/presscorner/api/rss?', credentials: [], publicRead: '/api/publications?plugin=ec-press-v1' },
    geography: { type: 'none', completeness: 'publisher-metadata-only', resolution: 'Policy tags and publication places are not incident coordinates or proof of applicable geography.' },
    temporal: { validTime: 'Source publication metadata, not incident time or legal effective dates.',
      publicationTime: 'Original RSS pubDate retained with explicit timezone and second representation; exact public-release instant is not independently verified.',
      captureTime: 'Original RSS bytes and actual source acquisition.', knowledgeTime: 'Actual completed database receipt; importing an older publication cannot backdate hosted knowledge.' },
    cadence: { providerIntervalMs: null, providerMeaning: 'Irregular Commission publications in a rolling feed; no delivery guarantee.', checkIntervalMs: 5 * MINUTE,
      checkMeaning: 'Due authenticated collector wakes; public reads never acquire. Typed source work has two per-wake slots and a shared 27-second budget; deferred work awaits another wake.', sourceLatencyMs: null, guaranteed: false },
    bounds: { maxRecords: 32, maxFeedItems: 100, observedProviderWindow: 10, maxCategoriesPerItem: 8,
      maxResponseBytes: 524288, maxArtifactBytes: 65536, deadlineMs: 20000 },
    upstreamArchive: 'Rolling English-route metadata only; body language is unknown. Source items leaving the feed stay retained; no historical publication backfill or full-document investigation is implemented.',
    rights: { status: 'reviewed-public-display', policyProvider: 'ec-owned-publication-metadata',
      attribution: 'European Commission / European Union; original source linked',
      scope: 'EU-owned title/link/date/category metadata under CC BY4.0 with credit and changes indicated; individual and third-party exceptions apply. No images, branding or full document bodies.',
      evidence: ['https://commission.europa.eu/legal-notice_en', 'https://creativecommons.org/licenses/by/4.0/'] },
    documentation: ['https://ec.europa.eu/commission/presscorner/home/en'],
    paths: ['worker/plugins/ec-press.js', 'worker/plugins/bounded-rss.js'],
    gaps: ['The observed ten-item rolling feed can omit publications between checks.', 'English-route metadata does not prove document body language.',
      'Publication dates and policy categories do not establish incident location, legal effects, causal claims or independent corroboration.',
      'RSS snippets are raw evidence only; no full-text extraction or document investigation is included.'],
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
  reviewedAt: '2026-10-12',
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
