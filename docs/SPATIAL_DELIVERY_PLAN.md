# Camera-prioritized spatial and temporal delivery

Read-only proposal, 12 October 2026. No grid dependency, schema, route or controller
was added by this audit. This plan follows the existing foundation and source contracts.

## Decision

Start with a small, versioned geographic quadtree using existing Cesium geometry.
Separate global collection, prepared serving, visitor delivery and rendering. A camera
changes what receives detail and bounded priority; it does not determine whether the
rest of the world continues to be collected. Establish event-time reconstruction before
adding a spatial cache that might preserve the wrong temporal semantics.

Do not build another raster tile system. Cesium and the current imagery adapter already
manage that. The new cells describe world-record delivery, source coverage, investigation
priority and reusable summaries, independently of imagery tiles.

## What exists and what is missing

| Existing implementation | Useful reuse | Current limit |
| --- | --- | --- |
| `src/core/transit.js:27`, `:52` | Approximate viewed rectangle/center and a 350ms settled-camera refresh | Feed selection uses city coverage/radius, not global world-record cells |
| `src/layers/installations/viewport.js:24` | Viewport/subject bounds, request ownership, deduplication, debounce and bounded retry | Adapter-specific geographic queries; not a shared scene coordinator |
| `src/layers/bikeshare/viewport.js` | Altitude hysteresis, nearby coverage registry, cancellation/generation and cached-status reuse | City activation; not universal geospatial delivery |
| `src/data/cameraSensitivity.js` | Named claims preserve other layers' camera-change sensitivity | Any new coordinator must use claims rather than overwrite the shared setting |
| `src/maps/openFreeMapImagery.js:169` | Shared reads, per-owner cancellation, 16MiB decoded-byte cache and 64 raster entries | These are existing raster budgets, not free space for a second world-data cache |
| `src/core/cached-fetch.js:46` | Source-specific freshness, shared revalidation, bounded browser snapshots | `/api/world/scene` is not an admitted cache route; source fetch time is not scene time |
| `src/core/entity-batches.js` | Bounded asynchronous staging and one collection notification | Replacing all entities on every response still discards stable display/selection identity |
| `src/core/live-updates.js` | One page-owned committed-revision stream with lifecycle/reconnect | Notifications are global collection revisions, not cell-specific manifests |
| `worker/world-model.js:251` | Exact retained evidence, publication receipts, bounded stored-data reads | Current API accepts `knownAt`/`limit`; no cells/bbox, archive scene or valid-time query |
| `db/schema.ts:41` | Immutable item/revision and event-time fields; `projection_json` retains source geometry | No spatial index columns/table; current membership reader is one bounded live-source snapshot |

The current world reader selects at most 100 events from the retained USGS M4.5+
seven-day snapshot. Global recency slicing is not a valid implementation of “events in
this camera view.” A later spatial query must filter the eligible source/archive
membership before applying its record limit. The first world reader is a narrow useful
seed; it does not supply a complete global or two-year archive.

## Temporal prerequisite: one clock, explicit dataset semantics

The scene UTC is the time of the world being viewed. It must never silently mean the
platform's knowledge cutoff. The present `/api/history` describes captured evidence;
the current `/api/world/events` uses retained platform knowledge. Keep those honest
existing archive/inspection paths while introducing a separate scene contract.

Propose `/api/world/scene` with explicit `validTime` and optional `knownAt`:

- Default reconstruction resolves records valid/occurring at `validTime`, using the
  latest admitted retained corrections. Return the evidence/analysis cutoff used.
- Optional “Known then” applies `knownAt` as an additional restriction, with its meaning
  explicitly retained platform knowledge. It cannot invent platform knowledge before
  recording began. A simple lens choice can keep the UI understandable; no second
  visible clock is necessary.
- Archive scope is independent of today's limited live-feed membership. A quake that
  falls out of a seven-day provider feed may still belong in a historical scene. A
  missing sampled record neither closes nor retracts it.
- Instant events use a bounded display window as a declared presentation choice.
  For example, “show earthquake reports from the preceding seven days” does not mean
  an earthquake ended after seven days. Source-supported durations/valid intervals
  take precedence where available.
- Capabilities publish indexed valid range, known-time range, resolutions, gaps,
  partial backfill and source scope separately. Source archive availability alone is
  not local indexed coverage, and 100 recent records cannot imply two years of replay.

The clock drives calculated sunlight continuously. Weather resolves real product
frames at that UTC. Event adapters resolve event/valid-time records. That keeps one
world time without incorrectly treating every source's capture date as valid time.

