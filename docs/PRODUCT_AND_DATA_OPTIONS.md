# Observer: product and data options

Recorded 12 October 2026, Europe/Brussels. This document captures the conversation and primary-source research. It is a planning reference, not a claim that these services, data sources or paid features are implemented.

Read with [CONSUMER_DIRECTION.md](CONSUMER_DIRECTION.md) for the decision record and [DESIGN_RESET.md](DESIGN_RESET.md) for the design review requirements. Source pricing, access rules and licences must be checked again before activation.

## 1. Direction and decision status

| Item | Status |
| --- | --- |
| Explain how the world changes through current developments, history and evidence | Established project intent |
| Individuals are the customers; companies are potential sponsors | Explicit user clarification |
| Personal catch-up, guided explanations, historical comparison and saved investigations | Direction authorised by the user's “let's do it” |
| EUR4.99/month consumer membership | Price hypothesis; demand, conversion and margins unvalidated |
| EUR5/month total recurring project services | Earlier ceiling remains in force; no replacement budget supplied |
| Root topics in X and use its official API | Requested, then reconsidered after pricing; alternative source choice unresolved |
| 2D intelligence atlas inspired by Check Point's threat map | Prototype authorised; its visual design has not been accepted as final |
| Activate billing, purchase API credits or establish commercial sponsorships | Pending a concrete reviewed package and the applicable account steps |

