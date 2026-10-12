import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentDossier, normalizeDocumentDossier, DOCUMENT_DOSSIER_URL, DOCUMENT_DOSSIER_LIMITS } from './document-dossier.js';
import { pluginFactsDigest } from './plugin-evidence.js';
import { claimDocumentInvestigation as claim, retainDocumentRaw as retain, completeDocumentInvestigation as complete,
  failDocumentInvestigation as fail, readDocumentAnalysis as read, DOCUMENT_POLICY } from '../../worker/document-investigations.js';
import { documentFixture, syntheticPdf, syntheticAnalysis } from '../../worker/document-investigation-fixture.mjs';

let serial = 0;
const lease = job => ({ jobId: job.jobId, fence: job.fence, leaseToken: job.leaseToken });
async function publish(f, label = 'A') {
  const job = (await claim(f.env, { workerId: 'test-only-ui', claimId: (++serial).toString(16).padStart(32, '0') }, { now: f.now })).job;
  const bytes = syntheticPdf(label);
  f.advance(1000);
  const raw = await retain(f.env, { ...lease(job), acquiredAt: f.stamp(), rawBytes: bytes }, { now: f.now });
  f.advance(1000);
  await complete(f.env, { ...lease(job), rawReceiptId: raw.receipt.id, ...await syntheticAnalysis(bytes) }, { now: f.now });
  return { payload: await read(f.env, {}, { now: f.now }), job, raw };
}
async function payloadFixture(t) { const f = await documentFixture(t); await f.source(); f.advance(1000); return { f, ...await publish(f) }; }
async function resign(value) { value.receipt.contentSha256 = await pluginFactsDigest(value.content); return value; }

