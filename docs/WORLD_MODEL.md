# Stored world evidence foundation

This is a narrow additive journal and stored-data reader. It reuses private R2
source snapshots and D1 history observations. It does not collect providers, merge
independent reports into stories, run AI research, backfill earlier years, infer
causality, or prove an unattended collector exists. Deploying its module alone
does not enable those capabilities.

## Module boundary

`src/core/world-model.js` has no storage dependencies. `worldItemIdentity(record)`
hashes the admitted provider ID and provider record ID. `worldRevision(record)`
hashes all canonical facts except `retrievedAt`; retrieval-only heartbeats do not
create another factual revision. `createWorldSourceItem(record, reference)` links
that immutable revision to a retained source snapshot. These are asynchronous
SHA-256 operations. `provisionalWorldEvent(item)` is a synchronous projection of
a trusted item created by that factory; it additionally checks evidence-reference
consistency. It produces a provisional USGS earthquake event and stable epicenter
reference, preserving reported dates, coordinates and uncertainty. It returns no
event for country/topic mentions or other source types.

`worker/world-model.js` exports:

- `projectWorldCollection(env, { packet, snapshots }, { now })`: call after an
  authenticated collection has successfully retained and D1-indexed source
  snapshots. It verifies each actual immutable body before deriving any item.
  Return fields include `configured`, `stored`, `available`, `capturedAt`,
  `sourceCount`, `itemCount`, `revisionCount`, `eventCount` and `jobCount: 0`.
  An unavailable migration, empty accepted-source set or incomplete publication
  cannot report stored success. Packet capture time must match accepted history.
- `readWorldEvents(env, { knownAt, limit, id }, { now })`: stored evidence only.
  `knownAt` means knowledge available from a complete world projection by that
  time, not an earthquake origin-time filter. It returns at most 100 events from
  the latest qualifying whole USGS snapshot, with explicit coverage and omissions.
  `publicationWindowStartAt` and `nextPublicationAt` bracket complete publication
  availability; the latter is the earliest USGS receipt transaction after the
  selected knowledge cutoff. `publicationRevision` describes selected snapshot
  scope and `currentPublishedRevision` carries the latest durable USGS version
  metadata, without inserting its later event facts into historical output.
- `createWorldModelHandler({ env, now })`: GET `/api/world/events`, optional
  `knownAt` and `limit` (default 50, maximum 100), and GET
  `/api/world/events/event:usgs:<64 lowercase hex digits>`, optional `knownAt`.
  Unknown/repeated filters, unsupported methods and invalid dates are rejected.
  No public request can select an upstream URL or an arbitrary storage key.
  Responses are `no-store`; error responses expose no credentials or raw storage
  errors. Missing index/migration/evidence returns 503. A missing selected event
  returns 404 without asserting that it ended.

Bindings are the existing private `EARTH_STORE` and `EARTH_DB`. D1 must support
`batch`, SQLite `strftime`, `json_set` and the generated migration
`drizzle/0003_world_evidence.sql`, including its source-leading receipt time index.
Reads and writes use `first-primary` sessions
when the binding exposes sessions, preserving read-after-write consistency.

## Evidence and clocks

`earth_world_revisions` retains one immutable source item/revision pair, its original
snapshot reference, first capture time, first item-index retention time and optional
USGS event projection. Conflict retries preserve the original row and dates.
`earth_world_observations` records changed item states encountered during projection.
It is not the authoritative membership of a complete source sample.

`earth_world_captures` is the immutable publication receipt for a complete source
snapshot. It is written only after referenced item rows are verified. Even an
unchanged source check gets this small D1 receipt. It does not create an R2 world
object or rewrite every item. `earth_world_sources` holds the latest source watermark.
Its conditional upsert accepts strictly newer capture times; equal-time conflicting
evidence is rejected, and late completion cannot replace newer state.

Record dates are deliberately separate:

- `eventTime` and `sourceTimes`: original provider semantics, including unknowns.
- `knowledge.firstCapturedAt`: the collector capture associated with first retention
  of that item revision. A later import of earlier evidence does not backdate it.
- `knowledge.firstRecordedAt`: database transaction time when the revision first
  entered this index, preserved through retry. SQLite also sets this date in the
  saved event projection through `json_set` in the same statement.
- `capture.capturedAt`: the selected complete source snapshot's collector check.
- `capture.publishedAt`: database publication transaction time of the complete
  receipt. Its SQL timestamp is computed during database execution, rather than
  before an awaited request that might spend time queued. Atomic batch visibility
  begins at transaction commit; the recorded date identifies that publication
  transaction, not a separately measured wall-clock commit acknowledgement.

