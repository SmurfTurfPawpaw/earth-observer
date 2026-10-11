# Unchanged collection efficiency: measured design

Status: read-only review on 12 October 2026. This note proposes the next bounded
package; it does not change the deployed collector or its acquisition cadence.

## Finding and first priority

`collectEarthSources` currently passes every accepted packet to
`persistEarthCollection`. That persists a new observation per available source,
publishes whole-source world receipts, promotes the prepared pointer and announces
a new collection revision, even when only retrieval/check clocks changed.
Content snapshots and world factual revisions already deduplicate; operational
checks, captures and notifications do not. The laptop pipeline already sends a
compact heartbeat when the factual digest and its local GKG generation are unchanged.

Reuse the compact operational path for **completed, unchanged hosted baselines**.
Continue actual source acquisition according to the existing fixed adapters and
backoff. A new check must update `checkedAt` and source status without pretending
that new evidence, history, a world revision or research was published.

## Measured costs

An inline Node diagnostic used all tracked generated Drizzle SQL migrations,
in-memory SQLite implementing the D1 interface, an instrumented R2 mock, and the
actual USGS, GDACS, EONET and GDELT normalization functions. It exercised
`persistEarthCollection`, the same prepared-read/digest/notification operations
used by `handleCollection`, and the existing `heartbeatCollection`. All inputs
were clearly marked synthetic fixtures; no provider requests or deployed writes
occurred. Counts describe successful warm storage with no CAS contention. Cold
schema checks, provider cache/lease operations and source download bytes are excluded.

| Per unchanged four-source check | Existing full publication | Existing compact heartbeat |
| --- | ---: | ---: |
| SQL statements | 14 | 0 |
| SQL write statements | 7 | 0 |
| SQL rows inserted/updated | 13 | 0 |
| SQL batches | 1 | 0 |
| R2 reads / heads | 19 / 4 | 2 / 0 |
| R2 writes | 9 | 1 |
| New immutable observation objects | 4 | 0 |
| New history observation rows | 4 | 0 |
| New world source captures | 4 | 0 |
| New factual world revisions | 0 | 0 |

The full path changes four observation rows, four capture rows, four current-source
watermarks and one collection notification row. Its nine R2 writes are four
observation objects, four recent manifests and the prepared pointer.

| Fixture retained records (USGS / GDACS / EONET / GDELT) | Full R2 bytes written | Compact R2 bytes written |
| --- | ---: | ---: |
| 4 (1 / 1 / 1 / 1) | 10,076 | 8,519 |
| 360 (100 / 100 / 60 / 100) | 359,309 | 357,731 |
| 500 (100 / 100 / 60 / 240) | 468,509 | 466,931 |

The existing heartbeat is compact in database work and object count, **not in R2
payload bytes**: it rewrites the complete prepared payload. At 288 nominal
five-minute wakes per day, unchanged full checks create 1,152 observation objects
and 1,152 history rows plus 1,152 world captures. Compact checks remove those new
objects/rows and reduce the measured R2 writes from 2,592 to 288. Those are workload
counts, not billing promises or guaranteed scheduled executions.

A safe direct-hosted shortcut needs baseline/completion checks in addition to the
measured heartbeat primitive. Budget one or two grouped primary D1 reads for
completion proof; no D1 writes on a completed unchanged check. Reusing the already
read prepared baseline gives two R2 gets and one put in the uncontended path.
Calling the existing heartbeat wrapper without refactoring adds a third get.

## Eligibility: factual identity and source semantics

The facts algorithm is UTF-8 SHA-256 of JSON canonical records, sorted by ordinal
record ID, with **only** `retrievedAt` removed. It retains all source facts,
geography, identity, time meaning, review status, attribution and source revision
dates. Membership changes and expiry withdrawals change the digest even if no
new event was reported. Never use count equality, pointer age or title equality
as a substitute.

Before selecting the operational path, compare the exact source ID sets, source
identity/adapter mode and reviewed coverage semantics as well as the factual
digest. Source order is not meaningful. A validated status change can be operational;
it must not turn stale/fallback data into a successful factual capture.

| Source | Operational changes allowed without a new capture | Changes requiring full retained publication |
| --- | --- | --- |
| USGS / GDACS | Retrieval/check clocks, freshness, retry state, readiness; their index generation currently embeds a retrieval clock | Any canonical record/membership change, source identity, reviewed query/coverage or metadata semantics change |
| EONET | A newer successful direct retrieval with the same canonical content generation; age/backoff/status | Content generation, direct-versus-scheduled-fallback mode, retained count/at-limit/coverage semantics change |
| GDELT | Release revalidation clock, age/backoff/status; never renew original article/batch retrieval or expiry | Release generation, mode/kind, processed batches, sample gaps, window endpoints, country meaning or coverage change, even if selected record IDs/facts match |