class Element {
  constructor(tag, document) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.listeners = new Map(); this.attributes = {}; this._text = ''; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  append(...items) { for (const item of items) { if (typeof item === 'object') item.parentElement = this; this.children.push(item); } }
  replaceChildren(...items) { for (const child of this.children) if (typeof child === 'object') child.parentElement = null; this.children = []; this._text = ''; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  trigger(type) { for (const fn of this.listeners.get(type) || []) fn(); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelector(selector) { return elements(this).find(el => el !== this && selector.startsWith('.') && el.className === selector.slice(1)) || null; }
}
const elements = el => [el, ...el.children.filter(child => typeof child === 'object').flatMap(elements)];
const visibleText = el => el.hidden ? '' : el._text + (el.tagName === 'details' && !el.open ? el.children.filter(child => child.tagName === 'summary') : el.children)
  .map(child => typeof child === 'string' ? child : visibleText(child)).join('');
function ui(fetchImpl) {
  const timers = new Map(); let clock = Date.parse('2026-10-12T05:00:00.000Z'), id = 0, back = 0;
  const documentRef = { hidden: false, createElement: tag => new Element(tag, documentRef) };
  const container = new Element('section', documentRef);
  const controller = createDocumentDossier({ container, documentRef, fetchImpl, now: () => clock, onBack: () => back++,
    setTimeoutImpl: (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; }, clearTimeoutImpl: key => timers.delete(key) });
  return { controller, container, documentRef, timers, advance: ms => { clock += ms; }, get back() { return back; } };
}

test('actual stored source/raw/publication payload admits four exact code-point citations and distinct knowledge clocks', async t => {
  const { f, payload } = await payloadFixture(t); f.reset();
  assert.equal(await normalizeDocumentDossier(payload, { item: payload.content.basis.item }), payload);
  assert.equal(payload.content.statements.length, 4);
  assert.ok(payload.knowledge.metadataRecordedAt < payload.knowledge.documentRecordedAt);
  assert.ok(payload.knowledge.documentRecordedAt < payload.knowledge.analysisPublishedAt);
  assert.equal(f.activity.providers.length, 0);
});

test('metadata correction preserves first raw basis; earlier analysis remains inspectable with explicit server mismatch', async t => {
  const { f, payload: original } = await payloadFixture(t);
  f.advance(1000); await f.source('B', { force: true });
  const mismatch = await read(f.env, {}, { now: f.now });
  assert.equal(mismatch.currentInputMatches, false);
  assert.equal(await normalizeDocumentDossier(mismatch, { item: { ...original.content.basis.item, revision: 'b'.repeat(64) } }), mismatch);
  const corrected = (await publish(f)).payload;
  assert.notEqual(corrected.content.rawReceipt.inputRevision, corrected.receipt.inputRevision);
  assert.notEqual(corrected.content.rawReceipt.basisReceiptId, corrected.content.basis.item.evidence.id);
  await normalizeDocumentDossier(corrected, { item: corrected.content.basis.item });
  await assert.rejects(normalizeDocumentDossier(corrected, { item: original.content.basis.item }), /metadata changed/);
});

test('retained newer failed body remains visible as prior attributed analysis without claiming current compatibility', async t => {
  const { f, payload } = await payloadFixture(t); f.advance(DOCUMENT_POLICY.checkMs + 1);
  const job = (await claim(f.env, { workerId: 'test-only-ui', claimId: (++serial).toString(16).padStart(32, '0') }, { now: f.now })).job;
  const newer = await retain(f.env, { ...lease(job), acquiredAt: f.stamp(), rawBytes: syntheticPdf('B') }, { now: f.now });
  await fail(f.env, { ...lease(job), errorCode: 'extractor_failed' }, { now: f.now });
  const prior = await read(f.env, {}, { now: f.now }); assert.equal(prior.latestBodyMatches, false);
  const calls = [], u = ui(async url => { calls.push(url); return Response.json(prior); }); await u.controller.open({ item: payload.content.basis.item });
  assert.match(visibleText(u.container), /newer PDF body was retained/);
  assert.match(visibleText(u.container), /Source statements · not independently corroborated\./);
  assert.equal(elements(u.container).filter(el => el.className === 'document-statement').length, 4);
  assert.doesNotMatch(visibleText(u.container), /SHA-256|Analysis receipt/);
  const retainedUrl = `${DOCUMENT_DOSSIER_URL}/original?receipt=${encodeURIComponent(payload.content.rawReceipt.id)}`;
  const references = elements(u.container).filter(el => el.className === 'document-citation');
  assert.equal(references.length, 4);
  for (const [index, link] of references.entries()) {
    assert.equal(link.textContent, `Retained PDF · page ${prior.content.statements[index].citation.page}`);
    assert.equal(link.href, `${retainedUrl}#page=${prior.content.statements[index].citation.page}`);
    assert.equal(new URL(link.href, 'https://giovannicallebaut.com').searchParams.get('receipt'), payload.content.rawReceipt.id);
    assert.notEqual(new URL(link.href, 'https://giovannicallebaut.com').searchParams.get('receipt'), newer.receipt.id);
    assert.match(link.attributes['aria-label'], /Retained original PDF, page 1, text characters/);
  }
  assert.equal(elements(u.container).find(el => el.tagName === 'a' && el.textContent === 'Download retained original').href, retainedUrl);
  assert.equal(elements(u.container).find(el => el.tagName === 'a' && el.textContent === 'Publisher PDF').href, prior.content.source.downloadUrl);
  assert.deepEqual(calls, [DOCUMENT_DOSSIER_URL], 'rendering links never downloads a retained or publisher PDF');
  const evidence = u.container.querySelector('.plugin-evidence'); assert.equal(evidence.open, false);
  assert.doesNotMatch(visibleText(u.container), /Source dates remain independent of globe time/);
  evidence.open = true; assert.match(visibleText(evidence), /Source dates remain independent of globe time/);
  assert.match(visibleText(evidence), /Original PDF first retained/); assert.match(visibleText(evidence), /Analysis published/); u.controller.destroy();
});

test('fixed source, receipt binding, text hashes and exact whole-sentence offsets fail closed even with rehashed content', async t => {
  const { payload } = await payloadFixture(t);
  for (const mutate of [
    p => { p.content.source.downloadUrl = 'https://example.com/other.pdf'; },
    p => { p.content.basis.item.revision = 'f'.repeat(64); },
    p => { p.content.statements[0].citation.end--; },
    p => { p.content.statements[0].citation.sourceUrl += '&other=1'; },
    p => { p.content.extraction.pages[0].textSha256 = 'f'.repeat(64); },
    p => { p.content.statements[0].predicate = 'causes-sanctions'; },
    p => { p.content.statements[3].temporal.anchor = p.content.source.publishedAt; },
    p => { p.content.rawReceipt.recordedAt = '2026-10-12T06:00:00.000Z'; },
    p => { p.receipt.rawReceiptId = p.content.rawReceipt.id = `document-raw:${'a'.repeat(64)}?foreign=1`; }
  ]) { const value = structuredClone(payload); mutate(value); await resign(value); await assert.rejects(normalizeDocumentDossier(value), /incompatible/); }
  const altered = structuredClone(payload); altered.content.attribution += ' altered'; await assert.rejects(normalizeDocumentDossier(altered), /incompatible/);
});

test('a new completed body edition changes retained citation links to its own raw receipt without eager PDF delivery', async t => {
  const { f, payload: first } = await payloadFixture(t); let current = first;
  const calls = [], u = ui(async url => { calls.push(url); return Response.json(current); });
  await u.controller.open({ item: first.content.basis.item });
  const oldLink = elements(u.container).find(el => el.className === 'document-citation').href;
  f.advance(DOCUMENT_POLICY.checkMs + 1); current = (await publish(f, 'B')).payload;
  assert.notEqual(current.content.rawReceipt.id, first.content.rawReceipt.id); await u.controller.refresh();
  const newLink = elements(u.container).find(el => el.className === 'document-citation').href;
  assert.notEqual(newLink, oldLink); assert.equal(new URL(newLink, 'https://giovannicallebaut.com').searchParams.get('receipt'), current.receipt.rawReceiptId);
  assert.equal(new URL(oldLink, 'https://giovannicallebaut.com').searchParams.get('receipt'), first.receipt.rawReceiptId);
  assert.deepEqual(calls, [DOCUMENT_DOSSIER_URL, DOCUMENT_DOSSIER_URL]); u.controller.destroy();
});

test('document delivery is lazy, fixed stored-only, cached and preserves disclosure on operational checks', async t => {
  const { payload } = await payloadFixture(t); const calls = [], u = ui(async (url, options) => { calls.push({ url, options }); return Response.json(payload); });
  assert.equal(calls.length, 0); await u.controller.open({ item: payload.content.basis.item });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, DOCUMENT_DOSSIER_URL); assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
  const evidence = u.container.querySelector('.plugin-evidence'); evidence.open = true; u.controller.focus(); assert.equal(u.documentRef.activeElement.tagName, 'button');
  u.controller.close(); assert.equal(u.timers.size, 0); await u.controller.open({ item: payload.content.basis.item }); assert.equal(calls.length, 1);
  await u.controller.refresh(); assert.equal(calls.length, 2); assert.equal(u.container.querySelector('.plugin-evidence'), evidence); assert.equal(evidence.open, true);
  assert.ok(u.container.textContent.includes(payload.knowledge.documentRecordedAt.replace('T', ' ').replace('.000Z', ' UTC')));
  elements(u.container).find(el => el.textContent === 'Back to publications').trigger('click'); assert.equal(u.back, 1); u.controller.destroy();
});

test('close and destroy abort stored reads and fence late deliveries; streamed overflow is cancelled', async t => {
  const { payload } = await payloadFixture(t); let resolve, signal;
  const u = ui((_url, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); });
  const work = u.controller.open({ item: payload.content.basis.item }); u.controller.close(); assert.equal(signal.aborted, true);
  resolve(Response.json(payload)); assert.equal(await work, false); assert.equal(elements(u.container).filter(el => el.className === 'document-statement').length, 0);
  u.controller.destroy(); assert.equal(u.container.children.length, 0);
  let cancelled = false;
  const large = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(DOCUMENT_DOSSIER_LIMITS.bytes + 1)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } });
  const bounded = ui(async () => large); assert.equal(await bounded.controller.open(), false); assert.equal(cancelled, true); assert.match(bounded.container.textContent, /reading budget/); bounded.controller.destroy();
});
