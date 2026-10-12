import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { createDocumentInvestigationProducer, createDocumentProducerFileStore, readDocumentProducerControl, DOCUMENT_PRODUCER_URL } from './document-investigation-producer.mjs';
import { EC_DOCUMENT_POLICY as P } from '../src/core/document-evidence.js';

const key = 'K'.repeat(43), at = '2026-10-12T02:00:00.000Z', now = () => Date.parse(at);
const sha = value => createHash('sha256').update(value).digest('hex'), clone = value => JSON.parse(JSON.stringify(value));
const raw = Buffer.from('%PDF-1.4\nTEST ONLY synthetic source bytes; parser is mocked.');
const sentences = [
  'The European Union has been a constant supporter of the International Criminal Court (ICC).',
  'The EU will work closely with the ICC to ensure it continues to operate effectively.',
  'It is deeply regrettable that the United States has announced intentions to impose sanctions.',
  'As there is a six-month delay before the measures are applicable, there is room for dialogue.',
];
const text = `TEST ONLY 😀\nEuropean Commission - Statement\n${P.title}\nBrussels, 9 October 2026\n${sentences.join('\n')}\nSTATEMENT/26/2127`;
const basis = { pluginId: P.pluginId, scopeId: P.scopeId, item: {
  itemId: `publication:ec:${sha(P.pageUrl)}`, revision: 'a'.repeat(64), kind: 'original-publication', title: P.title,
  url: P.pageUrl, sourceRecordId: P.pageUrl, publishedAt: '2026-10-09T12:14:20.000Z', publishedRaw: 'Fri, 09 Oct 2026 12:14:20 GMT', publishedPrecision: 'second',
  documentReference: P.documentReference, documentType: 'statement', categories: ['POLICY_AREA=GROWTH,JFRC'], firstRecordedAt: at, lastRecordedAt: at,
  evidence: { id: `receipt:${'b'.repeat(64)}`, capturedAt: at, recordedAt: at, factsDigest: 'c'.repeat(64), rawSha256: 'd'.repeat(64), artifactSha256: 'e'.repeat(64), sourceUpdatedAt: null, sourceVersion: 'RSS 2.0', locator: { kind: 'rss-guid', guid: P.pageUrl } },
} };
const lease = { jobId: `document:${sha(JSON.stringify([P.pluginId, P.scopeId, basis.item.itemId, P.id]))}`, inputRevision: basis.item.revision,
  subject: { kind: 'publication-item', pluginId: P.pluginId, scopeId: P.scopeId, itemId: basis.item.itemId }, basis,
  fence: 1, leaseToken: 'a'.repeat(32), leaseUntil: '2026-10-12T02:05:00.000Z', sourceUrl: P.downloadUrl };
const rawReceipt = { id: `document-raw:${'1'.repeat(64)}`, rawSha256: sha(raw), bytes: raw.length, acquiredAt: at, recordedAt: at };
const publication = { id: `document-analysis:${'2'.repeat(64)}`, recordedAt: at, rawReceiptId: rawReceipt.id, rawSha256: sha(raw), inputRevision: lease.inputRevision };
const execution = { mode: 'windows-job-object', memoryMeaning: 'committed-virtual-memory', processMemoryLimitBytes: 67108864,
  jobMemoryLimitBytes: 100663296, processesLimit: 2, wallSeconds: 20, inputBytesLimit: 524288, stdoutBytesLimit: 1048576, stderrBytesLimit: 65536,
  nativeReportedPeakProcessBytes: 24000000, nativeReportedPeakJobBytes: 39000000, activeProcessesAfterCleanup: 0,
  jobListAppliedBeforeExecution: true, hostAlreadyInJob: true, exitCode: 0, environment: 'minimal-without-producer-credentials' };
const extraction = { schemaVersion: 1, policyId: P.id, sourceUrl: P.downloadUrl, inputMode: 'stdin', acquiredAt: null,
  rawPdfSha256: sha(raw), rawPdfBytes: raw.length, extractor: { name: 'pypdf', version: '6.10.0', mode: 'default-extract-text', normalization: 'none', offsetUnit: 'unicode-code-points' },
  pages: [{ page: 1, text, textSha256: sha(text), characters: [...text].length }], pdfCreationDateRaw: null,
  runtime: { mode: 'local-supervised', wallTimeSeconds: 20, peakMemoryEnforced: false } };
