# Laptop processing before hosted publication

`scripts/local-intelligence-pipeline.mjs` moves the processing stage onto the owner's laptop: fixed-source acquisition → canonical change detection → local derived analysis → authenticated publication. The hosted website reads the resulting prepared data and durable history. This is a runnable processing interface, not evidence that the laptop daemon or hosted publish action is already running unattended.

Production version 24 was deployed on 11 October 2026 at 13:06:50 UTC. One actual laptop cycle published 350 source records and 350 deterministic analysis rows, and the hidden minute daemon subsequently completed two successful unchanged heartbeats. D1 history and R2 prepared reads were verified. Runtime observations are recorded in `.qa/live-v24-collection-evidence.json` and `.qa/collector-runtime.log`; the running process is still a laptop bridge, with no verified restart autostart or always-on cloud trigger.

```js
import { createLocalPipeline } from './scripts/local-intelligence-pipeline.mjs';
const pipeline = createLocalPipeline({
  stateDirectory: '.cache/collector',
  gdeltMode: 'local-gkg',
  publishUrl: 'https://giovannicallebaut.com/earth/api/collector',
  publishCredential: process.env.EARTH_COLLECTION_SECRET,
  // Optional: infer(changedRecords, { signal, inputDigest, createdAt })
});
await pipeline.cycle();
```

`cycle()` serializes acquisition, processing and publication. `flushOutbox()` retries a queued publication without acquiring or inferring again. `status()` returns a structured local summary. The daemon and one-cycle CLI select `gdeltMode: 'local-gkg'`; the factory retains an explicit `owned-release` compatibility default for other callers. Daemon startup must be separately coordinated and checked; changing source files does not restart a running process. A laptop that is asleep, disconnected, shut down or running no daemon cannot supply unattended updates.

## Fixed sources and actual limits

The local pipeline invokes registered USGS, GDACS and NASA EONET adapters through the same reviewed collector. Direct GDELT mode adds one fixed official latest GKG manifest/archive adapter; it neither fetches nor bootstraps the project GitHub release. It does not fetch article pages, arbitrary URLs or photographs. Native hazard cache/backoff is in process; local processing/outbox and direct GDELT acquisition policy survive restart.

`scripts/local-gdelt-source.mjs` checks only `https://data.gdeltproject.org/gdeltv2/lastupdate.txt`, with the manifest restricted to one current official archive. It checks at most once per minute when the serialized collector is running and not paused by publication or provider backoff. A previously processed batch is not downloaded again, including after restart. A newly published source batch is processed and sent in that same cycle; the source's 15-minute publishing interval is distinct from minute checks and is not streaming. Publication timing still depends on upstream release, Internet access, bounded processing and the authenticated sink.

The generator permits at most 16 MiB compressed, 128 MiB inflated, 50,000 rows, 512 KiB per row and 10,000 candidate metadata records. It checks manifest MD5, ZIP CRC/size and one fixed entry without extracting archive paths. CRC/inflation/TSV parsing run in a bounded local Node worker thread; cancellation terminates and joins that thread. The generator composes its 45-second deadline with the daemon's stop/cycle signal. The local daemon's 90-second cycle ceiling allows this acquisition, the default 10-second optional inference and a 15-second publication request without starting overlapping cycles. Neither bulk parsing nor Node imports enter the hosted Worker or browser.

At 96 source batches per day, the compressed cap implies up to 1.5 GiB of downloads and 12 GiB of decompression per day; these are ceilings, not measured traffic. Only the at-most-1-MiB metadata snapshot is retained. Minute unchanged checks download only the small manifest. Actual laptop resource use requires live measurement.

The atomic last-good sample and tiny check/retry state live in `.cache/collector/gdelt/`. Failure preserves the exact last-good sample; retries start at five minutes, double up to one hour, and honor `Retry-After` up to 24 hours. Owner cancellation retains admission without pretending an upstream failure or a successful manifest check. The latest-only manifest cannot recover batches missed while the computer was asleep or offline: rolling coverage retains actual processed batches and explicit gaps, with no historical backfill claim. Sample and record dates are never advanced by an unchanged check. Existing schema-2 `coverage.scheduledIntervalMinutes: 30` remains a legacy compatibility field; actual local checks and source cadence are explicitly reported separately as `refreshIntervalMs` and `sourceCadenceMs`.

The separate GitHub job remains available to owned-release consumers. Its delayed/dropped scheduling limitation does not control the direct laptop GDELT path. Existing NASA EONET outage fallback remains source-specific; it is not used to acquire local GKG.

## New or revised facts only

`factsDigest(records)` is UTF-8 SHA-256 over `JSON.stringify` of `canonicalDiscoveryRecord` values, sorted by ID with ordinal string comparison, each flat record excluding **only `retrievedAt`**. Source observations, indexing dates, modification dates, category/topic fields and original links stay in the facts identity. It is reproducible using WebCrypto in the hosted writer.

