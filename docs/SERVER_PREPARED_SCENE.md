# Server-prepared scene pilot

This is a bounded derivative of existing retained source evidence, not a new event database. The pure builder, two-slot R2 preparation store and stored-only API are implemented locally; publication, hosted cost and client adoption still need acceptance. The browser still owns camera interaction and GPU presentation. This does not resolve the intermittent native black-screen defect or prove that the runtime can perform arbitrary AI/GPU work.

## Existing authority and integration seams

- `worker/plugins/usgs-live-day.js` acquires the fixed USGS all-day source. The admitted factual scope is M2.5+ seismic reports, including source-reported non-earthquake types, at most 500 qualifying rows.
- `worker/plugins/store.js:runSourcePlugin` already publishes original bytes, canonical facts, artifact and D1 receipt/membership/head through its lease-fenced atomic publication. Reuse these clocks and identities.
- `readPluginObservations` verifies the completed receipt, factual/artifact body digests, membership and one coherent head retry. The existing `/api/layers/earthquakes` route is stored-only. The preparation builder consumes this reader's DTO or the equivalent evidence after verified receipt publication; it is not an authentication boundary and does not reread original provider bytes.
- `worker/collection-updates.js` already emits a small typed USGS plugin head revision over `/api/updates`. Its finite 4 KiB stream queue is for revision notifications, not complete scene bodies or large deltas.
- `worker/world-scene.js` already serves M4.5+ retained catalog history with event-time selection, separate knowledge cutoff, coverage and bounded buffered points. Keep that authority; do not reconstruct years from today's rolling-day source.

## Pure projection contract

`buildPreparedUsgsScene(snapshot,{signal})` admits one complete, digest-matching retained cohort and returns a deeply frozen artifact. The original `earthquake:<stableId>` display IDs, coordinates, origin time, provider update time and source event type remain exact. A per-row digest qualifies factual correction. The retained raw hash is an opaque citation from the existing authority, not a new claim that this builder validated the original body.

The artifact separates reusable `content` from `source` receipt basis. Content is keyed by factual digest plus `usgs-seismic-geographic-grid-v1`; a later receipt of identical facts can reuse the same content digest. The envelope version binds that content to exact receipt ID, fence, captured time, DB-recorded time and retained source generation time. Operational checks do not revise content or reset source age.

Three fixed, unequal-area geographic grids have 8×4, 32×16 and 128×64 cells. Each stores numeric feature indices, not duplicated evidence bodies. Dateline wrapping and pole clamping affect only indexing; the source positions are preserved. Cluster centers are explicitly cell summaries, never incident epicenters. Counts refer to the qualifying retained source cohort, not all physical earthquakes or a census of impacted areas.

`selectPreparedUsgsCells(prepared,{level,cells,mode})` selects at most 128 whole cells, with `mode:'clusters'|'features'`. Cell lists are canonical, duplicates and invalid coordinates fail. A coarse world view chooses the 32-cell grid; a detailed view requests finer visible cells and a bounded neighbor ring. Empty selected cells are empty within this retained response, not proof that nothing happened. Viewport cells prioritize delivery only; they never change unattended source acquisition or archive collection.

`diffPreparedUsgsViews(previous,next)` returns upserts/removals tied to an exact prior view version and identical selection/policy. Regressing or incomparable source editions, changed viewport/lens/policy, or an oversized delta require a full snapshot. A removal means absent from this selected display cohort; it does not mean retraction, an event ending or deleting retained evidence. The client advances the source basis and applies its corresponding diff together through the common scene-work/edition owner.

Bounds: source maximum 500 rows/128 KiB canonical facts; prepared artifact maximum 384 KiB; regional view and delta maximum 256 KiB; 128 requested cells. JSON/hashing costs and primitive/GPU publication remain measurable costs rather than a universal 4 ms guarantee.

## Bounded runtime package