GDELT is especially important: a newly processed batch can improve coverage without
changing the selected 240 links. The local pipeline explicitly recognizes its
GKG generation for this reason. The hosted path must compare the actual retained
generation and batch/gap metadata, including rolling-window changes. Do not drop
coverage fields merely to obtain a cache hit.

Use a versioned, small, reviewed semantic projection per retained adapter. Unknown
fields or unrecognized adapter modes fail closed to full publication until reviewed.
Exclude declared operational clocks, not an open-ended list of fields discovered
to be inconvenient. Validate source and index-coverage identities together.

## Completion gate and races

Prepared facts alone do not prove a completed publication. Promotion happens before
the collection notification is written; that notification can fail after R2 has
committed. Legacy prepared data can also predate the world index. Compacting the
next equal packet would otherwise leave notification/world completion unrepaired.

The shortcut needs evidence that this **exact prepared capture** has its required
history/world receipts and matching collection notification. Read the grouped
primary source receipts joined to history observations, and the collection
revision. Verify source IDs, original capture date, snapshot identities and counts,
plus collection date/digest/count. Reuse the existing history snapshot identity
algorithm rather than introducing an incompatible second hash. No receipt inferred
from merely having a schema, an R2 object or a successful previous HTTP request.

If completion is missing, use the existing retry/repair path for the exact retained
publication. If notification alone is missing, repair that original revision;
do not create a newer capture just to announce the same facts. Preserve explicit
partial/unavailable outcomes. Only compact after completion is demonstrated.

The operational write must repeat eligibility inside the conditional prepared
pointer update. Compare the prepared capture identity, factual digest and source
semantic fingerprint, not only facts and source IDs. A competing full publication
can change coverage while retaining identical record facts. CAS retries must
revalidate that boundary and cannot overwrite a newer generation or retime its
records. Operational `checkedAt` updates alone should not invalidate a factual
baseline. Bound conflict handling: re-read/reclassify once, then retain the packet
for the existing full path or report conflict; no unbounded acquisition loop.

`writePreparedOperationalCheck` already enforces that the complete canonical
record array, including original retrieval dates, is unchanged. Preserve that
check. Keep the original `collectedAt`, snapshots, history/world membership,
analysis pointer and collection notification revision intact. Successful checks
may update source `lastSuccessfulCheckAt` separately. Renew metadata cache expiry
only for sources whose successful acquisition policy permits it; never extend
GDELT batch provenance or turn a failed/fallback retrieval into fresh direct data.

## Module boundary and acknowledgment

Do not import `collection-publication.js` from `collector.js`: publication already
imports the collector, creating a circular dependency. Extract the low-level pure
canonical facts encoding/digest into a shared module, and extract operational
validation/update logic into a low-level collection-check module that imports
history and the shared digest but not the collector. Both the hosted collector and
the current external heartbeat wrapper can use it. History and the laptop should
use the same facts encoding; Node's synchronous digest may keep its public API
while hashing that shared exact encoding. Preserve the ordinal ordering contract;
history source snapshot hashes have a separate established ordering/schema.

Keep changed packets on `persistEarthCollection`; do not alter full historical
publication or source acquisition in this first package. Apply the shortcut to
hosted `collect`, not indiscriminately to explicit `publish` retries whose exact
captures/analysis may need repair.

The successful operational acknowledgment should explicitly carry `heartbeat:
true`, `factualPublication: false`, the preserved factual `collectedAt`, new
`checkedAt`, current record count, zero new snapshots and no research task. Do not
set `prepared.promoted` or `world.stored` as if a new factual publication happened.
The trigger/CLI summary should distinguish “check stored” from “new capture
published”; a successful operational check should still return HTTP 200 and
workflow success. `updatesPublished` remains false except a separately reported
repair of the original notification. Never print credentials or raw source bodies.

## Research queue follow-up

The bounded pipeline repeatedly enqueues the same top three current USGS revisions.
Durable job identity prevents extra jobs, but `enqueueInvestigation` performs a
five-statement write batch every time. Its job priority upsert and equal-job head
upsert change rows even when priority and identity are unchanged.

After all three jobs completed, a repeat sweep at 360/500 fixture records measured
30 SQL statements, 19 write statements and six changed rows, four R2 reads, no R2
writes and no started job. The single-event fixture measured 14 statements, nine
write statements and two changed rows. These include the empty claim's recovery
and admission work, not only enqueue.

