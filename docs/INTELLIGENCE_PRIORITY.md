# Demand-guided metadata sampling

The scheduled GKG generator can use Earth Observer's public, rounded demand summary to retain more metadata matching reviewed topic and explicitly entered country interests. This guides **sampling**, not truth, importance, independent confirmation or representative public opinion. Counts mean accepted actions, not unique people.

## Fixed acquisition and fallback

`scripts/gdelt-snapshot.mjs` remains the single scheduled entry. Its CLI enables the priority reader unless `INTELLIGENCE_DEMAND_PRIORITY=0`; programmatic `generateGkgSnapshot` retains its balanced default unless passed `demandPriority:true`.

For a new GKG batch, the generator makes one extra GET to exactly `https://giovannicallebaut.com/api/discovery/demand/summary`, in parallel with the existing official archive request. The summary request has no credentials, authorization, POST body or arbitrary URL, refuses redirects, has a 3-second default deadline (hard maximum 5 seconds) and a 64 KiB decoded limit. Already-processed batches do not request demand again.

The reader accepts only the finite reviewed subject/country catalog, exact public schema, today's seven-UTC-day window, threshold of 300 actions and multiples of 100. It refuses unknown fields, raw queries, publisher subjects, duplicate groups, unsupported countries, exact unrounded counts, stale windows, HTML, redirects and excessive bodies. Missing/disabled/empty/invalid/unavailable summaries preserve the balanced baseline, including the original 10,000-candidate reservoir. A global all-topics overview alone also preserves that baseline.

There is still only one fixed official update manifest and one permitted timestamped GKG archive per newly processed batch. Demand does not request additional archives or query the DOC API, change polling, or crawl publisher pages. No publisher article, photo or arbitrary visitor query is acquired.

## Bounded selection

With usable focused interests, the same 10,000-candidate parsing budget supports at least an 8,000-record global deterministic hash reservoir and at most a 2,000-record focused reservation. Unused focused capacity stays with the global sampler: without any matching focused rows it retains the original 10,000 records. Capacity is trimmed before new focused entries are added, so combined stored candidates never exceed the existing cap. The focused portion is stratified across published interests, with coarse weights 1–4 derived only from already rounded public buckets. Duplicate URL/category candidates are collapsed. A scarce demanded match therefore has a chance to survive a dense batch without increasing memory/candidate caps. Focused quotas cannot recover records absent from the downloaded batch or previously omitted rolling snapshots.

The existing country/publisher-balanced selection is still computed for each category. At least its first 60 of 80 records are preserved. No more than 20 slots per category can favor matching interests. Focused slots are allocated fairly with coarse weights; added records prefer less represented publishers, primary mentioned countries and reviewed themes. Focused additions cap at two per publisher domain, eight per primary mentioned country, eight per reviewed theme and eight per interest. Unused focused slots backfill from the balanced sample. Categories stay geopolitics/economy/disasters with at most 80 records each; demand cannot transfer all capacity to one popular category.

Country matching checks mentioned countries, not GPS, publisher nationality or incident location. Broad category interests guide only sampling within that existing category; a global overview never receives a focused reservation. Previous records only qualify while their batches remain inside the original 24-hour rolling window.

All selected records retain the exact original URL, reviewed labels, source, batch, retrieval/index times and machine-extraction caution. No popularity score or verification status is inserted into the snapshot. Normal consumer validation, archive integrity checks, 1 MiB output cap and preserve-last-good failure behavior remain. Generation logs report only the sampling mode and number of published interests, not raw searches or private events.

The reservation can improve useful topic/country coverage in a bounded sample; it cannot promise complete coverage or inclusion of every public interest. Popularity is not evidence that a claim is accurate. A missing match still does not establish absence.

## Verification

Synthetic tests cover strict schema/source/deadline/byte guards, unavailable/disabled byte-identical fallback, fair candidate budgets, scarce-match rescue, at least 60 baseline records, focused topic/country/publisher caps, unchanged provenance/verification, snapshot validation and the real scheduled generator integration with a tiny synthetic ZIP. They make no real summary POSTs, visitor counts, publisher requests or R2 writes.