const response = value => Response.json({ schemaVersion: 1, configured: true, ...value });
function memoryStore() {
  let value = null; const saves = [];
  return { saves, async load() { return clone(value); }, async save(next) { value = clone(next); saves.push(clone(next)); }, read: () => clone(value) };
}
function fixture({ lose, checked = false, noWork = false, rawAbsent = false, source, mutateExtraction, mutateRaw, terminalClaim, mismatchedClaim = false } = {}) {
  const store = memoryStore(), calls = [], bodies = []; let claim, acquired = false, complete = false, losses = 0, sources = 0, extracts = 0;
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url === P.downloadUrl) {
      sources++; assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.headers.Accept, 'application/pdf');
      return source ? source(init) : new Response(raw, { headers: { 'content-type': 'application/pdf' } });
    }
    assert.equal(url, DOCUMENT_PRODUCER_URL); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers), digest = sha(init.body), timestamp = headers.get('x-earth-document-timestamp'), nonce = headers.get('x-earth-document-nonce');
    assert.match(nonce, /^[a-f0-9]{32}$/); assert.equal(headers.get('x-earth-document-digest'), digest);
    assert.equal(headers.get('x-earth-document-signature'), createHmac('sha256', key).update(`earth-document-producer-v1\nPOST\n/api/document-investigations/producer\n${timestamp}\n${nonce}\n${digest}`).digest('hex'));
    const body = JSON.parse(init.body); bodies.push({ ...body, encoded: init.body });
    if (body.operation !== 'status') assert.equal(store.read()?.pending?.body, init.body, 'exact action is saved before dispatch');
    let value;
    if (body.operation === 'claim') { claim = body.claimId; value = noWork ? { status: 'not-due', job: null } : { status: 'leased', job: clone(lease) }; }
    else if (body.operation === 'raw') {
      assert.equal(body.rawPdfBase64, raw.toString('base64')); acquired = !rawAbsent || losses > 0; complete = checked && acquired;
      const receipt = clone(rawReceipt); mutateRaw?.(receipt);
      value = checked ? { status: 'checked', stored: true, changed: false, rawReceipt: receipt, publication, job: { state: 'succeeded' } } : { status: 'retained', stored: true, current: true, receipt };
    } else if (body.operation === 'complete') { complete = true; value = { status: 'published', stored: true, changed: true, receipt: publication, job: { state: 'succeeded' } }; }
    else if (body.operation === 'fail') value = { status: 'retry' };
    else if (body.operation === 'status') {
      if (body.claimId) {
        assert.equal(body.claimId, claim);
        value = terminalClaim ? { status: terminalClaim, available: true, attemptFound: true,
          job: { jobId: lease.jobId, inputRevision: '9'.repeat(64), fence: 3 },
          attempt: { jobId: lease.jobId, claimId: mismatchedClaim ? '0'.repeat(32) : claim, fence: 1, inputRevision: lease.inputRevision, state: terminalClaim } } :
          { status: 'leased', available: true, attemptFound: true, job: clone(lease) };
      }
      else value = { status: complete ? 'succeeded' : 'running', available: true, attemptFound: true, job: { jobId: lease.jobId, inputRevision: lease.inputRevision },
        attempt: { fence: lease.fence, state: complete ? 'succeeded' : 'running', inputRevision: lease.inputRevision, rawReceiptId: acquired ? rawReceipt.id : null, publicationId: complete ? publication.id : null, finishedAt: complete ? at : null },
        rawReceipt: acquired ? (mutateRaw ? Object.assign(clone(rawReceipt), { rawSha256: '9'.repeat(64) }) : rawReceipt) : null, publication: complete ? publication : null };
    } else throw Error('Unexpected fixture operation');
    if (body.operation === lose && losses++ === 0) throw Error('TEST ONLY lost committed response');
    return response(value);
  };
  const extractorImpl = async bytes => {
    extracts++; assert.deepEqual(bytes, raw);
    const result = { schemaVersion: 1, policyId: P.id, execution: clone(execution), result: { extraction: clone(extraction) } };
    mutateExtraction?.(result); return result;
  };
  const make = () => createDocumentInvestigationProducer({ key, now, stateStore: store, fetchImpl, extractorImpl });
  return { make, store, calls, bodies, stats: () => ({ sources, extracts }) };
}

test('one fixed cycle retains exact bytes, authenticates bounded actions and submits reviewed citations after native resource proof', async () => {
  const f = fixture(), result = await f.make().oneCycle();
  assert.deepEqual(result, { status: 'published', published: true, changed: true }); assert.equal(f.store.read(), null);
  assert.deepEqual(f.bodies.map(body => body.operation), ['claim', 'raw', 'complete']); assert.deepEqual(f.stats(), { sources: 1, extracts: 1 });
  const complete = f.bodies.at(-1); assert.equal(complete.rawReceiptId, rawReceipt.id); assert.equal(complete.citations.length, 4);
  for (const citation of complete.citations) assert.equal([...text].slice(citation.start, citation.end).join(''), citation.exact);
  assert.equal(JSON.stringify(f.store.saves).includes(key), false); assert.equal(JSON.stringify(result).includes(lease.leaseToken), false);
  assert.equal(complete.extraction.acquiredAt, null, 'source acquisition is independent of stdin extraction metadata');
});

