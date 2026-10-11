# Discovery and observed user journeys

The owner requested this work on 11 October 2026: test the platform with agents
acting as visitors, record their activity and friction, and use aggregated demand
to improve crawling, indexing, loading and intelligence. **Version 22 is deployed**:
application `42cb233566d385ddc8f2c440950138049776f7f0` is included in combined-site
revision `5c080c4bc32979c71d886921f345028eab11e78d`, whose deployment succeeded on
11 October 2026 at 10:13:34 UTC. The release includes the bounded metadata index,
optional aggregate-demand counter, demand-guided GKG sampling and persistent
World Bank annual snapshots. Actual browser checks and their limits are recorded
in local `.qa/discovery-release-verification.json`, `.qa/live-v22-startup.json`
and the [requirement audit](GOAL_AUDIT.md). Inclusion in the artifact is distinct
from exercising every contract in production. No general web crawler has been
implemented; acquisition uses reviewed feeds and one fixed scheduled GKG bulk
batch. Current uncommitted map-quality/CCTV work is outside this v22 evidence.

## Observe actual journeys

Use independent first-visit, mobile, research and returning/offline scenarios.
Run them against one immutable build. Each report must distinguish actual browser
actions, API requests, static inspection and unavailable capabilities. An agent
cannot report that it clicked a control when it only inspected its source.

| Journey | Task | Evidence |
| --- | --- | --- |
| First visit | Find Brussels, establish a 10 km workspace, inspect available layers and understand empty coverage | Action timestamps, current location/radius, rendered map, source status and any confusing control |
| Mobile | Search, change a layer, enlarge text, dismiss panels and navigate at 390 × 844 | Visible focus, readable labels and credits, no primary controls outside the viewport, screenshots |
| Research | Open a hazard, compare original sources and dates, record a private note and export it | Original URLs, explicit observation/publication/retrieval dates, no claim that related links verify a report |
| Returning/offline | Reload a saved view, retain preferences, lose/recover connectivity | Controls-ready and first-frame marks, cache delivery type, saved preferences, explicit offline/stale state |

Keep a bounded trace per run: scenario, build commit, synthetic input, action,
time, observed result, evidence path and severity. Avoid credentials, cookies,
real device location, private visitor notes or screenshots of private material.
Reports should identify the smallest repair that resolves observed friction.
Agent traces are test traffic; exclude them from all demand counts. Several
successful agent journeys are useful regression evidence, not proof of real
human usability or production capacity at 300 simultaneous visitors.

Earlier first-visit and returning/mobile traces under `.qa/` contain actual
local HTTP requests, static inspection and synthetic contract checks. Their
browser surfaces were unavailable then, so those traces do not establish real
clicks, mobile layout or an offline reload. Those files remain historical records.

The later immutable combined preview on `127.0.0.1:4180` was exercised with actual
browser actions. Brussels selection established a 10 km workspace and 27 km
camera altitude without requesting device GPS. A 390×844 Larger-text check showed
no horizontal document overflow and kept news above the attribution footer.
An actual offline reload restored a 10 km radius, 295 indexed records and 80
groups with saved-copy notices and no visible error, but **street detail was
incomplete**, with coarse bundled/imagery fallback. The network restriction and
temporary viewport were restored after testing.

Production v22 showed the new `index-CG1_w5QR.js` bootstrap and
`index-B6SCv4Kt.css` stylesheet, a visible globe, and 295 indexed records.
Submitting `Ukraine` produced **14 matching records / 14 groups without any
additional HTTP request**. The earlier preview query had 293 records and 11
matches; these are separate recorded samples, not interchangeable counts.
First observed/repeat production first frames were **5,561.8 / 3,157.7 ms**.
The repeat navigation's measured TTFB was about **2.37 seconds**; the trace does
not establish the cause of the delay. Earlier warm startup/framing measurements
retain their original builds and conditions. Remaining research/private-export,
keyboard/focus, sharper-map and complete offline-street journeys still require
bounded checks against the applicable immutable release.

## Crawl → index → rank → serve

