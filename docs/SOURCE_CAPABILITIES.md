# Source capabilities and acquisition choices

Baseline reviewed 11 October 2026 against `822d73a`, with a typed-plugin update on
12 October. This is a source and
code audit, not a deployment, freshness, completeness or uptime assertion. The
machine-readable ledger is [source-capabilities.js](../src/core/source-capabilities.js),
schema 1, revision 5. `getSourceCapability(id)` returns a frozen reviewed entry or
`null`; it does not enable an adapter. The existing public-hosting provider policy
governs map/proxy admission; the separate reviewed typed-plugin registry admits
three institutional/data pilots. The ledger activates neither. Actual manifests, outages and retained evidence restrict
the ledger further at query time.

Foundation update, 12 October: the separate USGS archive is now hosted with
completed count-matched M4.5+ coverage from 2024-10-12 to 2026-10-11. Optional GDELT
missed-batch repair is implemented with explicit budget, retries and provenance.
Hosted evidence at **2026-10-11T23:48Z** showed a temporary minute collector check,
newest GKG batch 23:45 and historical 09:15/09:30 repairs retrieved at 23:40; **52**
quarter-hour gaps remained in the retained span. These are dated observations,
not a guarantee of continued source availability or an always-on cloud runtime.
EONET checks are collector-driven; public visitors read stored data.

## Retained intelligence feeds

| Source | Current implementation | Source cadence versus checks | Geography and temporal meaning | History and rights |
| --- | --- | --- | --- | --- |
| USGS | Fixed M4.5+ seven-day summary; at most 100 normalized live records. Separate fixed catalog archive admits independently counted unsliced intervals of at most 500 records | Official summary regenerates every minute; current acquisition policy checks at most once/minute with backoff | Source hypocenter point, origin date and source revision date; no authoritative country code is supplied | Retained snapshots start at actual collection. The isolated archive/import and scene contracts are implemented; completed hosted receipts alone establish actual archive coverage. Current catalog results do not reproduce every past source revision. USGS-produced data are public domain; credit USGS and respect marked third-party content. |
| GDACS | Seven-day EQ/TC/FL/VO/WF/DR query; at most 100 notices | Episodes/notices have no fixed delivery guarantee; checks use a shared minute policy and backoff | Indicative points/countries and modeled impacts; start/end and modification dates differ from publication/capture | API documents historical date ranges; episode completeness is unverified. Integration is supported with GDACS credit; external resources have separate rights. |
| NASA EONET | Seven-day, three-category curated sample; at most 60 references | Curation has no guaranteed incident cadence; collector checks are bounded to once/minute with backoff. A scheduled copy is outage fallback, not fresh evidence | Current adapter excludes coordinates, descriptions and inferred countries. Geometry/end dates can be approximate and older than the query window | API supports date ranges/open/closed status. Our archive retains selected reference metadata only; linked publisher content is not copied. |
| GDELT | Owned bounded metadata release; at most 240 topic/link records | GKG has 15-minute batches; collector revalidates the release at most once/minute. Node release acquisition is separate; workflow runs at minutes 2/17/32/47 and can be delayed | Index/batch date is not original publication or incident time. A mentioned country is context, not an event point | Released datasets allow redistribution with citation/link. Publisher articles/images have separate rights. Latest-first acquisition can repair at most two explicit gaps within its retained 24-hour span; it is not a full archive. |

