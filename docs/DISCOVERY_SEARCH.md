# Metadata discovery search

Earth Observer searches the metadata already retained from its sources. It does not download article text, infer an incident location from a country mention, or score the truth or popularity of a report.

The portable index lives in `src/core/discovery-index.js` and is shared by the scheduled snapshot reader, the hosted API and the browser. `createDiscoveryIndex()` exposes `replaceSource`, `replacePayload`, `search`, `getState` and `clear`. Replacing a source generation rebuilds only that source's canonical records and search fields; another topic query searches the existing index. A generation always identifies the complete retained source sample, never a country-filtered subset.

## Searchable fields and ordering

Every query term must match a metadata field. Text is normalized for case and accents. Terms of three or more characters may match the beginning of a metadata word; shorter terms match whole words. Search covers:

- Original titles where the source supplies them, or explicitly generated GKG topic labels.
- Every reviewed GKG topic label, including topics omitted from a compact label's first three items.
- Publisher domains, source names and categories.
- Countries mentioned in GKG articles, countries reported by GDACS, and separately identified publisher countries where supplied.

Country names and aliases are indexed alongside their two-letter codes. `Ukraine sanctions` can therefore match a GKG record with `mentionedCountries: ["UA"]` and the reviewed `SANCTIONS` theme. Its `matchReasons` identify both metadata fields. A country filter accepts a GKG mention or an official reported-country tag; publisher country does not become an incident-country filter. Legacy title-only records can match a country name in their title, accompanied by an explicit explanation that no authoritative incident-country tag was supplied.

Ordering uses the strongest metadata field match for each term, then the source timestamp and record kind, followed by bounded publisher and topic diversity. Internal ordering values are not exposed as confidence, truth or popularity scores. Browser and legacy API query results use the same shared related-report grouping while preserving relevance order; each related source keeps its original date and URL, and topic mentions never become corroboration groups. Empty-query feeds retain the original grouped/date ordering, with expired primary and related records removed. Reviewed theme identifiers normalize to their human-readable label, and a selected category gets its own compact topic label. The browser searches without sending free text to the server or provider.

## Bounds, identity and expiry

The reusable index retains at most 600 unique records and 2 MiB of serialized canonical record JSON. These limits describe the records, not total JavaScript heap size. The hosted API uses a tighter 440-record ceiling: up to 240 GDELT category records, 100 USGS reports and 100 GDACS reports before canonical deduplication. Only acquired sources are present; those maxima are not claims of actual coverage. The default display remains bounded to 80 grouped reports.

Identity is a safe canonical HTTP(S) URL plus record kind. Fragments and recognized tracking parameters are removed. Same-batch topic records for a URL merge reviewed topics, categories and country mentions. A newer batch replaces older mentions rather than attaching a newer timestamp to the older metadata. Topic records retain `publishedAt: null`, `observedAt: null` and no coordinates. Hazard reports preserve their source-provided dates and coordinates. Unused bodies, images and arbitrary fields are discarded.

Each source supplies a generation, expiry, status and coverage note. GKG records also expire individually 24 hours after their actual batch timestamp. Provider failures preserve existing retrieval times and explicit stale status; records do not gain a new date merely because another visitor searched them. Existing upstream refresh intervals and backoff are unchanged. The optional controlled live GDELT fallback uses a coarse category/country cache key and fixed query; a different local topic term does not initiate a new provider query.

`/api/intelligence` retains its existing `reports`, `sources`, filters and grouping fields and adds:

```json
{
  "indexRecords": ["canonical metadata objects"],
  "indexVersion": 1,
  "indexCoverage": {
    "schemaVersion": 1,
    "recordCount": 156,
    "byteLength": 175908,
    "maxRecords": 440,
    "maxBytes": 2097152,
    "omittedRecords": 0,
    "sources": ["id, generation, expiresAt, status, coverage, recordCount"],
    "note": "The metadata-only search coverage explanation"
  }
}
```

The numeric `indexVersion` is local to the index instance. Source generation and expiry identify reusable data across server/browser instances. `replacePayload` replaces sources described in `indexCoverage.sources`; a previously acquired source absent from a later category response remains only until its original expiry, with its original coverage and status.

## Offline verification

An actual previously retrieved GKG snapshot generated at `2026-10-11T08:47:34.825Z` contained 202 category records. Offline indexing merged these to 156 unique URL/kind records, preserving 73 publisher domains and 79 distinct mentioned countries in 175,908 serialized bytes. `Ukraine` matched six records, `Ukraine trade` four, and `Belgium` one. These counts describe this one bounded sample, not the number of news stories or incidents in those countries. The trace `.qa/discovery-index-real-fixture.json` records evaluation time, method and exact match explanations; no additional network acquisition or browser behavior was claimed.

Focused tests cover country aliases and field roles, all-term matching, the reviewed taxonomy, canonical identity, source-generation replacement, individual batch expiry, size caps, ordering/diversity, full 440-candidate API capacity, shared acquisition across queries, controlled fallback reuse and relevance after grouping. The GKG sampler additionally revisits quota-skipped rows under progressively relaxed country/publisher quotas, so eligible single-record publishers can fill the existing 80-record cap without duplicating or creating records.
