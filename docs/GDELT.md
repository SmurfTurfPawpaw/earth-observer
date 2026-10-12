# Bounded GDELT acquisition and previous-release recovery

The producer downloads fixed official GDELT GKG ZIPs and publishes a rolling topic-mention sample. It does not copy article text/images or assert original headlines, incident times or event coordinates. Indexed batch time, actual retrieval time and sample generation remain separate; country mentions are not verified incident geography. At most 80 links per topic survive the existing diversity quotas. Missing/omitted entries are not evidence of absence or a full news archive.

## The observed continuity gap

The previous producer aborted before all historical repair work when `lastupdate.txt` advertised a batch more than five minutes ahead of its manifest check, or when an admitted latest ZIP returned HTTP 404. Its gap ledger only enumerates slots between actually processed endpoints. Therefore a retained sample ending at 00:45 cannot discover a newer 01:00 slot by simply rerunning that ledger.

## Narrow recovery

With the existing repair flag enabled, only a typed `manifest-batch-future` rejection after fixed-source/size/calendar validation, or a latest ZIP HTTP 404 with **no Retry-After header**, permits a previous-release probe. Zero, past-date and unparseable Retry-After header values still block this new recovery path. This stricter admission is specific to the new path; the legacy older-gap repair loop continues its prior effective-future-backoff policy.

The probe uses the previous quarter of the validated advertised batch, capped at the newest quarter at least five minutes behind the frozen manifest-check UTC. It must be a canonical quarter-hour within 24 hours, not already processed and not deferred by its existing retry ledger. An advertised 01:15 checked at 01:08 or 01:10 therefore targets 01:00. Neither the future advertisement nor retained 00:45 evidence is renamed or assigned new source/retrieval dates.

Acquisition reuses the existing fixed HTTPS HEAD size/strong ETag/identity checks, matching If-Match GET, exact ZIP filename and TSV batch identities, inflation limits, CRC and SHA-256. It does not reuse the failed manifest's MD5. Historical integrity is `https-head-size-and-zip-crc` with `providerMd5:null`, preserving the actual HEAD ETag. The parser verifies the complete original ZIP bytes; current rolling sample storage retains their digest/provenance, not an indefinite original-ZIP archive.

The previous-release HEAD consumes one of the existing two repair slots, leaving at most one known older-gap repair. Retained/deferred slots issue no HEAD/GET and consume no probe slot. An unsuccessful probe outside real retained endpoints stays a result/CLI diagnostic rather than fabricated coverage; its network work still consumes the cap. Another literal-404/no-Retry-After miss may permit the remaining known older gap. Other fallback failures remain fail-closed. A successful older original can publish its actual topic sample while preserving the latest failure diagnostic and advertised label separately.

The whole wake retains one shared 45-second deadline, at most three ZIPs, 48 MiB compressed bytes, 384 MiB expanded bytes and a 1 MiB result. No nested wake or larger budget is introduced. Provider 429/backoff, 503, malformed/foreign/expired/oversized manifests, corrupt source ZIP/MD5/CRC, invalid HEAD/GET identity, caller cancellation and timeout cannot become permission for a new fallback. The existing latest-503-prevents-all-repairs case remains. If nothing factual succeeds, the prior published asset and all original dates remain unchanged.

## Focused verification and release responsibility

```sh
node --test scripts/gdelt-catchup.test.mjs server/hosted/gdelt-snapshot.test.mjs scripts/local-gdelt-source.test.mjs
```

The final local run passed **36/36** checks in 1.96 seconds. Added fixtures exercise validated future recovery, latest ZIP 404, exact maturity boundary, original bytes/hash/CRC and MD5-null provenance, retained/deferred skip, a failed out-of-window probe consuming its slot, disabled repair, unchanged source clocks, literal Retry-After absence, unchanged legacy older-gap backoff, corrupt/oversized/foreign data, ignored-signal deadline and caller cancellation. The prior focused parser/sample byte and memory gates continue to pass.

These are deterministic local fixtures and no provider, API, GitHub, cloud, browser or deployment action was performed by the implementing agent. The release owner must publish the immutable source revision and observe an actual scheduled run, its explicit recovery diagnostic and the resulting stored batch/retrieval clocks. Code readiness does not prove provider availability or scheduler execution.

## Cadence compatibility followup

The workflow runs at minutes 2, 17, 32 and 47. The provider batch interval is 15 minutes. The schema-2 field `scheduledIntervalMinutes:30` remains unchanged in this package because existing retained snapshots and validators canonically reconstruct it.

Exact compatibility seams:

- `server/hosted/gdelt-gkg.js`: `gkgCoverage` emits the field (lines 82/88); `createGkgSnapshot` rebuilds coverage (128); `validateGkgSnapshot` recomputes and compares canonical coverage (198–199).
- `server/hosted/gdelt-snapshot.js`: the hosted reader recomputes rolling coverage (141).
- `scripts/gdelt-snapshot.mjs`: prior pruning recreates a snapshot through `createGkgSnapshot`; new generation uses the same creator.
- `scripts/local-gdelt-source.test.mjs`: one existing legacy expectation is 30 (75); a minute-driven local acquisition must not be described as a 15-minute schedule.
- `.github/workflows/intelligence-data.yml`: actual 15-minute workflow (5); the source capability ledger already distinguishes provider cadence and checked cadence.