The current timeline also derives its ruler and scene-clock clamp from capture-manifest
`firstAt`/`lastAt`. A valid-time scene needs its own indexed-valid-coverage ruler and
adapter frame resolution; importing older evidence today must not make that older
valid date inaccessible merely because its hosted capture occurred today. Preserve
the existing capture browser as evidence inspection, and migrate the scene timeline
only when the new contract can report genuine ranges and gaps. Rename neither the
existing capture path nor its passing tests into complete historical world playback.

## Grid choice and the conditions for changing it

| Candidate | Why it fits | Important constraint | Recommendation |
| --- | --- | --- | --- |
| Existing `Cesium.GeographicTilingScheme` | Direct longitude/latitude rectangles; existing library; two-by-one root tiles; deterministic hierarchy | Cells shrink in physical area near poles; bounding rectangles need dateline splitting and exact final predicates | Initial serving/cache partition |
| H3 | Hierarchical spherical hexagonal indexing with neighbor-oriented aggregation | Twelve pentagons per resolution; parent-child geographic containment is approximate, so exact geometry needs a final check | Revisit for cross-source density/flow analysis |
| S2 | Spherical quadrilateral hierarchy and region covers | Additional runtime/binding choice; identifiers require safe string/64-bit handling; cover budgets need explicit verification | Revisit for complex global region covering |