test('unconfigured and not-due cycles never acquire source bytes or launch an extractor', async () => {
  const f = fixture({ noWork: true }); assert.equal((await f.make().oneCycle()).status, 'not-due'); assert.deepEqual(f.stats(), { sources: 0, extracts: 0 });
  assert.deepEqual(f.bodies.map(body => body.operation), ['claim']); assert.equal(f.store.read(), null);
  const producer = createDocumentInvestigationProducer({ key: '', stateStore: { exclusive() { throw Error('No unconfigured file work'); } }, fetchImpl() { throw Error('No unconfigured network'); } });
  assert.equal((await producer.oneCycle()).status, 'unconfigured');
});

test('lost raw receipt resumes through exact attempt readback without recollecting the source', async () => {
  const f = fixture({ lose: 'raw' }); assert.equal((await f.make().oneCycle()).status, 'awaiting-readback');
  assert.deepEqual(f.stats(), { sources: 1, extracts: 0 }); const original = f.store.read().pending.body;
  assert.equal((await f.make().oneCycle()).status, 'published'); assert.deepEqual(f.stats(), { sources: 1, extracts: 1 });
  assert.deepEqual(f.bodies.map(body => body.operation), ['claim', 'raw', 'status', 'complete']); assert.equal(f.bodies[1].encoded, original);
});

test('a proven absent raw receipt permits only the exact saved body retry after status', async () => {
  const f = fixture({ lose: 'raw', rawAbsent: true }); assert.equal((await f.make().oneCycle()).status, 'awaiting-readback');
  const original = f.store.read().pending.body; assert.equal((await f.make().oneCycle()).status, 'published');
  assert.deepEqual(f.bodies.map(body => body.operation), ['claim', 'raw', 'status', 'raw', 'complete']);
  assert.equal(f.bodies[3].encoded, original); assert.deepEqual(f.stats(), { sources: 1, extracts: 1 });
});

test('lost publication response resolves retained completion with zero additional fetch, extraction or complete POST', async () => {
  const f = fixture({ lose: 'complete' }); assert.equal((await f.make().oneCycle()).status, 'awaiting-readback');
  assert.equal(f.store.read().pending.operation, 'complete'); assert.equal((await f.make().oneCycle()).status, 'published');
  assert.deepEqual(f.stats(), { sources: 1, extracts: 1 }); assert.deepEqual(f.bodies.map(body => body.operation), ['claim', 'raw', 'complete', 'status']);
});

test('unchanged raw checks skip extraction and lost checked acknowledgments preserve that meaning on readback', async () => {
  for (const lose of [undefined, 'raw']) {
    const f = fixture({ checked: true, lose }); const first = await f.make().oneCycle();
    const result = lose ? await f.make().oneCycle() : first;
    assert.deepEqual(result, { status: 'checked', published: false, changed: false }); assert.deepEqual(f.stats(), { sources: 1, extracts: 0 });
    assert.equal(f.bodies.some(body => body.operation === 'complete'), false); assert.equal(f.store.read(), null);
  }
});

test('lost claim response recovers the same durable claim without requesting another lease', async () => {
  const f = fixture({ lose: 'claim' }); assert.equal((await f.make().oneCycle()).status, 'awaiting-readback'); assert.deepEqual(f.stats(), { sources: 0, extracts: 0 });
  const claim = f.store.read().claimId; assert.equal((await f.make().oneCycle()).status, 'published');
  assert.deepEqual(f.bodies.map(body => body.operation), ['claim', 'status', 'raw', 'complete']); assert.equal(f.bodies[1].claimId, claim);
});

test('positive terminal lost-claim proof clears only that selected claim without borrowing a newer current fence or acquiring', async () => {
  for (const terminalClaim of ['lease-expired', 'superseded', 'failed', 'succeeded']) {
    const f = fixture({ lose: 'claim', terminalClaim }); assert.equal((await f.make().oneCycle()).status, 'awaiting-readback');
    assert.deepEqual(await f.make().oneCycle(), { status: terminalClaim, published: false }); assert.equal(f.store.read(), null);
    assert.deepEqual(f.stats(), { sources: 0, extracts: 0 }); assert.deepEqual(f.bodies.map(body => body.operation), ['claim', 'status']);
  }
  const mismatch = fixture({ lose: 'claim', terminalClaim: 'lease-expired', mismatchedClaim: true });
  await mismatch.make().oneCycle(); assert.equal((await mismatch.make().oneCycle()).status, 'awaiting-readback'); assert.ok(mismatch.store.read().pending);
  assert.deepEqual(mismatch.stats(), { sources: 0, extracts: 0 });
});

