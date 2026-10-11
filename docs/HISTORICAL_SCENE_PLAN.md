# Event-time scenes and a separately scoped USGS archive

12 October 2026. The bounded archive storage and stored-only scene endpoint below
are implemented in this checkout. The first release still needs integrated hosting
validation and a deliberately small import. A complete two-year archive has not been
imported. Source-specific hosted-knowledge replay and current scientific
reconstruction are different products, with different publication cutoffs.

## Visitor contract

Add a stored-data-only `/api/world/scene` with required selected UTC `at`, a bounded
named event window (initially `7d`), a reviewed source scope and optional `knownAt`.
The default reconstructs the selected event-time window using the best retained
source revisions available now. It answers which reported earthquakes belong in
that period using current retained scientific information. Optional `knownAt`
restricts eligible revisions to complete hosted publications by that cutoff. It
answers what this platform could support then. Those two questions remain distinct.

An earthquake is transient: include origin times in `(at - window, at]`, rather
than retaining every earlier earthquake forever. Unknown origin dates cannot be
placed on that calendar scene. Other future modules need their own event/interval
lifetime semantics; the same seven-day rule does not fit a war or an infrastructure
asset. Calculated sunlight still follows `at`, independently of observation dates.

Return selected mode, event window, optional knowledge cutoff, source/dataset scope,
selected revision references, complete available coverage, pending/failed gaps,
returned/omitted counts and a version signal. A request outside imported coverage
returns a real gap, not today's snapshot. Source observation/revision, actual import,
first hosted knowledge and scene time remain separate in dossiers. Visible bounds
may limit serving; they do not define whether global acquisition happened.

Archive fetched today cannot populate a knowledge cutoff before its publication.
Default reconstruction can still show its older source events. No retrospective
import may backdate a hosted publication merely because an event occurred earlier.

## Scope isolation is the first hard gate

Keep source identity (`usgs`) separate from dataset scope. The existing live sample
is the M4.5+ seven-day summary, currently limited to 100 records. A proposed archive
scope such as `usgs-catalog-m4.5-v1` describes catalog filters and completed event-time
coverage. Archive data must never call the current `persistEarthCollection` path,
advance `earth_world_sources`, write live `earth_world_captures`, replace prepared
intelligence, or create an unrelated factual collection-stream revision.

Reuse immutable source item/revision identity where normalization is equivalent.
Archive completion has its own receipt/membership and coverage checkpoint. Its
publication invalidates only matching archive/scene caches. The live summary can
continue updating while archive work is paused, retried or partly complete. A source
specific complete archive chunk can be valid even before a wider import run finishes;
global completeness is the union of explicitly completed coverage segments, not a
boolean copied from one successful page.

Retain original response bytes/hash in private archive evidence, plus bounded
normalized chunks and their transformation version. The existing summary normalizer
silently takes at most 100 features; do not pass a larger catalog response through
it and call the archive complete. Reuse a fact-level normalizer in bounded groups or
create a separately tested catalog adapter. Preserve provider event type, aliases,
depth/units and measurement uncertainty when collected; do not infer them from a
country label or discard them while advertising scientific completeness.

## Primary USGS documentation checked

