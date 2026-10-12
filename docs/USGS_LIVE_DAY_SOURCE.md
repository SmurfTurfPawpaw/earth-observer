# Central USGS day observations

This independently gated plugin retains the original fixed USGS `all_day.geojson`
response and its M2.5+ qualifying seismic observations. It is separate from the
existing `usgs` M4.5+ week collector, world journal and M4.5 catalog archive.
Those source identities, memberships and history scopes remain unchanged.

Plugin and scope: `usgs-live-day-m2-5-v1`. Kind: `observation-feed`. One typed
`rolling-observation-feed` item owns each complete cohort; its revision is the
qualifying factual digest. This is neither an original publication nor a
statistical dataset. Event IDs, reported type, status, update time, coordinates,
magnitude and original event URL are retained when supplied. A quarry blast or
unknown type is not reclassified as an earthquake. A cohort receipt is not an
individual event's first-known clock.

The fixed source is
`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson`.
Only owner-authenticated collector wakes can run it. The runner requires
`EARTH_USGS_LIVE_DAY_ENABLED=1`; otherwise it does not read/write that source's
state or contact its provider. The minute source is first in the existing
two-source queue. The shared 27-second wake budget remains unchanged. Other due
sources can be deferred by that budget; successful minute acquisition is not a
guarantee of fairness for slow institutional sources.

## Bounds and publication

- Source response: 512 KiB streamed, 15-second acquisition deadline.
- At most 2,000 source features and 500 qualifying records; facts at most 128 KiB.
- Small overview: 8 KiB; public delivery: 160 KiB and 15 seconds.
- Complete source metadata count must match the original feature array.
- Malformed qualifying geometry/depth/time, duplicate/missing IDs, foreign
  source URLs and scope/budget violations fail closed. No silent truncation.

Original byte SHA is independent from the qualifying factual SHA. Metadata
generation, irrelevant below-threshold changes and a valid 304 do not publish a
new factual receipt when qualifying observations are unchanged. The actual last
check and successful checked generation remain operational state. Original
source generation/acquisition, first cohort revision retention and each complete
receipt's database publication clock remain unchanged. An older source generation
cannot regress a later successful check. Different factual reports at an equal
source generation can produce separate traceable receipts; they are not declared
independently verified corrections.

Future source generation, event origin and update clocks are each capped at five
minutes beyond the acquisition clock. The two tolerances do not compound. The
reported origin must also fit the source's rolling day window with that tolerance.

Raw, facts and overview are immutable content-addressed R2 objects. This source
requires successful retained byte-count/SHA readback before complete D1 admission.
The existing lease/fence and atomic receipt-dependent publication batch gate all
visible revisions/membership/heads. Failed or superseded work can leave private
orphan objects but cannot expose a completed edition. Prior complete receipts
survive failed checks, A/B/A changes and new editions. Existing generic plugin
tables suffice; no migration is introduced.

## Stored delivery and clocks

`GET /earth/api/layers/earthquakes` returns the exact fixed source scope, complete
receipt/version, overview and bounded normalized `records`. It never collects,
enables, queues, writes or accepts a provider URL. Current reads expose separate
`factualEditionAgeMs`, `retainedSourceGenerationAgeMs`, current validated
`sourceGenerationAgeMs` and `check.sourceGeneratedAt`. An unchanged fresh check
does not make an old factual edition falsely stale; a failed check still marks
retained data stale. Missing/corrupt storage is unavailable, never a substitute
empty source response.

Optional canonical `knownAt` chooses a complete platform receipt at that cutoff.
Later check state/ages are omitted. This is the retained rolling feed membership
as known to this platform, not event-time reconstruction or a two-year M2.5+
backfill. Current reads and their edition recheck join the indexed current receipt
pointer to the exact completed capture. Cutoff reads use the indexed capture history.
Both use bounded immutable facts/overview reads and at most one whole-edition retry.
Observation-only `receipt.fence` identifies the completed factual publication;
operational lease/check advancement cannot fabricate a newer factual fence.

The existing shared SSE connection announces only the latest completed head with
fixed plugin/scope, receipt ID, capture fence, factual digest and publication time.
It may coalesce intermediate revisions. Stored receipts remain the history; SSE is
not an every-edition delivery queue. Generated-only/304 checks remain quiet.

## Activation and operating limits

Release backend first; enable the source through an owner environment revision;
prove a complete receipt and at least two unattended due checks independently of
visitors. Only then publish a separately reviewed client fetch cutover and its
mounted `/earth/` routing/cache invalidation. Backend-first v38 is deployed and its
first receipt plus two unattended due checks passed at 02:55–02:57 UTC on October 12.
The separate v39 browser cutover is under review; do not assume it is deployed until
the exact release and actual browser acceptance are recorded.
The current supervised minute bridge ends at 06:39 UTC. The automatic GitHub wake
is being removed in v39 after observed schedule gaps and a product-use terms review;
manual bounded deployment acceptance remains separate. A permanent independent
minute runner still needs provisioning and verification.

One planning read on 2026-10-12 retained no provider body: 140,979 original bytes,
197 source features and 46 qualifying observations, about 14.9 KiB of evidence
facts. This sample fits existing limits but proves neither future dense-day bounds
nor historical completeness. Raw SHA:
`8c6a337710e4bcab7170f1c4976ae8a74c2128007cf5339835122796d1e5679a`.

Deduplication avoids storing generation-only checks and reuses identical factual
objects across reversions. Changed qualifying records still retain their full
original source response: at the measured size, a hypothetical 1,440 changed
receipts/day would retain about 203 MB/day of raw originals alone, before facts,
indexes and overviews. This is a bound illustration, not a measured change rate.
Actual changed-receipt frequency/storage growth and hosted CPU must be measured
before promising inexpensive long-term continuous retention. Node fixture timings
do not establish hosted Worker CPU-quota compliance.
