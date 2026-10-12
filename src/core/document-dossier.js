import { EC_DOCUMENT_POLICY as P } from './document-evidence.js';
import { pluginBytesDigest, pluginFactsDigest, pluginJson } from './plugin-evidence.js';
import { worldTime, isWorldDigest } from './world-identity.js';

export const DOCUMENT_DOSSIER_URL = '/api/documents/ec-statement-26-2127';
const ORIGINAL_DOCUMENT_URL = `${import.meta.env?.BASE_URL || '/'}api/documents/ec-statement-26-2127/original`;
export const DOCUMENT_DOSSIER_LIMITS = Object.freeze({ bytes: 256 * 1024, contentBytes: 96 * 1024, deadlineMs: 15000, refreshMs: 300000 });
const UTF8 = new TextEncoder(), fixedIdentity = pluginBytesDigest(UTF8.encode(P.pageUrl));
const rules = Object.freeze({
  'eu-icc-position': { label: 'Institutional position', kind: 'institutional-position', subject: 'organization:eu', predicate: 'reports-support-for', object: 'organization:icc', sentence: 'The European Union has been a constant supporter of the International Criminal Court (ICC).' },
  'eu-icc-commitment': { label: 'Declared commitment', kind: 'declared-commitment', subject: 'organization:eu', predicate: 'declares-intention-to-work-with', object: 'organization:icc', sentence: 'The EU will work closely with the ICC to ensure it continues to operate effectively.' },
  'reported-us-sanctions-intent': { label: 'Reported external intention', kind: 'reported-external-intention', subject: 'country:US', predicate: 'reports-intention-to-impose', object: 'source-measures:unspecified', sentence: 'It is deeply regrettable that the United States has announced intentions to impose sanctions.' },
  'reported-relative-delay': { label: 'Source-relative delay', kind: 'source-relative-time-assertion', subject: 'source-measures:unspecified', predicate: 'reports-relative-applicability-delay', object: null, sentence: 'As there is a six-month delay before the measures are applicable, there is room for dialogue.' },
});
const stamp = value => { try { return worldTime(value) === value ? value : null; } catch { return null; } };
const display = value => stamp(value)?.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') || 'Not supplied';
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const normalized = value => value.replace(/\s+/gu, ' ').trim();
const invalid = () => { throw new Error('Stored document evidence is incompatible with its source.'); };

/** A first raw-byte receipt may precede a corrected metadata input. The analysis
 * receipt, its own basis and text/citations must still identify one exact edition. */
