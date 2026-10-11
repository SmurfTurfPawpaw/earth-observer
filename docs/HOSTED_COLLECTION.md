# Hosted collection and durable evidence history

`worker/collector.js` provides a fixed source registry and a collection runtime independent of the browser, its layer toggles, location permission, session or searches. This module implements acquisition and storage; exporting it does **not** provision or prove an unattended scheduler. The host must configure and verify an actual scheduled or authenticated invocation separately. `getCollectorStatus` always distinguishes implemented runtime/storage from unverified unattended execution.

## Reviewed initial plugins

| Adapter | Fixed collection | Check policy | Limits and meaning |
| --- | --- | --- | --- |
| USGS | Official magnitude 4.5+ seven-day earthquake summary | Shared 60-second acquisition/cache policy | At most 100 records. Scientific source coordinates and origin/revision dates; no inferred country. |
| GDACS | Fixed EQ/TC/FL/VO/WF/DR seven-day notice query | Shared 60-second policy with source backoff | At most 100 records. Modeled impacts and indicative source metadata; consult national authorities. |
| NASA EONET | Fixed wildfires/severe storms/volcanoes API query | Shared 60-second live policy; owned snapshot is an outage fallback | At most 60 curated references. Geometry dates are not verified incident or publication times. EONET coordinates, descriptions and linked content are excluded. |
| GDELT | Project-owned bounded JSON release | Shared 60-second release revalidation | At most 240 topic/link records. GKG's source batch cadence is 15 minutes, and actual publication depends on the separate bounded job. No bulk ZIP processing occurs in the Worker. |

All four initial adapters require no provider credentials. They use the existing reviewed `intelligenceProxy`, provider persistence, coalescing, source leases and bounded retry policy. The registry contains code-reviewed adapters only. A URL or uploaded code cannot create an executable plugin, and the collector never follows publisher, EONET-reference or picture links. Other source candidates need a reviewed adapter, license/purpose assessment, capacity limit and tests before registration.

`collectEarthSources(env, ctx, { now, fetchImpl })` runs one global/all-category acquisition and stores a prepared response plus history. Concurrent local calls share work; source policies remain authoritative across calls. A successful configured run returns a small publication summary rather than all metadata. When storage is absent, it returns a bounded portable `packet`, which a separate authenticated writer can persist with `persistEarthCollection`. Authentication, body admission and scheduler provisioning belong to the host integration; this module exposes no public write endpoint. A packet retains its collector capture date when it reaches the host, and older packets cannot replace a newer current publication.

## Storage and history indexing

`EARTH_STORE` is the persistent R2 binding. `EARTH_DB` is the optional durable D1 history index. Its migration is supplied by the host:

```sql
CREATE TABLE earth_observations (
  source TEXT NOT NULL,
  at TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  PRIMARY KEY (source, at)
);
CREATE INDEX earth_observations_at ON earth_observations(at);
```

Content is stored once at `history/snapshots/<source>/<sha256>.json`. Its facts identity excludes only `retrievedAt`, so a routine download of unchanged facts does not create another large blob. Immutable content retains its **first captured retrieval dates**; each later collection check is separately recorded with its actual `at` date. Event origin, modification, indexing and approximate geometry dates remain part of the facts identity, so a source revision creates a new snapshot. A second body digest covers the complete retained snapshot, including its first retrieval dates, and is checked when serving history. Current prepared intelligence keeps the latest actual source retrieval dates and is separate from this deduplication.

Immutable check journals use `history/observations/<source>/<at>_<sha256>.json`. Per-source recent manifests and the source catalog use local serialization plus R2 conditional writes; conflicting writers retry against the latest ETag. Existing content is checked with R2 `HEAD` before attempting another write, and the source-discovery catalog changes only for a new source or earlier first observation; current coverage comes from source manifests/D1. This avoids redundant Class A writes for every unchanged blob and catalog check. Existing blobs and observation checks are never overwritten. A repeated `(source, at)` cannot silently replace different content. Check times mean the evidence was collected or retained at that point, rather than that an incident occurred then.

D1 indexes every observation and permits bounded queries across the full recorded archive. Reads admit at most **20 sources**, **1200 observation entries per request**, **500 records/1 MiB per content snapshot**, and **2000 reports per selected-time response** with an explicit omitted count. R2 operations have a 2.5-second deadline; manifest contention has eight attempts. Append-only blobs and journals are not automatically deleted. Storage is deduplicated, but a long-running archive still grows; quotas, retention/backups and operational cost need host monitoring. Minute checks do not imply a new content blob every minute.

If D1 is absent or temporarily unavailable, the reader labels itself `r2-recent-history`. Its R2 index retains at most 1200 recent observations **per source** and exposes `availableFrom`; it cannot claim complete earlier query coverage. Older immutable blobs/journals remain stored and can be reindexed, but the public reader does not crawl object storage to reconstruct missing index entries. Full archive range access requires the D1 index.

## Read contracts

`createHistoryHandler({ env, now })` handles only `GET /api/history` on the runtime's normalized internal request. Other paths return `null`; writes return 405.

- No filters, or `from=<ISO>&to=<ISO>&limit=<1..1200>`, returns `{ configured, firstAt, lastAt, snapshots: [{ at, id, source, recordCount }], sources, indexMode }`. Rows are bounded and newest first.
- `at=<ISO>` selects the newest observation from each source whose collection check was **at or before** that time, then returns validated canonical `reports` and permitted USGS `coordinates`. It does not backfill history from present feeds or retime old records. No prior collection means no prior evidence; missing objects or integrity failures return a dated availability error instead of substitute data.

`readPreparedIntelligence(env, { now })` performs only an R2 read and returns `{ payload, collectedAt, ageMs, stale, expiresAt }`, or `null` when missing/invalid/older than 24 hours. It never calls a provider. The response's individual source statuses, generation/indexing/observation/retrieval dates and backoff remain unchanged; `collectedAt` is the prepared publication's capture/check time, not proof that every source is fresh. Visitors can filter/index this prepared metadata locally without triggering collection.

## Evidence and limits

`worker/hosted-collection.test.mjs` exercises content deduplication across different download dates, preserved first/source dates, source revisions, immutable check history, real SQLite execution of the D1 queries, access beyond the recent R2 index, competing conditional writers, integrity failure, fixed-source acquisition, current reads with no upstream calls, outage/backoff and Worker bundling without Node imports or bulk decoders.

These synthetic tests do not prove production R2/D1 migrations, an unattended minute trigger, all-source coverage, real-time upstream publication or persistent source recovery after an actual production restart. Those remain separate deployment/runtime checks. The collector's initial four-source registry does not imply that all map imagery, credentialed layers or arbitrary open APIs are collected continuously.
