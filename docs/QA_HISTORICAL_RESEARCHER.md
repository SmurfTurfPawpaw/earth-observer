# Historical researcher: public API journey

Observed on 2026-10-12 against https://giovannicallebaut.com/earth/. Root identified the deployed frontend as v29; this journey directly observed backend edition `archive:114`. This is an actual synthetic, read-only HTTP journey, not a browser rendering test or a claim about real visitors.

## Method and bounds

Exactly 15 requests to the platform's stored-only scene/detail routes, using no cookies, credentials, provider requests, collection wakes, analytics, or writes. Redirects were disabled. Each request had a 15-second deadline and a 1,048,576-byte read limit. Request headers identified `EarthObserver-Synthetic-QA/1.0` and `X-Earth-Test: 1`.

The first request started at 2026-10-12T00:13:27.477Z; the last started at 00:16:06.108Z. Responses totaled 1,216,605 bytes; the largest was 229,193 bytes. The sum of individual network/request durations was 14,779.74 ms, with a maximum of 1,183.51 ms. These durations include network and response reading, not rendering, GPU smoothness, or end-to-end human task time.

All scene requests used scope `usgs-catalog-m4.5-v1` and window `7d`. Subsequent pages retained the original query and only added the prior returned cursor.

## Request record

| # | Request start UTC | Operation | HTTP | Duration ms | Bytes |
| --- | --- | --- | --- | ---: | ---: |
| 1 | 00:13:27.477Z | Scene metadata | 200 | 1,183.51 | 1,235 |
| 2 | 00:14:25.425Z | 2024-11-01 00:00 UTC, page 1 | 200 | 932.01 | 228,966 |
| 3 | 00:14:26.357Z | Same 2024 scene, page 2 | 200 | 1,156.25 | 10,618 |
| 4 | 00:14:27.513Z | 2025-10-08 00:00 UTC, page 1 | 200 | 1,038.67 | 229,193 |
| 5 | 00:14:28.552Z | Same 2025 scene, page 2 | 200 | 1,052.46 | 192,563 |
| 6 | 00:14:29.605Z | 2026-09-15 00:00 UTC, page 1 | 200 | 944.11 | 228,927 |
| 7 | 00:14:30.549Z | Same 2026 scene, page 2 | 200 | 844.47 | 51,487 |
| 8 | 00:15:59.358Z | Selected 2025 event, exact revision | 200 | 1,096.93 | 6,080 |
| 9 | 00:16:00.455Z | 2025 scene, Known then | 200 | 859.09 | 1,582 |
| 10 | 00:16:01.314Z | 2025 reconstruction, 7-day point buffer, page 1 | 200 | 1,112.09 | 60,111 |
| 11 | 00:16:02.426Z | Same point buffer, page 2 | 200 | 809.12 | 60,186 |
| 12 | 00:16:03.235Z | Same point buffer, page 3 | 200 | 1,038.90 | 59,850 |
| 13 | 00:16:04.274Z | Same point buffer, page 4 | 200 | 791.68 | 59,897 |
| 14 | 00:16:05.066Z | Current UTC scene, limit 10 | 200 | 1,040.82 | 24,619 |
| 15 | 00:16:06.108Z | Same selected event, deliberately wrong revision | 409 | 879.63 | 1,291 |

Routes were `/earth/api/world/scene` and `/earth/api/world/scene/events/<raw eventId>`. Metadata used `?scope=usgs-catalog-m4.5-v1&metadata=1`; ordinary scenes used canonical UTC `at`, `window=7d`, and `limit=100`. Known then added `knownMode=scene`; the buffer added `points=1&span=7d`. No provider URL was fetched.

## Observed scene and evidence behavior

Metadata advertised one complete, count-matched origin interval from **2024-10-12T00:00:00.000Z through 2026-10-11T00:00:00.000Z**, with no gaps in that interval. This scope covers retained USGS catalog earthquakes of magnitude 4.5 or greater. The response correctly qualifies coverage as completed catalog intervals, not proof that every physical earthquake was detected.

