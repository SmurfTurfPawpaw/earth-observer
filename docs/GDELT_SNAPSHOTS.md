# Shared news discovery snapshots

The scheduled path publishes bounded GDELT headline/link metadata to this repository's `intelligence-data` release as the single asset `gdelt.snapshot.json`. Earth Observer reads a shared dated sample instead of sending a new GDELT query for every visitor. The asset contains no article bodies, photographs, thumbnails or generated claims.

## Contract

`schemaVersion: 1` has `generatedAt`, `source`, `coverage` and three `categories`: `geopolitics`, `economy`, `disasters`. Each category records its exact fixed `queryUrl`, the actual completed retrieval time and at most 80 normalized reports. The queries use the application's reviewed category terms, ArticleList JSON, the last 24 hours and date-descending indexing order. Arbitrary countries, user search strings and upstream URLs do not enter the scheduled queries.

Every report preserves its original publisher link, title, publisher name/country, language and GDELT `indexedAt` time. Original `publishedAt` and `observedAt` remain null because this API does not establish them. The category `retrievedAt` belongs to the completed fetch; `generatedAt` follows completion of the whole batch and precedes release upload. These timestamps do not represent independent fact verification. Related reports start empty; the consumer's grouping is indicative and may include syndicated coverage.

The [official DOC API documentation](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) describes this discovery API. [GDELT terms](https://www.gdeltproject.org/about.html#termsofuse) allow reuse of GDELT data with attribution/link; they do not grant rights to publisher article text or imagery. Earth Observer keeps the GDELT credit and publisher links and exposes metadata only. A discovery sample is neither complete world coverage nor proof of a reported event.

## Generation and failure behavior

`scripts/gdelt-snapshot.mjs` makes at most three sequential requests, with request starts at least 6 seconds apart (6.1 seconds by default). Each has a 15-second timeout, no redirects, a 2 MiB body limit and at most 80 raw articles. The final JSON must fit within 1 MiB. It never retries a failed query in the same run.

All three categories must validate before any snapshot is written. HTTP 429, other HTTP errors, timeout, malformed metadata or an oversized body produces `status: skipped` and no asset write/upload. The existing local file and previously published release survive these skipped runs. A successful empty query is an honest empty sample, not a provider failure. The local writer stages a temporary file and renames it after complete generation.

`.github/workflows/intelligence-data.yml` requests a run at minutes 17 and 47 each hour and supports manual dispatch. GitHub schedules can be delayed; displayed source timestamps remain authoritative. The workflow runs only in `SmurfTurfPawpaw/earth-observer`, serializes publication, uses a scoped repository token, and replaces this one asset only on `status: generated`. No growing archive or binary files are committed to Git.

GitHub release replacement with `--clobber` is not a transactional publication system: a failed upload during replacement can remove the old asset. The reader's last validated cache and optional persistent store cover that case; invalid/unavailable assets do not become fresh data. Upstream rate limits and skipped generation preserve the release because no upload starts.

The shared reader validates the fixed schema and canonical metadata, caches retrievals for 30 minutes and expires generated snapshots after 24 hours. Country and text filtering of the scheduled sample happens locally and carries a bounded-sample coverage note. A news mention or publisher country is not authoritative incident geography. The reader retains actual generation/category retrieval times and explicit stale/unavailable states. Where direct-query fallback is enabled, it keeps the existing provider spacing, bounded cache and failure backoff.

## Checks and live coverage

Four focused generator tests verify exact fixed queries, at least six-second spacing, indexing/retrieval separation, stripping article bodies and images, no retries after rate limiting, no partial or oversized replacement, and complete empty-sample publication. Reader and route tests cover consumption separately.

The prior direct GDELT probe on 2026-10-11 returned HTTP 429 with an instruction to limit requests to one per five seconds. This was actual rate limiting, not evidence of a query-format error. One actual scheduled-generator run on the same date made its first geopolitics request and returned `status: skipped`, `reason: GDELT metadata unavailable or invalid; previous snapshot preserved`. It made no further category requests and wrote no asset. That run did not produce a usable live news snapshot. The 429 came from the separate direct probe; the generator's generic invalid/unavailable result does not establish its exact upstream failure. Synthetic tests do not prove current news coverage.