A later narrow compatibility package should accept exactly legacy 30 and new hosted 15, thread the admitted value through creation/pruning/reader aging, preserve previously retained values and clocks, and select 15 explicitly only for newly generated hosted snapshots. The hosted consumer must accept both before the producer emits 15. This package does not silently rewrite historical cadence or claim that schedules are continuous provider emissions.

## Prepared-release freshness and monotonic reader admission

The owner workflow run `38193595256` recovered the actual 01:45 batch plus one older gap and completed at 2026-10-12 01:52:59 UTC. Two bounded read-only checks at 01:56 UTC found the prepared release generated at `01:52:55.172Z` and the public stored intelligence already serving it. The prepared asset returned HTTP 200, 249,301 bytes, ETag `"0x8DF2803895F7589"`, Last-Modified 01:52:56 GMT and Age 37. Its SHA-256 was `a621cbca804d526f076f0be98f345d4835d0a51e97a9e181eeb7e9cfeeaca530`. The stored response kept actual batch retrieval `01:52:54.912Z`, prepared-asset retrieval/check `01:55:35.503Z`, and packet collection `01:55:38.226Z` separate. Observed HTTP request durations were 607 ms and 2,943 ms; these are network timings, not globe rendering measurements.

That observation is compatible with the 60-second release check, collector and CDN delivery path; it does not demonstrate a stuck consumer. The earlier 01:53 check of the old sample cannot establish whether the response was an HTTP 304 or an older HTTP 200 without outbound-response telemetry. A successful conditional revalidation only advances `snapshotCheckedAt`, not the generation, original batch retrieval or `snapshotRetrievedAt`.

A separate deterministic local reproduction did demonstrate an admission defect: after retaining a newer validated generation, an HTTP 200 carrying an older but still valid generation replaced both local and durable state. The reader now validates the network body, then rereads retained state before admission. Older generations and earlier checks of the same generation preserve the newer facts, source ETag, original acquisition and successful-check clocks. A failed response records its actual `lastAttemptAt` and existing bounded backoff/reason; it cannot claim a new successful acquisition. A 304 is tied to its original request generation and validator and cannot restamp a concurrently advanced retained entity.

Production R2 admission uses optional `getVersioned(key)` and `putIfVersion(key,value,version)` adapter primitives. The former returns the decoded value and the **R2 object** ETag, distinct from the upstream release ETag stored inside the value. The latter uses `onlyIf.etagMatches` or, for a missing object, `If-None-Match:*`. Only a confirmed conditional commit promotes the network candidate. A conflict or uncertain/timed-out acknowledgement performs at most one bounded readback; only the exact canonical snapshot representation, upstream ETag and acquisition/check clocks can confirm an uncertain candidate. Otherwise the reader adopts a validated newer retained state and uses the existing failure backoff. It issues no write retry or unconditional R2 fallback. A delayed conditional write cannot replace an object whose R2 version has advanced. Expired/invalid retained metadata can be conditionally replaced by a newly validated release; unavailable versioned storage cannot promote an unconfirmed acquisition.

The [official Cloudflare R2 reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations) admits Headers and R2Conditional for `onlyIf`, distinguishes object `etag` from quoted `httpEtag`, and specifies null/no write when a condition fails. The source and packaged personal-site hosting manifests both declare `r2: "EARTH_STORE"`; no hosting-account inspection was performed for this patch.

The fixed release URL, 1 MiB body cap, 12-second network timeout, 60-second release check, provider provenance validation and existing failure policy remain. Optional storage operations each retain their configured deadline (1 second by default, at most 5 seconds). Admission performs one authoritative read and one conditional write, plus at most one confirmation read after a conflict/uncertain result; this is a storage bound, not an additional provider fetch. Existing provider `get`, `put` and attempt-claim behavior is unchanged.

KV/custom stores without both versioned primitives retain the local and saved-state guard with best-effort persistence. They cannot guarantee atomic cross-isolate admission or prevent a late unconditional put. The R2 guarantee applies to writers using the new conditional path; an older deployed runtime or any unrelated unconditional writer is outside that guarantee. Failure/backoff state is local to the reader; this package adds no persistent failure journal, binding or migration and does not prove scheduler/CDN latency.

Focused verification:

```sh
node --test server/hosted/gdelt-snapshot-reader.test.mjs server/hosted/gdelt-gkg.test.mjs worker/storage.test.mjs
node --experimental-strip-types --test --test-name-pattern='R2 attempt reservations|satellite non-200 pauses' worker/runtime.test.mjs
node --experimental-strip-types --test --test-name-pattern='fixed collector prepares and archives' worker/hosted-collection.test.mjs
```

The reader/GKG/store run passed **39/39** checks in 0.59 seconds; the two selected existing runtime checks and one existing collector-to-R2/D1-to-stored-public-read fixture also passed. The new fixtures cover an older 200 after a newer receipt, retained GKG batch evidence, authoritative reread after a competing reader, the exact CAS read/write race, old 304 responses after a new generation or validator, timed-out late writes, exact readback confirmation, unreadable storage, expired-state replacement, missing-object admission, version fencing and absence of pretend KV atomicity. All are local mocked HTTP/R2 fixtures. One official documentation page was read. No provider acquisition, GitHub or owner action, hosting-account mutation, deployment or browser action was performed for this safeguard.