| Selected UTC | Unique events after all pages | Earliest returned origin | Latest returned origin | Requested origin-window coverage |
| --- | ---: | --- | --- | --- |
| 2024-11-01T00:00:00.000Z | 104 | 2024-10-25T00:00:32.139Z | 2024-10-31T22:24:42.056Z | Complete |
| 2025-10-08T00:00:00.000Z | 184 | 2025-10-01T02:13:02.628Z | 2025-10-07T23:52:12.499Z | Complete |
| 2026-09-15T00:00:00.000Z | 122 | 2026-09-08T00:52:01.884Z | 2026-09-14T23:52:47.098Z | Complete |

Each scene completed in two pages, with zero duplicate event IDs and matching aggregate eligible counts. Backend interval bounds included exact entry/expiry changes: the 2025 scene's next change was 2025-10-08T00:54:08.307Z. We did not advance a browser clock in this journey.

The selected event was `event:usgs:42d7a3f08426f7b7c4d79dad5f9ac6e1eaed15f42493e5909f0dd2b35a5a5502`, provider record `usgs:us6000rivu`: source-reported M4.7, 49 km south of Ialibu, Papua New Guinea. The exact-revision detail request matched its identity, revision, snapshot, origin, location, magnitude, and reviewed status.

Its distinct clocks were preserved:

- Event origin: **2025-10-01T02:13:02.628Z**.
- Provider scientific revision: **2025-12-19T22:50:26.040Z**.
- Source retrieval/first capture: **2026-10-11T22:38:50.870Z**.
- First stored item knowledge: **2026-10-11T23:03:50.385Z**.
- Archive receipt publication: **2026-10-11T23:03:50.435Z**.
- Source publication date: absent, rather than invented.

Revision: `886fdf4fe0465ba2ea3d9bac7645ffb708590e0e1bc37a316a0143fc42c14059`.

Snapshot: `583eae5f978d07f794a82b58cdf5e910e29baa4ed1c4eb9a8e1cdc68329853af`.

Source citation: https://earthquake.usgs.gov/earthquakes/eventpage/us6000rivu. It was returned as a citation; this journey did not request it or independently inspect the raw source bytes. The backend detail route's retained-evidence verification succeeded.

The December 2025 revision appears in the October 2025 **Reconstruction** view, correctly illustrating reconstruction with later retained corrections. With `knownMode=scene`, the same October 2025 scene returned no events, `version=archive:0`, `currentVersion=archive:114`, and a whole-window `unavailable-at-cutoff` gap. This means the **platform had not yet retained the evidence**, not that USGS or the world knew of no earthquakes then.

A detail request with a deliberately mismatched 64-zero revision returned HTTP 409, `errorCode=revision-changed`, the actual selected revision, and no event. It did not attach a different factual projection to the selected marker.

The buffered acquisition covered point origins from October 1 through October 15, with reusable scene time [October 8, October 15). Four bounded pages returned **400 of 413** eligible unique points and still had a cursor. We deliberately stopped at the request budget; this buffer was **not fully acquired**. Local origin filtering at the buffer start yielded 184 eligible points and included the selected exact revision, matching the instant scene's count. This is not proof of full-set equality, complete caching, playback, or rendered performance.

## Concrete gaps and priorities

1. **Archive freshness needs unattended maintenance.** At 2026-10-12T00:16:05.066Z, the scene reported a `not-imported` gap from **2026-10-11T00:00:00.001Z through the selected current UTC**, about 24 hours 16 minutes. Older events remained available. This is an archive coverage gap; this journey did not test the separate Live feed.
2. **Pagination flags are easy to misread.** Final cursorless pages still returned `complete=false`, `truncated=true`, and `counts.omitted=100`, because these describe one page against the total eligible membership. The frontend correctly aggregates unique events against `eligible`. A clearer future contract should distinguish page remaining items, scene membership completion, and source coverage completion.
3. **Known then needs a precise short label.** The actual cutoff is hosted platform receipt publication. “Platform knew then” or an equivalent explanation avoids suggesting universal historical knowledge.
4. **Point buffering materially reduces payload per request, but acquisition remains visible work.** Approximately 60 KB point pages compared with 229 KB full-event pages support the current minimal-marker/lazy-detail design. We did not complete the buffer or measure browser frame performance.
5. **Current metadata cannot report maintenance job state.** `pending=[]` and `failed=[]` are presently fixed absent-job fields; they should not imply a healthy unattended scheduler.

