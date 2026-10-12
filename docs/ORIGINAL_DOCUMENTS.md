# Original-document investigation

Site version35 includes the durable document lane, actual Drizzle migration
`0010_document_investigations.sql`, mounted routes and a one-cycle supervised
producer. Environment revision6 supplies a distinct scoped secret. The production
migration, one actual raw/analysis admission and public reader are verified; no
permanent producer timer is installed. The fixed policy is `ec-statement-pdf-v1`,
Commission document `statement_26_2127`. Source attribution does not turn
institutional statements into independently verified external facts.

The local reader adds Inspect document only to this reviewed Commission statement.
It imports its controller when selected and reads the stored public endpoint; it
does not acquire a PDF or start producer work. Four attributed statements expose
page/code-point citations, with source and knowledge clocks under one disclosure.
Back preserves the publication list and focus. Metadata/body mismatch remains
readable with an explicit notice; source switch, hide and destroy cancel late work.
The initial UI package passed28 checks and actual hosted inspection rendered all
four statements while preserving camera/UTC. The mobile spacing correction passed
actual390×844 geometry. A focused mobile reading presentation is local for the next
package because repeated parent controls push statements below the fold.

The local followup original route is
`/earth/api/documents/ec-statement-26-2127/original?receipt=document-raw:<SHA256>`.
The receipt digest identifies a fixed job/body, not the raw PDF SHA by itself.
Only raw receipts linked to completed analyses are public. The stored reader verifies
exact receipt/key/length/SHA and returns unchanged PDF bytes as a fixed attachment,
with a stricter sandbox policy enforced alongside the application policy. It never
fetches the publisher. Citations link this retained edition; Publisher PDF remains
separate because that URL can change. The followup has23 lane/API checks and15
mounted-runtime checks. Actual public download acceptance awaits deployment.

Version35 actual raw retention is2026-10-12T01:54:36.171Z and analysis publication
is01:54:39.881Z. Source publication/metadata retention keep their original dates.
Knowledge cutoffs before completion correctly exclude it; exact completion selects
it. A repeat cycle returned not-due with zero publisher requests. Its next six-hour
body check is07:54:39.881Z. Detailed receipt/resource/browser evidence is recorded
in FOUNDATION_PROGRESS.md; local and deployed corrections remain distinguished.

## Existing dependencies and extraction

The isolated bundled runtime is Python 3.12.14 with pypdf **6.10.0**; Poppler is also
available. Earlier normal-path extraction loaded pypdf 5.4.0 from the user's
`AppData/Roaming/Python/Python312/site-packages`, not from the bundle. That earlier
library provenance description was incorrect. The staged codec now pins 6.10.0,
and both extractor parent and parser child use `-I -B` to avoid user-site imports.
No PDF parser is present in the app's Node dependencies. No dependency was
installed. `scripts/extract-ec-document.py` uses the bundled Python interpreter:

`C:/Users/schak/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe`

```text
<bundled-python> -I -B scripts/extract-ec-document.py < original.pdf
<bundled-python> -I -B scripts/extract-ec-document.py --fetch
```

Only `--fetch` and `--include-original` are admitted. Fetch targets the one fixed
official PDF; no URL/path grid, images, linked attachments or general scraper.
Default stdin mode declares no retrieval date. Fixed-fetch mode records the actual
acquisition date. Output is one JSON envelope containing extraction evidence;
`--include-original` optionally adds the unchanged original bytes as base64.
Neither mode writes files, databases or external services.

Limits: 512 KiB raw PDF, four pages, 16,384 Unicode code points per page, 64 KiB
total UTF-8 text, 1 MiB JSON output, ten-second socket timeout and a twenty-second
outer child-process wall limit. Even blocked stdin reading happens in the child.
The parent kills an expired child and returns failure without a success artifact.
Encryption, unexpected identity and root active actions are rejected. Creation
metadata is retained as rendering metadata, not converted into publication time.

**The extractor CLI alone does not isolate memory.** Decoded-page checks occur after allocation and
do not prevent decompression/parser allocation spikes. Execution remains explicitly
`local-supervised`, `peakMemoryEnforced: false`. The separate Windows wrapper below
adds verified native resource controls without silently rewriting that inner
contract. Hosted activation still requires a reviewed producer, trusted transport
and completed durable admission. Do not put this parser in the visitor browser or
treat either CLI as an always-on cloud service.

