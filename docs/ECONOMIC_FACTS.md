# Official annual economic facts

Checked on 2026-10-11. The Economics & trade panel includes five World Bank World Development Indicators (WDI), source `2`. This is an annual statistical series with revisions and reporting delays. The latest available value in each series can have a different reference year.

| Indicator | Meaning and units | Official definition and rights |
| --- | --- | --- |
| `NY.GDP.MKTP.CD` | GDP in current US dollars; nominal values, not inflation-adjusted | [GDP](https://data.worldbank.org/indicator/NY.GDP.MKTP.CD) |
| `NY.GDP.MKTP.KD.ZG` | Real GDP growth, annual percent | [Real GDP growth](https://data.worldbank.org/indicator/NY.GDP.MKTP.KD.ZG) |
| `FP.CPI.TOTL.ZG` | Annual consumer price inflation, percent; national coverage | [Consumer price inflation](https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG) |
| `NE.TRD.GNFS.ZS` | Exports plus imports of goods and services as a percent of GDP; can exceed 100% | [Trade](https://data.worldbank.org/indicator/NE.TRD.GNFS.ZS) |
| `SP.POP.TOTL` | Midyear resident population estimate, people | [Population](https://data.worldbank.org/indicator/SP.POP.TOTL) |

Each of these five official indicator pages displays **CC BY 4.0**. The [World Bank data terms](https://data.worldbank.org/summary-terms-of-use) allow reuse under that license where no specific exception applies and require attribution to the World Bank and relevant data providers. This allowlist does not grant rights to arbitrary World Bank indicators or third-party datasets. Adding a series requires checking its individual page and metadata first.

GDP, growth and trade credits identify national statistical offices, central banks, OECD and World Bank staff estimates. Inflation credits identify the IMF International Financial Statistics. Population credits identify UN Population Division and Statistics Division, national statistical offices and Eurostat. The UI shows the indicator link, units, provider credits, dataset link, license and terms; API records carry those fields too. Definitions are paraphrased, with official source links for full methodology.

## API and dates

`GET /api/economics?country=BE` accepts the supported World Bank two- or three-letter economy codes and the explicitly allowed `WLD` world aggregate. `BE` and `BEL` share one canonical cache entry. The [official country/economy registry](https://api.worldbank.org/v2/country?format=json&per_page=400) contained 217 nonaggregate economies on the check date. These are economies recognized by this dataset, including territories; the selector does not assert sovereignty or political recognition. Other aggregates and arbitrary upstream URLs are rejected.

The fixed upstream call requests exactly the five reviewed series, `source=2`, the ten most recently completed calendar years, JSON, at most 100 records and available footnotes. Semicolon-separated indicators, source selection, date ranges and footnotes are documented in the [official API call structures](https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures). The live composite response returns `sourceid: null`; the normalizer accepts that documented request's response while binding its source through the fixed URL and each indicator's independently checked source-2 metadata. Any other declared source ID is rejected.

`year` belongs to the statistical observation. `datasetUpdatedDate` is the dataset update date supplied by the API, not an individual observation's release date. `retrievedAt` is when Earth Observer completed and validated the fetch. True zeroes stay zero, null values remain missing, and histories retain gaps without interpolation. The UI neither converts indexing/retrieval dates into observation years nor labels these annual series live.

## Resource and availability limits

There is no startup polling. A visible, opened economic panel requests its selected economy; closing the panel or changing the country cancels its own UI request and prevents late responses from replacing another country's facts. The backend shares concurrent requests for the same canonical economy, permits at most four distinct requests at once and retains at most 40 cached economy responses. Responses have a 256 KiB body limit, a 15-second timeout and no redirects.

Validated annual responses are fresh for 24 hours. After a failed refresh, the same economy's previous values remain explicitly marked stale for at most seven days after retrieval. Provider failures use an exponential cooldown, honoring bounded `Retry-After` values. No data or an expired copy produces an unavailable state with an empty indicators array. Browser cache age uses its actual stored timestamp; a saved stale/offline copy is labeled and a successful background update refreshes the displayed values.

The hosted Worker also reuses strict, minimal annual snapshots in `EARTH_STORE` across instances. Each of the 218 supported economy keys (including World) has one finite storage location. A restore is lazy and coalesced with its requested economy's refresh; no startup scan or background polling is introduced. Each snapshot is limited to 50 observations and 64 KiB, validates country and canonical dates, and reconstructs credits/definitions from the reviewed catalog. Storage operations have a one-second optional deadline and cannot turn valid upstream data into a provider failure. The original retrieval date remains authoritative; the HTTP age header advances on edge hits, and ready response caching stops at the remaining 24-hour freshness boundary.

## Validation evidence

Thirteen focused backend/UI tests cover country/filter rejection, true zeroes and null gaps, source and observation validation, canonical request sharing, LRU/pending bounds, response caps, cooldown/staleness expiry, country-switch cancellation, annual formatting and browser cache revalidation. Synthetic test values are not real country statistics.

The official live Belgium batch was retrieved and normalized on 2026-10-11: 50 observations across the five series, dataset update date `2026-10-08`, with the latest reference year `2025` for each series. A subsequent actual Node provider call returned `ready` in 276 ms. Earlier cold requests timed out; the implementation reported unavailable and did not manufacture fallback values. This verifies one live country response and the fixed protocol, not the completeness or timeliness of every supported economy.