1. After an authorized fixed source-plugin wake completes a verified publication, successful unchanged/304 check or not-due owner check, `ensurePreparedUsgsScene` repairs the reconstructable derivative if needed. A completed acquisition remains successful even if preparation fails. This hook is absent from visitor reads and does not replace the source lease/head database.
2. There are exactly two derivative objects: `prepared/usgs-seismic-geographic-grid-v1/current.json` and `prior.json`, at most 384 KiB each (768 KiB total durable payload). Original raw/factual/artifact/archive evidence is neither deleted nor rewritten. Conditional writes use the real R2 object's ETag, or `If-None-Match: *` for a missing slot. Higher fences and equal-fence different bases cannot be overwritten; at most one conflict restart is admitted. Ambiguous writes require readback and remain explicitly uncertain. No KV atomicity is invented.
3. Current/prior slot changes and the D1 receipt are not a transaction. A source head moving between the final guard and R2 write can temporarily leave a stale derivative, so public delivery requires the exact completed capture receipt/fence/digests/clocks and one final D1 recheck. Mismatch is preparation-pending, not newer facts. A lost prior means a full snapshot. Cold reads validate bounded bytes, canonical facts/row hashes, exact grid and content/envelope digests once before caching; warm matching reads reuse that frozen object. No visitor GET builds or repairs. Operational check metadata is delivered separately and does not revise factual scene versions.
4. Reuse existing typed SSE head notifications. After a revision or reconnect, the client makes a bounded stored GET carrying its exact base view version and selection. The server returns an exact delta when its retained base is available, otherwise a complete snapshot. Do not insert large scene payloads into the existing stream queue or retain unbounded subscriber viewport state.
5. Selected evidence binds exact receipt/factual digest/stable ID/row revision from an admitted current or prior slot. The prior also matches its own retained D1 capture. Low-magnitude live rows may have no matching world-event index; do not invent an event or cite a newer cohort. Per-report first-known dates are unknown in this whole-feed pilot; cohort capture/publication dates must be labelled accordingly.
6. Durable derivative storage is structurally capped by the two fixed slots. Per-isolate decoded preparation cache holds only current/prior; view caching has its own bounded API budget. Earlier prepared editions may be unavailable even while original source evidence remains retained. This first route is Live/current with an exact prior recovery base, not an arbitrary historical prepared archive. Existing catalog History and its knowledge-cutoff APIs remain separate.

An owner wake may repair a malformed/oversized/integrity-invalid reconstructable slot only after obtaining its actual R2 ETag, rebuilding from the completed source receipt and rechecking that head. Replacement uses that exact ETag; no unconditional write or evidence deletion occurs. A transport failure or missing object version does not become permission to repair. Invalid owner descriptors never enter public cache admission. Corrupt prior storage must not prevent the next completed scene from being prepared.

Every authority/head recheck uses base D1 statements, which use the primary database. A single reused `first-primary` session would force only the first statement to primary and could subsequently miss an edition admitted during R2 work; that bookmark is insufficient for this current-head guard.

The documented R2 conditional API accepts `Headers` and `R2Conditional.etagMatches`, returns `null` on a failed condition, and makes completed writes strongly consistent. These are actual R2 guarantees, not a cross-object or R2/D1 atomicity claim. [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

The Cloudflare minute trigger is a small authenticated wake, not the data-processing/GPU engine. The existing hosted source runtime is the prospective processor for this bounded pilot. Measure actual hosted CPU, memory, R2 reads/writes and deadline behavior before claiming capacity, costs or a free always-on AI service.

## Time and history

| Clock | Meaning |
|---|---|
| record origin time | Source-reported time of the seismic event/report; never the check or scene clock |
| record updated time | Provider revision time of that record |
| retained source generation | Time declared by the source response retained by this receipt |
| captured time | Acquisition clock of the retained cohort |
| recorded time | Authoritative platform publication/knowledge clock |
| `sceneUtc` | User's selected world time; advances independently of arrivals and camera movement |
| `knownAt` | Optional evidence-knowledge cutoff; independent of valid/event time |

A `knownAt` rolling-day observation read is a captured membership snapshot available by that cutoff. It is not event-time reconstruction at the same date. The builder rejects receipts recorded after the supplied cutoff, but does not infer an individual report's first-known time. Default History continues through the existing catalog scene API using valid/event time and latest retained corrections; strict Known then adds its knowledge cutoff. Scientific future forecast frames may use their declared valid times in their own source scope; this seismic pilot creates no predictions.

## Acceptance before deployment

Pure checks cover deterministic identities/hashes, mismatched receipts and knowledge cutoffs, exact dateline/pole positions, meaningful cluster geometry, canonical bounded selection, delta/full equivalence and payload bounds. Native SQLite/R2-contract fixtures cover publication/304 repair, exact current/prior basis, A/B/A content reuse, delayed conditional writers, ambiguity/readback, corrupt grid/size failure, owner-only conditional repair, stale-replica head rejection and read-only visitor delivery. Hosted preparation/GET, actual source rolloff, public cache behavior, exact evidence and native client rendering still need acceptance. A synthetic Node test is not a hosted CPU or GPU responsiveness measurement.