## Windows resource wrapper

`scripts/document-extractor-sandbox.py` invokes only the fixed extractor in its
public CLI. Input must be a binary stdin pipe; console/disk handles, arbitrary
commands, source URLs and `--fetch` are rejected. Acquisition occurs separately
before parsing. The pipe reader rejects more than 512 KiB and polls availability
under the shared wall deadline, so a stalled input does not block outside a job.

```text
<binary producer> | <bundled-python> -I -B scripts/document-extractor-sandbox.py --include-original
```

The wrapper creates an unnamed native Windows Job Object with verified limits:
64 MiB per-process committed memory, 96 MiB aggregate committed memory, at most
two processes, twenty-second input/execution wall budget, 1 MiB stdout and 64 KiB
stderr. Cleanup receives at most two additional seconds. The exact child is
assigned at creation using `PROC_THREAD_ATTRIBUTE_JOB_LIST`, with a three-handle
allowlist, no breakaway settings and kill-on-last-job-handle-close. Both Python
processes inherit the limits. Its environment contains only Windows runtime paths
and Python import controls, excluding producer credentials. Nested-job admission
works on the current Windows 11 Home build26300 host, which already runs us in a
job. Unsupported platforms or rejected native admission fail closed.

After root exit, timeout or output failure, the entire job is terminated. The
wrapper verifies zero active processes and finished pipe handling before returning
a successful envelope. It separately returns native quota/accounting details and
the unchanged extractor result; it publishes nothing. The internal generic process
primitive exists for bounded test workloads and is not an admission policy.

