# Bounded USGS catalog archive operation

This importer is an owner-operated acquisition tool. Visitors read retained scenes;
they never fetch a provider, write an archive, or receive an import credential.
The only admitted dataset is `usgs-catalog-m4.5-v1`: reported earthquakes with
magnitude at least 4.5. It is distinct from the bounded live summary feed.

## Completion gate

1. Count the fixed official FDSN interval, then acquire its unsliced GeoJSON.
2. Preserve the exact original bytes and verify all features against that count,
   interval, threshold, identity and geometry. Split dense responses with deliberate
   endpoint overlap; stable source identities deduplicate those endpoints.
3. Save raw evidence and the deterministic candidate locally before publication.
4. Sign the bounded input for `/earth/api/world/archive/import` with the separate
   `EARTH_ARCHIVE_IMPORT_KEY` capability. The server chooses normalization and storage.
5. Read the exact primary-storage receipt. Only a verified complete receipt advances
   the local checkpoint and the advertised coverage. An HTTP timeout can still commit;
   uncertainty requires receipt readback before another publication.

The archive writes separate receipt, membership, coverage and selected-head tables.
It reuses immutable source revisions but never promotes the live prepared packet,
source completion pointers, or live collection notification. Actual database
publication dates cannot be backdated to earthquake origin dates.

## Local operation

Use the supported Node runtime from the app checkout. `--prepare` acquires one
bounded interval without a hosted write. `--import` reads a scoped secret from the
process environment and uses `.cache/usgs-archive/import-journal.json`.

```text
node scripts/usgs-archive-import.mjs --prepare 2025-10-01T00:00:00.000Z 2025-10-08T00:00:00.000Z
node scripts/usgs-archive-import.mjs --import 2024-10-12T00:00:00.000Z 2026-10-12T00:00:00.000Z
```

Do not put the secret in shell arguments, source files, logs or the journal. A new
overall date range requires a separate journal; the programmatic entry point accepts
an absolute journal path. A run processes at most eight complete intervals, 40
provider requests and 2,000 records. Run subsequent batches against that same
checkpoint. A lock prevents two local importers from sharing one journal; inspect
the recorded PID and outstanding hosted receipt before removing an abandoned lock.

Prepared candidates can outlive their first HTTP attempt. Their original acquisition
date is retained, with future clock skew bounded. Resuming recomputes identity from
intact raw evidence and verifies complete interval accounting. Stored capture and
current retry dates are separate. An empty provider response, changed catalog count,
unavailable receipt or damaged checkpoint remains incomplete.

## Public reconstruction

`/earth/api/world/scene?metadata=1` reports actual available origin dates and gaps.
An instantaneous scene uses `at=<UTC>&window=7d`. Buffered Reconstruction adds
`points=1&span=7d`; all cursor pages must be consumed before cache reuse. Marker
membership at each UTC is exactly `(UTC - 7d, UTC]`, which is a display window,
not a claim that an earthquake's consequences ended.

`knownMode=scene` instead selects only archive evidence published by that UTC.
An archive imported today can reconstruct an older earthquake but cannot claim
the platform knew it then. Detail is bound to the selected source revision.
Base-map imagery is current imagery; sunlight is calculated at scene UTC.

Two-year catalog reconstruction, continuous archive renewal, deletion/alias handling,
other hazard archives and complete historical scientific product revisions require
their own measured acquisition and coverage gates. Code availability alone does not
establish those capabilities on the public site.