An initial record is added, a changed facts hash is revised, and a previously retained ID absent from the current bounded input is withdrawn. **Withdrawn means absent from this retained metadata input**; it does not establish that an incident ended, a claim was retracted or a source was disproved. The pipeline never moves dates or changes the canonical source record to match an interpretation.

Default analysis counts reviewed topics/categories/source associations and emits labels such as `Source: usgs` and `Metadata: hazard-report`. A shared topic or source association is a metadata relation, not independent corroboration. The artifact is separate from source facts:

```js
{
  schemaVersion: 1,
  method: 'deterministic-source-metadata',
  createdAt: packet.collectedAt,
  inputDigest: '64 hexadecimal characters',
  changes: { added: 0, revised: 0, withdrawn: 0 },
  topics: [{ label: 'Source: usgs', count: 1 }],
  analysis: [{ id: 'source record ID', labels: ['Source: usgs'] }]
}
```

The artifact is capped at 64 KiB, with at most 80 topic counters and 500 analysis rows. Long IDs can reduce the retained row count; the digest and change/topic counts cover all admitted input records. No significance, confidence, geopolitical conclusion, verified-event claim or invented location is generated by the deterministic method.

An optional asynchronous `infer` callback receives **only added/revised records**, cloned to prevent mutation of source facts. It may return `[{ id, labels: [...] }]` for those exact IDs. Output is capped and validated; the default deadline is 10 seconds, with an abort signal and configurable maximum of 60 seconds. Timeout, malformed output or oversized output falls back to deterministic metadata analysis. Optional labels remain explicitly derived and unverified. Unchanged records reuse cached labels; withdrawals alone trigger no inference. No model, model download, inference service request or GPU capability is supplied or claimed by this module.

## Local state, compact delivery and retries

The owned `.cache/collector` directory is Git ignored. `facts.json` retains the bounded latest packet and optional labels and is rewritten only when source facts change. Unchanged acquisition/capture clocks live in small `clock.json`; an unchanged successful cycle does not rewrite the complete facts file. Canonical source retrieval dates in the current outgoing packet remain those actually supplied by the collector.

`outbox.json` records a publication before sending it. Atomic temporary-file rename protects each state update. A pending publication is retried before new acquisition, so a failed sink does not cause repeated inference or discard an intermediate changed packet. A restart can recover a crash between queuing publication and committing the facts file. Retry preserves the original capture and analysis dates; HTTP `Retry-After` is honored up to 24 hours, with bounded exponential retry otherwise. Existing pending state is never silently replaced with newer unprocessed data.

After a successfully published facts baseline, unchanged input uses the small private `{ action: 'heartbeat', collectedAt, sources, inputDigest }` body. A server `409` baseline mismatch falls back to one full `{ action: 'publish', packet, analysis }` submission. This reduces recurring wire/disk data while retaining dated source status and history checks. GDELT records keep their distinct original batch retrieval dates; a latest-batch source clock must not be assigned to older retained records. Failed heartbeats may retain their current packet for recovery; ordinary successful unchanged polls avoid storing another full packet.

A newly processed local GKG batch forces a full publication even when the selected fact IDs are unchanged, so the host receives its actual generation and batch/gap coverage. This never triggers repeated inference: analysis changes remain zero when facts are unchanged. Between-batch checks keep compact heartbeats.

If a restart occurs after queuing a compact heartbeat but before retaining its full recovery packet, fallback reconstructs only ready direct-source retrieval clocks and their matching index generation/expiry. Stale direct-source facts retain their actual retrieval/coverage dates. GDELT retrieval and coverage batch dates remain unchanged.

Publication is restricted to the exact owned HTTPS `/earth/api/collector` endpoint, using a private Bearer credential supplied at runtime. Credentials are never written to state or logged. The standalone one-cycle CLI reads `EARTH_COLLECTION_SECRET` or the compatibility `EARTH_COLLECTOR_TOKEN`, and prints only an allowlisted summary. Without a configured credential/publish URL it performs local processing and returns a portable packet; it does not publish.

## Verification boundary

`scripts/local-intelligence-pipeline.test.mjs` and `scripts/local-gdelt-source.test.mjs` use synthetic fixed-source responses to check revision-only inference, immutable source facts, stable digests, no full facts-file rewrite on unchanged polls, compact heartbeats, coverage-only full publication, baseline-mismatch fallback, exact idempotent replay, restart deduplication, persistent retry timing, actual stream/thread cancellation, timeout/cap fallback and fixed-target admission. They make no real provider, hosted writer or model request. Actual laptop daemon startup, production writer support/credential configuration and a successfully published processed packet remain separate checks.