First, the unchanged acquisition shortcut must not schedule this pipeline. Second,
a separate small package can make enqueue priority updates conditional on an
increase, avoid updating an already-equal head, and perform a bounded retained-job
lookup to skip known unchanged candidates while preserving SQL fencing for real
corrections and priority changes. Avoid an isolate-only dedupe that loses work
after restart. Due/retry jobs must remain durable and runnable.

One scheduling tradeoff must be explicit: the current pipeline runs only after a
factual publication, one due job per sweep. If unchanged checks schedule no research,
pending jobs can wait until the next factual change. Separate due-job advancement
from new-input enqueue in a later authenticated, budgeted runner; a heartbeat
cannot claim that research ran. Do not quietly re-enable expensive sweep/enqueue
work on every unchanged source check to hide this gap.

## Bounded implementation and acceptance

1. Release the current package before touching shared collector/publication/history
   files. Agree ownership for the shared digest, operational helper and completion
   proof/API. No migration is required unless completion proof is deliberately
   stored as a new durable receipt instead of derived from existing tables.
2. Implement the hosted-only selector and exact CAS boundary. Preserve the existing
   local/external heartbeat contract, full publication repair and error outcomes.
3. Prove through actual migrations/adapters that the second identical collection
   updates operational status but adds zero history observations, world captures,
   factual revisions, analysis artifacts, collection notifications or research tasks.
4. Prove a source correction, membership expiry, GDELT coverage-only generation change
   and EONET fallback-mode change take the full path. Verify stored history reads
   retain the original evidence dates after a heartbeat.
5. Inject a same-facts/different-coverage concurrent promotion, failed world receipt
   and failed collection notification. No shortcut may erase a change, strand repair
   or claim a fresh capture. Check exact trigger/CLI operational acknowledgments.
6. Measure fixture operation counts again. Deploy only after these few contract
   checks; parent owns account/env/secret/schedule/deployment operations.

Further byte reduction should be a separate reviewed package: immutable prepared
content plus a genuinely small operational pointer, integrity checks and a recovery
contract. It could eliminate rewriting hundreds of KB on unchanged checks, but
changing public read assembly, source expiry and pointer migration at the same time
would enlarge this first correctness-sensitive change unnecessarily.

## Implemented package, awaiting parent deployment

The hosted selector, shared factual encoding, operational validator and one-query
completion proof are implemented. Focused actual-adapter/migration fixtures prove
the warm unchanged collector uses **one SQL read, zero SQL writes, two non-provider
R2 reads and one prepared pointer write**. Original source dates, history/world
captures and notification revision remain unchanged. Missing completion replays
the original capture; the related world watermark repair preserves the first
publication receipt or restores a missing receipt's exact publication clock so
the world reader remains usable. Conflicting/invalid/unavailable proof fails
explicitly; same-facts coverage races reject the obsolete operational CAS.

Research now has a durable bounded-admission receipt, generated migration
`0006_investigation_admission.sql`. It joins the current USGS source capture,
snapshot and fixed ranking policy to one indexed receipt. Warm admission skips
world-body reads and all candidate enqueues. Missing admission after a process
loss replays at most three current candidates, reusing existing jobs through a
read-only lookup; only then does a transaction mark the exact current source
publication. Capture identity distinguishes A-to-B-to-A. A crash after the first
corrected enqueue, followed by a new isolate's compact wake, is covered by a
meaningful fixture. A changed input overlapping research receives one bounded
metadata-only coalesced admission pass; later losses remain recoverable from D1.

An idle due check is a read-only gate before the existing SQL claim/fence. Combined
warm admission plus idle due advancement uses **two SQL reads, no SQL writes and
no R2 reads/writes**. Thus the warm unchanged collector plus idle research costs
three SQL reads and one R2 write, compared with the measured former 44 SQL
statements / 26 write statements and nine R2 writes. Cold schema validation,
real due jobs, first admission, completion repair and provider operations add
their actual bounded work; none are presented as zero-cost.

The approved `enqueueCandidates:false` server-owned mode means “advance due work
without repeating completed admission”; it still repairs a missing durable
admission after restart. Public/external heartbeat and visitor reads do not start
research. GDELT's reviewed retry-only `catchup` object is operational; successful
batch receipts/integrity and sample gaps remain part of the source semantic
boundary. No account, source, runtime environment or deployment changes were
made by this implementation agent.

Release boundary: the compact source envelope remains 32 KiB. A valid maximum
96-batch GDELT ledger with archive integrity/strong provider ETags can exceed it;
the hosted selector now takes the bounded full path before operational mutation
instead of failing that collection. A real validated GKG snapshot plus the other
three actual adapters exercises this case. The low warm operation counts above
apply to eligible compact envelopes, not to these full fallback publications.
