# European Commission publication metadata

The reviewed adapter is implemented in `worker/plugins/ec-press.js`, registered
locally and admitted by the existing stored publication API/read-only MCP tool.
This package is not yet hosted. The source remains separate from incident layers.
It acquires only the fixed anonymous RSS endpoint:

```text
https://ec.europa.eu/commission/presscorner/api/rss?
```

## Verified acquisition and scope

A native adapter call on 12 October 2026 at **00:19:20.108Z** returned HTTP 200,
7,100 original UTF-8 bytes, ten admitted items and no ETag or Last-Modified.
The exact bytes are in `server/hosted/fixtures/ec-press-20261012.xml`:

```text
Raw SHA-256: 042779ee87820d013f9e2f929db8699ca03eb7c7d5b0092cf5606034a3113815
Facts SHA-256: fa4a83d6826a6907dadf5b42e692491b67aeaff60ab1d882308879e8384b6308
```

Exports are `EC_PRESS_PLUGIN`, `collectEcPress`, `decodeEcPress` and `ecPressItems`.
The plugin ID is `ec-press-v1`, scope `ec-presscorner-en-metadata-v1`, source
`european-commission`, kind `publication-feed`. Its collector has the same schema-1
raw/facts/artifact capture envelope as the existing reviewed plugins.

The source is English-route **metadata**. `/en/` and channel `EN` do not establish
the document body's language: the retained feed includes a French speech snippet.
Snippets remain in original evidence only; no body, extracted claims, coordinates,
incident geometry or jurisdiction relationship is produced by this adapter.

Only exact `https://ec.europa.eu/commission/presscorner/detail/en/` references with
reviewed `ip`, `statement`, `read`, `qanda`, `fs`, `mex` or `speech` document types
are admitted. Other types/routes/publishers are counted as excluded, not fetched.
The daily-news `mex` type is a collection; it is not silently turned into one event.
`POLICY_AREA` categories stay source tags, not evidence of causation or geography.

Each canonical item contains:

```text
itemId: publication:ec:<SHA-256 of exact GUID UTF-8 bytes>
sourceRecordId: exact source GUID, matching the admitted source link
kind: original-publication
publisherId: european-commission
title, url, publishedAt, publishedRaw, publishedPrecision: second
documentReference: e.g. statement_26_2127
documentType: e.g. statement
categories: sorted original POLICY_AREA strings
sourceRevision: canonical item facts digest
```

The title is trimmed; raw field formatting stays in the original body. GUIDs are
not trimmed or case-normalized. The raw publication date is retained and parsed
separately with its explicit timezone. Reference-year digits in a document ID do
not substitute for its publication date. The initial server HTML canonical link
points to the homepage; the adapter does not use it to merge publication identities.

## Rights, times and coverage