Cesium documents [geographic tiles and rectangle conversion](https://cesium.com/learn/cesiumjs/ref-doc/GeographicTilingScheme.html).
H3 documents its [grid structure](https://h3geo.org/docs/core-library/overview/) and
[logical versus geographic containment](https://h3geo.org/docs/highlights/indexing/).
S2 documents its [cell hierarchy](https://s2geometry.io/devguide/s2cell_hierarchy.html)
and [region-cover budget caveats](https://github.com/google/s2geometry/blob/master/src/s2/s2region_coverer.h).
The comparison is an engineering choice for this workload, not a claim that one grid
is universally better. Do not hand-build hexagons or a spherical region coverer.

Initial IDs could be `geo-v1:level/x/y`; the prefix versions coordinate/boundary rules.
Keep source geometry unchanged. A grid center is an aggregate marker, not an incident
location. Use explicit half-open point ownership, longitude wrapping, pole clamping
and a deterministic deduplication rule at boundaries. Dateline views split into two
longitude intervals. Region/polygon geometries require their own final intersection
predicate; shared cells do not establish event identity, causality or corroboration.

## Camera and request ownership

Use the existing public [Cesium camera rectangle/events](https://cesium.com/learn/cesiumjs/ref-doc/Camera.html)
as a conservative region estimate. It is approximate and can be unavailable when the
ellipsoid is outside view. Neither a failed rectangle nor a horizon-facing camera
should trigger a full-world detail download. Retain a compatible coarse view and
use known visible cells; apply frustum/horizon visibility for final drawing.

One scene coordinator owns the normalized cell set, scene lens/time, source capabilities
and request generation. Existing adapter camera listeners can migrate incrementally;
do not leave duplicate owners fetching the same source. Start on initial camera, use
`moveEnd` with about 250–350ms debounce, and allow bounded throttled updates during a
long drag when the coarse cell set genuinely changes. Never fetch per render frame.

Choose detail level from useful projected cell size and record density, with hysteresis
around level changes. If the region needs too many cells, coarsen the cover rather
than omit arbitrary areas. Prioritize visible center cells, then visible edges, then
one small neighboring fringe. A local radius is a user scope/filter, not a fixed global
grid size; a cell cover followed by a distance predicate can support that scope.

Each camera/time/lens change increments a generation and cancels obsolete work. Responses
may populate immutable cache after validation, but only the current generation may
change the displayed scene. Hold selected/followed dossier identity even when it leaves
the visible cells. Explicit user navigation remains interruptible.

## Proposed serving envelope

Batch the bounded cell set; do not open one HTTP request or stream per cell. The scene
response should carry:

- The requested `validTime`, optional `knownAt`, lens, grid version/level/cell IDs, and
  explicit source/archive scope.
- Immutable item/revision/evidence references plus reported geometry and source times.
- Resolved publication/version boundaries, source frame/valid intervals, and relevant
  capability revision. A response is compatible only inside the intervals it proves.
- Per-cell returned/eligible/omitted counts, partial coverage and gaps. Aggregate markers
  distinguish a count/location summary from a reported event pin.
- A deterministic continuation tied to the same immutable source/archive selection,
  where needed. No arbitrary URL, source object path or executable visitor query.

For the initial bounded USGS source, filter validated complete snapshot membership in
one batched read before the limit. Avoid reading/hashing the same R2 body separately
for every cell. Reuse immutable evidence validation and prepared source projections.
For growing archives, precompute a versioned spatial delivery index and source-revision
references at publication/backfill; do not scan a multi-year global archive on each pan.

Select the admitted revision before determining its spatial membership. Otherwise an
old location can leak into a cell after a later correction moved the event elsewhere.
Versioned index completion must use the same publication/receipt discipline as facts;
partially prepared cells are not a complete scene. A geometry or viewport membership
removal is distinct from an actual source retraction or event ending.

## Cache and subscription contract

Cache by dataset/source revision, grid version/cell/level, lens, valid-time interval,
optional knowledge cutoff/window, and display-window policy. The exact wall-clock
second is not a universal dataset version. Valid-time chunks may carry records whose
actual intervals intersect the chunk, with the client applying the selected UTC.
Discrete solar ticks alone do not invalidate facts.

Strict known-then responses must exclude later knowledge at the server boundary;
do not prefetch later factual revisions into an earlier known-time payload and merely
hide them visually. Prefetch compatible/past intervals or successor availability
metadata until the chosen knowledge cutoff reaches the next publication. Historical
and reconstruction caches must never collide with live or stricter-lens keys.

Keep one existing page update stream. Initially, a global committed revision can
coalesce revalidation of active cell batches. Add cell/dataset revision manifests
only when the publisher genuinely produces them; their absence is not permission to
invent per-cell freshness. Return Live releases historical ownership, admits the
current source revisions and resumes the current subscription path coherently.

Memory LRU can show the last compatible view immediately. Persist only admitted public
payloads in the existing bounded browser store, preserving source/retrieval dates.
Track total byte budgets across decoded maps, rasters, world records and time chunks;
the same 64MiB cannot be allocated independently by each layer. Cancel unused prefetch
first, then evict unpinned stale detail before visible or selected records.

## Acquisition priority preserves the global baseline

Camera cell interest primarily changes delivery, rendering and cache warming. Any
upstream acquisition/research boost is shared and deduplicated by source/cell/job, not
one expensive crawl per visitor. It remains below source cadence/access and job budgets.

Reserve global baseline collection capacity regardless of visitors, then budget boosts
for actual event importance, active investigation/follow interest and recent coarse
viewport demand. Demand decays; rare/unvisited areas do not lose baseline monitoring.
Popularity helps indexing/cache decisions, not evidence credibility. Synthetic agent
journeys are excluded from real demand. Coarse anonymous interest can remain ephemeral;
do not require precise location or a permanent user identity to view the globe.

## Proposed first budgets and acceptance slice

These are engineering targets to measure, not established performance results:

| Resource | Initial bound |
| --- | --- |
| Visible/fringe scene cells | About 12 visible plus at most 4 neighboring cells; coarsen before exceeding |
| Scene network | Two concurrent batched requests; visible batch wins over one prefetch batch |
| Scene response | About 500KiB compressed target plus explicit uncompressed byte/record cap |
| Drawn record budget | Existing source cap first; eventually about 1,000 markers total across sources, with fewer labels |
| Application frame work | Aim near 4ms; yield decode/staging; do not rebuild unchanged cards/controls |
| World/time memory | Share the foundation's 64MiB total target with existing caches; measure actual combined peak |
| Background visitors | No camera requests while hidden; baseline collectors continue independently |

Implement one representative slice before applying this to every adapter:
retained USGS archive → explicit valid-time scene/optional known cutoff → bounded cell
batch and truthful coverage → stable reported pins/aggregate summary → original source
dossier → calendar playback/Return Live. Existing raster/weather adapters keep their
own tile/frame machinery and join through the shared time/capability contract.

Acceptance should include dateline/poles, a tilted horizon, rapid pan/zoom interruption,
no redundant request inside an unchanged cell/time/version interval, out-of-order
response cancellation, corrected location moving between cells, valid-time versus
known-time reconstruction, absence from the live feed, gaps/backfill bounds, no visitors
during baseline collection, and a narrow-device byte/frame budget observation. Record
actual source membership and omitted counts so an apparently smooth map cannot conceal
an arbitrary global cap. No two-year availability claim until the archive is indexed
and those dates are exercised end to end.