Primary evidence: [USGS summary cadence](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php),
[USGS catalog API](https://earthquake.usgs.gov/fdsnws/event/1/),
[USGS reuse policy](https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted),
[GDACS API quick start](https://data.gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf),
[GDACS limitations](https://data.gdacs.org/About/termofuse.aspx),
[EONET API](https://eonet.gsfc.nasa.gov/docs/v3),
[EONET purpose and approximate extents](https://eonet.gsfc.nasa.gov/what-is-eonet),
[GDELT batch semantics](https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/),
[GDELT reuse terms](https://gdeltproject.org/about.html).

All four current retained-feed adapters require no provider credential. They do
not follow article, image or EONET reference URLs. A bounded source sample is not a
world event inventory: absence cannot close an event, retract a report or establish
that nothing happened. Countries, publishers, repeated copies and shared keywords
do not establish causality or independent confirmation.

## Typed original-publication and statistical plugins

These are separate compiled plugins with D1 leases/completed receipts and immutable
R2 original bytes, canonical facts and compact artifacts. They do not change the
four-source hazard/discovery packet, enable a map layer or turn a jurisdiction into
an incident point. Source adapters and their storage tests are implemented;
hosted plugin publication/readback and long-running collector availability remain
separate release gates. Public `/api/publications` and dossier reads never acquire.

| Plugin | Fixed scope and actual source evidence | Source cadence versus due checks | History, geography and rights |
| --- | --- | --- | --- |
| `ecb-press-v1` | English institutional `/press/pr/date/` RSS releases only. Native adapter GET on 11 October at 23:40Z returned 5,790 bytes, 15 feed items, two selected institutional originals and a 2,219-byte overview. A prior conditional request returned 304 | Publications are irregular. Conditional source checks are due every five minutes on authenticated collector wakes; no delivery guarantee. RSS build/check clocks do not create publication revisions | Original title, exact GUID/URL and RSS `pubDate` offset/second precision; publication time differs from survey/reference periods. Retained originals remain when the rolling feed drops them. No older publisher backfill or extracted article claims. ECB jurisdiction is publisher context, never an incident coordinate. Accurate credited reuse applies; named-author speeches/interviews/research and images are excluded |
| `eurostat-gas-origins-v1` | `nrg_ti_gas`, Belgium, annual `G3000`, `TJ_GCV`, since 2024. Verified small anonymous JSON-stat query supplied 2024 observations; no invented 2025/2026 values | Annual reference periods and irregular source revisions. Conditional checks are due every six hours; that does not create six-hour measurements. API global updated/structure clocks alone do not revise statistical facts | Preserve source units, partner/codelist labels, periods, values and status flags. Missing/suppressed values remain missing. Derived supported shares use reported TOTAL with formula/policy provenance. Origins can include countries, aggregates and unknowns; they do not prove shipment routes, present supply or causal effects. Source-credit Eurostat and mark derived calculations; individual/third-party exceptions remain applicable |

The shared store records first hosted knowledge at actual completed database
receipts, independently of source publication and annual observation periods.
Changed/reverted facts retain immutable item revisions; unchanged and 304 checks
update only operational state. A historical cutoff excludes later acquisitions.
Known-then delivery has a bounded membership budget and cannot substitute partial
history when that budget is exceeded. These pilots do not supply a complete two-year
publisher knowledge archive, forecasts or independent corroboration.

The third typed plugin, `ec-press-v1`, acquires fixed European Commission RSS
metadata. Its native source proof on 12 October at 00:19:20Z retained 7,100 bytes
and ten publications with exact GUIDs, UTC/raw source dates and document/category
fields. English-route metadata does not prove body language, and the rolling window
can omit releases between checks. Credited EU-owned metadata follows CC BY4.0 with
changes indicated and individual/third-party exceptions; no image/full body is
included. This backend package remains local pending publication/readback.
[Exact scope and source evidence](EC_PRESS_SOURCE.md),
[Commission legal notice](https://commission.europa.eu/legal-notice_en).

Primary evidence: [ECB official feed directory](https://www.ecb.europa.eu/home/html/rss.en.html),
[ECB reuse terms](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html),
[example institutional release and credited-reproduction notice](https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr261007~6447350434.en.html),
[Eurostat fixed dataset](https://ec.europa.eu/eurostat/databrowser/view/nrg_ti_gas/default/table),
[Eurostat Statistics API](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines/api-statistics),
[Eurostat reuse](https://ec.europa.eu/eurostat/about-us/communicating-disseminating-statistics).

Current operational wording still needs a separate compatibility change: EONET's
reusable reader says "active demand" although hosted collection supplies the
demand; GKG schema 2 retains legacy `scheduledIntervalMinutes:30` even though the
workflow has a 15-minute schedule. This field is compatibility metadata, not a
current cadence promise. Replacing it must not rewrite retained factual history.

## Calculated astronomy and timed weather

Astronomy evaluates Cesium Sun/Moon positions and lighting at selected UTC without
fetching an observation. It supports calculated past/future scene time, not event
prediction. Numerical accuracy/range has not been validated here; the visual night
brightness includes a usability floor. Satellite orbits need a separate element
epoch and propagation contract. [Cesium astronomical calculations](https://cesium.com/learn/cesiumjs/ref-doc/Simon1994PlanetaryPositions.html).

The existing nowCOAST adapter uses advertised WMS frames. It is request-driven and
does not independently archive imagery or preserve first-known weather state.
The proxy admits up to 26 recent frames no older than 24 hours and exposes at most
13 in its browser manifest. That is a code bound, not a guaranteed available span.

| Product | Official metadata and semantics | Current advertised frames inspected on 11 October | Limits |
| --- | --- | --- | --- |
| CONUS radar | About 4-minute updates; approximately 1 km, reflectivity in dBZ | 99 frames, 15:04:16–21:36:05 UTC | Contiguous US; missing pixels are not absence of precipitation |
| Lightning density | About 15-minute publication and accumulation; approximately 8 km cells | 17 frames, 17:15–21:15 UTC | Pacific/Americas coverage, not global or individual strikes; NOAA-derived Level 5 only |
| Global longwave IR | Hourly, approximately 3 km; documented 2–3 hour latency | 6 frames, 16:00–21:00 UTC | Thermal cloud/surface patterns, not a cloud-only mask. OSPO nominal ±60° differs from advertised raster extent of about ±72.7°; defer to valid pixels/current capabilities |
| GOES regional longwave IR | 5-minute product, approximately 2 km, Band 14 | 80 frames, 15:03–21:38 UTC | Regional Americas extent, not global |

The table records one capability inspection, not a refreshed feed or a promise of
future availability. Every source advertised `nearestValue=1`; the app must admit
explicit advertised times and reject expired/unknown frames so the server cannot
quietly substitute another date. Holding/crossfading actual images smooths display;
it does not create new radar readings, lightning strikes or cloud observations.

Primary evidence: [radar capabilities](https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows?service=WMS&version=1.3.0&request=GetCapabilities),
[lightning capabilities](https://nowcoast.noaa.gov/geoserver/observations/lightning_detection/ows?service=WMS&version=1.3.0&request=GetCapabilities),
[satellite capabilities](https://nowcoast.noaa.gov/geoserver/observations/satellite/ows?service=WMS&version=1.3.0&request=GetCapabilities),
[GMGSI description](https://www.ospo.noaa.gov/products/imagery/gmgsi/),
[nowCOAST integration](https://nauticalcharts.noaa.gov/learn/nowcoast.html),
[NOAA reuse/disclaimer](https://oceanservice.noaa.gov/disclaimer.html).
The lightning capabilities explicitly permit public distribution of the derived
Level 5 density; this does not grant access to raw contractor detections.

## Acquisition strategy and expansion gates

Prefer fixed official APIs, source RSS and permitted bulk archives before generic
web extraction. Conditional requests and immutable evidence identities avoid
downloading or reanalyzing unchanged content. Track a persistent watermark, bounded
catch-up queue and actual gap intervals; do not change timestamps to hide missed
data. Archive backfill stores its present capture/first-hosted-knowledge dates even
when the event date is old. Keep retrospective reconstruction separate from evidence
that was available at the historical time.

| Candidate | Useful contribution | Verified route/constraints | Current status |
| --- | --- | --- | --- |
| USGS/GDACS archives | Scientific and modeled disaster history | Fixed official date-range endpoints; bounded pagination, revision semantics and source limits need an adapter | USGS M4.5+ count-matched archive implemented and hosted 2024-10-12 to 2026-10-11; GDACS archive remains a proposal |
| GDELT archives | Discovery/index coverage and media context | Official bulk files/codebooks; checkpointed Node ingestion before compact hosted publication. No automatic right to republish publisher content | Latest-first repair of at most two explicit missed batches/run in a retained 24-hour span is implemented and a dated hosted repair was observed; 52 gaps remained at the cited check, no two-year discovery archive |
| ReliefWeb | Humanitarian situation reports, disasters and dated source links | Free read-only API; pre-approved `appname` required since November 2025; 1,000 calls/day and 1,000 results/call. Partner report copyright remains separate | Approval/account eligibility unverified; no adapter |
| Eurostat | Trade, prices, housing and regional indicators for mechanism investigations | Public statistical API and source-credited reuse; individual notices/third-party exceptions apply. Preserve units, periods, revisions and dataset geography | The bounded Belgium gas-origins plugin is implemented; other datasets remain proposals. Annual series are not breaking-event pins |
| Wikidata | Stable place/organization/asset identifiers and attributed relations | Structured data CC0; API/bulk access available. Check each referenced statement and qualifiers; linked text/images are separate | No adapter; not a source of verified real-time event truth |

Primary evidence: [GDELT data access](https://gdeltproject.org/data.html),
[ReliefWeb access, quotas and rights](https://apidoc.reliefweb.int/),
[Eurostat API](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-introduction),
[Eurostat reuse](https://ec.europa.eu/eurostat/help/copyright-notice),
[Wikidata access and CC0](https://www.wikidata.org/wiki/Help:Data_access).

X has a paid API/filtered stream; do not assume unrestricted free crawling.
Reddit needs approved OAuth access and deletion compliance; the intended AI use
requires its own approval review. Ground News has no public API verified in this
audit and its aggregation/competitive reuse is restricted. These remain optional,
disabled adapters pending authorized access, rights and an explicit budget.
[X pricing](https://docs.x.com/x-api/getting-started/pricing),
[Reddit API rules](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki),
[Ground News terms](https://about.ground.news/terms-and-conditions).

Firecrawl, Tavily, Exa and Parallel Search are discoverable plugins but were
uninstalled/unconnected at inspection. Native web search is available for this
research session; neither it nor a search plugin provisions autonomous crawling or
licenses the returned publisher content. Before choosing one, measure the smallest
permitted extraction task, verify account allowance and store only allowed content.
No plugin or account was connected in this audit.