The [Commission legal notice](https://commission.europa.eu/legal-notice_en) permits
reuse of EU-owned content under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
with appropriate credit and changes identified, unless an individual notice says
otherwise. Third-party content and identifiable persons can require additional
rights; logos and other industrial-property material are excluded. This pilot
retains attributed title/link/date/category metadata. It acquires no images,
branding, full body or third-party attachments. Future document extraction needs
its own rights and format gate.

Keep RSS publication, acquisition/check, database retention and later analysis
publication dates separate. `sourceUpdatedAt` is null when `lastBuildDate` is
absent; it is not synthesized from the newest item or acquisition clock. Source
RSS dates carry seconds in their representation, but are not an independent
verification of the exact instant a release became public. Several entries report
22:00 GMT with a next-day descriptive date; retain that source metadata as supplied.

The observed provider window is ten items. Five-minute checking cannot guarantee
every publication is captured during busy periods. The rolling feed is not a full
archive. Disappearance is not withdrawal. Corrections revise source metadata;
snippet-only changes do not claim that a full body was acquired or investigated.
Repeated institutional publications are not independent corroboration. A press
statement does not itself establish the underlying legal instrument's effects.

## Budgets and failure behavior

The fixed adapter declares five-minute due checks, a 20-second acquisition deadline,
512 KiB response cap, 32 admitted items and 64 KiB artifact cap. XML bounds are
100 source items, 2,048 nodes, four nesting levels, 16 KiB text per node and 4 KiB
per tag. Titles are at most 512 UTF-8 bytes; each item has at most eight category
strings, each at most 256 characters. Larger, unsupported or malformed input fails
closed instead of quietly truncating accepted facts. The maximum normal 32-item
test artifact is **43,238 bytes**; an over-budget category-rich artifact is rejected.

DTD/custom entity expansion, unknown namespaces, invalid UTF-8/declarations,
duplicate identity fields, missing explicit timezone and malformed calendars are
rejected. Named source tags never instruct collection or execute code. Render
source strings as text, including CDATA strings that contain markup.

Conditional requests require a retained factual baseline. HTTP 304 returns explicit
null raw/facts/artifact, retains its prior facts digest, and supplies operational
validators only. HTTP 200 without validators clears old validators. An unchanged
facts digest must reuse retained evidence in the shared store. Backoff is capped
and caller cancellation settles even an ignored-signal transport. The only request
target is the fixed feed; its empty trailing question mark may be absent in the
response URL without expanding the admitted target.

## Backend integration and remaining rollout gate

The compiled typed registry now admits this source. The capability ledger is
revision 5. Existing `GET /api/publications?plugin=ec-press-v1` and MCP
`list_publications` retain their method, argument, budget, anonymous read-only and
known-time boundaries. No tool or write authority was added. The four-source
discovery/incident packet is unchanged.

Shared publication projections retain and validate `documentReference`,
`documentType` and `categories`, plus the source publisher and raw/UTC time match.
Native SQLite evidence demonstrates current and historical delivery and old items
that leave the latest rolling feed: each item still has its own correct receipt,
even when the outer receipt describes a newer empty feed. The existing 64 KiB
projection-batch cap remains; it was not expanded to accommodate the new source.

Source execution now uses two per-wake slots and a shared 27-second deadline.
Cheap not-due checks release slots. Queued work that cannot start is deferred to
another authenticated wake without provider calls or a queued-source state write.
This does not introduce a distributed global semaphore; durable per-plugin fences
remain authoritative across isolates. Source failures still preserve other pilot
publications and last-good evidence.

Both publishers now share `bounded-rss.js` syntax/calendar primitives. ECB keeps
its existing exported timestamp function, error family and publisher-specific
namespace/URL rules. Its old duplicate parser was removed after both source suites
passed. Literal U+FFFE/U+FFFF now fail XML admission in both adapters.

Publish the matching worker/UI, perform an authenticated wake, read back exact EC
raw/facts/artifact receipts and verify a due unchanged check. Inspect the
source-labelled UI and its item-owned evidence, then verify unattended runtime
independently. Existing migrations suffice; no new schema was introduced here.

Focused offline check:

```text
node --test worker/plugins/ec-press.test.mjs
```

## Full-document access is a separate future policy

Read-only source research followed the official page's linked application files
to its download component. That component builds a public PDF URL from the source
document reference and language. One officially identified
[ICC statement PDF](https://ec.europa.eu/commission/presscorner/api/files/document/print/en/statement_26_2127/STATEMENT_26_2127_EN.pdf)
returned HTTP 200, 66,354 bytes and `%PDF-1.4` at **00:13:14Z**; its in-memory
SHA-256 was `6c486947e47760f7b9b0950ef221dd93e9e71038cad1974c41b18e70b4913f42`.
The bytes were not added to this package. This is an observed public UI download
contract, not a documented stable API guarantee or validated text extraction.
The adapter never downloads it. A selected, bounded document investigation must
retain its own original evidence and actual first knowledge, verify language and
rights, and attach extraction locators before publishing claims.