## Proposed next package: fixed-scope archive maintenance

This proposal is not deployed or runtime-enabled. No additional provider requests were made for it.

Reuse the existing count/query validation, unsliced original GeoJSON, deterministic archive candidate, exact receipt readback, raw retention, revision selection, and atomic publication. Extract one portable acquisition contract so the Node CLI and hosted maintenance delegate to the same implementation; do not create a competing importer.

Add a durable scope-owned frontier and work queue. A signed owner collector wake checks database due time, claims a database-clock lease and increasing fence, and processes at most one bounded interval per wake. Freeze its exact closed interval and candidate identity before publication. Dense intervals split into persistent children with the existing inclusive endpoint overlap; the frontier advances only through contiguous verified child receipts. A quiet interval requires a genuine original empty GeoJSON response whose count equals zero; an empty body or changing count remains a gap and retry. Source origin, retrieval, and database publication retain their separate meanings.

Keep the immutable interval receipts, but materialize their **first coverage proof by UTC day** for calendar delivery. A day holds disjoint first-proof pieces carrying exact receipt publication time and chunk identity; overlap or later rechecks do not create duplicate first-proof pieces. Once their union covers the whole UTC day, record the exact full-day-known-at boundary. Reconstruction reads completed daily rows cheaply; a knowledge cutoff before day completion uses only first-proof pieces admitted at that cutoff. Partial days and truthful gaps remain expressible. This avoids scanning an ever-growing receipt journal or incorrectly collapsing all knowledge into a later daily snapshot.

The publisher must gate the initial receipt against the maintenance fence/lease and affected daily materialization generations; its receipt, coverage, archive heads, daily materialization, and frontier completion must commit together. Existing exact receipts may be acknowledged under a fresh owned fence without rewriting their original knowledge clocks. Conflicting day writers re-read once rather than overwrite materialization. A receipt or raw object alone never advances coverage/frontier by assumption.

Public reconstruction metadata should read a bounded daily calendar (the current roughly two-year scope fits within 736 day rows), and exact 7/14-day scenes should read only their intersecting day proofs. Keep explicit row/byte caps and truthful incomplete delivery if a cutoff requires too many partial pieces. Later expansion beyond this scope needs calendar paging rather than an unbounded receipt scan.

Suggested initial policy for review: a ten-minute due check, a conservative closed upper boundary five minutes before the wake, bounded catch-up, and a separate recent overlap recheck. Those are collection policy choices, not guaranteed provider delivery times. Overlap can discover later qualifying revisions; it must not infer withdrawals or certify every old correction. Below-threshold corrections to previously retained events require the existing explicit correction path, not absence in an interval.

New schema/module work stays staged until root approves the exact interface. Existing runtime files, generated migrations, Live pointers, and browser behavior remain unchanged during this design step.

### Meaningful acceptance checks for the staged package

- Concurrent due wakes admit one owner; an expired/stolen fence cannot publish or advance the frontier.
- A frozen candidate can resume after timeout only after exact receipt readback, preserving original bytes and all clocks.
- A genuinely empty count-matched original response certifies its interval; empty body, count drift, HTTP failure, and truncation do not.
- Inclusive split seams neither invent coverage nor lose source IDs.
- Daily proof reconstruction matches the immutable receipt union, including a cutoff before partial-day completion and the exact completion boundary.
- More than 2,048 interval receipts remain deliverable through bounded day materialization; exceeding the day/proof budget fails truthfully.
- Publication and cursor completion are atomic; no public read starts acquisition and no maintenance publication replaces Live source pointers.
