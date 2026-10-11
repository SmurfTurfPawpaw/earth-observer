# NASA EONET discovery references

Reviewed on 2026-10-11. The reader now acquires the fixed NASA metadata endpoint
directly while discovery is active, rather than waiting for a GitHub schedule.
The separately published scheduled artifact remains a bounded outage fallback.
The direct-reader revision has synthetic contract checks; its implementation
does not establish production deployment or an exact real-time incident stream.

## Scope and source review

NASA EONET is a curated natural-event metadata service whose documented purpose
includes application visualization. Version 3 is the current stable API;
requests use documented category, status, day and event-limit parameters.
[EONET overview](https://eonet.gsfc.nasa.gov/),
[v3 documentation](https://eonet.gsfc.nasa.gov/docs/v3).

This integration retains selected factual reference fields and links. It never
follows linked publisher pages or acquires article bodies, descriptions,
attachments, images, magnitudes or map layers. The NASA license guidance
distinguishes mission data from other data with original-source rights. We do
not apply a blanket CC0 license to EONET's linked publishers. Application
display includes `NASA EONET` and the retained source IDs/links; this is our
attribution policy, rather than prescribed wording from NASA.
[NASA data-license guidance](https://science.data.nasa.gov/about/license).

EONET is for visualization and general information. Spatial and temporal
extents can be approximate, rather than authoritative incident boundaries or
times. Curation is selective and can reference an existing source such as
GDACS; a second feed link is not independent confirmation. Preserve the
qualification in each record and source status.
[EONET limitations](https://eonet.gsfc.nasa.gov/what-is-eonet),
[curation criteria](https://eonet.gsfc.nasa.gov/event-curation).

No numeric quota or required refresh/retention interval was established by this
review. The following acquisition and expiry limits are application policy.

## Active direct acquisition

The opened disaster/all-topics discovery path checks the same fixed
`EONET_QUERY_URL` directly on the server. Local visitor queries and coordinates
never enter that request. Concurrent callers share one acquisition in an
instance, with a minimum 60 seconds between source attempts. Where the host
supplies the atomic R2 `claim` implementation, an independently bounded
60-second lease also suppresses source fanout across instances. A denied,
failed or timed-out lease performs no source request: it rechecks normalized
storage or returns an honest busy/retained-data state. The KV compatibility
claim is not atomic, and an unconfigured store cannot establish cross-instance
coalescing. These are deployment limits, rather than a claim that every visitor
always hits one global process.

The request uses `credentials: omit`, `cache: no-store`, a fixed identifying
User-Agent, redirect rejection, the 12-second reader deadline and a 2 MiB
decoded body limit. The observed JSON/RSS-header compatibility described below
still requires bounded JSON parsing and the complete metadata schema. Only the
normalized result, capped at 100 KiB, may be persisted. No raw private upstream
response or linked publisher page is stored.

An actual successful complete source acquisition records its completion as
`retrievedAt`, even if the factual generation hash is unchanged. Geometry and
closed dates do not change unless NASA supplies new dates. This is a fresh
metadata acquisition, not evidence that a particular incident was just
observed. No conditional requests are made; an unexpected 304 does not invent
a new retrieval date.

Live failures use increasing backoff from one minute up to one hour, honoring
Retry-After up to 24 hours. The bounded `eonet:live-policy` persistence retains
attempt/retry clocks without visitor records; valid restoration can suppress
a new instance while that policy remains available. Lease expiry, storage
eviction/outage and the non-atomic KV path limit this protection. Successful
source acquisition resets live failures. An existing usable normalized copy
remains dated and explicitly stale during an outage.

If no usable last-good copy exists after a direct failure, the reader may fetch
only the owned `eonet.snapshot.json` release. Fallback attempts are bounded
separately to at most once per 30 minutes per instance, with Retry-After
suppression. Its original NASA retrieval remains unchanged; acquiring that
copy never resets live provider backoff or turns it into a live check. Once a
usable copy exists, an outage does not download the release per visitor.

The direct path removes the scheduled-job wait. NASA's selective curation and
source availability still determine what metadata exists; 60-second active
checking is not a push protocol, a guarantee of second-by-second reporting,
or independent confirmation of linked reports.

## Fixed scheduled fallback acquisition

`scripts/eonet-snapshot.mjs` performs at most one request per acquisition run:

```text
https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires,severeStorms,volcanoes&status=all&days=7&limit=60
```

The scheduled workflow runs at minutes 7 and 37, at most 48 scheduled
opportunities per day. Manual dispatches are additional opportunities. A
15-second deadline, 2 MiB decoded response limit, reviewed media-type check and
redirect rejection bound that single request. Visitor text, country filters
and arbitrary URLs never change the acquisition URL.

The fixed endpoint has an observed content-type inconsistency. A single local
diagnostic completed at **2026-10-11T11:53:15.734Z** with HTTP 200 and
`application/rss+xml; charset=utf-8`, while its 68,901-byte body was valid JSON
and passed the complete normalization contract for 49 events. The generator
therefore accepts exactly `application/json` or `application/rss+xml` media
types for this fixed request, with parameters such as charset allowed. The
latter is header compatibility only: actual RSS XML, HTML and invalid metadata
still fail bounded JSON parsing or schema validation and preserve last-good
bytes. An unrecognized HTTP 200 media type is still rejected. Compact
diagnostics retain status and at most 80 characters of media type, without
logging source bodies or JSON parser excerpts. This is a measured source quirk,
not a claim that EONET documents RSS as its JSON response type.

All returned events must normalize successfully. Invalid fields, unsupported
categories, duplicate IDs, unsafe links, future dates, malformed calendar
dates and size excess reject the generation. Valid `events: []` replaces the
previous sample with an explicitly empty result. More than 60 returned events
is rejected rather than silently truncated. A result with exactly 60 sets
`coverage.atLimit`; fewer events still do not establish complete coverage.

HTTP failure, timeout, malformed data or an oversized normalized result skips
publication and preserves the previous release asset. An acquisition state
file records actual attempt/success timestamps and a retry deadline. The
workflow caches that small state separately from event metadata; Retry-After
and increasing failure backoff suppress scheduled attempts while state is
available. Cache eviction can lose that suppression, so this is not a durable
provider-wide quota system.

The workflow uses the existing `intelligence-data` concurrency group to
serialize release writes with the GDELT workflow. It replaces only
`eonet.snapshot.json` under that release and does not overwrite GDELT assets or
existing release notes. No raw EONET response is persisted or published. In
the actual source check, the response declared `Cache-Control: no-cache,
private`; acquisition uses `cache: no-store`. The published artifact is a
selected metadata index with its own provenance, rather than a transparent
shared HTTP cache of that response.

## Normalized contract

`server/hosted/eonet-snapshot.js` exports `createEonetSnapshot`,
`validateEonetSnapshot` and `createEonetSnapshotReader`. Creation and validation
are asynchronous because they compute/check a portable SHA-256 generation.

The asset has `schemaVersion: 1`, `kind: "curated-event-sample"`, the fixed
source/query URL, original `retrievedAt`, `generatedAt`, generation hash,
coverage and at most 60 records within 100 KiB. The digest covers canonical
factual records, excluding their repeated retrieval date. An unchanged
factual sample can share its generation hash while a new actual retrieval
extends its source expiry. Re-reading an unchanged published asset does not
change its original retrieval or expiry.

Each record uses `sourceId: "eonet"`, `kind: "curated-event"`,
`category: "disasters"` and identity `eonet:<EONET event ID>`. Retained fields
are a compact event title, canonical EONET event API link, reviewed category
IDs/titles, bounded referenced source IDs/links, explicit closed date and
latest supplied geometry date. The latter becomes `sourceGeometryAt`; it does
not become a publication or verified incident timestamp. `publishedAt`,
`observedAt`, `indexedAt` and `publisherCountry` remain null. The record keeps
the date-meaning and visualization limitations as plain text.

Geometry histories can precede the seven-day query interval. The parser reads
supplied dates only to select the latest; it discards coordinates and history.
It does not derive a country from titles, URLs or geometry. Referenced sources
remain attribution links, never acquisition targets or confirmation counts.

## Shared reader and freshness

The reader checks the fixed NASA endpoint directly and uses the fixed owned
release only after a direct failure with no usable copy. Optional persistence
under `eonet:snapshot` stores the normalized last-good snapshot, its acquisition
mode/copy date and bounded acquisition policy. Invalid persisted data is
discarded. A legacy scheduled entry remains a fallback and does not suppress
the first direct check. Fixed release downloads can follow GitHub's delivery
redirects; direct and scheduled NASA acquisitions reject redirects.

The returned interface contains `records`, `indexRecords`, `indexSource` and
`state`. Applicable requests receive the whole bounded candidate generation;
local or legacy API query ranking must operate on that metadata, rather than
change source acquisition. `indexSource.expiresAt` is original retrieval plus
24 hours. `state.retrievedAt` is the actual EONET retrieval;
`state.snapshotRetrievedAt` is when this reader acquired its normalized copy.
`state.mode` distinguishes `live-eonet` from `scheduled-eonet-fallback`, and
`state.lastAttemptAt` is the direct-attempt clock, which can describe a failed
check. These dates must not be displayed interchangeably.

Country filters and categories other than All/Disasters return
`not-applicable` without source acquisition. A filtered not-applicable result
must not replace a previously acquired complete source generation in the
local index. Records have no incident coordinates, so they must not create a
map navigation target or independent-confirmation grouping.

After 60 seconds from direct retrieval, an unchecked retained live sample is
explicitly stale. A scheduled fallback is always labeled stale because the
direct source check failed. Failed acquisitions preserve usable records with
original dates and source status; after exactly 24 hours those records are
unavailable and retired. Failed HTTP bodies are canceled; NASA and fallback
Retry-After clocks are independent. Scheduled delays and provider failures
cannot silently make an old retrieval current.

## Actual bounded source check

One fixed request completed with HTTP 200 on
**2026-10-11T11:30:51.823Z**, without credentials, retries or linked-source
requests. Normalization produced **49 records / 46,367 bytes**: 43 wildfire
references, 6 severe-storm references and no volcano references. Retained
latest geometry dates ranged from 2026-10-04T19:00:00.000Z to
2026-10-11T06:00:00.000Z. These are source geometry dates, not publication or
validated occurrence times.

The normalized local fixture is
`.cache/intelligence-snapshots/eonet.snapshot.json`, generation
`f462ea054ea077d516085b119bc8e5b5808e80b744d93b104a873c9f937a2332`.
This check confirms the endpoint and normalization for that retrieval only.
It does not demonstrate complete world coverage, an absence of volcano events,
an activated schedule, a published release asset, a browser rendering or
production deployment.

Thirty-one focused tests cover field/date meaning, calendar validity including
offset ISO dates, strict provenance and generation checks, size and event
bounds, empty reconciliation, shared acquisition, non-applicable filters,
unchanged-copy freshness, persistent outage/expiry, provider backoff, exact
request count, last-good atomic writes, stalled optional-storage reads/writes
and the observed MIME exception versus rejected XML/HTML; direct 60-second
cadence, independent-reader atomic leases, persisted live retry policy, explicit
busy lease failures and fallback-to-live transitions. These synthetic checks
make no NASA, GitHub release or linked-source requests.
Optional snapshot storage has a one-second default deadline; timed-out or late
restores cannot overwrite a newly acquired release generation:

```sh
node --test server/hosted/eonet-snapshot.test.mjs server/hosted/eonet-snapshot-reader.test.mjs scripts/eonet-snapshot.test.mjs
```
