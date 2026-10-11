# Maxinomics research for Earth Observer

Research date: **11 October 2026**. Requested window: **11 December 2025 through 11 October 2026**, inclusive. This is a dated research inventory and a set of reporting leads. It is not a live news feed or a complete transcript analysis.

## Channel and actual coverage

The channel is **Maxinomics**, created and hosted by **Phil Andrews**, affiliated with **Morning Brew**. The official creator site and Morning Brew brand page identify the same project; the public YouTube pages return channel ID `UCUEmaeh13ai1ivT5wzz5Lhg`, handle `@Maxinomics`. [Creator site](https://www.maxinomics.com/), [Morning Brew](https://morningbrewinc.com/brands/maxinomics), [YouTube channel](https://www.youtube.com/@Maxinomics).

The public `/videos` and `/shorts` listings exposed **31 long videos and 128 Shorts**. Official watch-page publication dates were retrieved for all 31 long videos and 118 Shorts. **13 long videos and 52 dated Shorts** fall inside the window. Ten older-listed Shorts have unresolved dates and remain in a separate appendix. No public streams tab was exposed. Private, deleted, unlisted, region-hidden, or otherwise omitted uploads cannot be counted from these listings. Dates below use the calendar date of the official watch-page `publishDate`; the JSON preserves its timezone offset. [Long-video listing](https://www.youtube.com/@Maxinomics/videos), [Shorts listing](https://www.youtube.com/@Maxinomics/shorts).

**What was read:** all 13 in-window long-video descriptions, six public third-party full-text transcript reposts, and indexed transcript excerpts for one additional video. **What was not done:** watching the full videos, verifying reposts against audio, reviewing the 52 Shorts' full content, or obtaining all requested official transcripts. Reposted captions may contain transcription errors, missing passages, earlier edits, or advertisements. A repost's public availability does not establish redistribution permission.

For the 65 dated in-window videos, ordinary public caption requests returned **52 empty responses and 13 fetch errors**. Caption tracks listed in watch metadata are therefore recorded as *unretrieved*, rather than treated as an available transcript. A transcript-library request reported `IpBlocked`; no proxy rotation or authentication workaround was attempted. This agent's browser tool reported `Browser is not available: iab` and an empty browser inventory. The parent agent separately tested the supported official browser transcript export for `BXLGV0Sj0n8`: it returned **“No transcript is available for this YouTube video”** and the player showed **“Subtitles/closed captions unavailable”**. That browser result applies to the probed video; it does not establish that all other videos lack captions.

The official Data API is suitable for an ongoing metadata inventory: obtain the channel's uploads playlist, paginate `playlistItems.list`, and retrieve exact video metadata. `captions.download` requires permission to edit the video; a public API key does not grant arbitrary channels' caption-download access. [Channels API](https://developers.google.com/youtube/v3/docs/channels/list), [playlist pagination](https://developers.google.com/youtube/v3/docs/playlistItems/list), [caption authorization](https://developers.google.com/youtube/v3/docs/captions/download).

The machine-readable companion is [`public/research/maxinomics.json`](../public/research/maxinomics.json). It contains source URLs, IDs, dates, brief original paraphrases, per-video coverage, and explicit unresolved records. It contains no full transcript, copied description, video, audio, or thumbnail. Treat it as a dated research artifact. A future API-powered catalog must meet YouTube's refresh/deletion policies rather than indefinitely caching changing API metadata. [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies?hl=en).

## Long videos in the window

| Published | Video | ID | Review coverage |
| --- | --- | --- | --- |
| 2026-09-25 | [The Shadow That Ruined Airbnb](https://www.youtube.com/watch?v=aIK8f8nX8xs) | `aIK8f8nX8xs` | Official description only |
| 2026-09-11 | [China Found Something Better Than Oil](https://www.youtube.com/watch?v=BXLGV0Sj0n8) | `BXLGV0Sj0n8` | Official description + third-party full text |
| 2026-08-07 | [The Simple Question Socialism Couldn't Answer](https://www.youtube.com/watch?v=mMHyhneAxXY) | `mMHyhneAxXY` | Official description only |
| 2026-07-16 | [Why Elon Musk is Really Building Starship](https://www.youtube.com/watch?v=DlXb3zSLdFY) | `DlXb3zSLdFY` | Official description + third-party full text |
| 2026-07-01 | [AI Was Supposed To Take Your Job. Why Hasn't It?](https://www.youtube.com/watch?v=zRv5kW5mAxM) | `zRv5kW5mAxM` | Official description + third-party full text |
| 2026-06-10 | [How SpaceX Is Making America Uncatchable](https://www.youtube.com/watch?v=t_jGAK0LRRk) | `t_jGAK0LRRk` | Official description + third-party full text |
| 2026-05-29 | [Americans Are About to Get a Lot Richer](https://www.youtube.com/watch?v=mCd9ctg1sO4) | `mCd9ctg1sO4` | Official description + third-party full text |
| 2026-05-08 | [It Was Saudi Arabia That Broke Iran, Not the US](https://www.youtube.com/watch?v=2L5buspfCNY) | `2L5buspfCNY` | Official description + third-party full text |
| 2026-03-31 | [The Oil Nobody Is Allowed to Buy](https://www.youtube.com/watch?v=IWj39ekjwcE) | `IWj39ekjwcE` | Official description only |
| 2026-03-27 | [China Will Never Beat Taiwan, Here’s Why](https://www.youtube.com/watch?v=UWBrzzd1_yg) | `UWBrzzd1_yg` | Official description only |
| 2026-02-20 | [The Hidden Force That Made Everyone Wear Wide Leg Pants](https://www.youtube.com/watch?v=DA-CozY2isc) | `DA-CozY2isc` | Official description only |
| 2026-01-28 | [Saudi Arabia Has Oil, America Has This](https://www.youtube.com/watch?v=Y9V4jNTLGus) | `Y9V4jNTLGus` | Official description + indexed excerpts |
| 2025-12-22 | [Why Everyone Is Wrong About the AI Bubble](https://www.youtube.com/watch?v=Wcv0600V5q4) | `Wcv0600V5q4` | Official description only |

“Official description only” means the video was inventoried and its creator-supplied description was read; it does not mean its spoken content was reviewed.

## Public transcript sources reviewed

| Video ID | Accessible text and coverage | Material limitation |
| --- | --- | --- |
| `BXLGV0Sj0n8` | [SozAI rare-earth transcript](https://sozai.app/transcript/china-found-better-than-oil/), full displayed text | Repost duration 27:03 differs from official metadata 27:26; identity by video topic/title, unverified audio alignment. |
| `DlXb3zSLdFY` | [transcribe Starship transcript](https://www.usetranscribe.io/yt/DlXb3zSLdFY/elon-musk-starship-reason), full displayed text | Automatic text errors; revenue-per-ton calculations are the creator's model, not audited company figures. |
| `t_jGAK0LRRk` | [transcribe space-frontier transcript](https://www.usetranscribe.io/yt/t_jGAK0LRRk/spacex-america), full displayed text | Analogies about occupying space are not a statement of legal ownership; proposed lunar industry is prospective. |
| `mCd9ctg1sO4` | [transcribe freight transcript](https://www.usetranscribe.io/yt/mCd9ctg1sO4/flatbed-trucking-economy), full displayed text | Freight signals cited by the creator/interviewee are proprietary; aggregate productivity does not identify an AI cause. |
| `2L5buspfCNY` | [Decent Newsroom oil transcript](https://decentnewsroom.com/p/npub1fwj3ghwuuuezcdpzp95e0l0e6h8erxp3946k0vxa5f67tqr9f20s962gfv/d/2195cb5d085f6198), full displayed text | Repost title is the earlier *Why Oil Will Never Hit $200*, with the same video ID. Its claim of human captions was not verified. |
| `zRv5kW5mAxM` | [Free Republic user repost](https://freerepublic.com/focus/f-bloggers/4386977/posts), the block labeled Transcript | Earlier title *Why AI Can't Take Your Job*. Forum comments are different authors and were excluded from creator attribution. |
| `Y9V4jNTLGus` | [Rosetta indexed excerpts](https://rosetta.to/u/maxinomics/saudi-arabia-has-oil-america-has-this-2026-01-28) | Search excerpts were accessible; page body was not. Only partial text was reviewed. |

Targeted public searches for the remaining long videos also surfaced summaries, links, forum discussion, and a curated podcast excerpt. Those were not counted as complete original transcripts. The other six long videos remain described from official descriptions. A licensed creator-supplied transcript export would be the most reliable way to close this gap; none is available in this repository.

## Recurring themes and reporting leads

**Concentrated industrial capabilities create leverage.** The rare-earth, quartz, and Taiwan episodes repeatedly move from a resource or factory on a map to the harder-to-replace processing skills and surrounding supply chain. The useful reporting question is where substitution really fails: ore, chemical separation, components, equipment, certification, water, power, or trained staff. A marker should name the particular bottleneck and its evidence date, rather than declare that one country controls an entire industry. [Rare-earth episode](https://www.youtube.com/watch?v=BXLGV0Sj0n8), [quartz episode](https://www.youtube.com/watch?v=Y9V4jNTLGus), [Taiwan episode](https://www.youtube.com/watch?v=UWBrzzd1_yg).

**Energy links economics to policy and shipping.** The oil episodes interpret producer incentives, sanctions, ownership structures, insurance, and maritime routes. This suggests reporting on changes to specific restrictions and documented trade flows, alongside energy supply and disaster measurements. Historical Saudi-Iranian causation is the creator's interpretation; the oil transcript itself acknowledges that it is not a single-cause account of the Iranian Revolution. A sanctions designation needs a jurisdiction, effective date, legal authority, and exact entity or vessel identifier. [Oil-market repost](https://decentnewsroom.com/p/npub1fwj3ghwuuuezcdpzp95e0l0e6h8erxp3946k0vxa5f67tqr9f20s962gfv/d/2195cb5d085f6198), [shadow-oil episode](https://www.youtube.com/watch?v=IWj39ekjwcE).

**Investment promises must meet physical and labor constraints.** AI, freight, and both space episodes connect capital spending with power, transport, launch throughput, and demand. Their outlook is often optimistic and uses historical analogies. Preserve the alternative explanation: new investment can coexist with displaced workers, unprofitable firms, delays, and an uneven distribution of gains. These videos supply hypotheses to test, rather than a validated national growth forecast. [AI/jobs repost](https://freerepublic.com/focus/f-bloggers/4386977/posts), [freight repost](https://www.usetranscribe.io/yt/mCd9ctg1sO4/flatbed-trucking-economy), [AI-bubble episode](https://www.youtube.com/watch?v=Wcv0600V5q4).

**Space infrastructure has economic and governance consequences.** The creator emphasizes reusable transport, vertically integrated services, crowded orbital resources, and possible lunar supply infrastructure. Distinguish operating satellites and recorded launches from company plans, modeled future margins, or predicted resource extraction. National licensing and international spectrum coordination are part of that story. [Starship repost](https://www.usetranscribe.io/yt/DlXb3zSLdFY/elon-musk-starship-reason), [space-frontier repost](https://www.usetranscribe.io/yt/t_jGAK0LRRk/spacex-america).

**Institutions and feedback loops matter locally as well as globally.** The socialism, fashion, and Airbnb descriptions cover price signals, central planning, narrative-driven demand, zoning, and tax changes. Keep definitions and competing interpretations visible: a political label or persuasive title is not a neutral finding. Local housing rules need local sources and current dates. [Political-economy episode](https://www.youtube.com/watch?v=mMHyhneAxXY), [fashion episode](https://www.youtube.com/watch?v=DA-CozY2isc), [Airbnb episode](https://www.youtube.com/watch?v=aIK8f8nX8xs).

These are recurring themes in this selected channel material, **not an exhaustive survey of global tensions**. An open journalism platform also needs independent regional reporting, affected communities, and primary records on issues the channel scarcely covers. Popularity, repetition, or a dramatic title does not determine an event's importance or truth.

## Representative primary-source checks

| Claim or reporting lead | Primary evidence read | What the evidence supports and limits |
| --- | --- | --- |
| Rare-earth processing concentration | [IEA Rare Earth Elements executive summary](https://www.iea.org/reports/rare-earth-elements/executive-summary) | For **magnet rare earths in 2024**, China accounted for 60% of mining, 91% of refined output, and 94% of sintered permanent magnets. These are distinct stages and denominators, not one interchangeable “rare-earth share.” |
| Export controls and diversification | [IEA Global Critical Minerals Outlook 2026](https://www.iea.org/reports/global-critical-minerals-outlook-2026/executive-summary) | The report describes April 2025 controls and says the expanded October 2025 measures were suspended until November 2026. It also reports a modest 2025 decrease in rare-earth refining concentration from US/Malaysian capacity. Do not render every announced control as currently active, or scenario exposure as realized losses. |
| High-purity quartz in chip supply chains | [The Quartz Corp's production and application description](https://www.thequartzcorp.com/high-purity-quartz) | The producer explains Spruce Pine's prized geology and quartz crucibles used to grow silicon ingots. This interested-party source supports an important input and process. It does **not** establish the video's universal claim that advanced chips could never be manufactured without that single deposit. Its Norwegian registered office is not proof of a separate Norwegian ore deposit. |
| Industrial growth and AI productivity | [BLS productivity release, 3 September 2026](https://www.bls.gov/news.release/archives/prod2_09032026.htm) | Revised Q2 2026 nonfarm-business productivity grew 1.4% at a quarterly annualized rate and 2.2% year over year. Those are different measures. The release does not establish the freight video's causal story or identify an AI contribution. |
| Automation and new jobs | [Autor et al., NBER working paper and published-paper record](https://www.nber.org/papers/w30389) | Historical research finds substantial new work and changing patterns of job creation. It does not guarantee that current AI will preserve every occupation or worker's income. The study spans **1940–2018**, so preserve that period rather than silently changing it to an unspecified recent 50 years. |
| Sanctions and Iranian oil | [US Treasury teapot-refinery alert, 28 April 2026](https://home.treasury.gov/news/press-releases/sb0476), [OFAC license change, 7 July 2026](https://ofac.treasury.gov/recent-actions/20260707) | These document US agency estimates, enforcement guidance, and changing license rules. The alert estimates China's share of Iranian exports at about 90%; attribute that to Treasury. Sanctions and exemptions are jurisdiction- and date-specific. The video's “nobody” title is not a universal legal prohibition. |
| Satellite resources and ownership | [ITU satellite regulation and coordination](https://www.itu.int/en/mediacentre/backgrounders/Pages/Regulation-of-Satellite-Systems.aspx), [Outer Space Treaty text](https://www.unoosa.org/oosa/en/ourwork/spacelaw/treaties/outerspacetreaty.html) | ITU describes national licensing, frequency coordination, and international recording. Treaty Articles II and VI address national non-appropriation and state supervision. Early deployment is not automatically ownership of an orbital band or the Moon. The literal “no gatekeepers” interpretation is unsupported. |

This is a sample of substantive checks, not a verification of every number in six reposts or thirteen descriptions. No military-outcome prediction, comprehensive oil-price ceiling, audited SpaceX margin, or causal AI employment estimate was established here.

## Implications for the journalism platform

1. Publish discoverable **source-linked reports** with outlet/agency, observation time, publication time when known, retrieval time, and the exact scope of the claim. Keep commentary, measurements, official allegations/designations, and forecasts visibly distinct.
2. Use the channel's themes as search categories: critical minerals and chips; energy and maritime trade; sanctions and policy; AI, labor, and infrastructure; space. Add regional and humanitarian coverage beyond this channel.
3. Separate an event's location from places mentioned in an article and from the publisher's country. A country-name search is a topic match, not a verified incident coordinate. Broad country findings should appear at country level with that precision stated.
4. Group related coverage while preserving each link and author. Syndicated stories or articles based on the same press release are not independent corroboration. Do not derive a truth or war-probability score from volume or sentiment.
5. Connect stories to open measurements and primary records before making claims of disruption: official mineral production, releases of energy statistics, dated sanctions changes, hazards, and documented infrastructure. An earthquake near a factory alone does not prove the factory stopped.
6. Keep the transcript gap visible. Link to the creator's video and reviewed text source, publish only original short summaries, and seek creator permission before reproducing a transcript corpus. Future retrieval should use supported access and stop when a provider refuses it.

Additional sources and their practical integration conditions are in [`OPEN_SOURCES.md`](OPEN_SOURCES.md). Implemented intelligence providers and their actual freshness behavior are documented separately in [`INTELLIGENCE_SOURCES.md`](INTELLIGENCE_SOURCES.md).

## Dated Shorts in the window

These **52 entries are metadata inventories**, not full transcript reviews. Several are clips of longer episodes, including clips published in this window from long videos originally published earlier. Sponsored clips are present; they are not independent economic evidence. Their dates alone do not establish a new underlying event.

| Published | Short | ID |
| --- | --- | --- |
| 2026-09-05 | [How Taiwan built a chip city  #business](https://www.youtube.com/watch?v=UBiT14hsgKA) | `UBiT14hsgKA` |
| 2026-09-03 | [The reusable rocket was the most expensive way to reach orbit. Until it wasn't #space #business](https://www.youtube.com/watch?v=DPbMOC0k-OM) | `DPbMOC0k-OM` |
| 2026-08-12 | [Same car for 30 years. Ten-year wait to get a new one](https://www.youtube.com/watch?v=ZL-70QvCNfY) | `ZL-70QvCNfY` |
| 2026-08-11 | [Ask 10 people what socialism is. You'll get 10 answers](https://www.youtube.com/watch?v=O8PXdwknlfU) | `O8PXdwknlfU` |
| 2026-08-04 | [A refinery in the sky #space #business](https://www.youtube.com/watch?v=_-Tb5c-C7Rs) | `_-Tb5c-C7Rs` |
| 2026-07-29 | [The grocery store has become a groceraunt: grocery plus restaurant](https://www.youtube.com/watch?v=Q2saGr07ego) | `Q2saGr07ego` |
| 2026-07-27 | [Being the landlord and tenant, you dont negotiate or worry the tenant walks, you collect both checks](https://www.youtube.com/watch?v=qL7OKwLghPg) | `qL7OKwLghPg` |
| 2026-07-24 | [$800,000 to build. $7 million earned. Then it burns up on purpose.](https://www.youtube.com/watch?v=qvlQfjZlVds) | `qvlQfjZlVds` |
| 2026-07-09 | [July 9, 2026](https://www.youtube.com/watch?v=0BOCyHPLrnY) | `0BOCyHPLrnY` |
| 2026-07-08 | [Is AI going to take my job?](https://www.youtube.com/watch?v=CosquplBAkg) | `CosquplBAkg` |
| 2026-06-30 | [Pure unmet demand](https://www.youtube.com/watch?v=p6MrsQHPe_c) | `p6MrsQHPe_c` |
| 2026-06-17 | [Six steps from boat to counter, cut to three. Same price, everyone gets paid more, fresher fish.](https://www.youtube.com/watch?v=0Wuf9P6PkG8) | `0Wuf9P6PkG8` |
| 2026-06-16 | [The tokenmaxxing era is over](https://www.youtube.com/watch?v=ZJ7WYtTPy90) | `ZJ7WYtTPy90` |
| 2026-06-12 | [Space has the properties of things that become bubbles](https://www.youtube.com/watch?v=9xltCNauU_M) | `9xltCNauU_M` |
| 2026-06-11 | [You could make a lot of money counting cars with access to one of the satellites that could do it](https://www.youtube.com/watch?v=th59SSPj3Gc) | `th59SSPj3Gc` |
| 2026-06-11 | [SpaceX doesn't sell rockets anymore. The rockets are the factory](https://www.youtube.com/watch?v=5i-kvBMf6PM) | `5i-kvBMf6PM` |
| 2026-06-10 | [A new frontier hasn't opened in 100 years. Until now #spacex](https://www.youtube.com/watch?v=kgQ3VFh_aAY) | `kgQ3VFh_aAY` |
| 2026-06-07 | [The race for the most valuable parts of space #spacex #space](https://www.youtube.com/watch?v=oT9pEOydkwI) | `oT9pEOydkwI` |
| 2026-06-05 | [Two companies trained AI on the entire history of recorded music. The labels noticed](https://www.youtube.com/watch?v=SAjsbWhS7j0) | `SAjsbWhS7j0` |
| 2026-06-04 | [We think of black swans as unpredictable disasters. This was the other kind, the positive black swan](https://www.youtube.com/watch?v=uqcxhlbfzkI) | `uqcxhlbfzkI` |
| 2026-06-03 | [Cheap labor isn't why advanced factories move. It's energy](https://www.youtube.com/watch?v=x_0gb0ekZ1E) | `x_0gb0ekZ1E` |
| 2026-06-02 | [The heat is dead center, exactly where it shouldn't be](https://www.youtube.com/watch?v=eufGg_M-TgA) | `eufGg_M-TgA` |
| 2026-06-01 | [The most important signal in America isn't the Fed, stock market, jobs numbers. It's a flatbed truck](https://www.youtube.com/watch?v=eEDFkG6OQwQ) | `eEDFkG6OQwQ` |
| 2026-05-20 | [The Stone Age didn't end because we ran out of stones](https://www.youtube.com/watch?v=UzJ6VmWmYLE) | `UzJ6VmWmYLE` |
| 2026-05-16 | [Why a small town in North Carolina is America's ace in the hole](https://www.youtube.com/watch?v=t4RXuiiwDuE) | `t4RXuiiwDuE` |
| 2026-05-15 | [$3. That’s what it costs Saudi Arabia to lift a barrel of oil out of the ground.](https://www.youtube.com/watch?v=UkAxA5ASRBE) | `UkAxA5ASRBE` |
| 2026-05-14 | [The selfishly crude world of oil](https://www.youtube.com/watch?v=Sk4x1fBSNsM) | `Sk4x1fBSNsM` |
| 2026-04-10 | [Why wouldn’t they want to use US dollars?](https://www.youtube.com/watch?v=hzgqcYU02Y0) | `hzgqcYU02Y0` |
| 2026-04-02 | [That’s why the price of oil started going up and down so much](https://www.youtube.com/watch?v=yV9iyyr2IPw) | `yV9iyyr2IPw` |
| 2026-03-31 | [How to smuggle a million barrels of oil](https://www.youtube.com/watch?v=wHZfKTd2EXE) | `wHZfKTd2EXE` |
| 2026-03-30 | [What do these six areas all have in common?](https://www.youtube.com/watch?v=q477cX3xx9A) | `q477cX3xx9A` |
| 2026-03-28 | [Whoever said “necessity is the mother of all invention” was probably talking about Taiwan #taiwan](https://www.youtube.com/watch?v=ZtirzwUbQuE) | `ZtirzwUbQuE` |
| 2026-03-28 | [Great for milk oysters, terrible for computer chips #taiwan #science](https://www.youtube.com/watch?v=Z5ieYkHWAN0) | `Z5ieYkHWAN0` |
| 2026-03-27 | [The worst place on Earth to build a chip factory](https://www.youtube.com/watch?v=QOxo0ZUXHJU) | `QOxo0ZUXHJU` |
| 2026-03-25 | [Their forecasts are right suspiciously often, why?](https://www.youtube.com/watch?v=L3H10o7XrVY) | `L3H10o7XrVY` |
| 2026-03-24 | [Jeans took 100 years to become common](https://www.youtube.com/watch?v=Y_hRMhSmR_0) | `Y_hRMhSmR_0` |
| 2026-03-23 | [The shot market has reached equilibrium with the new DraftKings Predictions app! #DKPartner](https://www.youtube.com/watch?v=y1TyZV_X_Ys) | `y1TyZV_X_Ys` |
| 2026-02-25 | [Why are clothing stores shaped like that](https://www.youtube.com/watch?v=9qfyU9lecr4) | `9qfyU9lecr4` |
| 2026-02-22 | [Are my wide leg pants about to look stupid](https://www.youtube.com/watch?v=K1P1mrVeEOo) | `K1P1mrVeEOo` |
| 2026-02-02 | [There’s science and then there’s the black arts](https://www.youtube.com/watch?v=Dk_KPoZsSMo) | `Dk_KPoZsSMo` |
| 2026-02-01 | [The purest silica the world has ever seen](https://www.youtube.com/watch?v=TW_n8w2I4Dw) | `TW_n8w2I4Dw` |
| 2026-01-28 | [Saudi Arabia Has Oil, America Has This](https://www.youtube.com/watch?v=YGHBCOIzEw0) | `YGHBCOIzEw0` |
| 2026-01-15 | [The real numbers behind nuclear accidents](https://www.youtube.com/watch?v=t6eE8ALZKUs) | `t6eE8ALZKUs` |
| 2026-01-14 | [What if we just used a nuclear submarine for electricity](https://www.youtube.com/watch?v=kT5jx7TRS1Q) | `kT5jx7TRS1Q` |
| 2026-01-13 | [This is why we stopped building nuclear plants](https://www.youtube.com/watch?v=tR_inrPhXLQ) | `tR_inrPhXLQ` |
| 2026-01-05 | [Cars, refrigerators, oil, farming… Jevons Paradox frames the story of every major technology](https://www.youtube.com/watch?v=ZGED9KZ10lA) | `ZGED9KZ10lA` |
| 2026-01-04 | [Turns out people wanted more and were willing to pay for it](https://www.youtube.com/watch?v=Rs8eIJsNeac) | `Rs8eIJsNeac` |
| 2025-12-28 | [The problem was “Dark Fiber”](https://www.youtube.com/watch?v=jp_kcOa9AY0) | `jp_kcOa9AY0` |
| 2025-12-27 | [The logic for data centers the size of Manhattan](https://www.youtube.com/watch?v=-3AiEB8-T7M) | `-3AiEB8-T7M` |
| 2025-12-23 | [The hype that kicked off the bubble everyone is worried we’re repeating today](https://www.youtube.com/watch?v=vp28mgapoD8) | `vp28mgapoD8` |
| 2025-12-17 | [Pray for snow](https://www.youtube.com/watch?v=2lgvfJuv2lo) | `2lgvfJuv2lo` |
| 2025-12-16 | [Why ski resorts can’t solve their crowd problem](https://www.youtube.com/watch?v=ubnqy5F1gSs) | `ubnqy5F1gSs` |

## Listed Shorts with unresolved dates

These ten entries appear after the May 2024 portion of the public ordered Shorts listing. That order suggests older uploads, but their date requests failed, so exact dates and formal window membership remain unresolved. They are not silently included in the 52 confirmed items or claimed as fully checked.

| Listed Short with unreadable date | ID |
| --- | --- |
| [How the US became the King of Natural Gas 🔥 #economy #energy #finance #oil #lng](https://www.youtube.com/watch?v=7WhuiK3bpbw) | `7WhuiK3bpbw` |
| [Airlines are a terrible investment #economy #travel #airlines](https://www.youtube.com/watch?v=4fF1Qg-wYTI) | `4fF1Qg-wYTI` |
| [The reason oil is so cheap right now #oil #economy #finance](https://www.youtube.com/watch?v=1xzyYPJEbVU) | `1xzyYPJEbVU` |
| [Have you seen how fast Zyn is growing?](https://www.youtube.com/watch?v=qlc4J19No_c) | `qlc4J19No_c` |
| [You may hate the password sharing crackdown by Netflix, but shareholders love it](https://www.youtube.com/watch?v=vUvYcXILw28) | `vUvYcXILw28` |
| [The True King of Aerospace  ✈️ #boeing  #plane #stocks](https://www.youtube.com/watch?v=hgXw0E1uqrc) | `hgXw0E1uqrc` |
| [Is inflation going back up? #economy #inflation #oil](https://www.youtube.com/watch?v=nJqAcw0XVMQ) | `nJqAcw0XVMQ` |
| [Coal says Baltimore Port reopens in weeks instead of months #baltimore #shipping #coal](https://www.youtube.com/watch?v=OTXgqJBUdXA) | `OTXgqJBUdXA` |
| [Manufacturing is coming back to the US 🏗️ #manufacturing #semiconductors #batteries](https://www.youtube.com/watch?v=Frq2uoWWnxg) | `Frq2uoWWnxg` |
| [🚂 US will import more goods from Mexico than China within 5 years #china #mexico #unionpacific](https://www.youtube.com/watch?v=fIx8RzADgVw) | `fIx8RzADgVw` |

## Reproducibility and maintenance

The one-off inventory used the public channel/watch pages and trusted metadata tooling; no media download was performed. Raw descriptions, tool outputs, and package installation files were kept in ignored `.cache/research/`, not in the publishable artifacts. Review classifications in the JSON must change only after the corresponding content is actually read. Video titles can change; video ID is the stable join key, and earlier repost titles are recorded as such.

For a future full review, start with the 65 dated IDs plus unresolved records, obtain an authorized creator transcript export or supported public access where available, record language and automated/human status, compare edits against the source video, and preserve coverage gaps. This report is candidly incomplete with respect to the request for **all transcripts**.
