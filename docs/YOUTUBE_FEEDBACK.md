# Original creator YouTube feedback

Collected and reviewed on **2026-10-11**. This report concerns **Bilawal Sidhu**, the original God’s Eye View creator, separately from [Maxinomics research](MAXINOMICS_RESEARCH.md). It reviews a bounded public comment sample rather than a complete channel archive or a user survey.

## Identity and coverage

The [upstream project README](https://github.com/bilawalsidhu/gods-eye-view#readme) links the creator’s [official channel](https://www.youtube.com/@bilawalsidhu) and the open-source launch video. The official watch pages for all three selected videos identify **Bilawal Sidhu** and the same channel ID, `UC7bGK0A1weWfNaRfO0hGVdg`. The launch video’s official description links the other two videos and the upstream repository. Titles below are the titles returned by the official watch pages at collection; indexed titles elsewhere can be older.

| Official video | Publication date from official metadata | Top-level comments reviewed | Comment count reported by public section |
| --- | --- | ---: | ---: |
| [We Got Open Source God’s Eye Before GTA 6](https://www.youtube.com/watch?v=GRJaKcXZS94) | 2026-08-24 | 100 | ~1,630 |
| [Ex-Google PM Builds God's Eye to Monitor Iran in 4D](https://www.youtube.com/watch?v=0p8o7AeHDzg) | 2026-03-03 | 100 | ~4,859 |
| [Ex-Google Maps PM Vibe Coded God's Eye In a Weekend](https://www.youtube.com/watch?v=rXvU7bPJ8n4) | 2026-02-24 | 100 | ~1,567 |

**300 comments were retrieved and read:** the first 100 top-sorted, top-level comments on each video. Reply threads were deliberately excluded. The displayed totals above include comments outside this sample and are approximate upstream totals, not totals we reviewed. Top sorting favors popular and older discussion; YouTube can also personalize ordering. This sample cannot establish what a majority of viewers want, quantify all feature requests, or represent every language or later upload. Praise, jokes, allegations and repeated requests to open-source the already-released project dominate much of the sample; those are weak evidence for new product scope.

Method: ordinary unauthenticated HTTPS requests retrieved each official watch page; the public comment continuation actually embedded in that page was then followed using the installed `yt-dlp` comment parser, capped at 100 top-level comments per video. No video media was downloaded; no account cookies, private endpoint authorization, proxy, or generated continuation for unavailable comments was used. Comments were accessible even though official captions in the separate Maxinomics study were not. These are different endpoints and different availability results.

Each cited permalink below is constructed from a real comment ID returned in the official public comment response. The web search tool could not render the comment body on direct `lc=` permalink opens; this report’s comment evidence comes from the actual public response rather than search snippets. Raw comment text is kept only in the ignored local research cache; this document publishes original short paraphrases and links. User handles and relative publication labels are reproduced as supplied; approximate `yt-dlp` timestamps are not converted into invented exact publication dates. A comment can later be edited or removed.

## Findings that matter for this project

1. **Show provenance, timestamps and what a source can establish.** An explicit request asks for source vetting and visible certainty levels ([@B01](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=Ugz9UxicuvSV4TslpIp4AaABAg)). Several commenters separately question the claim that a satellite pass proves a specific intelligence task ([@JonoSeneff](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=UgwCxziFStfi_5qbooB4AaABAg); [@DentedToolbox](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=Ugxl1R1LI3OHlRG__sh4AaABAg); [@dontanton7775](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=Ugyr9A-Ld0jtAyekiQl4AaABAg)). For Earth Observer, label satellite positions as propagated orbital estimates, show element epochs, and avoid inferring imaging target or mission intent from a pass. For news, show the publisher, publication/index times, links and verification state; multiple syndicated copies do not become independent corroboration. A numerical confidence score needs a defined method and supporting evidence.

2. **Make historical context a deliberate, separate view.** Requests describe seeing what else happened at the same historical moment and reconstructing previous places ([@BlackHoleForge](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugz_V5rPorYat--CF9J4AaABAg); [@Brasileirocansado-01](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgwM-geXgJEWDuSu2Eh4AaABAg)); another requests retained past evidence ([@MarcSpctr](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=UgxcDOsLTGaVO-pn3VN4AaABAg)). Start with dated articles and licensed saved observations in a timeline. Show the selected period, archive provenance, gaps and the difference between the event date and the date a source was published. A historical city model would require its own evidence and licensing work; present reconstructed geometry as a reconstruction.

3. **Keep mapped ALPR locations useful and precise.** Two direct requests seek a Flock camera layer; another proposes UK ANPR location coverage ([@subwaysnacker](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgzztPlgBQkRJTuaorp4AaABAg); [@badlicious](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgzqUyOKz-51REyaoWt4AaABAg); [@Absentzak](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgyE04ZVIUL2quZjVOB4AaABAg)). The already retained OpenStreetMap ALPR location layer answers a useful part of that demand. The feature card should say these are mapped locations and tags, with contributor/source credit and incomplete coverage. They are neither plate records nor access to private Flock camera footage. A commenter’s suggestion of private camera availability is not a clearance or an integration contract.

4. **Explain coverage gaps and freshness.** A comment flags missing aircraft with inactive transponders; another flags regional CCTV limits ([@anthonyfickas3435](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgzDiZdoW_juK6oHRER4AaABAg); [@oranhunter2286](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgwGUeJNrKJzIc4UkFR4AaABAg)). Selected entities and layer status should expose provider, last observation or retrieval time, geographic coverage and stale/unavailable state. Empty results should be distinguishable from a failed provider. Missing receiver observations do not establish that an aircraft or an event does not exist.

5. **Make the hosted product immediately understandable.** Direct requests seek a usable link and beginner installation guidance ([@relife-s](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=Ugxgl5Z-vM-7hlhSW7N4AaABAg); [@qbertatx](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugy4yvs4JiHAB5awLtJ4AaABAg)), while one comment calls the original interface overwhelming and another requests fewer effects ([@JFomo](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgwYAzhNVle3LkKpRc14AaABAg); [@Superman-8Ball](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgzIr2atdAdGZ0JbXOt4AaABAg)). The lean hosted globe, clear search, sensible defaults, short in-app help and shareable scenes are good responses. Retain technical deployment instructions in the repository for people who choose to self-host.

6. **Keep operating cost and source rights visible.** Comments ask about API expenditure and correctly distinguish public availability from permission to reuse a feed ([@cheese22](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgwE35JliG-7e1M24HZ4AaABAg); [@sadprom](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugx6UfFCr7RM08zieXR4AaABAg); [@debbyrates2110](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgzhdD4ZZaMbiqrkZbt4AaABAg)). Cache common public data, use bounded refresh rates, and document which integrations need registered credentials. The [provider policy](DATA_POLICY.md) and [open-source integration shortlist](OPEN_SOURCES.md) provide actual provider evidence; comments do not establish license rights.

7. **Add economic context through licensed statistical feeds.** One direct request asks for food-price data ([@Redranddd](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=Ugy6H4Wp8tpnp5UsHlR4AaABAg)); documentary and journalism interest appears separately ([@cheese22](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgwE35JliG-7e1M24HZ4AaABAg); [@QuasarSeraphim](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=UgyeWvhN4vaYSyOR-5d4AaABAg)). World Bank, Eurostat, BLS and EIA indicators are a stronger first step than indiscriminate retailer scraping. A country indicator must show units, reference period and release date. Annual national series cannot truthfully become real-time local grocery prices.

8. **Treat immersive modes and high-resolution remote sensing as later work.** VR/AR appears in several direct requests ([@zetapal](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugw5AL6sYYzPnVPnS514AaABAg); [@DonCurlyOny](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugwnuvwn4ZZm-pMBlvl4AaABAg); [@04dram04](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugz7CM1ndm80K-PRQq14AaABAg)); a research user requests SAR, higher-resolution imagery and blending ([@saverblade](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=Ugxj9viGHe7KeWHO12V4AaABAg)). These are plausible extensions, but they need platform support, a performance budget and source-specific clearances. A request naming ICEYE, Umbra or Maxar does not mean their imagery is open. The first journalistic version benefits more from readable evidence and dated context than a VR renderer.

The sample also includes requests for individual surveillance, private camera data and network-device search. They are not selected product recommendations: the product here is a public-evidence journalism platform, and a public comment supplies neither private data nor permission to access it. Comments making accusations or geopolitical claims were not treated as evidence of those claims.

## Immediate implementation recommendations

These are recommendations from the reviewed sample, **not claims that every item has already shipped**:

| Priority | Concrete change | Evidence | Acceptance check |
| --- | --- | --- | --- |
| First | A source card with observation/publication time, retrieval time, source link and coverage note | C06–C11, C26 | A reader can identify what was observed, estimated, indexed or unavailable; stale data is visibly dated. |
| First | Clear live versus archive states, including the retained fire archive and future news timeline | C04, C05, C24 | Changing the article window does not imply that flight/camera observations came from the same past time. |
| First | ALPR location labels and publisher/source links in feature details | C01–C03, C16 | Selecting a marker says it is a mapped camera location and exposes its actual source. |
| First | Fast initial globe, real loading/error states, simple help and URL sharing | C12, C13, C17, C18 | A new visitor can navigate, identify active layers and share the current scene without installation. |
| Next | Region/time/topic filters for news, plus dated national economic indicators | C04, C06, C14, C20, C25 | Article identity, publisher and dates survive filtering; economic units/reference periods stay visible. |
| Next | Licensed evidence export with source links and coverage warnings | C14, C24, C26 | A download preserves dates, source IDs and original links; it does not redistribute unlicensed article bodies. |
| Later | Optional immersive navigation and cleared remote-sensing imagery | C19, C21–C23 | New rendering and imagery pass separate performance and provider checks before becoming defaults. |

## Selected comment evidence

Labels C01–C26 refer to **26 selected comments out of the 300 reviewed**. They are illustrative evidence, not frequency estimates. Paraphrases below are written for this report; no full comment dataset is published.

| ID | Official comment permalink / public handle | Relative publication label at retrieval | Original short paraphrase |
| --- | --- | --- | --- |
| C01 | [@subwaysnacker](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgzztPlgBQkRJTuaorp4AaABAg) | 1 month ago | Requests a mapped Flock camera layer for public awareness. |
| C02 | [@badlicious](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgzqUyOKz-51REyaoWt4AaABAg) | 1 month ago | Also asks for a Flock camera layer. |
| C03 | [@Absentzak](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgyE04ZVIUL2quZjVOB4AaABAg) | 1 month ago | Proposes UK ANPR location coverage if official notification records can be obtained. |
| C04 | [@BlackHoleForge](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugz_V5rPorYat--CF9J4AaABAg) | 1 month ago | Wants to compare a place with historical events occurring elsewhere at the same time. |
| C05 | [@Brasileirocansado-01](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgwM-geXgJEWDuSu2Eh4AaABAg) | 1 month ago | Proposes historical city and civilization reconstructions from scholarly evidence. |
| C06 | [@B01](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=Ugz9UxicuvSV4TslpIp4AaABAg) | 7 months ago | Requests a visible certainty level and backend source vetting for reported events. |
| C07 | [@JonoSeneff](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=UgwCxziFStfi_5qbooB4AaABAg) | 7 months ago | Challenges the inference that satellite passes establish deliberate orbit changes or specific imaging tasks. |
| C08 | [@DentedToolbox](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=Ugxl1R1LI3OHlRG__sh4AaABAg) | 7 months ago | Questions whether ordinary orbital passes establish a connection with a conflict. |
| C09 | [@dontanton7775](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=Ugyr9A-Ld0jtAyekiQl4AaABAg) | 7 months ago | Warns against describing an ordinary satellite orbit as dispatching a satellite to a scene. |
| C10 | [@anthonyfickas3435](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgzDiZdoW_juK6oHRER4AaABAg) | 7 months ago | Highlights that aircraft with inactive transponders do not appear in ADS-B observations. |
| C11 | [@oranhunter2286](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgwGUeJNrKJzIc4UkFR4AaABAg) | 3 weeks ago | Notes that available CCTV coverage is restricted to specific regions. |
| C12 | [@qbertatx](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugy4yvs4JiHAB5awLtJ4AaABAg) | 1 month ago | Requests a beginner-friendly installation tutorial. |
| C13 | [@relife-s](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=Ugxgl5Z-vM-7hlhSW7N4AaABAg) | 7 months ago | Asks for a direct link to explore the project. |
| C14 | [@cheese22](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgwE35JliG-7e1M24HZ4AaABAg) | 7 months ago | Sees documentary uses and requests a breakdown of project and API costs. |
| C15 | [@sadprom](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugx6UfFCr7RM08zieXR4AaABAg) | 1 month ago | Raises API running costs as a concern. |
| C16 | [@debbyrates2110](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=UgzhdD4ZZaMbiqrkZbt4AaABAg) | 1 month ago | Points out that public availability does not itself grant commercial reuse rights. |
| C17 | [@Superman-8Ball](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgzIr2atdAdGZ0JbXOt4AaABAg) | 7 months ago | Requests a simpler visual style and more practical infrastructure layers. |
| C18 | [@JFomo](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgwYAzhNVle3LkKpRc14AaABAg) | 7 months ago | Finds the interface overwhelming. |
| C19 | [@saverblade](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=Ugxj9viGHe7KeWHO12V4AaABAg) | 7 months ago (edited) | Requests SAR, geological imagery, better resolution and image blending for remote-sensing research. |
| C20 | [@Redranddd](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=Ugy6H4Wp8tpnp5UsHlR4AaABAg) | 7 months ago | Requests food-price data collection. |
| C21 | [@zetapal](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugw5AL6sYYzPnVPnS514AaABAg) | 1 month ago | Requests a VR version. |
| C22 | [@DonCurlyOny](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugwnuvwn4ZZm-pMBlvl4AaABAg) | 1 month ago | Requests VR or AR with hand interaction. |
| C23 | [@04dram04](https://www.youtube.com/watch?v=GRJaKcXZS94&lc=Ugz7CM1ndm80K-PRQq14AaABAg) | 1 month ago | Also requests a complete VR mode. |
| C24 | [@MarcSpctr](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=UgxcDOsLTGaVO-pn3VN4AaABAg) | 7 months ago | Wants past source records retained for later investigation. |
| C25 | [@QuasarSeraphim](https://www.youtube.com/watch?v=0p8o7AeHDzg&lc=UgyeWvhN4vaYSyOR-5d4AaABAg) | 6 months ago | Sees potential value for accurate journalism. |
| C26 | [@GBakalkinOpenAITeam2](https://www.youtube.com/watch?v=rXvU7bPJ8n4&lc=UgzV-PqsuUrx9-MBm554AaABAg) | 7 months ago | Asks how generated traffic is checked and how the software is validated. |

## Primary checks behind the data recommendations

Comment authors are not technical authorities. CelesTrak describes SGP4 as an orbital propagator used with GP elements to produce satellite position and velocity estimates; it also explains why observation/model differences and element updates matter. This supports presenting the globe’s positions as predictions tied to an element epoch. The public elements used by the renderer do not supply a camera’s aim or establish surveillance intent. [CelesTrak orbit determination](https://www.celestrak.org/columns/v01n06/), [CelesTrak SGP4 software tutorial](https://celestrak.org/software/tutorials/sgp4.php).

The FAA describes ADS-B Out as onboard position determination followed by broadcasts received by surveillance systems, and its FAQ explains range and line-of-sight limitations. The report adopts the practical coverage warning rather than a commenter’s unsupported claim that all military aircraft must always transmit. [FAA surveillance systems](https://www.faa.gov/air_traffic/publications/aim_html/chap4_section_5.html), [FAA ADS-B FAQ](https://www.faa.gov/air_traffic/technology/adsb/faq).

For economic indicators, news discovery and humanitarian/conflict data, current API terms, registration requirements and reuse boundaries are recorded with primary citations in [OPEN_SOURCES.md](OPEN_SOURCES.md). This feedback report does not expand the runtime provider allowlist.
