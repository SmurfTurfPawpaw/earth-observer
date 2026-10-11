# Bounded GDELT GKG acquisition repair

Implemented in the Node producer; rollout is disabled by default. This repairs
known missing update files in a rolling discovery sample. It does not establish a
complete news archive, verified incidents, original headlines or independent
corroboration. The browser and hosted Worker continue reading the prepared sample.

## Acquisition order and limits

1. Validate/prune the last-good checkpoint without renewing its dates. A retained
   HTTP 429 retry checkpoint suppresses all further GDELT requests until its retry
   date; this pause does not claim a new provider check.
2. Read the fixed official `lastupdate.txt`. If the latest batch has not been
   retained, acquire and validate it first. A failure here preserves the entire
   previous published asset and performs no repairs.
3. Derive quarter-hour holes only between the earliest and latest retained
   processed batches, inside the rolling 24-hour limit. Do not invent coverage
   before this producer's retained starting point.
4. Attempt at most two oldest eligible holes. Skip persisted per-slot backoff.
   Every archive acquisition and parse finishes before the next starts. A failed
   historical request stays missing; successful latest/repair files remain usable.

The shared invocation deadline is at most 45 seconds. There are at most three
archives, each at most 16 MiB compressed / 128 MiB expanded, hence at most 48 MiB
compressed and 384 MiB expanded across the invocation. The existing limits remain
50,000 rows/file, 512 KiB/row and 10,000 candidate metadata records/file. Inflated
chunks are bounded and the parser checks an absolute acquisition deadline between
chunks/rows, separately from an event-loop abort. Local parsing uses a bounded
worker thread that is terminated on cancellation. No archive is extracted to disk.

At most 80 sampled links/category, 240 overall, reach the release. The serialized
asset must fit 1 MiB; oversize validation fails before any file/release replacement.
The focused stress fixture with 240 long URL/country records and 94 missing-slot
retry checkpoints measured **745,045 bytes**. This is a tested fixture size, not a
guarantee for every permitted URL combination; extreme larger payloads are rejected.

## Historical integrity, with honest provenance

Current `lastupdate.txt` supplies size and MD5; the parser validates both and ZIP
entry name, structure, CRC and complete compressed/expanded consumption. The
historical path uses only the fixed official HTTPS URL for a valid quarter-hour:
`https://data.gdeltproject.org/gdeltv2/<batch>.gkg.csv.zip`.

A historical HEAD must expose a positive bounded Content-Length and a bounded
strong quoted ETag, with identity/no Content-Encoding. GET uses `If-Match`, disallows
redirects, requires the same ETag and Content-Length/identity encoding, and checks
the actual body size. The strict single-entry ZIP/CRC/inflation parser then applies.
Own SHA-256 is retained for both modes. ETag is not interpreted as provider MD5.
HTTPS/header matching and ZIP CRC are not a provider digital signature.

The official master inventory is growing; no whole-master-list fetch or fabricated
inventory row is used. A bounded HEAD-only feasibility check observed HTTP 200,
3,075,305 bytes and strong ETag for `20261011213000.gkg.csv.zip`; it supplied no
Content-MD5. This package has **not** yet passed a real historical ZIP GET/parse
gate. The release owner must perform one bounded real-file proof before enabling it.
[Official batch/archive description](https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/),
[GDELT timestamp rationale](https://blog.gdeltproject.org/a-behind-the-scenes-look-at-how-we-think-about-master-file-formats-and-timestamping/).

## Additive checkpoint contract

Schema 2 accepts the previous metadata unchanged. Repair-enabled successful
`coverage.processedBatches` entries additionally retain:

```js
integrity: {
  mode: 'manifest-md5-and-zip-crc' | 'https-head-size-and-zip-crc',
  sha256, archiveBytes, expandedBytes,
  providerMd5, // original manifest MD5, or null for historical HEAD mode
  providerEtag // actual strong HEAD/If-Match ETag; historical mode only
}
```

Optional `coverage.catchup` contains schemaVersion 1, `checkedAt`, `latestBatch`,
up to two `attemptedBatches` for this invocation, up to 96 failed `attempts`
(`id`, `checkedAt`, `retryAt`, bounded `code` and optional `httpStatus`), derived
`pendingBatches`, `deferredBatches`, `cappedBatches`, and the fixed invocation budget.
Attempts outside current retained gaps are removed. A processed receipt never
appears for a failed request. HTTP 429 pauses the host; other missing files retain
their own retry dates. Retry-After is bounded to 24 hours, with a five-minute retry
floor. Capped means a known pending slot was outside this run's attempt budget;
it does not mean absence of reporting or permanent completion.

`catchup` is operational metadata. It does **not** assert source facts or renew
their generation/retrieval times. Retry-only checkpoint writes return
`factualChanged:false`, preserve `generatedAt`, all processed `retrievedAt` and
sampled records. A newly retained archive adds factual acquisition coverage even
when its rows produce no additional sampled link. Successful acquisition coverage,
integrity and existing sample gaps participate in source semantics; the entire
catch-up attempt/clock object is excluded from factual and inference digests.

The hosted/local reader exposes this object only as `source.state.catchup`.
It adds no top-level packet or index-coverage-scope fields. GDELT batch/indexing,
actual retrieval, derived snapshot generation, operational check and hosted
publication times stay separate. No publication or incident time is inferred.

## Rollout and local use

The workflow schedule remains `2,17,32,47 * * * *`. The existing schema's legacy
`scheduledIntervalMinutes:30` remains solely for compatibility, not as an accurate
runtime/source cadence declaration. Existing `sourceCadenceMs:900000` and check
intervals describe those separate clocks.

1. Release the hosted validator/reader and operational semantic classifier first.
   Existing old consumers reject the new optional fields, so enabling the producer
   before that release/readback is unsafe.
2. Perform the real bounded historical-file proof and confirm stored source readback.
3. Enable repository variable `INTELLIGENCE_GKG_REPAIR_ENABLED=1`. Empty/other values
   leave the producer on its exact previous latest-only output contract.
4. For a reviewed local runtime, pass `repairEnabled:true` to
   `createLocalGdeltSource` (default false). It persists the validated snapshot and
   existing admission/backoff state in the owned cache directory; restart cannot
   silently forget pending-slot retry dates. Wiring that option into the broader
   local pipeline remains a separate release-owner decision.

Disabling the flag prevents new repair acquisitions; it does not erase already
retained integrity provenance. An application rollback must still consume the
existing published additive schema, or restore a known compatible release asset.

Focused check command:

```sh
node --test scripts/gdelt-catchup.test.mjs server/hosted/gdelt-gkg.test.mjs server/hosted/gdelt-snapshot.test.mjs scripts/local-gdelt-source.test.mjs
```

35 checks passed: fixed URL/header/integrity rules, latest-first and finite repair,
failure preservation, CRC corruption, restarts, clock-only updates, provider
backoff, bounded ignored-signal transport, parser deadline, byte limit and legacy
reader/local compatibility. No provider bulk acquisition, commits or deployment
were performed by this package's implementation agent.