Google documents separate discovery/crawling, indexing and serving stages. This
platform follows that separation at its own scale through curated acquisition,
metadata indexing and serving; it has no general page crawler or Google-scale
coverage/ranking. [Google Search stages](https://developers.google.com/search/docs/fundamentals/how-search-works/)

```mermaid
flowchart LR
  A[Permitted APIs, feeds and public sources] --> B[Bounded scheduled acquisition]
  B --> C[Validate, deduplicate and retain provenance]
  C --> D[Versioned searchable index]
  D --> E[Rank relevant source records]
  E --> F[Cached browser and edge results]
  G[Opted-in aggregate demand] --> B
  H[Agent journey findings] --> I[Verified interface and loading improvements]
```

1. **Acquire:** start with existing reviewed structured feeds and GDELT bulk
   metadata. A source registry records the fixed origin, rights, allowed paths,
   byte/record limits, cadence and failure policy. Page crawling requires separate
   permission and robots evaluation; follow robots rules, respect access failures,
   bound redirects to approved origins and avoid login/CAPTCHA bypasses. Use
   conditional requests and source release schedules. [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)
2. **Index:** preserve the original source record, canonical URL, source ID,
   content kind, topic/country mentions, dates, retrieval time, revision and rights.
   Use a versioned manifest and atomic last-good snapshot. Remove withdrawn or
   expired material. A mention, forecast, measurement and creator commentary
   remain different kinds. Metadata permission does not license an article body,
   photograph or transcript.
3. **Rank:** combine query relevance, explicit geographic match, observation
   freshness and source type. Explain why a record matched. Country mentions do
   not establish incident locations. Deduplicate syndicated URLs without counting
   them as independent confirmation. Popularity may prioritize acquisition and
   cache warming; it must not turn a popular allegation into a verified fact.
4. **Serve:** share the same bounded index across visitors, use versioned browser
   snapshots and query-result caches, and refresh in the background. Never crawl
   synchronously for each search. Report the index's coverage and last refresh;
   a zero-result sample must not be presented as proof that no event occurred.

The implemented [metadata index](DISCOVERY_SEARCH.md) canonicalizes URL/kind,
preserves source generations and dates, and retains at most 600 records/2 MiB
of serialized metadata; the API uses a tighter 440-record cap. Country-name
aliases and every reviewed GKG label are searchable. Exact known theme IDs are
translated to labels by the browser/API entry points. All query terms must match
metadata, with explicit match reasons and relevance/date/provenance/diversity
ordering. No ordering value establishes confidence, truth or popularity.

The browser keeps ordinary free-text searches local. The scheduled reader uses
one shared acquisition rather than a new upstream query for each search. Browser
and legacy API now share related-report grouping with query relevance preserved;
all original primary/related source dates and links survive. Compact topic labels
follow the selected category. Source expiry and individual GKG batch expiry apply
to searches and default groups, including failed-refresh and clear-query paths.
The source/parity regressions are committed and included in v22. Ordinary local
search was exercised in production; expiry under a 24-hour outage, detailed
grouping parity and identifier-validation edges are verified by contract
regressions rather than separate production reproductions. The local full suite
recorded 1,011 passes at runtime revision `5f69738`, before two CSS-only footer
repairs; exact final revision `42cb233` passed GitHub Check run 38130335814 and
combined build/routing checks.

The [annual economic facts](ECONOMIC_FACTS.md) Worker path can lazily reuse strict
`EARTH_STORE` snapshots across instances, at most 50 observations/64 KiB per
supported economy. Restoration preserves the original retrieval date and the
24-hour freshness/seven-day stale bounds. This path is included in v22; the
release record does not prove production R2 restoration across a restart or
coverage of every supported economy. It introduces no startup dataset sweep or
observation interpolation.

## Aggregate demand without private search histories

The implemented [counter](AGGREGATE_DEMAND.md) starts unchecked on each page and
records only an explicitly consented, accepted form-submit action matching a
reviewed subject or category/country overview. The outgoing payload is exactly
`{subjectId, country, consent:true}`. Arbitrary raw queries, publisher searches,
precise coordinates, identity, device fingerprints and notebook contents are
excluded. Matching a known label does not create consent. Mounted panels,
refreshes, polling and map movement do not increment the counter.

The public summary reports only groups with at least **300 accepted actions**
over seven UTC calendar days, rounded down to 100-action buckets. These are
consented search actions, not unique people or proof of representative interest.
The 300-action threshold and 300 reviewed YouTube comments do not establish
capacity for 300 concurrent visitors. Preview/local/marked agent traffic is
excluded; tests used synthetic summaries and storage. Actual v22 production
status and summary GETs returned 200 with `enabled=true`, and the summary returned
`groups=[]`. The observed production search had consent unchecked; **no real
demand POST or production counter-write journey was performed**. These checks
do not manufacture counts or establish unique visitors. Physical idle-period
deletion still requires the scoped lifecycle/scheduler configuration described in
the counter document.

The scheduled [sampling integration](INTELLIGENCE_PRIORITY.md) reads one fixed
owned public summary and uses only its validated, rounded reviewed subjects.
It preserves at least 60 of 80 balanced records per category and lets at most 20
slots favor demanded metadata, within the existing 10,000-candidate budget and
publisher/country/theme limits. Unavailable or unmatched demand preserves the
balanced baseline. Source URLs, dates and verification cautions stay unchanged.
The official archive count and acquisition cadence remain fixed. General page
crawling, demand-built topic landing pages and arbitrary cache warming remain
future work. The counter and sampling code are included in v22. Scheduled data
workflow 38130210098 at revision `deadb71` generated and published metadata
successfully, with an observed retrieval timestamp of
`2026-10-11T09:57:37.727Z`. This establishes one scheduled publication, not a
measured effect from real opted-in demand; no such counter submissions were made.

New source acquisition still requires rights and coverage checks even when demand
is high. Publish the source catalogue, freshness limits, ranking explanation and
journey findings so platform improvements can be examined by others.
