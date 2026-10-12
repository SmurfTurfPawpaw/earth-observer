# Next durable investigation slice

Foundation plan and remaining domain work, updated 12 October 2026. A narrow
durable USGS detail investigation lane is now implemented and has a completed
hosted acquisition/receipt/result proof. It is fixed scientific enrichment, not
a general AI research runtime, cross-source verification or global claim graph.
The current system also retains typed institutional publication and annual-data
receipts. Other discovery items remain metadata, not verified incident pins.

## Implemented investigation boundary

`worker/investigation-pipeline.js` admits at most three recent source-reported
USGS events per material source capture, prioritizing reported magnitude/newness.
Its persistent admission receipt can repair a lost enqueue step on a later wake;
unchanged checks do not continually enqueue the same input. One due job runs per
bounded authenticated wake. `worker/investigation-jobs.js` owns conditional
leases/fences, a fixed USGS detail source, immutable originals and cited results.
The stored-only public API does not acquire providers. The completed hosted
roundtrip is recorded in FOUNDATION_PROGRESS.md; it does not prove permanent
unattended execution or corroborated geopolitical analysis.

Original Commission PDF evidence is separately staged in ORIGINAL_DOCUMENTS.md.
Institutional publication items require their own source-item subject, original
PDF retention and analysis publication receipts. Existing USGS event/snapshot
fields cannot be filled with invented publication identifiers. Supervised local
extraction and pure citation validation are not hosted document investigation.

## Publication review and release boundary

The reviewed collector previously advanced the public prepared R2 pointer before
history/world completed. A failed newer B could consequently be announced when an
older A finished and read that unrelated current pointer. The current fix preflights
the candidate, retains source history, completes world evidence, then conditionally
promotes prepared data. Notification binds to the exact completed packet while it
still matches the pointer. Equal-time differing facts conflict before promotion;
older completed packets cannot regress the prepared pointer. A failed promotion
preserves completed evidence for retry, without announcing it as a prepared success.

Compact heartbeat is now explicitly operational. It updates `checkedAt`, source
check/health fields and serving eligibility under the exact factual-baseline ETag.
It preserves `collectedAt`, every source record and original retrieval date, writes
no history/world receipt, and creates no factual D1/SSE revision. `checkAgeMs`
describes collector checks; collection/source evidence age remains separate.
This removes the proved H→D→H failure in which a rejected obsolete heartbeat with
a greater capture time could replace newer world facts. Full packets still retain
real complete captures, including repeated factual membership.

R2 conditional ETag semantics are required. Per-isolate serialization is not a
distributed lock; the focused concurrency fixture uses different binding wrappers
over one bucket. The target host must honor conditional puts, returning a failed
conditional write rather than silently overwriting. No universal R2/D1 transaction
is claimed. Complete source-specific world receipts can be independently valid
while aggregate prepared promotion fails; current global metadata and source world
publication therefore have distinct scopes. Unified packet/scene authority should
be a deliberate later contract if the product needs a single global atomic cut.

The legacy `/api/history` remains a collection-capture archive. It does not prove
what was publicly known then. `/api/world/events?knownAt=…` uses complete hosted
publication receipts. Scene pins, dossiers and historical cards must declare which
contract they use; later facts from legacy metadata must not silently appear as
strict knowledge replay. Archive imports must never replace the live source sample.

Focused release checks cover the failed-newer/older-completion race, equal-time
fact conflicts, source/history failure, pointer failure, retry, immutable source
dates, operational-only heartbeat and cross-isolate H→D→H. Passing these checks
does not certify unattended acquisition, global story verification or a two-year
archive. Operational health needs a small independent refresh when facts are
unchanged; a health check must not rebuild the event scene.

## Smallest useful domain extension

Reuse existing source item/revision IDs and immutable snapshot evidence. Add only
the records required for one investigated event:

- A **claim** attributes one statement or measurement to its source revision,
  including subject/predicate/value, original date meaning and evidence locator.
  A source assertion is not a platform verification. An unsupported date/location
  remains unknown. USGS origin/magnitude is the first structured example.
- An **entity** has a stable typed identity and source identifier mappings. Keep
  source-event epicenters separate from globally resolved places, organizations,
  ports, infrastructure or resources. A suggested match is revisable, with evidence.