The official catalog supports `query`, matching-filter `count`, UTC date ranges,
`updatedafter`, magnitude/type filtering, ascending time order and one-based
offsets. Its query maximum is 20,000 events. Default searches cover 30 days, so both
date bounds must be explicit. Preferred information is returned when catalog and
contributor are unspecified. Deleted records can be requested in GeoJSON/CSV;
superseded products require a single `eventid` query. These features do not certify
a complete historical public-knowledge replay.
[USGS catalog API](https://earthquake.usgs.gov/fdsnws/event/1/).

Summary GeoJSON exposes origin and update times, provider IDs/aliases, event type,
review state and longitude/latitude/depth. Detail adds versioned contributor
products and content links; it is a different, potentially larger acquisition.
[USGS summary format](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php),
[USGS detail format](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson_detail.php).
Catalog constituents and geographic coverage vary; “ComCat” does not promise that
every event everywhere was detected.
[ComCat overview](https://earthquake.usgs.gov/data/comcat/).

Only documentation was read for this proposal. No bulk catalog query, source import
or new provider connection was started. Publisher/linked-product content is outside
the proposed metadata import, and retains separate access/rights checks.

## Bounded two-year acquisition

Declare a fixed calendar interval, e.g. `[2024-10-12, 2026-10-12]` for this planning
date, with `minmagnitude=4.5`, `eventtype=earthquake`, `format=geojson` and explicit
UTC boundaries. Store the policy version and exact query filters. This provides a
bounded starting dataset, not all seismic measurements or all world incidents.

Run an independent authenticated importer on the laptop/approved worker runtime,
outside visitor requests. Start with small date intervals and a count request;
split dense intervals until one bounded response can fit the chosen record/byte
budget. A suggested initial page target is 250–500 records, one concurrent request
and at most 1 MiB normalized evidence per hosted chunk. These are proposed local
budgets, not USGS quotas. Configure actual request/byte/time limits before execution.

Prefer subdivided single-response intervals over long mutable offset walks. USGS
date bounds are inclusive, so overlap endpoints intentionally and deduplicate by
provider identity/revision. Record response generation time, counts and query bounds.
The catalog can change during acquisition: reconcile count/result discrepancies,
retry bounded intervals and perform an overlap repair pass. A count match alone
does not prove one globally consistent catalog snapshot. If a cap is hit or counts
remain inconsistent, coverage stays partial rather than silently truncated.

Checkpoint interval/page identity and state in a durable import job. Retain source
evidence, insert normalized item/revision rows with bounded JSON1 groups, verify
references, then commit archive membership/coverage. Failed writes leave no complete
coverage receipt. Same-input retry preserves the first actual hosted retention and
does not duplicate revisions. Apply backoff/deadline and resume after restart.
Backfill budget is separate from live acquisition and investigation budgets.

After the initial import, `updatedafter` with a persisted provider update watermark
and overlapping repair interval can discover later catalog corrections. Never
advance that watermark before all admitted results commit. Compare explicit
provider modification dates for the same event; a later import of an older provider
revision must not automatically replace a newer retained one. Unknown or equal-date
conflicts remain traceable and require a declared selection policy. Explicit source
deletion is a dated assertion; missing from a query/sample is not deletion.

## Minimal indexed serving model

The next schema discussion needs only archive chunk receipts/membership, coverage
segments and a temporal event serving index. Reuse source revisions and cited event
projections; do not construct a second parallel evidence warehouse. Keep raw archive
evidence references and normalization versions compatible with retained v1 bodies.

For default reconstruction, maintain a scoped current event head with its chosen
revision and event time. Index `(scope_id, event_at, event_id)` for bounded date-window
queries; geographic cells can be an additional serving index after measuring need.
Current heads update only after complete archive evidence publication, using the
declared source-revision policy. Keep all older revisions and head-selection reasons.

For `knownAt`, index committed revision availability by
`(scope_id, event_id, published_at)` and candidate event time by
`(scope_id, event_at, event_id)`. First collect a bounded candidate set from revisions
whose source event dates overlap the requested window and eligible scope. Resolve
each candidate's selected revision under the knowledge cutoff independently of
event-time/geographic filters; only then apply the final window/bounds. Otherwise
an origin correction moving an event outside the window can leave its obsolete
pin visible, or an earlier coordinate can survive a later correction.

Do not scan every retained earthquake or load all source chunks into a visitor.
Use keyset pagination and explicit omitted/partial counts, a small scene memory cache,
neighboring event-time prefetch, cancellation and revision invalidation. Add an
immutable materialized time/cell chunk only if the measured indexed query requires
it. A cached scene must include scope, event window and knowledge mode/cutoff;
current scientific reconstruction cannot share a cache identity with old knowledge.

Provider aliases can change preferred IDs or associate previously separate records.
Retain original IDs and cited alias assertions. Any canonical entity mapping must
be versioned by publication time; do not use today's alias merge to fabricate what
the platform knew before that association arrived. Cross-provider proximity or
similar titles still do not establish one earthquake or independent corroboration.

## First implementation/release gate

Demonstrate one completed small historical interval and one deliberately failed
interval. Show reconstruction before today's import date, show a true gap at an
earlier hosted-knowledge cutoff, apply a corrected origin/magnitude, retry without
duplicates, and prove unchanged live prepared/source pointers. Measure SQLite query
plans/rows, payload sizes and scene latency with a representative archive fixture.
Only then enqueue the remaining two-year interval. Two-year completeness requires
every requested interval's checkpoint plus repair evidence, not a successful import
request or a timeline label stretching back two years.

## Implemented bounded storage and serving contract

`db/world-archive-schema.ts` adds four isolated tables. Immutable
`earth_archive_chunks` receipts have a monotonic integer publication order and
actual SQL publication timestamps. `earth_archive_membership` retains exact
item/revision membership. `earth_archive_coverage` records only independently
count-matched complete origin intervals. `earth_archive_heads` serves current
preferred retained revisions with an origin-time index. No archive call advances
live source captures, live history observations, prepared intelligence or its stream
revision. These tables ship in the generated migration `0004_world_archive_investigations`.

`worker/world-archive.js` exports the internal importer boundary:

- `retainWorldArchiveRaw(env, {body})` retains at most 1 MiB of original USGS
  GeoJSON text at a SHA-256-derived private key. Original bytes remain unchanged.
- `createWorldArchiveCandidate(input, {now})` computes the same deterministic
  `chunkId` and factual `snapshotId` used by publication, without storage access.
  Identity includes raw response bytes and scope/query policy, excluding the
  clock of a retried HTTP attempt.
- `publishWorldArchiveChunk(env, input, {now})` accepts schema version 1, scope ID,
  capture time, `interval` or `correction`, interval bounds and external count where
  applicable, original raw SHA-256, and at most 500 canonical USGS records.
- `readWorldArchiveChunk(env, {chunkId})` returns only an exact completed receipt;
  partial item writes are `stored:false`.

Transport must normalize all features in groups no larger than 100 with the existing
USGS adapter and canonical discovery record function. The writer independently
normalizes original features one by one and checks factual equality, so the live
summary cap cannot silently truncate an archive. All 500 epicenter coordinates are
retained in record fields and the original GeoJSON. The redundant v1 snapshot
`coordinates` array is empty, preserving compatibility with existing live evidence
readers without losing geometry. Raw bytes retain aliases, depth and provider fields
that the narrow v1 event projection does not yet expose.

Catalog query GeoJSON can omit the summary feed's `metadata.count`. This is admitted;
when present the count must agree. Complete interval publication requires the
independently supplied catalog count to equal all original features and normalized
records. Its original metadata query URL must identify the official FDSN endpoint
with the declared UTC bounds, earthquake type, M4.5 threshold and GeoJSON format.
Unknown narrowing filters and offsets other than the first page are rejected.
Source counts establish bounded acquisition completeness, not worldwide detection.

Item/revision rows reuse existing immutable world evidence when facts match. First
retention clocks are preserved on retries, even if an earlier attempt never completed
the archive receipt. Receipt publication, coverage and head selection commit together
after references verify. Future capture skew is capped at five minutes relative to
the importer clock and 305 seconds relative to the publication SQL clock before a
receipt can exist. Captures may predate a retry/publication; the original date is
retained, with no lower age bound. SQL timestamps
describe database transaction execution, with atomic visibility;
they are separate from provider origin/update times and response retrieval.

Current scoped heads select the greatest non-null provider update timestamp. A dated
revision outranks an undated one. Equal-date differing facts keep the first committed
selection, including equal database clock values through receipt integer order. All
alternatives remain retained; detail returns up to 20 cited conflict references.
Older imports cannot replace newer provider facts. A correction can move an event
outside its old period or bounds, and a below-M4.5 correction can remove a previously
scoped event from the visible threshold. Absence alone never deletes a head. Explicit
deletions, alias merges and full scientific product histories remain later contracts.

`worker/world-scene.js` exports `readWorldScene` and `createWorldSceneHandler`:

- `GET /api/world/scene?at=<UTC>&window=7d&scope=usgs-catalog-m4.5-v1` reconstructs
  `(at - 7d, at]` from current retained scientific revisions.
- `knownAt=<UTC>` fixes hosted knowledge eligibility to completed archive receipts
  by that date. `knownMode=scene` instead advances that eligibility with selected
  `at`; it never substitutes provider occurrence dates for actual publication.
- `metadata=1` exposes the advertised retained origin range and completed segments
  without requiring a scene selection. Earlier knowledge cutoffs retain that
  advertised range but identify unavailable-at-cutoff gaps. Never imported gaps are
  distinct. Pending/failed job arrays are empty because this module has no job ledger.
- Bounded `limit` (1–100), optional dateline-aware `bbox` and query/version-bound
  keyset `cursor` support paging. `counts.eligible`/`omitted` are exact only if the
  5,000-candidate selection completes; otherwise they are null and `truncated:true`.
- Scene detail is `/api/world/scene/events/<event:usgs:hash>` with the same query
  context. It verifies the selected canonical body, original first-retained evidence
  body and original raw response before serving the dossier. Lists validate committed
  projection/reference consistency without downloading every source body.

Revision selection precedes origin, threshold and geography filtering, including
knowledge replay. Indexed candidates spanning the scene window plus a one-day
neighbor horizon bound query and memory work. A complete selection proves a
version-scoped constant-membership interval `[validFrom, validTo)`, stopping at exact
event entry/seven-day expiry and at archive publication boundaries for advancing
knowledge. Candidate overflow returns null interval bounds. Calendar gaps do not
become event-free scientific claims. Frontend code must consume all cursor pages
before treating a marker set as complete; `membershipComplete` reports candidate
selection completeness, while `complete` also requires full returned membership and
complete source coverage. A changed archive version invalidates earlier scene caches.

Twenty-one focused tests use the actual generated migrations and SQLite. They cover
retry and previous live evidence reuse, partial writes, concurrent older/newer
promotion, count/query/raw integrity, reconstruction versus hosted cutoff, corrections
before final filters, conflicts/unknown dates, dateline bounds, real coverage gaps,
keyset pages, interval boundaries and SQL-clock admission. A rich 500-record fixture
uses 28 D1 statements including five first-use schema probes; maximum JSON1 input is
260,094 bytes. Each list scene lens uses five queries and SQLite plans confirm origin
and per-item revision indexes. These are local invariant and query-plan measurements,
not hosted latency or two-year completeness claims.

### Buffered Reconstruction for fast timeline playback

The default instantaneous scene remains available. For rapid reconstruction playback,
`points=1&span=7d` fetches minimal source-grounded points once per timeline chunk,
with origins in `(at - 7d, at + span]`. The upper end is clamped to actual retained
archive coverage and current wall time. Future catalog intervals cannot be declared
complete. Each point contains event ID, source/provider record ID, item/revision and
first evidence snapshot refs, epicenter, magnitude, origin timestamp, title and official
source URL. Full projections are retrieved only for selected scene detail.

The response includes `bufferFrom`, exclusive `bufferTo`, `bufferWindowFrom`, source
version, counts/cursor and coverage/gaps for the entire acquired origin interval.
For every UTC inside a fully fetched buffer, the browser can select
`origin > utc - 7d && origin <= utc` locally. This avoids requests at each origin or
expiry boundary during high-speed playback. Pages are bounded to 100 points, with
5,000 indexed candidate records maximum. The frontend's bounded point cap must be
reported as partial if fewer than all eligible points have been retained. Reuse is
version-scoped; advancing into another buffer or discovering a new archive version
requires prefetch/invalidation. No-future buffer bounds are null rather than an
unusable fabricated interval.

Buffer mode is rejected for both fixed and advancing knowledge lenses. Those modes
retain instantaneous complete-publication eligibility and cannot leak today's
scientific revisions into old hosted knowledge. Optional scene-detail
`revision=<selected point revision>` returns a conflict when the currently selected
revision differs, rather than attaching a different source revision to the selected
pin. Tests compare local buffer filtering against authoritative instantaneous scenes
across entry/expiry seams, verify exact page membership, correction/version handling,
coverage clamps, lens rejection and detail conflicts. Equivalent concurrent retries
also prove that D1 projections use the canonical R2 body that actually won immutable
retention, preserving its original retrieval clock.
