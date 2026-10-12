# Delivery capacity: assumptions and next operating gates

Read-only code audit at 2026-10-12 05:10 UTC. This is an operating model, not a
load test or a verified Sites quota. The v44 five-minute log sample returned 14
approximately 40-second streams and five collector calls, all normal outcomes.
It establishes a small successful operating sample only.

## Current bounded delivery

worker/collection-updates.js shares one grouped primary D1 read per second within
each stable database-binding/isolate group. Six fixed heads are read, without R2
or provider acquisition. Only one query is outstanding; a timed-out native query
keeps admission until it actually settles. Deadline is 2.5 seconds and failure
backoff grows to 15 seconds. These are local sharing groups, not a global broker.

Each stream has a nominal 40-second lifetime, 15-second keepalive, 4 KiB queued
payload limit and at most 128 clients per sharing group. Connections replay
current heads and clients deduplicate revisions. Hidden/offline tabs disconnect.
Normal EOF advertises a two-second retry; terminal retries back off without jitter.

Public GET responses use no-store/no-transform. Outer admission has a 32 KiB URL
bound and local limits of 240 requests/minute per trusted connecting IP or shared
unknown fallback, 4,000/minute per worker closure and 2,000 tracked keys. A NAT
crowd or missing trusted IP can hit these limits. They are not distributed limits.

## Illustrative audience model

Assume 300 continuously visible clients for 24 hours, all enabling USGS and no
other interactions. Source changes, edition notifications, retries, GDACS,
historical queries, assets and investigation add work beyond this model.

| Work | Approximate daily volume |
| --- | ---: |
| Stream openings at 40 seconds connected plus two seconds retry | 617,000 |
| Shared stream SQL queries | 86,400 times actual sharing groups |
| USGS current reads at one per minute per client | 432,000 |
| Normal SQL queries for those reads | 1.73 million |
| Integrity-checked R2 objects for those reads | 864,000 |
| Combined queued stream payload ceiling | 1.17 MiB |

The final row excludes all runtime overhead and is not a process-memory bound.
worker/plugins/store.js normally uses four SQL queries and two objects per current
read. Query count is not rows scanned. Three hundred searches do not establish
any of these concurrency assumptions or unique-user counts.

## Required decisions before expanding audience

1. Measure actual binding reuse, isolate distribution, query/row work, reconnect
   bursts, CPU, memory and legitimate-user throttling under an authorized bounded
   acceptance plan. Verify actual Sites quotas and operating cost separately.
2. Reuse bounded, validated immutable factual editions where possible. Deliver
   operational check dates separately; preserve receipt/fence integrity, revision
   correction, stale-source semantics and per-client selection ownership.
3. Introduce fan-out only through a verified runtime capability. Publish completed
   heads to a bounded broker, replay them on connection and reconcile missed
   notifications. D1/R2 remain authoritative. Visitors and the broker do not
   acquire providers. A browser SSE connection is not an acquisition scheduler.

The generic [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/)
are comparison bounds, not verified Sites allowances. The sampled managed backend
collector CPU of 281–817 ms is distinct from the prepared tiny minute signer.
No free-plan, unlimited storage, 300-client capacity or full outage-isolation claim
is admitted by this model. No account, runtime or provider changes were made.
