# Next intelligence slice: from discoveries to investigated mechanisms

Audit and proposal, 12 October 2026. A bounded GDELT missing-batch acquisition
package was subsequently implemented behind a disabled rollout flag; see
[its exact contract and release gates](GDELT_CATCHUP.md). Other source/analysis
modules here remain proposals: no broad crawler, model call, account, job schema or
original-checkout change was made by this audit. The intended product is a public world-understanding
lab: observations, attributable stories, relationships and evaluated scenarios.

## What the current system actually provides

The public stored `/earth/api/intelligence` read at 2026-10-11T22:55:47Z returned
`prepared-hosted-data`: 360 indexed records, including 190 GDELT entries. Every news
entry was a `topic-mention`, with generated topic labels rather than original
headlines. Publication and incident times were null. The prepared capture/check was
22:31:13Z; GDELT retrieval was 21:45:21Z. Five processed batches spanned 09:00–21:45,
with 47 missing quarter-hour intervals between those endpoints. All four source
states were stale at this particular read. This is dated operational evidence, not
a claim that they remain stale or that no news happened in those intervals.

At the audit time, the clean producer checked only `gdeltv2/lastupdate.txt` and parsed one latest GKG ZIP.
It retains a rolling sample of at most 80 links per category/240 overall, even though
it may parse more candidates. Limits are 16 MiB compressed, 128 MiB expanded,
50,000 rows and 10,000 candidates. The release asset is overwritten with the latest
sample; hosted source snapshots preserve only what collectors actually retained.
The Node parser already validates ZIP structure, MD5 where supplied and CRC, and
keeps decompression out of the browser/Worker. Reuse it.

The original `earth-observer` checkout was inspected without edits. Its current
GDELT WIP separates 15-minute source cadence from minute manifest/release checks,
accepts the exact old schema-2 schedule field for compatibility, and explains
source batch clocks that run ahead of retrieval. It does **not** implement missed
batch acquisition. Preserve and review that small compatibility package independently
instead of treating its improved labels as catch-up functionality.

The current durable investigation implementation is useful but USGS-specific:
`event:usgs:*` IDs, `usgs-detail-v1`, official detail JSON and deterministic scientific
facts. It has persisted attempts, leases/fences, retry, evidence hashes and artifacts.
It does not investigate journalism, resolve actors, compare claims or run an LLM.
The pipeline selects at most three recent USGS events and runs one due job. The
source capability ledger is explicitly a baseline audit, revision 1; it needs
dataset-specific archive/runtime entries when new capabilities are verified.

Relevant existing boundaries are `scripts/gdelt-snapshot.mjs`,
`server/hosted/gdelt-gkg.js`, `src/core/world-model.js`,
`worker/investigation-jobs.js` and `docs/SOURCE_CAPABILITIES.md`.

## Five structural gaps, in dependency order

1. **Acquisition coverage:** source checks, completed evidence, discovery coverage
   and unattended execution are separate. Latest-batch sampling skips intervals;
   minute presentation cannot restore missing evidence. Global discovery needs
   explicit expected/acquired/failed/capped coverage and a verified runtime.
2. **Original source assertions:** a generated topic label/country mention supplies
   neither the publisher's claim nor its publication/incident location. Current
   canonical source validation admits four sources only. Add reviewed adapter
   contracts for original publications and structured observations before expanding
   source IDs or making new pins.
3. **Living story and entity identity:** current similarity grouping deliberately
   avoids asserting corroboration, but there is no stable story/claim/typed-relation
   graph. A repeated URL or shared country does not establish one event. Legal acts,
   companies, places and resources need source-mapped identities with revisable links.
4. **Investigation/synthesis policy:** the USGS job lifecycle can be reused, but its
   subject/policy restrictions cannot represent a news document, a story or a data
   revision. Generalize the subject boundary additively, keeping existing USGS routes
   valid. Separate cheap acquisition, claim extraction and expensive synthesis.
5. **Mechanisms and evaluation:** no implementation currently demonstrates causal
   channels, alternative explanations or prospectively evaluated scenarios. A news
   burst, annual dependency statistic and subsequent price move are different kinds
   of evidence; none alone proves the others caused it.

## Start with a source that can actually be acquired

