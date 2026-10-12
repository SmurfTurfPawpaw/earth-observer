# Staged original-document investigation

This package is local foundation code only. It registers no source, job, API,
database table, production acquisition or UI. Its fixed policy is
`ec-statement-pdf-v1`, Commission document `statement_26_2127`. It retains source
attribution without treating institutional statements as verified external facts.

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

## Later durable admission seams

1. Resolve an exact retained source item/revision/own receipt from plugin heads;
   deduplicate admission by material input revision and reviewed policy, not every
   unchanged feed check. Source disappearance is not withdrawal.
2. Add a validated source-item investigation subject without fake USGS event IDs
   or snapshot references. Current USGS jobs/admissions are provider-specific;
   reuse their attempt/retry/lease/fence mechanisms through an explicitly reviewed
   schema/policy extension. No migration is included here.
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
as current analysis. This is a proposed integration seam, not implemented storage.

Focused offline verification (CLI tests require the bundled runtime or the explicit
`EARTH_DOCUMENT_PYTHON` test interpreter override; absent runtimes are reported as
skipped):

```text
node --test src/core/document-evidence.test.mjs scripts/extract-ec-document.test.mjs scripts/document-extractor-sandbox.test.mjs
```