export async function normalizeDocumentDossier(value, { item } = {}) {
  if (value?.schemaVersion !== 1 || typeof value.configured !== 'boolean' || typeof value.available !== 'boolean') invalid();
  if (!value.available) return { ...value, explanation: text(value.explanation, 1000) ? value.explanation : 'No completed stored examination is available yet.' };
  if (!value.configured || value.status !== 'available' || value.knownAt !== null) invalid();
  const c = value.content, receipt = value.receipt, raw = c?.rawReceipt, basis = c?.basis?.item, source = c?.source, knowledge = value.knowledge;
  const identity = await fixedIdentity;
  if (!c || c.schemaVersion !== 1 || c.kind !== 'retained-attributed-document-analysis' || c.policyId !== P.id ||
      c.subject?.kind !== 'publication-item' || c.subject.pluginId !== P.pluginId || c.subject.scopeId !== P.scopeId || c.subject.itemId !== `publication:ec:${identity}` ||
      !/^document-analysis:[a-f0-9]{64}$/.test(receipt?.id || '') || !stamp(receipt.recordedAt) || !stamp(receipt.acquiredAt) ||
      !isWorldDigest(receipt.inputRevision) || receipt.inputRevision !== c.inputRevision || basis?.revision !== c.inputRevision ||
      !isWorldDigest(receipt.contentSha256) || UTF8.encode(pluginJson(c)).byteLength > DOCUMENT_DOSSIER_LIMITS.contentBytes ||
      await pluginFactsDigest(c) !== receipt.contentSha256 || !/^document-raw:[a-f0-9]{64}$/.test(raw?.id || '') || receipt.rawReceiptId !== raw.id ||
      !isWorldDigest(raw.rawSha256) || raw.rawSha256 !== receipt.rawSha256 || !Number.isSafeInteger(raw.bytes) || raw.bytes < 8 || raw.bytes > P.rawBytes ||
      !stamp(raw.recordedAt) || !stamp(raw.acquiredAt) || !isWorldDigest(raw.inputRevision) || !/^receipt:[a-f0-9]{64}$/.test(raw.basisReceiptId || '') ||
      c.basis.pluginId !== P.pluginId || c.basis.scopeId !== P.scopeId || basis.itemId !== c.subject.itemId || basis.kind !== 'original-publication' || basis.title !== P.title || basis.url !== P.pageUrl ||
      basis.sourceRecordId !== P.pageUrl || basis.documentReference !== P.documentReference || basis.documentType !== 'statement' ||
      source?.publisherId !== 'european-commission' || source.pageUrl !== P.pageUrl || source.downloadUrl !== P.downloadUrl || source.documentReference !== P.documentReference ||
      source.publishedAt !== basis.publishedAt || source.publishedRaw !== basis.publishedRaw || !stamp(source.publishedAt) || !text(source.publishedRaw, 128) ||
      Date.parse(source.publishedRaw.trim()) !== Date.parse(source.publishedAt) || source.publishedPrecision !== 'second' ||
      !stamp(knowledge?.metadataRecordedAt) || knowledge.metadataRecordedAt !== c.knowledge?.metadataRecordedAt || knowledge.metadataRecordedAt !== basis.evidence?.recordedAt ||
      knowledge.documentRecordedAt !== raw.recordedAt || knowledge.documentRecordedAt !== c.knowledge.documentRecordedAt || knowledge.analysisPublishedAt !== receipt.recordedAt ||
      knowledge.metadataRecordedAt > receipt.recordedAt || knowledge.documentRecordedAt > receipt.recordedAt ||
      typeof value.currentInputMatches !== 'boolean' || value.latestBodyMatches !== null && typeof value.latestBodyMatches !== 'boolean' ||
      !isWorldDigest(c.codec?.evidenceRevision) || !isWorldDigest(c.codec?.artifactRevision) || !text(c.attribution, 2000) || !text(c.limitations, 4000)) invalid();
  if (item && (item.itemId !== c.subject.itemId || item.url !== P.pageUrl || item.documentReference !== P.documentReference || !isWorldDigest(item.revision))) invalid();
  if (item && item.revision !== c.inputRevision && value.currentInputMatches)
    throw new Error('Publication metadata changed. Return to publications and refresh before inspecting this document.');
  const extraction = c.extraction, extractor = extraction?.extractor;
  if (extraction?.schemaVersion !== 1 || extraction.policyId !== P.id || extraction.sourceUrl !== P.downloadUrl || extraction.rawPdfSha256 !== raw.rawSha256 || extraction.rawPdfBytes !== raw.bytes ||
      extractor?.name !== 'pypdf' || extractor.version !== '6.10.0' || extractor.mode !== 'default-extract-text' || extractor.normalization !== 'none' || extractor.offsetUnit !== 'unicode-code-points' ||
      !Array.isArray(extraction.pages) || !extraction.pages.length || extraction.pages.length > P.pages || !Array.isArray(c.statements) || !c.statements.length || c.statements.length > 4) invalid();
  let textBytes = 0;
  for (const [index, page] of extraction.pages.entries()) {
    if (page.page !== index + 1 || !text(page.text, P.pageCharacters * 2) || [...page.text].length !== page.characters || page.characters > P.pageCharacters ||
        await pluginBytesDigest(UTF8.encode(page.text)) !== page.textSha256) invalid();
    textBytes += UTF8.encode(page.text).byteLength;
  }
  if (textBytes > P.textBytes) invalid();
  const selectors = new Set();
  for (const statement of c.statements) {
    const citation = statement.citation, rule = Object.hasOwn(rules, citation?.selector) ? rules[citation.selector] : null;
    const page = extraction.pages.find(page => page.page === citation?.page);
    if (!rule || selectors.has(citation.selector) || statement.kind !== rule.kind || statement.meaning !== 'attributed-source-statement' ||
        statement.publisherId !== 'european-commission' || statement.claimantId !== 'organization:european-commission' ||
        statement.subjectId !== rule.subject || statement.predicate !== rule.predicate || statement.objectId !== rule.object ||
        statement.id !== `statement:${await pluginFactsDigest([`document:ec:${identity}`, citation.selector])}` ||
        !page || citation.rawPdfSha256 !== raw.rawSha256 || citation.textSha256 !== page.textSha256 || citation.offsetUnit !== 'unicode-code-points' ||
        citation.sourceUrl !== `${P.downloadUrl}#page=${page.page}` || !Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end) ||
        citation.start < 0 || citation.end <= citation.start || citation.end > page.characters || !text(citation.exact, P.pageCharacters * 2) ||
        [...page.text].slice(citation.start, citation.end).join('') !== citation.exact || normalized(citation.exact) !== rule.sentence ||
        pluginJson(citation.extractor) !== pluginJson(extractor)) invalid();
    if (rule.kind === 'source-relative-time-assertion' && (statement.temporal?.kind !== 'source-relative-duration' || statement.temporal.duration !== 'P6M' ||
        statement.temporal.anchor !== null || statement.temporal.applicableFrom !== null || statement.temporal.applicableUntil !== null)) invalid();
    if (rule.kind !== 'source-relative-time-assertion' && (statement.temporal?.kind !== (rule.kind === 'declared-commitment' ? 'declared-future-intention' : 'source-publication-context') || statement.temporal.horizon !== null)) invalid();
    selectors.add(citation.selector);
  }
  return value;
}