The Council publishes a press RSS directory and permits attributed reuse of its own
text under stated conditions; third-party material retains separate rights.
[Council RSS](https://www.consilium.europa.eu/en/about-site/rss/),
[Council copyright](https://www.consilium.europa.eu/en/about-site/copyright/).
However, this audit's direct bounded Node request of the RSS guide returned 403,
and a web-tool feed click failed. Its anonymous unattended feed access is therefore
**not verified**. Do not bypass access controls or call that source ready.

A concrete policy-story candidate is the Council's 8 October announcement extending
its restrictive-measures framework until 9 October 2027. The page describes asset
freezes, prohibited resource provision and travel restrictions and links Decision
(CFSP) 2024/2643. Treat the decision announcement as an institutional source claim;
the page's allegations about hostile activity remain attributed allegations.
Do not turn this into a general trade embargo or a predicted gas-price effect.
[Original announcement](https://www.consilium.europa.eu/en/press/press-releases/2026/10/08/russia-s-hybrid-activities-council-prolongs-restrictive-measures-until-october-2027/).
Its displayed 12:20 publication time has no verified UTC offset in the inspected
text. Preserve that precision/uncertainty until source metadata establishes it.

For an immediately testable first module, choose **data journalism about Belgium's
natural-gas import origins**. A bounded official Statistics API request with
`nrg_ti_gas`, `geo=BE` and `sinceTimePeriod=2024` returned HTTP 200 and 15,907 bytes.
It supplied JSON-stat 2.0, update time `2026-10-09T23:00:00+0200`, dimensions
`freq,siec,partner,unit,geo,time` and one annual period, 2024. The two products were
natural gas and LNG; units were million cubic metres and gross-calorific-value
terajoules. This verifies small anonymous API access and schema, not any particular
dependency conclusion or present-day supply.
[Dataset](https://ec.europa.eu/eurostat/databrowser/view/nrg_ti_gas/default/table),
[Statistics API contract](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines/api-statistics).

Eurostat documents dataset-change RSS, generated twice daily with a seven-day
change window. A direct GET succeeded but exceeded this audit's 512 KiB read cap;
HEAD with an RSS-specific Accept header returned 406. No feed body was retained.
Start with one fixed dataset and a small periodic query rather than assuming an
unbounded RSS discovery feed fits the Worker. Validate a separately budgeted feed
adapter later. Eurostat reuse requires attribution and preservation of applicable
exceptions.
[Update RSS](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines/catalogue-api/rss),
[Eurostat reuse](https://ec.europa.eu/eurostat/about-us/communicating-disseminating-statistics).

## Smallest useful end-to-end investigation

Implement one independently deployable source/policy package:

1. A reviewed `eurostat-gas-origins-v1` adapter checks the fixed Belgium dataset
   slice every six hours, with deadline/backoff and a 512 KiB response cap. No visitor
   fetches, arbitrary dataset codes or upstream URLs. An unchanged factual hash
   creates no new observation/analysis, even when a check timestamp changes.
2. Retain one immutable source body per changed revision in R2 and a small D1 serving
   index. Preserve dataset/codelist version, dimensions, units, periods, status flags,
   source update and actual hosted publication dates. Missing/suppressed cells stay
   missing. Do not add overlapping natural-gas and LNG totals or invent a denominator.
3. Create a stable dossier, initially `Belgium natural-gas origins`, with dated
   observations and cited relations between the reporting country, ultimate-origin
   countries and the resource. A statistical origin is not a shipment route, pipeline
   map or evidence that a particular port supplied Belgium. The 2024 period is not
   a live 2026 measurement.
4. Run deterministic checks first: validate units, identify actual reported totals,
   compare like-for-like revisions and calculate supported shares/concentration.
   Store every derivation's inputs/formula/version; avoid a narrative conclusion
   when completeness or the denominator is insufficient.
5. Attach existing GDELT links as **related discovery candidates**, not independent
   proof. Once an original political/news source passes unattended access/rights
   gates, investigate one change in the same dossier: what the source asserts,
   what mechanism could connect it to supply, and what evidence would test that
   mechanism. Until then, do not pretend the policy-story branch is complete.
6. Serve a compact country/resource relationship view, observation history and one
   dossier. The selected world date resolves actual observation periods; source
   releases/revisions use a separate publication timeline. A policy jurisdiction
   or country's statistical region is not a newly geolocated incident pin.

Proposed initial budget: four dataset checks/day, one concurrent acquisition, one
changed-body object per revision, at most two investigated dossiers/day, at most
three attempts/job and a 32 KiB public analysis artifact. A 512 KiB cap gives at most
2 MiB/day of dataset downloads at this cadence; the observed sample is much smaller.
These are project budgets, not guaranteed provider quotas. Keep publisher research
at most two reviewed sources/20 references per pilot dossier, with separate access
and byte limits. No model budget is authorized by this proposal.

The first-hour research policy can later boost one materially changed story without
changing baseline acquisition. Cap its number of jobs, then use contextual six/
twelve-hour due times; severe ongoing events can retain priority without a follow.
Opening the dossier, search popularity and viewport interest affect serving/research
priority, never factual credibility or global coverage declarations.

## Minimal shared contracts, without another evidence warehouse

Use existing immutable revision refs and completion receipts. Add only:

- `SourceAssertion`: source item/revision, locator, author, subject/predicate/value,
  time meaning/precision and geometry meaning. A reported assertion is distinct
  from a verified platform conclusion.
- `Story`: stable topic/event anchor, evidence membership revisions, lifecycle
  assertions and identity links. Unknown matches remain candidates.
- `Entity` and `Relation`: source IDs/aliases and typed, dated, evidence-cited links.
  Keep reported legal restriction, measured exposure and inferred causal mechanism
  as separate relation types.
- `AnalysisRevision`: ordered evidence IDs/cutoff, extraction/analysis policy version,
  actual publication time, assumptions, alternatives and superseded revision.

Generalize durable jobs to a validated `subjectKind/subjectId` and reviewed policy
registry. Deduplication uses material evidence revisions and policy, not every new
GKG indexing observation. Keep fenced completion and current-input checks. Source
publication, event/valid period, first retention, dossier publication and analysis
publication remain separate. Imports today cannot backdate hosted knowledge.

Corroboration is a lineage question: canonical/AMP URLs, explicit wire attribution,
shared primary quotes and identical text can suggest copying. Distinct domains or
high headline counts alone do not establish independence. Store `independent`,
`syndicated/shared-origin` or `unknown` with evidence for that classification; do
not manufacture an independent-source count or confidence percentage.

No general RSS/XML parser was found in current server/Worker dependencies. Reuse
the bounded HTTP helpers, hashes, JSON handling, Drizzle and existing time/evidence
primitives first. If RSS becomes the chosen source, review one narrowly configured
parser dependency and bounded untrusted-input tests; do not reuse the WMS-specific
XML regex as a general feed/document parser. Source text never changes tool policy.

A capability module can declare reviewed source/schema, rights, coverage, cadence,
budget and display semantics without loading executable plugins from discovered
pages. Start with that descriptor for this one adapter. Own MCP tools can later
query the same stored evidence/story/relationship/period-comparison interfaces,
making investigations usable in ChatGPT as well as the atlas. They neither create
another warehouse nor provision an independent acquisition runtime. Research/follow
writes retain separate owner/visitor authorization and budget gates.

## GDELT continuity: a separate bounded acquisition package

The independent repair package is now implemented but not enabled or deployed:
latest first, at most two oldest missing quarter-hour slots within the retained
24-hour span, a shared 45-second/three-archive budget, persisted retry checkpoints
and explicit unresolved/capped intervals. Its new hosted consumer must be released
first; see [GDELT_CATCHUP.md](GDELT_CATCHUP.md). Preserve the original checkout's
cadence/clock WIP for independent review. Admit
only reviewed timestamp-derived official paths; a missing file is not evidence that
no event happened. Provider manifest MD5 is verified where supplied; historical
HEAD/If-Match size and strong ETag, strict ZIP CRC and own SHA-256 preserve honest
integrity provenance with providerMd5 null. Do not fetch a growing
master list on every minute or call all omitted/sampled news archived.

One day has 96 quarter-hour slots; two years imply about 70,080 files before any
translation/variant scope. Even a quiet roughly 2 MiB example implies substantial
bulk traffic. Measure actual sizes and parsing costs before choosing an independent
Node runtime or retention policy. Minute Cloudflare wake logic does not make its
Free CPU budget appropriate for GKG inflation. The existing DOC API can supply
bounded targeted article discovery, but actual access/quotas must be measured and
it is not a complete two-year publication archive.
[GDELT batch/archive documentation](https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/),
[DOC API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/).

CELLAR supplies persistent EU publication identifiers and REST/SPARQL/feed interfaces
for the later legal-relationship branch. Verify the particular metadata access and
current/superseded document identity before connecting policy claims. This is an
API-first candidate, not a verified integration or a reason to bypass EUR-Lex's
robot challenge observed during this audit.
[CELLAR data model and access](https://op.europa.eu/en/web/cellar/cellar-data).

## Future understanding and acceptance gate

Start with an explicitly conditional dependency stress test, not a claimed price
forecast: given cited annual volumes, what changes under a stated origin-volume
reduction and stated replacement assumptions? Store baseline period, actual
knowledge cutoff, scenario horizon, assumptions and formula/model version. This
does not establish disruption likelihood or predict geopolitical intent.

Later prospective scenarios need immutable publication before outcomes, a declared
measurable target/horizon, comparison baseline and outcome-source coverage. Evaluate
numeric outcomes with stated error metrics and probabilistic forecasts with proper
scores only if supported probabilities were actually issued. Unknown outcome data
is unevaluated, not success. A dataset imported today cannot support an honest
historical claim that the platform predicted that old outcome.

Release the first package only after one real small source revision is retained,
read back and investigated without visitors; retry changes nothing; a correction
creates a dated revision; missing cells/access remain explicit; every displayed
claim/edge/formula resolves to evidence; known-then excludes later analysis; and the
frontend cannot attach a different source revision to a selected point. Only then
add more original-news sources, regions, entity mappings or model-assisted notes.