The separate [design preview](https://giovannicallebaut.com/earth/design/) uses fictional fixtures. Publication, successful checks and business discussion do not establish visual acceptance. This documentation request does not resume the broader implementation effort or authorise new collection.

## 2. What an individual might pay for

The first consumer offer should be useful repeatedly:

1. **Catch up:** “What changed since my last visit in the subjects I follow?” Preserve a user's reading position and show substantive developments, corrections and newly available evidence.
2. **Understand:** Explain the background and documented dependencies of a subject through a geographic view and a historical timeline. Preserve competing accounts and uncertainty.
3. **Keep an investigation:** Save a question, evidence links, notes and comparisons; show what subsequent information changes the picture.

Suggested free/paid boundary, still a proposal:

| Public experience, potentially sponsor funded | Consumer membership |
| --- | --- |
| Current map, basic stories, source links and correction notices | Personal catch-up across followed subjects |
| Selected interactive explanations | Full guided explanation library |
| Basic history exploration | Deeper comparisons across dates and subjects |
| Public investigations | Private notes, annotations, saved investigations and exports |

A user who enjoys detailed explanations of geopolitics, economics or technology could explore the evidence and then keep that understanding current. General visitors may remain free users. Validate repeat use and actual payment before treating subscription revenue as proven.

Useful consumer precedents, not proof of demand for Observer: [Ground News](https://help.ground.news/en/articles/648513) for comparison/personalisation, [Brilliant](https://brilliant.org/help/features/what-are-learning-paths/) for guided interactive learning, and [Readwise](https://readwise.io/pricing/reader) for retaining and organising reading.

## 3. Other product options considered

These are alternatives or later extensions. Some were suggested before the clarification that individual users are the primary customers.

| Option | Useful outcome | Possible revenue | Current priority |
| --- | --- | --- | --- |
| Personal radar | Follow places, companies, industries and subjects | Consumer membership | Part of the proposed first offer |
| Investigation rooms | Shared source timelines, annotations and exportable dossiers | Individual/team membership | Start with personal investigations; collaboration later |
| World Replay Studio | Create sourced animated maps for videos, presentations or exhibitions | Production projects; export subscription later | A potential separate early revenue experiment |
| Dependency atlas | Explore materials, production regions and infrastructure behind everyday products | Public sponsorship; paid explanation collections | Strong public feature candidate |
| World Classroom | Reconstruct events, compare sources and learn through guided investigations | Consumer learning packs; institutional licensing later | Later extension |
| Opportunity Atlas | Follow public contracts, planned projects and industrial investment | Membership or professional extension | Source-backed candidate; avoid replacing the consumer focus |
| Location history reports | Reconstruct documented developments around a place and period | Bounded paid research/export | Later extension; state coverage gaps |
| Public investigation commissions | Fund a bounded investigation whose results become public | Commissioned research; contributor-platform fees later | Funding and editorial model unresolved |
| Scenario Studio | Explore consequences of explicit assumptions using a documented model | Learning/workshop licences | Later; distinguish scenarios from observations |
| Publisher toolkit | Embed maps, history replays and explanations | Licensing | Later distribution channel |
| Normalised data/API/MCP service | Deliver maintained event records, revisions and provenance to other tools | Access subscription/licensing | Later; source resale rights must support it |
| Business radar | Monitor business dependencies and operational developments | Team subscriptions | Previously explored; secondary to current consumer direction |

A commercial intelligence MCP precedent is [Crunchbase's MCP](https://about.crunchbase.com/products/crunchbase-mcp). An MCP changes access and orchestration; it does not grant additional content rights, free inference or unlimited data access.

## 4. Sponsorship approach

Potential formats include a weekly visual world replay, public thematic observatories and commissioned educational collections. Sponsors would fund a defined audience and useful coverage. Their placements would be clearly identified and editorial selection would remain independent.

Sponsorship attractiveness, audience size, engagement and sponsor pricing are unvalidated. Do not activate topic-derived sponsor matching or advertise guaranteed reach.

The original God's Eye View [MIT licence](https://github.com/bilawalsidhu/gods-eye-view/blob/main/LICENSE) permits commercial source-code reuse with required notices retained. Bundled assets and provider data have their own terms, including noncommercial restrictions. Renaming the product does not remove those obligations.

## 5. Source catalogue for targeted collection

“Free” below means a documented free data-access path or allowance, subject to its limits. It does not mean free hosting, inference, storage, complete coverage or unrestricted republication of every linked work.

### Preferred foundation

| Source | Targeting and identifiers | Access and time behaviour | Rights and practical limits |
| --- | --- | --- | --- |
| **Wikidata** | QIDs, aliases, places, companies, public roles and external identifiers | Public entity access and query services; facts change through community edits | Structured data is CC0. Preserve references and qualifiers; a community relationship is not independently verified current fact. Query services have limits. [Licence](https://www.wikidata.org/wiki/Wikidata:Licensing), [access](https://www.wikidata.org/wiki/Help:Data_access) |
| **GDELT** | News themes, entity/place mentions, languages and publisher domains | GKG batches update every 15 minutes; bounded article discovery and historical datasets | Commercial dataset reuse is free with attribution. Mentions are discovery signals, not verified incident coordinates or independent corroboration. Linked article/image rights remain separate. [Terms](https://gdeltproject.org/about.html#termsofuse), [data](https://gdeltproject.org/data.html) |
| **SEC EDGAR** | Company CIKs, accession numbers, filing forms, XBRL concepts and reporting periods | No API key; submissions update as filings are disseminated; nightly bulk files | Declare the automated client and respect fair-access limits, currently at most 10 requests/second. Filing/publication time differs from the financial period. Public filings may be reused; other site works can have separate rights. [API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [access](https://www.sec.gov/about/developer-resources), [reuse](https://www.sec.gov/about/webmaster-frequently-asked-questions) |
| **European Parliament open data** | MEP, parliamentary body, procedure, document and meeting identities | Official API and update feeds; actual authentication, availability and publication delay need an integration check | API documentation identifies CC BY 4.0; check individual publications and media separately. Follow documented public institutional actions. [API](https://data.europarl.europa.eu/en/developer-corner/opendata-api), [legal notice](https://www.europarl.europa.eu/legal-notice/en) |
| **EU TED procurement** | Notice/procedure IDs, sector CPV codes, place-of-performance NUTS codes and supplied organisation IDs | Anonymous published-notice search API; editions published on working days | Designed for reuse, including commercial services. Apply the notice's licence/attribution and third-party exceptions. Buyer address differs from project location; awards and amendments are distinct records. [API](https://docs.ted.europa.eu/api/latest/search.html), [reuse](https://ted.europa.eu/en/legal-notice), [publication information](https://ted.europa.eu/en/help/data-reuse) |
| **Permitted publisher and institutional feeds/pages** | Original links, publication IDs, subjects and declared publication dates | RSS/Atom, sitemaps, feeds or bounded page checks; publication is source dependent | Approve each source's collection and commercial reuse terms. Public accessibility or RSS availability does not license full articles, pictures or videos. Example: [ECB RSS](https://www.ecb.europa.eu/home/html/rss.en.html) |

### Supporting sources

| Source | Useful contribution | Free access and limits |
| --- | --- | --- |
| **OpenAlex / Crossref** | Research subjects, works/DOIs, institutions, authors, references and corrections | OpenAlex metadata is CC0. A free account/key currently provides USD1/day of API usage without a payment method; free bulk snapshots are quarterly, while daily snapshots and change-date synchronisation are paid. Crossref metadata retrieval requires no signup. Article/full-text and some abstract rights are separate. Use stable IDs and handle names carefully. [OpenAlex pricing](https://help.openalex.org/access/pricing/), [metadata/access reference](https://help.openalex.org/api/llm-quick-reference/), [bulk/sync](https://help.openalex.org/access/sync/), [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) |
| **Bluesky / AT Protocol** | Early discussion, subject mentions and links from public records | Jetstream v2 has an anonymous public live tail; history replay needs separate authenticated access. Stream filtering by records/accounts differs from keyword matching. Apply edits/deletes; author rights remain. It does not reproduce X's audience. [Stream](https://bsky.network/docs/jetstream/), [replay](https://bsky.network/docs/jetstream-replay/), [terms](https://bsky.social/about/support/tos) |
| **USGS** | Precise seismic event observations and revisions | Public GeoJSON feeds refresh every minute; actual events/measurements and revisions arrive at their own times. USGS-produced information is public domain, with third-party exceptions. [Feed](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), [rights](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits) |
| **ReliefWeb** | Humanitarian reports, disasters, countries and publishing organisations | Free API requires an approved app name; documented limits currently 1,000 calls/day and 1,000 entries/call. Keep report/source IDs and original/curation/modification dates separate. Partner content can remain copyrighted; start with permitted metadata and original links. [API and terms](https://apidoc.reliefweb.int/) |
| **Eurostat** | Energy, trade, industry and regional statistical context | Public APIs; series can be annual, quarterly or monthly and dataset updates do not create new current observations. Commercial reuse has specific country/trade exceptions. Select and clear the dataset before acquisition. [API](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-introduction), [copyright](https://ec.europa.eu/eurostat/web/main/help/copyright-notice) |
| **ECB data** | Monetary, financial and economic statistical context | SDMX supports changed-data retrieval and revisions. Paid reuse requires notice that underlying ECB information is freely available; named-author papers have stricter republication terms. [Data API](https://data.ecb.europa.eu/help/api/data), [reuse](https://www.ecb.europa.eu/services/using-our-site/disclaimer/html/index.en.html) |
| **World Bank indicators** | Long-term development, industry and country comparisons | Indicators API requires no key. Dataset terms default to CC BY 4.0 unless otherwise labelled, with third-party exceptions; general website content has different terms. Series reference periods and missing values must remain explicit. [API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation), [dataset terms](https://www.worldbank.org/ext/en/legal/terms-conditions/datasets) |
| **GDACS** | Indicative disaster notices and affected areas | Useful feed access, with model uncertainty and no complete/timely coverage guarantee. Its terms do not establish blanket commercial rights to all contributing works. [Terms](https://gdacs.org/About/termofuse.aspx) |
| **Selected Mastodon servers** | Public subject/account discussions | Access, availability and rules depend on each server. A server's public timeline is not a global feed. [Timeline API](https://docs.joinmastodon.org/methods/timelines/) |

The codebase already contains work for several source families, including GDELT, USGS/GDACS and institutional/statistical plugins. This catalogue does not establish their current production health or integrate the new options. See [INTELLIGENCE_SOURCES.md](INTELLIGENCE_SOURCES.md) and [SOURCE_PLUGINS.md](SOURCE_PLUGINS.md) for existing contracts.

**Wikipedia background is a separate option:** reused/adapted article text is generally CC BY-SA 4.0, with attribution and applicable share-alike obligations; images have individual licences. Wikidata's CC0 structured-data grant does not extend to Wikipedia prose or media. See [Wikimedia's terms](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use).

## 6. X, Reddit and browser-agent options

### Official X API

X is a possible selective discovery input. Current [pricing](https://docs.x.com/x-api/getting-started/pricing) lists USD0.005 per post read, USD0.010 per user read and USD0.010 per trends request. It uses prepaid usage credits. A USD5 allowance buys 1,000 post reads alone; profiles, other calls, analysis, taxes, conversion and infrastructure reduce the available project budget. Console spending limits and a durable application budget would be required before activation.

[Filtered streams](https://docs.x.com/x-api/posts/filtered-stream/introduction) deliver posts matching rules. [Recent search](https://docs.x.com/x-api/posts/search/introduction) and trends are bounded discovery paths, not evidence of comprehensive X coverage. A small pilot and a constant worldwide intake are different workloads.

The [Developer Agreement](https://docs.x.com/developer-terms/agreement) requires approved analysis scope, prohibits foundation/frontier-model training with its content and restricts using content or derived analysis to target or serve advertising outside X. Larger commercial usage can require Enterprise access. The [Developer Policy](https://docs.x.com/developer-terms/policy) constrains redistribution and requires handling content availability, edits and removals. Sponsor use and persistent history therefore need explicit clearance.

The console redirected to sign-in during the account check. API entitlement remains unverified. No X adapter was created, credentials connected, credits purchased or paid requests made.

### Grok, embeds and third-party services

[Grok X Search](https://docs.x.ai/developers/pricing) currently bills per fetched post/profile plus model usage; it is not a verified cheaper bulk-X route. Selected links or official embeds can show known posts, but they do not supply a bulk index. Embeds also have applicable notice/consent obligations. Third-party data providers require an access, licence, cost and reliability review before becoming a dependency.

### Reddit

Reddit's [Data API Terms](https://redditinc.com/policies/data-api-terms) require a separate agreement for commercial use. Its [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) covers AI agents and commercial approval. The [Public Content Policy](https://support.reddithelp.com/hc/en-us/articles/26410290525844-Public-Content-Policy) preserves restrictions on reuse and deletion handling. Free website viewing does not establish a free commercial collection licence.

### Browser agents and focused web collection

Browser agents can reduce the work needed for a small investigation. Constant operation adds page rendering, model/tool processing, navigation, session recovery and maintenance. Locally running inference can reduce paid model usage, but shifts resource use to the laptop; sleep and disconnections interrupt collection. Visible feed/search results are selected slices of the available information.

X's [website terms](https://x.com/en/tos) require prior written consent for crawling/scraping. Browser automation does not remove platform access or content-reuse requirements.

Recommended division of work, still a proposal:

1. Approved structured sources perform routine discovery and supply identifiers, timestamps and revisions.
2. A substantive development or user question wakes an agent for a bounded investigation using permitted sources.
3. Retain permitted source references and evidence-backed findings, with uncertainty and lifecycle handling.
4. Reuse that investigation across everyone following the subject.
5. Revisit when substantive evidence changes or an explicitly defined review interval is due.

For permitted websites, start with feeds and sitemaps; fetch known pages conditionally, honour access policies and backoff, and deduplicate changes. Do not build around bypassing logins, blocks, paywalls or technical limits. Measure cost per useful new development and investigation; exact savings have not been benchmarked.

## 7. Entities, observations and the aircraft example

The user cited ElonJet as an example of deriving insight from observable signals. The general [ADS-B mechanism](https://www.faa.gov/about/office_org/headquarters_offices/avs/offices/afx/afs/afs400/afs410/ads-b) broadcasts aircraft position, altitude and speed. An aircraft observation does not establish a passenger's presence or that person's whereabouts after landing. It also does not establish a free commercial global flight-data feed.

Observer should connect observations to what they actually describe. Company disclosures, public institutional actions, infrastructure records and permitted scientific observations are useful subjects. For people, focus on their public roles, statements, published work and official actions. Preserve ambiguity when identities or names conflict. Do not derive private personal whereabouts or sensitive personal profiles.

Avoid equivalent inference mistakes elsewhere: a publisher country is not an incident location; a buyer address is not the project site; a place mention is not a confirmed event; popularity is not verification; correlated records are not proof of causality.

## 8. Proposed targeted acquisition and investigation method

### A. Subject registry

Start with followable subjects: a place, industry, company, public institution, public role or documented question. Connect stable identifiers such as QID, CIK, DOI, procedure/notice ID and geographic codes. Keep source assertions, resolution decisions and confidence/uncertainty separate. Merge identities only when evidence supports it.

### B. Shared acquisition

Collect each source scope once for all users. Retain cursors, validators, backoff state, budget and source-specific coverage. Use streamed updates where supported and bounded incremental checks elsewhere. Acquisition should continue independently of open browsers, subject to a verified always-on host and resource limits.

### C. Evidence and history

For each admitted record preserve:

- Original source ID and link.
- Publication/observation time and its meaning.
- Retrieval time and first hosted knowledge time.
- Reporting period, revision/withdrawal state and applicable rights.
- Geographic precision and any uncertainty.

Store only content whose retention is permitted. Deletion-sensitive social posts need a mutable compliance path rather than an immutable public copy. Independently sourced event history should remain distinct from social-post history.

### D. Investigation

Deduplicate repeated/syndicated reporting before grouping. Match developments to subjects using explicit evidence. Agents investigate significant additions, contradictory accounts or unresolved questions; analysis runs once per shared story whenever possible. Keep interpretations and scenarios separate from source observations.

### E. Personal serving

Serve cached/indexed subject records and changes since the member's last visit. Public page loads must not trigger a new external investigation per person. Filtering and map resolution should reveal relevant retained data; empty coverage is not evidence of absence.

The interface can animate transitions, source arrivals and timeline movement smoothly. It must not invent incidents, passenger presence, causal links or measurements. Source update rates, acquisition delay and rendering continuity are different contracts.

### Example subject: Taiwan and semiconductor supply

Use Wikidata for candidate entity identities, company disclosures for dated corporate statements, research metadata for technical context, public policy documents for institutional actions, and GDELT/approved feeds for discovery. Link the evidence into one evolving investigation. Relationships and locations must be supported rather than generated solely from co-mentions. This is an example workflow, not a completed dataset.

## 9. Phases and re-examination loop

| Phase | Reviewable result | Exit check |
| --- | --- | --- |
| 1. Consumer experience | A design-led personal catch-up and saved-investigation prototype | User accepts the visual/interaction direction; sample status is clear |
| 2. Targeted source pilot | One subject using identities, news discovery and one official evidence source | Access/rights cleared; real source times, identities, changes and costs checked |
| 3. Shared collection/history | Incremental acquisition, lifecycle handling, revisions and historical comparisons | Restart/reconnect preserves state; deletion and source gaps handled; cost stays bounded |
| 4. Membership value | Useful personal recap and persistent investigations | Real users return, understand the evidence and demonstrate willingness to pay |
| 5. Sponsorship/billing | A concrete offer and approved commercial/source use | Rights, editorial separation, payment steps and measured costs support launch |
| 6. Expansion | Additional subjects and optional products | Each addition has an independently evaluated source/value/cost contract |

At every exit check: compare the result with the original user goal, identify new constraints or better methods, revise dependent phases, and repeat the affected phase if its standard is unmet. Revisit fundamentals before adding scope. A source failure, new licence limit, weak retention or changed cost invalidates downstream assumptions.

## 10. Open decisions and current handoff

- Accepted final visual direction and representative device behaviour.
- First subject and source combination to validate.
- Whether X/Reddit are needed at launch, and account-specific approved access if so.
- Actual cost and capacity of existing hosting, retention and analysis under the EUR5 ceiling.
- Consumer willingness to pay, price and conversion.
- Retention scope, permissible historical content and source-specific lifecycle handling.
- Commercial sponsor compatibility and concrete payment implementation.

No new collection, paid services, billing, source adapter or site deployment was performed while documenting these options. Preserve unrelated backend retention/audit changes. Further implementation should begin with an announced, reviewable package using the current decision record.