function active(work, signal) {
  if (signal.aborted) { void Promise.resolve(work).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function read(response, signal) {
  const declared = response.headers.get('content-length');
  if (!response.ok || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body ||
      declared !== null && (!/^\d+$/.test(declared) || Number(declared) > DOCUMENT_DOSSIER_LIMITS.bytes)) {
    void response.body?.cancel().catch(() => {}); throw new Error('Stored document examination is unavailable.');
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) { signal.throwIfAborted(); const part = await active(reader.read(), signal); signal.throwIfAborted(); if (part.done) break;
      size += part.value.byteLength; if (size > DOCUMENT_DOSSIER_LIMITS.bytes) throw new Error('Stored document exceeds its reading budget.'); chunks.push(part.value); }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) { abort(); throw error; } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** One lazy stored-document view. No constructor request, producer controls,
 * scene clock, geographic state or provider endpoint can enter this controller. */
export function createDocumentDossier({ container, fetchImpl = globalThis.fetch, onBack = () => {}, documentRef = container?.ownerDocument || globalThis.document,
  now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!container || !documentRef) throw new TypeError('Document context needs a container');
  const node = (tag, className, text) => { const el = documentRef.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const link = (text, href, className = '') => { const el = node('a', className, text); el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; return el; };
  const back = node('button', 'plugin-refresh', 'Back to publications'), status = node('p', 'plugin-status'), notice = node('p', 'plugin-caution'), content = node('div', 'plugin-content');
  back.type = 'button'; status.setAttribute('role', 'status'); notice.hidden = true; container.replaceChildren(back, status, notice, content);
  const backClick = () => onBack(); back.addEventListener('click', backClick);
  let opened = false, destroyed = false, generation = 0, request, pending, timer, item, cache, rendered, dirty = false, queued = false, fields = [];
  const visible = () => opened && !destroyed && !documentRef.hidden;
  const stop = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  function cancel() { ++generation; request?.abort(); request = null; pending = null; queued = false; stop(); container.setAttribute('aria-busy', 'false'); }
  function arm() { stop(); if (visible()) timer = setTimeoutImpl(() => { timer = undefined; void load(true); }, DOCUMENT_DOSSIER_LIMITS.refreshMs); }
  function paint(payload) {
    if (!payload.available) { rendered = null; fields = []; notice.hidden = true; content.replaceChildren(node('p', 'plugin-note', payload.explanation)); return; }
    const c = payload.content, r = payload.receipt, signature = `${r.id}:${r.contentSha256}`;
    const messages = [];
    if (!payload.currentInputMatches) messages.push('Source metadata has changed. This examination retains its earlier publication basis.');
    if (payload.latestBodyMatches === false) messages.push('A newer PDF body was retained. These statements describe the earlier body.');
    if (payload.latestBodyMatches === null) messages.push('Compatibility with the latest PDF body is unknown.');
    notice.hidden = !messages.length; notice.textContent = messages.join(' ');
    if (rendered !== signature) {
      const previousEvidence = content.querySelector?.('.plugin-evidence'), open = Boolean(previousEvidence?.open);
      const retainedPdf = `${ORIGINAL_DOCUMENT_URL}?receipt=${encodeURIComponent(c.rawReceipt.id)}`;
      rendered = signature; fields = []; content.replaceChildren();
      content.append(link(P.title, P.pageUrl), node('p', 'plugin-note', `European Commission / European Union · Published ${display(c.source.publishedAt)}`),
        node('p', 'plugin-note', 'Source statements · not independently corroborated.'));
      for (const statement of c.statements) {
        const citation = statement.citation, rule = rules[citation.selector], card = node('article', 'plugin-publication');
        card.append(node('h4', '', rule.label), node('p', 'document-statement', citation.exact));
        const reference = link(`Retained PDF · page ${citation.page}`, `${retainedPdf}#page=${citation.page}`, 'document-citation');
        reference.title = `Text characters ${citation.start}–${citation.end}, measured as Unicode code points.`;
        reference.setAttribute('aria-label', `Retained original PDF, page ${citation.page}, text characters ${citation.start} to ${citation.end}`); card.append(reference);
        if (rule.kind === 'source-relative-time-assertion') card.append(node('p', 'plugin-note', 'Six months is the source’s relative duration; its start and legal applicability dates remain unspecified.'));
        content.append(card);
      }
      const evidence = node('details', 'plugin-evidence'); evidence.open = open; evidence.append(node('summary', '', 'Source, dates and citation evidence'),
        link('Download retained original', retainedPdf), link('Publisher PDF', P.downloadUrl),
        node('p', 'plugin-note', 'Source dates remain independent of globe time.'));
      const facts = node('dl', 'plugin-facts');
      for (const [label, getter] of [['Source published', p => display(p.content.source.publishedAt)], ['Source date as supplied', p => p.content.source.publishedRaw], ['Publication metadata retained', p => display(p.knowledge.metadataRecordedAt)],
        ['Original PDF observed', p => display(p.content.rawReceipt.acquiredAt)], ['Original PDF first retained', p => display(p.knowledge.documentRecordedAt)],
        ['PDF observed for this analysis edition', p => display(p.receipt.acquiredAt)], ['Analysis published', p => display(p.knowledge.analysisPublishedAt)],
        ['Latest body observed', p => p.bodyCheck?.lastBodyObservedAt ? display(p.bodyCheck.lastBodyObservedAt) : 'Unknown'],
        ['Analysis receipt', p => p.receipt.id], ['Analysis input revision', p => p.receipt.inputRevision], ['First raw input revision', p => p.content.rawReceipt.inputRevision],
        ['First raw basis receipt', p => p.content.rawReceipt.basisReceiptId], ['Original PDF SHA-256', p => p.content.rawReceipt.rawSha256],
        ['Stored content SHA-256', p => p.receipt.contentSha256], ['Text method', () => 'pypdf 6.10.0 · Unicode code-point offsets']]) {
        const value = node('dd'); facts.append(node('dt', '', label), value); fields.push({ value, getter });
      }
      for (const statement of c.statements) facts.append(node('dt', '', rules[statement.citation.selector].label),
        node('dd', 'plugin-hash', `Page ${statement.citation.page} · characters [${statement.citation.start}, ${statement.citation.end}) · text SHA-256 ${statement.citation.textSha256}`));
      evidence.append(facts, node('p', 'plugin-note', c.attribution), node('p', 'plugin-note', c.limitations)); content.append(evidence);
    }
    for (const { value, getter } of fields) value.textContent = getter(payload);
  }
  function load(force = false) {
    if (!visible()) return Promise.resolve(false); if (pending) { if (force) queued = true; return pending; }
    if (!force && !dirty && cache && now() - cache.at < DOCUMENT_DOSSIER_LIMITS.refreshMs) { paint(cache.payload); status.textContent = cache.payload.available ? 'Retained source examination' : 'Stored examination unavailable'; arm(); return Promise.resolve(true); }
    stop(); const owner = ++generation, selectedItem = item, controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(DOCUMENT_DOSSIER_LIMITS.deadlineMs)]);
    request = controller; queued = false; container.setAttribute('aria-busy', 'true'); status.textContent = cache ? 'Checking stored examination · previous evidence remains available…' : 'Loading stored document examination…';
    const work = (async () => {
      try {
        const response = await active(fetchImpl(DOCUMENT_DOSSIER_URL, { signal, cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } }), signal);
        const payload = await normalizeDocumentDossier(await read(response, signal), { item: selectedItem }); signal.throwIfAborted();
        if (!visible() || owner !== generation || item !== selectedItem) return false;
        cache = { payload, at: now() }; dirty = false; paint(payload); status.textContent = payload.available ? 'Retained source examination' : 'Stored examination unavailable'; return true;
      } catch (error) {
        if (!visible() || owner !== generation || controller.signal.aborted) return false;
        status.textContent = `${signal.aborted ? 'Stored document examination timed out.' : error.message || 'Stored document examination is unavailable.'}${cache ? ' Previous evidence keeps its original dates.' : ''}`; return false;
      } finally { if (owner === generation && !destroyed) { request = null; pending = null; container.setAttribute('aria-busy', 'false'); if (queued && visible()) void load(true); else arm(); } }
    })(); pending = work; return work;
  }
  return { open({ item: next } = {}) { if (destroyed) return Promise.resolve(false); if (item?.revision !== next?.revision) { dirty = true; cancel(); item = next; } else if (!item) item = next; opened = true; return load(); },
    close() { opened = false; cancel(); }, refresh: () => load(true), invalidate() { dirty = true; if (visible()) void load(true); },
    focus() { back.focus?.(); }, destroy() { if (destroyed) return; destroyed = true; opened = false; cancel(); cache = null; back.removeEventListener('click', backClick); container.replaceChildren(); } };
}