- A **story/event link** groups explicitly related claims under a stable dossier.
  Source event IDs can establish same-provider continuity. Proximity, shared words,
  country mentions and co-occurrence only propose cross-provider candidates.
- A **relation** cites dated evidence and names its type. Reported ownership/trade
  or physical dependency differs from a suggested explanation of cause. Economic
  exposure is not proof that an incident caused a price movement.
- An **analysis revision** stores cited input revision IDs, evidence cutoff,
  method/model/policy version, publication date, limitations and superseded revision.
  A later correction creates another revision. Predictions/scenarios additionally
  require assumptions, horizon, alternatives and later outcome evaluation.

Retain source attribution/rights and independent provenance. Syndicated copies,
aggregator links and reposts are one evidence lineage until independent reporting
is established. Neither a larger count of outlets nor search popularity increases
factual credibility automatically. Do not manufacture a confidence percentage.

## Bounded persistent research work

Start with one durable job type: investigate a published provisional event revision
through a reviewed, fixed-access source adapter. Unique work identity combines the
event/story, ordered input revision IDs, investigation policy version and a bounded
research window. Source heartbeats never create jobs. Persistent states should
cover queued, leased/running, retryable, completed, superseded and blocked-by-access;
retain attempts, due time, lease/fencing token, reason and resulting artifact ID.

Lease acquisition/completion uses conditional database updates. An expired worker
cannot publish after a replacement worker or overwrite analysis for a newer input.
Changed input supersedes pending synthesis; historical artifacts remain traceable.
Evidence retention precedes result publication. Partial research, unavailable
sources or a lost inference response retain the last supported dossier and explicit
coverage gaps. They do not close a story, invent a finding or silently reset dates.

Use inexpensive deterministic matching and capability checks first. Admit only
bounded new evidence to laptop inference: fixed provider/query allowlists, byte/time
limits, a small concurrency budget, conditional requests and deduplicated artifacts.
Source text is data; it cannot grant tool permissions or change collection policy.
One confirmed acquisition/job/result roundtrip without visitors is the execution
gate. An MCP wrapper or an available model does not provision that runtime.

Priority is a transparent owner policy: baseline global coverage, then newness,
source-reported severity, context, explicit follows and optional coarse viewport
interest. A first-hour boost is a capped research budget, not unrestricted scraping.
Afterward, contextual due times govern follow-up; a high-impact unfolding event can
retain priority without a follow, while a resolved transit delay does not need
repeated investigations. Source resolution/correction, not sample disappearance,
controls closure. Anonymous viewing stays easy; accounts/notifications and demand
telemetry need their own eligibility/consent design. Synthetic agents do not count
as real demand or corroboration.

## Coverage and backfill dependencies

The local capability ledger reviews USGS catalog date-range access, GDACS custom
dates and EONET start/end/open/closed queries. USGS M4.5+ origin-time backfill is
implemented: the initial retained range runs from 12 October 2024 through
11 October 2026 midnight. Incremental maintenance remains a separate acceptance
gate. A catalog fetched today reconstructs source event history using today's
available revisions, not old public knowledge. GDACS/EONET archive backfill is
not implemented.
GDACS episode completeness and EONET curation/onset precision remain unverified.
GDELT processes a bounded latest GKG batch with bounded recent missed-batch
repair outside the public Worker. Skipped batches preserve the prior sample and
explicit gaps; the current producer cadence is not a reliable streaming runtime.
Longer historical ingestion requires checkpointed bulk work. Country mentions
and index dates remain discovery context.

Each backfill job declares dataset scope, requested interval, filters/resolution,
cursor, attempted/completed coverage, truncation and actual capture/knowledge dates.
Use small resumable pages, immutable evidence and source item/revision deduplication.
Advance a coverage checkpoint only after all referenced evidence/index rows commit.
Separate archive membership from the live source watermark and prepared pointer.
Backfill and enrichment have separate budgets so neither starves current collection.

Expansion candidates remain gated by actual access: ReliefWeb requires approved
application identity; X/Reddit access and AI reuse cannot be assumed free/authorized;
Ground News has no verified public integration here. Eurostat and Wikidata are
useful mechanism/entity modules, not instant verified news feeds. See the reviewed
links and dated constraints in `SOURCE_CAPABILITIES.md`; verify the chosen adapter's
current primary documentation before implementation, rather than copying arbitrary
publisher text or images through an unrestricted crawler.