Seven offline checks exercised pre-execution assignment, denied 96 MiB allocation
under a 32 MiB process quota, denied aggregate allocations, a rejected third
process, descendant cleanup, wall/output/input limits and unchanged synthetic PDF
bytes. All attempted test allocations stay below 128 MiB, with immediate cleanup.
Native peak counters are reported unchanged: the aggregate denial test returned a
peak of 82,034,688 bytes under a 67,108,864-byte configured quota. We do not treat
`peak <= quota` as proof or infer a physical resident-memory ceiling. The measured
proof is native quota readback, allocation denial and tree cleanup. Windows
documents [committed-memory quotas](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
and [job assignment at process creation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).

This is **resource isolation**, not a filesystem, network, user-account or general
security sandbox. It changes no Windows settings or account. Immutable producer,
interpreter/library policy and server-side validation remain activation gates.

## Pure codec interfaces

```js
const evidence = await createEcDocumentEvidence(
  { pluginId: 'ec-press-v1', scopeId: 'ec-presscorner-en-metadata-v1', item },
  originalPdfBytes,
  extractionEnvelope.extraction,
);
const artifact = await createEcDocumentArtifact(evidence, citations);
```

`item` is the exact stored publication projection including its own `evidence`
receipt and RSS GUID locator, first/last hosted dates, revision and reviewed
document/category fields. It is not the latest outer feed receipt. The codec checks
the exact GUID-hashed item ID and fixed scope, original PDF byte hash/length,
independent page text hashes/code-point counts and pinned extraction policy/version.
It reuses canonical JSON/digests and the existing pure source calendar parser.

Raw PDF hashes and parent RSS raw hashes describe different original evidence.
Hash checks prove internal integrity; they do not prove an arbitrary caller actually
extracted the claimed text from those PDF bytes or retrieved them from the publisher.
Server-side job/basis admission and a trusted bounded producer remain necessary.
Offline unit fixtures are explicitly synthetic and do not authenticate a source.
Artifact creation revalidates the complete closed evidence contract and derived
fields, so recomputing a digest does not admit extra fields or fabricated dates.

Document evidence includes exact original source/publication references, the
day-level displayed document date, independent PDF rendering metadata, acquisition
metadata, complete bounded page text/digests and a content-hashed revision. Metadata
knowledge is preserved; document retention and analysis publication dates are null
because this stage publishes neither. There is no fabricated `snapshotId`.

Citation input is closed and bounded to four reviewed selectors:

```text
{ selector, page, start, end, exact }
```

Offsets use Unicode code points, not UTF-16 units or PDF byte offsets. The exact
substring must resolve to a reviewed full source sentence, with whitespace only
normalized for comparison. Drift, duplicate selectors, partial/cherry-picked
fragments and extra confidence/geography/legal-date fields fail closed. Every output
citation retains original-PDF SHA, page-text SHA, extractor/version and original
page link. Document identity and stable statement IDs are separate from revisions.

The reviewed types are institutional position, declared commitment, reported
external intention and source-relative time assertion. The claimant is the
publishing Commission; subjects can be the EU, US or unspecified source measures.
The six-month statement preserves `P6M` with unknown anchor/applicability endpoints.
It does not derive a legal effective date from RSS publication or PDF creation.
No global entity graph, source corroboration, causal model or probability is created.

## Real source proof

Earlier read-only extraction verified the
[official statement PDF](https://ec.europa.eu/commission/presscorner/api/files/document/print/en/statement_26_2127/STATEMENT_26_2127_EN.pdf):
one page, 66,354 bytes, 33,083 decoded stream bytes and 1,133 text characters.

```text
Raw SHA:  6c486947e47760f7b9b0950ef221dd93e9e71038cad1974c41b18e70b4913f42
Text SHA: e4c96a4602753e767cd01a5df9f6c71c6db41bc6cbaf4c40f5c03dacdc233e43
```

The new external CLI independently passed the fixed-fetch acceptance in memory at
`2026-10-12T00:47:24.937Z`, returning those same original-byte and page-text hashes.
That earlier acceptance used the normal-path user-site 5.4.0 library. It verified
extraction only. The process timeout was also exercised with blocked stdin and
returned no success output after its twenty-second bound.

A later bounded proof at `2026-10-12T01:02:15.867Z` fetched the one fixed official
PDF into memory and passed its unchanged bytes through the Windows wrapper with
isolated bundled pypdf 6.10.0. Both hashes and all 1,133 page code points remained
identical. All four full-sentence citations resolved at page1 half-open offsets:
position `[142,233)`, reported external intention `[234,327)`, commitment
`[328,412)`, relative delay `[589,682)`. Native reported peaks were 24,174,592
process bytes and 39,374,848 aggregate bytes; cleanup retained zero active children.

The staged codec used the actual hosted item's own receipt
`receipt:48c6f5b0a1de3b726662a7d194d27b9cec56acb1e14c5e07c1a2add464a3a922`,
recorded at `2026-10-12T00:38:19.033Z`, without changing its source publication
date `2026-10-09T12:14:20.000Z`. This proves the local codec against real retained
metadata and exact PDF evidence. `documentRecordedAt` and `analysisPublishedAt`
remain null: no hosted document or analysis receipt was fabricated. Stdin-mode
extraction retains no acquisition timestamp; the transport observation above is
separate and must be admitted independently by a future trusted producer.

The document expresses EU support/commitment concerning the ICC, reports US
sanctions intentions and describes a six-month delay without a verified start
anchor. Those are attributed statements, not confirmed legal scope or future
outcomes. Contacts and an unresolved template marker are not investigation claims.
The actual PDF is not committed as a fixture; tests create small synthetic inputs.
EU-owned content reuse follows the
[Commission legal notice](https://commission.europa.eu/legal-notice_en), with source
credit/change indication under CC BY4.0 and individual/third-party exceptions.

## Durable admission requirements

1. Resolve an exact retained source item/revision/own receipt from plugin heads;
   deduplicate admission by material input revision and reviewed policy, not every
   unchanged feed check. Source disappearance is not withdrawal.
2. Add a validated source-item investigation subject without fake USGS event IDs
   or snapshot references. Current USGS jobs/admissions are provider-specific;
   reuse their attempt/retry/lease/fence mechanisms through an explicitly reviewed
   schema/policy extension. Migration 0010 adds the separate publication-item lane.
3. Separate cheap document checks/raw revisions from extraction and analysis jobs.
   A body correction can occur without a changed headline. Group immutable originals
   and extraction artifacts in existing R2, with completed D1 receipts and current
   input/fence verification; no second warehouse is needed.
4. Provide a scoped authenticated producer claim/read/upload/status interface.
   Current collect-only HMAC admission is not permission to publish arbitrary
   document artifacts. Retain raw evidence before analysis publication; uncertain
   completion must be read back before retry.
5. Database retention and analysis publication dates must come from their actual
   completed transactions. Known-time readers exclude later extraction/analysis,
   independently of source publication/document dates. Failure preserves last-good
   evidence. Finish source-rights, identity, extraction-resource and readback gates
   before production/UI wiring or broader document scopes.

For the first hosted integration, resolve the item through its indexed plugin
head, exact revision and own capture membership. Repeated unrelated feed editions
must not enqueue an unchanged material item. A correct subject is
`{kind:'publication-item',pluginId,scopeId,itemId,itemRevision,basisReceiptId}`.
Current investigation tables and public routes require USGS event/snapshot IDs;
passing publication IDs through those fields is not a valid shortcut. Reuse the
lease/fence/attempt/readback protocol through a reviewed source-item lane.

The proposed sequence is claim/fence, verified content-addressed raw PDF retention,
DB raw-retention receipt, bounded extraction, validated immutable artifact, then
one D1 admission transaction that checks the live lease/current item revision and
inserts the completed analysis receipt before promoting its head. Body SHA changes
can occur without headline changes, so raw checks and extraction identity must be
separate. The extraction input identity binds item revision, raw SHA and versioned
extraction/statement policies. Unchanged checks update operational clocks only;
reverted bytes preserve first retention while receiving a new current publication
receipt. Uncertain transport completion requires status/readback before retry.
Earlier complete results remain retained; changed inputs cannot silently reuse them
as current analysis. The implemented lane below follows this sequence.

Focused offline verification (CLI tests require the bundled runtime or the explicit
`EARTH_DOCUMENT_PYTHON` test interpreter override; absent runtimes are reported as
skipped):

```text
node --test src/core/document-evidence.test.mjs scripts/extract-ec-document.test.mjs scripts/document-extractor-sandbox.test.mjs
```

## Durable source-item lane

`db/document-investigation-schema.ts` exports four tables through the shared schema.
The installed Drizzle generator produced migration 0010 and its actual snapshot and
journal entry. It creates four tables and seven indexes; no USGS investigation table
is changed. The full runtime checks execute this generated SQL in real SQLite.

- `earth_document_work`: one fixed publication-item/policy row with material metadata
  revision, its own immutable basis, due/check clock, monotonically increasing fence,
  short lease and current raw/publication pointers.
- `earth_document_attempts`: each lease attempt's metadata input, raw request identity,
  admission token and completed/expired/superseded outcome.
- `earth_document_raw_receipts`: immutable original PDF admission before extraction,
  its original source-item basis and actual database retention time, identified by
  fixed document/job plus raw SHA independently of later metadata revisions.
- `earth_document_publications`: immutable complete analysis admissions, linked raw
  receipt, content hash and actual database publication transaction time.

`worker/document-investigations.js` resolves the exact fixed item through indexed
plugin head/revision/capture/membership joins. Before admitting a new metadata input,
it verifies that item's own retained original RSS bytes and canonical facts hashes.
It does not substitute the outer latest feed receipt or fetch a provider. Unrelated
rolling-feed changes do not reset work. Source absence from a newer feed is not
withdrawal because the existing plugin item head remains retained.

Body checks are independently due every **six hours** and may be invoked explicitly
by the owner producer. This is a declared polling bound, not continuous PDF updates.
A successful unchanged-byte check finishes operationally without another analysis
receipt or extraction. A changed/reverted raw body admits another current edition;
existing raw receipts keep their first retention time. Metadata revision changes
invalidate active leases but retain earlier complete analysis historically.
Analysis always binds the current work item's own retained metadata receipt;
identical raw bytes keep their original receipt/basis and first-byte knowledge.
The last accepted body observation has its own preserved pointer/time, separate
from active-attempt admission, so a new lease cannot hide an observed mismatch.

The new raw operation verifies content-addressed R2 put/readback, then admits its
receipt before parsing. A fresh transaction admission token protects subsequent
raw pointer/attempt updates even if lease time expires between statements. Analysis
completion runs the strict fixed codec, verifies immutable content readback, and
uses a first-statement live lease/current metadata guard. All head/attempt promotion
depends on that exact admitted publication receipt in the same D1 batch. R2 and D1
are not one distributed transaction: failed writes can leave private unreferenced
content objects, but no reader selects them without a complete database receipt.

The server accepts only the four reviewed attributed statement selectors and the
fixed extraction policy. Native execution accounting supplied by the authenticated
producer is stored as producer-reported evidence, not remote hardware attestation.
Server content has source/raw retention clocks; its analysis publication time lives
in the database envelope, not in a client timestamp or rewritten immutable object.

`worker/document-investigation-api.js` is mounted in `worker/index.js` ahead of the
generic provider cache. Its stored-only GET is
`/earth/api/documents/ec-statement-26-2127`, optionally `knownAt`.
Only complete admitted receipts can be selected. Current responses report
`currentInputMatches`, `latestBodyMatches` and the operational body-check state.
A newer retained PDF whose extraction fails leaves the previous complete analysis
readable with an explicit body mismatch. Historical reads exclude later check state.
A changed complete edition during object delivery causes at most one whole-read
retry; repeated changes fail closed instead of mixing editions.

The producer-only POST is `/earth/api/document-investigations/producer`, with closed
schemaVersion1 operations `claim`, `raw`, `complete`, `fail` and `status`. The
deployment must supply a new, distinct `EARTH_DOCUMENT_PRODUCER_KEY`; missing or
reused broader collector/trigger/archive credentials fail closed. Authentication
binds POST/path, original body SHA256, seconds timestamp and 128-bit nonce. Nonce
rejection is isolate-local; idempotent claim identity, immutable receipt identities
and D1 fences remain the cross-isolate mutation authority. This capability cannot
register a URL, collect another provider, alter incident packets or admit a USGS job.

Producer retry/readback distinguishes an exact absent claim from an unavailable
read. Same active claim recovery returns its original lease. Exact attempt status
remains addressable after a newer fence and reports expired/superseded leases without
returning their tokens. Completion's digest must match an already admitted attempt;
a different payload at that fence is a conflict. HTTP timeouts after mutation start
return uncertain completion and require status/readback before retry.

## One-cycle local producer and activation gates

`scripts/document-investigation-producer.mjs` is an explicit one-cycle command,
not an installed timer. Its public CLI accepts **only hidden stdin** JSON of at most
1 KiB: `{schemaVersion:1,producerKey}`. There are no URL/path arguments or credential
environment lookups; its library requires an explicit RAM-only key. The key is never
put in argv, the local outbox, logs, evidence or parser environment. The parser's
separate binary stdin contains only fetched PDF bytes.

The source and hosted producer endpoint are compiled fixed URLs. Provider reading
is capped at 512 KiB/ten seconds; API requests at 768 KiB/fifteen seconds and responses
at 256 KiB. The Windows wrapper receives only runtime paths/import controls and runs
isolated bundled pypdf 6.10.0. The producer validates exact original/text hashes,
native execution fields and four unique full-sentence citations before submitting.
Whole local cycle timeout is ninety seconds; the parser outer supervision is 22.5s.

Its ignored `.cache/document-investigations/outbox.json` records the exact pending
body/digest before dispatch, with no producer key. A lost response is reconciled by
exact claim/attempt/raw/publication identity before the same body may be retried.
It does not silently refetch/reextract after uncertain raw or analysis publication.
The bounded 2 MiB local journal uses atomic temporary-file write/fsync/rename and a
local exclusive lock. A hard-killed producer can leave the lock: automatic stale
unlink was deliberately rejected because it can race another process. An owner
must confirm the lock owner is dead and remove only that exact stale lock while
preserving the outbox. Ordinary restarts after a clean exit recover their journal.
Unix file modes do not establish Windows ACL isolation; local access follows the
verified workspace/profile permissions and is a separate activation consideration.

Release acceptance must apply the actual migration and scoped capability, run one
real hosted raw/analysis admission with database clocks, verify the public reader,
and retain exact lost-response readback. The one-cycle command has no collector
hook or permanent timer. Broader policies need their own source, rights, identity
and citation review. Any future awake schedule must state its host dependency.

Focused lane verification (real SQLite schema is derived in memory from the actual
standalone Drizzle definitions; no migration file is hand-generated):

```text
node --test worker/document-investigations.test.mjs worker/document-investigation-api.test.mjs scripts/document-investigation-producer.test.mjs
```

The first frozen package passed 32 focused checks, including a producer-to-real
SQLite/backend transport run with mocked providers. No real provider, hosted
mutation or Python process was invoked by those lane checks. Warm not-due admission
uses at most three indexed SQL reads with zero writes/R2 traffic; historical delivery
uses at most two indexed receipt reads and one bounded content object.