Item retention can precede complete projection publication after an interrupted
chunk. Public knowledge-cutoff selection uses publication receipts, so partially
retained corrections do not appear in the earlier public world view. It selects
the greatest source capture time among receipts published by the cutoff. Late
imports cannot introduce older source state as the current view.

Receipt admission also enforces `capturedAt <= database publication time + 305
seconds` inside the SQL INSERT. This includes the existing 300-second capture
admission tolerance and an explicit five-second additional clock allowance. It
does not assume that two independently sampled clocks always agree. A queued
publication evaluates the rule at database execution. A violation leaves retained
source/item evidence intact and creates no source receipt; a later safe retry
preserves first-retention dates. It cannot become a successful public projection.

The historical lookup may consequently seek `capturedAt <= knownAt + 305 seconds`
using the existing `(source_id, captured_at)` primary key before checking receipt
publication time. The proof is direct: a qualifying receipt has publication time
at or before `knownAt`, and SQL admission bounds its capture to at most 305 seconds
later. This excludes no accepted receipt and avoids starting a backward scan at
today when asking about an early historical date. Explicit earlier-than-first
publication reads avoid that scan entirely. The source-leading
`(source_id, recorded_at, captured_at)` index supports first/next publication
minima without scanning other providers. A very large retrospective import with
many old captures published late can still enlarge the historical filter work;
capture range seeking is not a promise of constant cost for arbitrary backfills.

The reader resolves membership from that whole immutable snapshot, never from
independently selected latest item observations. This matters when A is published,
B remains pending, a newer unchanged A check publishes, then B finally completes.
Current view remains A, and a historical cutoff before B's publication cannot see B.

The event list verifies the selected source body's factual hash and full-body
SHA-256, and validates saved event facts against that membership. Unchanged items
can cite their earlier original body; their first retrieval date is preserved.
Detail reads additionally load and integrity-check the exact original cited body,
verifying that it contains the precise source ID/revision and displayed source dates.
Missing or corrupted retained evidence fails closed. Body integrity establishes
retention consistency; it does not independently verify provider claims.

## Bounded operation and remaining work

Current admission limits are four sources, 500 total collection records, 1 MiB per
existing source body and 100 output events. JSON1 parameter payloads are capped at
256 KiB, with one bound parameter per bulk source lookup or mutation. Item work is
split by actual encoded bytes, not an arbitrary ten-item group. A complete accepted
package verifies all item groups before one atomic receipt/watermark batch across
its pending sources. At most eight item groups are admitted, bounding publication
to 40 D1 statements including four initial schema probes. An oversized projection
is rejected before item writes and receipts, preserving its underlying source
evidence for a differently budgeted retry rather than silently publishing a subset.

The realistic maximum fixture uses 100 USGS, 100 GDACS, 60 EONET and 240 GDELT
records with 680,081 encoded bytes of source metadata. Publication uses 16 SQL
statements, with a largest JSON bind of 260,858 bytes. An unchanged four-source
follow-up uses four statements and no item rewrites. These are measured local
query/byte bounds, not a claim that the full collector's free-tier invocation,
rows-read allowance or production CPU budget is sufficient. The collector host's
actual resource tier still needs review.

A current public list uses two SQL statements: one watermark/publication-window
lookup and one JSON1 revision lookup for at most 100 items, plus one immutable
body read. A historical read may add one source/capture range lookup. Four schema
probes are cached against the root binding. Detail adds at most one original-body
read. Each storage operation has a 2.5-second deadline. Actual query-plan checks
confirm indexed composite item identity lookup, source/capture range seeking and
source/recorded-time lookup; no per-item database request is necessary.

The source remains the collector's bounded USGS M4.5+ seven-day sample, not a complete
Earth history or complete incident archive. Sample disappearance is not retraction,
disproof, resolution or closure. There are no investigation jobs yet. Next contracts
should consume complete receipts and source revisions, then add bounded deduplicated
research work, cited claims and dated typed relations. An epicenter reference is a
place attached to one source event; it is not yet global place/entity resolution.

Focused checks use actual generated migrations and SQLite, including stable identity,
correction, unchanged/repeated input, first retention on retry, partial publication,
out-of-order completion, the pending-B/newer-A race, original evidence integrity,
knowledge cutoffs, source semantics, strict public queries and bounded storage work.
Clock-boundary checks include exact 305-second admission, a one-millisecond excess,
independent server/database clocks and a queued publication evaluated later.