test('mismatched raw SHA remains uncertain and cannot cause extraction, false completion or another source fetch', async () => {
  const f = fixture({ mutateRaw: receipt => { receipt.rawSha256 = '9'.repeat(64); } });
  assert.equal((await f.make().oneCycle()).status, 'awaiting-readback'); assert.equal((await f.make().oneCycle()).status, 'awaiting-readback');
  assert.deepEqual(f.stats(), { sources: 1, extracts: 0 }); assert.deepEqual(f.bodies.map(body => body.operation), ['claim', 'raw', 'status']);
});

test('declared oversized sources are canceled before raw upload and invalid resource proofs cannot publish', async () => {
  let cancelled = 0;
  const f = fixture({ source: () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/pdf', 'content-length': String(P.rawBytes + 1) } }) });
  assert.equal((await f.make().oneCycle()).status, 'retry'); assert.equal(cancelled, 1); assert.equal(f.bodies.at(-1).errorCode, 'source_limit');
  assert.equal(f.bodies.some(body => ['raw', 'complete'].includes(body.operation)), false);
  const invalid = fixture({ mutateExtraction: envelope => { envelope.execution.activeProcessesAfterCleanup = 1; } });
  assert.equal((await invalid.make().oneCycle()).status, 'retry'); assert.equal(invalid.bodies.at(-1).errorCode, 'resource_limit');
  assert.equal(invalid.bodies.some(body => body.operation === 'complete'), false);
});

test('caller cancellation rejects late source completion without uploading raw bytes or dispatching failure', async () => {
  let started, release; const began = new Promise(resolve => { started = resolve; });
  const f = fixture({ source: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const controller = new AbortController(), work = f.make().oneCycle({ signal: controller.signal }); await began; controller.abort();
  assert.equal((await work).status, 'cancelled'); release(new Response(raw)); assert.deepEqual(f.bodies.map(body => body.operation), ['claim']);
  assert.deepEqual(f.stats(), { sources: 1, extracts: 0 }); assert.equal(f.store.read().pending, null);
});

test('bounded file outbox survives a new producer instance, refuses corruption and serializes concurrent local cycles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'earth-document-outbox-')), target = resolve(directory), base = resolve(tmpdir());
  t.after(async () => { if (!target.startsWith(base + sep)) throw Error('Unexpected test cleanup path'); await rm(target, { recursive: true, force: true }); });
  const store = createDocumentProducerFileStore({ directory }), f = fixture({ lose: 'raw' });
  await f.make().oneCycle(); const journal = f.store.read(); await store.save(journal); assert.deepEqual(await store.load(), journal);
  assert.equal((await readFile(join(directory, 'outbox.json'), 'utf8')).includes(key), false); assert.deepEqual(await readdir(directory), ['outbox.json']);
  let release, started; const begun = new Promise(resolve => { started = resolve; });
  const held = store.exclusive(async () => { started(); await new Promise(resolve => { release = resolve; }); return { status: 'held' }; });
  await begun; assert.equal((await store.exclusive(() => { throw Error('Concurrent cycle must not start'); })).status, 'busy'); release(); await held;
  await writeFile(join(directory, 'outbox.json'), '{invalid'); await assert.rejects(store.load(), { code: 'storage_unavailable' });
});

test('hidden stdin control is small, closed and never contains PDF bytes, endpoint choices or diagnostics', async () => {
  const control = await readDocumentProducerControl({ input: Readable.from([Buffer.from(JSON.stringify({ schemaVersion: 1, producerKey: key }))]) });
  assert.deepEqual(control, { schemaVersion: 1, producerKey: key });
  for (const value of [Buffer.alloc(1025), Buffer.from('not JSON'), Buffer.from(JSON.stringify({ schemaVersion: 1, producerKey: key, url: P.downloadUrl })),
    Buffer.from(JSON.stringify({ schemaVersion: 1, producerKey: 'short' }))])
    await assert.rejects(readDocumentProducerControl({ input: Readable.from([value]) }), error => error.message === 'invalid-control' && !error.message.includes(key));
  const stalled = new PassThrough(); await assert.rejects(readDocumentProducerControl({ input: stalled, timeoutMs: 5 }), /invalid-control/); stalled.destroy();
});
