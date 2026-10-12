# Reviewed source plugins

These plugins extend the intelligence foundation without forcing publications or
annual statistics into incident pins. The existing four-source collection packet
and its notifications remain a separate contract. The three scopes reuse the current
private R2 evidence bucket and D1 database; no second warehouse or dependency was added.

| Plugin | Acquisition | Meaning and limits |
| --- | --- | --- |
| `ecb-press-v1` | Fixed anonymous ECB RSS; conditional check at most every five minutes | Institutional press releases only. Publication is irregular. Speeches, interviews, named-author material and images are excluded. A rolling feed is not a complete archive; disappearance is not withdrawal. |
| `eurostat-gas-origins-v1` | Fixed Eurostat JSON-stat query; check at most every six hours | Belgian annual natural-gas import origins, gross calorific value in TJ. The verified current response has reference year 2024. Annual origin shares do not establish current consumption dependency, routes or 2026 quantities. |
| `ec-press-v1` | Fixed anonymous Commission RSS; check at most every five minutes | English-route title/GUID/date/type/category metadata, with body language unknown. Ten items were observed; busy intervals can omit publications. No full-text claims, legal-effect inference or incident pins. |

Adapters have fixed scope, rights, response size, deadline and item bounds. Their
original bytes, canonical facts and derived artifact hashes are independently
checked by the shared store. Raw source bytes remain private. Original source links,
scope, dates, formulas, flags and evidence digests are public. Missing values are
not zero. Source global update clocks and HTTP validators are operational metadata;
they do not create new statistical revisions.

## Execution and storage

Only an authenticated admitted `collect` action registers plugin work. The original
packet can fail without starving a different plugin; public reads never fetch or
enqueue. The reviewed three-plugin registry has two concurrent source slots and
one shared 27-second wake budget, in addition to each store deadline. Queued work
that cannot start is deferred to another authenticated wake; not-due state reads
free slots without provider requests. This is a per-wake bound; per-source durable
leases remain the cross-isolate authority. Providers have a 20-second bound,
512 KiB maximum response and 64 KiB artifact. No work starts
if the host cannot retain the background operation. Repeated wakes coalesce locally;
durable SQL claims and a 60-second lease/fence govern cross-isolate writers.

The five tables have distinct purposes:

- `earth_plugin_state`: due/check dates, validators, retry and durable lease/fence.
- `earth_plugin_captures`: immutable completed factual acquisition receipts.
- `earth_plugin_revisions`: immutable item facts and first hosted knowledge.
- `earth_plugin_membership`: exact items in each changed or reverted acquisition.
- `earth_plugin_heads`: indexed current delivery, preserving publications that leave
  the rolling feed.

Content-addressed raw/facts/artifact objects are stored before publication. One
atomic D1 batch admits the live lease, records the receipt, revisions, membership
and heads, then advances operational state. Subsequent statements depend on the
admitted receipt; expiry between statements cannot publish partial history. Every
item's knowledge date comes from that same database receipt. Source/check clocks
never replace it. Unchanged/304 checks update only operational state. A not-due
wake is one indexed state read with no provider calls, SQL writes or R2 access.

Retry state survives restarts and respects bounded Retry-After. Failures preserve
last-good evidence; an expired or superseded writer cannot replace it. Identical
facts reuse their original receipt/artifact even if transport formatting or source
global clocks change. Raw representations are retained on changed factual
acquisitions, rather than indefinitely duplicating identical annual data checks.

## Delivery and known-time limits

Stored-only routes:

```text
GET /earth/api/dossiers/belgium-natural-gas-origins[?knownAt=canonical-UTC]
GET /earth/api/publications?plugin=ecb-press-v1&limit=20[&at=UTC&knownAt=UTC]
GET /earth/api/publications?plugin=ec-press-v1&limit=20[&at=UTC&knownAt=UTC]
```

`at` filters original publication time; `knownAt` independently selects hosted
knowledge. The initial public API admits canonical UTC milliseconds and at most
40 publications. The outer ECB receipt describes the selected feed acquisition;
each retained item has its own exact receipt and RSS GUID locator. A final edition
check retries once if acquisition changed during delivery. A second change fails
closed rather than mixing evidence.

Current reads use indexed heads. Historical reconstruction currently has an
explicit maximum of 4,096 membership candidates, bound to the selected receipt's
fence. A capped probe runs before ranking. Over-budget requests return unavailable
with `historical-delivery-budget`; no incomplete list is passed off as history.
Independent native SQLite measurements confirmed the guard, including a new
capture arriving between probe and ranking. These timings are not browser or
production performance guarantees. Before expanding institutional history beyond
this pilot, replace the membership scan with a scalable temporal index and verify
query work against large retained histories.

## Rollout gate

Local checks prove storage/admission invariants, not hosted acquisition or browser
appearance. Existing generated migrations 0007 and 0008 are required; Commission
integration introduces no new tables or migration. Publish the matching worker,
perform an authenticated collection wake, read the selected stored receipts, verify an
unchanged check, then exercise Context views on desktop/mobile. Source-specific
rights and scope live in the common capability ledger. Permanent cloud minute
execution remains a separate infrastructure gate; a temporary awake-laptop bridge
cannot be described as always-on hosting.

Commission integration uses existing tables and item-owned receipts. Reviewed
document references/types/categories are retained in projections, so publications
leaving the latest rolling feed keep their original metadata and evidence. ECB and
Commission now share bounded XML and explicit-offset calendar primitives, with
publisher-specific field/namespace/URL admission unchanged. The Commission adapter
and backend integration are local until the matching release/readback succeeds;
see [its exact source proof and rollout gate](EC_PRESS_SOURCE.md).
