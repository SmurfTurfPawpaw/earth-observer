import { pluginBytesDigest, pluginFactsDigest, pluginJson } from './plugin-evidence.js';
import { rssPublicationTime } from '../../worker/plugins/bounded-rss.js';

export const EC_DOCUMENT_POLICY = Object.freeze({ id: 'ec-statement-pdf-v1', pluginId: 'ec-press-v1',
  scopeId: 'ec-presscorner-en-metadata-v1', documentReference: 'statement_26_2127',
  pageUrl: 'https://ec.europa.eu/commission/presscorner/detail/en/statement_26_2127',
  downloadUrl: 'https://ec.europa.eu/commission/presscorner/api/files/document/print/en/statement_26_2127/STATEMENT_26_2127_EN.pdf',
  title: 'Statement on the International Criminal Court following announcement of US sanctions',
  rawBytes: 524288, pages: 4, pageCharacters: 16384, textBytes: 65536, artifactBytes: 16384 });
const P = EC_DOCUMENT_POLICY, UTF8 = new TextEncoder();
const statements = Object.freeze({
  'eu-icc-position': Object.freeze({ kind: 'institutional-position', subjectId: 'organization:eu', predicate: 'reports-support-for', objectId: 'organization:icc',
    sentence: 'The European Union has been a constant supporter of the International Criminal Court (ICC).' }),
  'eu-icc-commitment': Object.freeze({ kind: 'declared-commitment', subjectId: 'organization:eu', predicate: 'declares-intention-to-work-with', objectId: 'organization:icc',
    sentence: 'The EU will work closely with the ICC to ensure it continues to operate effectively.' }),
  'reported-us-sanctions-intent': Object.freeze({ kind: 'reported-external-intention', subjectId: 'country:US', predicate: 'reports-intention-to-impose', objectId: 'source-measures:unspecified',
    sentence: 'It is deeply regrettable that the United States has announced intentions to impose sanctions.' }),
  'reported-relative-delay': Object.freeze({ kind: 'source-relative-time-assertion', subjectId: 'source-measures:unspecified', predicate: 'reports-relative-applicability-delay', objectId: null,
    sentence: 'As there is a six-month delay before the measures are applicable, there is room for dialogue.' }),
});
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const normalize = value => value.replace(/\s+/gu, ' ').trim();
const copy = value => JSON.parse(pluginJson(value));
const fail = message => { throw Object.assign(new TypeError(message), { code: 'document_evidence_invalid' }); };
function closed(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('Use the fixed document-evidence contract');
}

/** Integrity binds supplied text to its hashes; it does not prove an untrusted
 * caller extracted that text from the PDF. A trusted bounded producer is a later gate. */
export async function createEcDocumentEvidence(basis, rawPdf, extraction) {
  if (!(rawPdf instanceof Uint8Array) || rawPdf.byteLength < 8 || rawPdf.byteLength > P.rawBytes ||
      !/^%PDF-1\.[0-7]/.test(new TextDecoder().decode(rawPdf.subarray(0, 8)))) fail('Use bounded original PDF bytes');
  return createEvidence(basis, { sha256: await pluginBytesDigest(rawPdf), bytes: rawPdf.byteLength, mediaType: 'application/pdf' }, extraction);
}

async function createEvidence(basis, raw, extraction) {
  closed(raw, ['sha256', 'bytes', 'mediaType']);
  if (!digest(raw.sha256) || !Number.isSafeInteger(raw.bytes) || raw.bytes < 8 || raw.bytes > P.rawBytes || raw.mediaType !== 'application/pdf')
    fail('Use bounded original PDF evidence');
  closed(basis, ['pluginId', 'scopeId', 'item']);
  const item = basis.item;
  closed(item, ['itemId', 'revision', 'kind', 'title', 'url', 'sourceRecordId', 'publishedAt', 'publishedRaw', 'publishedPrecision',
    'documentReference', 'documentType', 'categories', 'firstRecordedAt', 'lastRecordedAt', 'evidence']);
  const receipt = item.evidence;
  closed(receipt, ['id', 'capturedAt', 'recordedAt', 'factsDigest', 'rawSha256', 'artifactSha256', 'sourceUpdatedAt', 'sourceVersion', 'locator']);
  closed(receipt.locator, ['kind', 'guid']);
  let publishedAt;
  try { publishedAt = typeof item.publishedRaw === 'string' ? rssPublicationTime(item.publishedRaw.trim()) : null; }
  catch { fail('Invalid source publication date'); }
  if (basis.pluginId !== P.pluginId || basis.scopeId !== P.scopeId || item.kind !== 'original-publication' || !digest(item.revision) ||
      item.url !== P.pageUrl || item.sourceRecordId !== P.pageUrl || item.documentReference !== P.documentReference || item.documentType !== 'statement' ||
      item.title !== P.title || !utc(item.publishedAt) || publishedAt !== item.publishedAt || item.publishedPrecision !== 'second' || typeof item.publishedRaw !== 'string' || item.publishedRaw.length > 128 ||
      !utc(item.firstRecordedAt) || !utc(item.lastRecordedAt) || Date.parse(item.firstRecordedAt) > Date.parse(item.lastRecordedAt) ||
      !/^receipt:[a-f0-9]{64}$/.test(receipt.id) || !utc(receipt.capturedAt) || !utc(receipt.recordedAt) || item.lastRecordedAt !== receipt.recordedAt ||
      !['factsDigest', 'rawSha256', 'artifactSha256'].every(key => digest(receipt[key])) ||
      receipt.sourceUpdatedAt !== null && !utc(receipt.sourceUpdatedAt) || receipt.sourceVersion !== null && (typeof receipt.sourceVersion !== 'string' || receipt.sourceVersion.length > 100) ||
      receipt.locator.kind !== 'rss-guid' || receipt.locator.guid !== P.pageUrl || !Array.isArray(item.categories) || item.categories.length > 8 ||
      new Set(item.categories).size !== item.categories.length || item.categories.some(value => typeof value !== 'string' || value.length > 256 ||
        !/^POLICY_AREA=[A-Z][A-Z0-9]{0,63}(?:,[A-Z][A-Z0-9]{0,63}){0,15}$/.test(value))) fail('Invalid retained publication basis');
  if (item.itemId !== `publication:ec:${await pluginBytesDigest(UTF8.encode(P.pageUrl))}`) fail('Publication GUID identity mismatch');
  closed(extraction, ['schemaVersion', 'policyId', 'sourceUrl', 'inputMode', 'acquiredAt', 'rawPdfSha256', 'rawPdfBytes', 'extractor',
    'pages', 'pdfCreationDateRaw', 'runtime']);
  closed(extraction.extractor, ['name', 'version', 'mode', 'normalization', 'offsetUnit']);
  closed(extraction.runtime, ['mode', 'wallTimeSeconds', 'peakMemoryEnforced']);
  if (extraction.schemaVersion !== 1 || extraction.policyId !== P.id || extraction.sourceUrl !== P.downloadUrl ||
      !['stdin', 'fixed-fetch'].includes(extraction.inputMode) || extraction.inputMode === 'stdin' && extraction.acquiredAt !== null ||
      extraction.inputMode === 'fixed-fetch' && !utc(extraction.acquiredAt) || extraction.rawPdfBytes !== raw.bytes ||
      extraction.rawPdfSha256 !== raw.sha256 || extraction.extractor.name !== 'pypdf' || extraction.extractor.version !== '6.10.0' ||
      extraction.extractor.mode !== 'default-extract-text' || extraction.extractor.normalization !== 'none' || extraction.extractor.offsetUnit !== 'unicode-code-points' ||
      extraction.runtime.mode !== 'local-supervised' || extraction.runtime.wallTimeSeconds !== 20 || extraction.runtime.peakMemoryEnforced !== false ||
      extraction.pdfCreationDateRaw !== null && (typeof extraction.pdfCreationDateRaw !== 'string' || extraction.pdfCreationDateRaw.length > 80) ||
      !Array.isArray(extraction.pages) || !extraction.pages.length || extraction.pages.length > P.pages) fail('Invalid bounded extraction evidence');
  let textBytes = 0;
  for (const [index, page] of extraction.pages.entries()) {
    closed(page, ['page', 'text', 'textSha256', 'characters']);
    if (page.page !== index + 1 || typeof page.text !== 'string' || !Number.isSafeInteger(page.characters) || page.characters < 1 ||
        page.characters > P.pageCharacters || [...page.text].length !== page.characters ||
        page.textSha256 !== await pluginBytesDigest(UTF8.encode(page.text))) fail('Page text or digest mismatch');
    textBytes += UTF8.encode(page.text).byteLength;
  }
  const text = normalize(extraction.pages.map(page => page.text).join('\n'));
  if (textBytes > P.textBytes || !text.includes('European Commission - Statement') || !text.includes(P.title) ||
      !text.includes('STATEMENT/26/2127') || !text.includes('Brussels, 9 October 2026')) fail('Extracted document identity mismatch');
  const value = { schemaVersion: 1, kind: 'original-document-evidence', policyId: P.id,
    documentId: `document:ec:${await pluginBytesDigest(UTF8.encode(P.pageUrl))}`, status: 'staged-local-evidence',
    source: { publisherId: 'european-commission', pageUrl: P.pageUrl, downloadUrl: P.downloadUrl, documentReference: P.documentReference,
      publishedAt: item.publishedAt, publishedRaw: item.publishedRaw, publishedPrecision: item.publishedPrecision,
      documentDated: { date: '2026-10-09', precision: 'day', meaning: 'source-document-date' },
      pdfCreationDate: { raw: extraction.pdfCreationDateRaw, meaning: 'rendering-metadata-not-publication' } },
    basis: copy(basis), raw: { sha256: extraction.rawPdfSha256, bytes: extraction.rawPdfBytes, mediaType: 'application/pdf' },
    extraction: copy(extraction), textDigest: await pluginFactsDigest(extraction.pages.map(({ page, textSha256, characters }) => ({ page, textSha256, characters }))),
    knowledge: { metadataRecordedAt: receipt.recordedAt, documentRecordedAt: null, analysisPublishedAt: null },
    limitations: 'Locally staged evidence, not a hosted document or analysis publication. Source statements are attributed, not independently verified. Supplied hashes do not authenticate an arbitrary extraction producer. No legal applicability date, incident geography, confidence or causal prediction is inferred.' };
  return { ...value, revision: await pluginFactsDigest(value) };
}

/** Only reviewed full-sentence selectors are admitted. Arbitrary paraphrases,
 * effective dates, geometry and confidence cannot enter this staged artifact. */
export async function createEcDocumentArtifact(evidence, citations) {
  if (!evidence || evidence.kind !== 'original-document-evidence' || evidence.policyId !== P.id || !digest(evidence.revision)) fail('Use verified staged document evidence');
  closed(evidence, ['schemaVersion', 'kind', 'policyId', 'documentId', 'status', 'source', 'basis', 'raw', 'extraction', 'textDigest', 'knowledge', 'limitations', 'revision']);
  const { revision, ...content } = evidence;
  if (await pluginFactsDigest(content) !== revision || !Array.isArray(citations) || !citations.length || citations.length > 4) fail('Evidence revision or citation budget mismatch');
  // A valid hash alone is not admission: rebuilding validates every nested input
  // and checks derived source/date/status fields without trusting caller additions.
  const validated = await createEvidence(evidence.basis, evidence.raw, evidence.extraction);
  if (validated.revision !== revision) fail('Evidence does not match the reviewed source contract');
  const selected = [], seen = new Set();
  for (const citation of citations) {
    closed(citation, ['selector', 'page', 'start', 'end', 'exact']);
    const template = Object.hasOwn(statements, citation.selector) ? statements[citation.selector] : null;
    const page = evidence.extraction.pages.find(page => page.page === citation.page);
    if (!template || seen.has(citation.selector) || !page || !Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end) ||
        citation.start < 0 || citation.end <= citation.start || citation.end > page.characters || typeof citation.exact !== 'string' ||
        [...page.text].slice(citation.start, citation.end).join('') !== citation.exact || normalize(citation.exact) !== template.sentence)
      fail('Citation does not resolve to the reviewed full source sentence');
    seen.add(citation.selector);
    selected.push({ id: `statement:${await pluginFactsDigest([evidence.documentId, citation.selector])}`, kind: template.kind,
      publisherId: 'european-commission', claimantId: 'organization:european-commission', subjectId: template.subjectId,
      predicate: template.predicate, objectId: template.objectId, meaning: 'attributed-source-statement',
      temporal: template.kind === 'source-relative-time-assertion' ? { kind: 'source-relative-duration', duration: 'P6M', anchor: null, applicableFrom: null, applicableUntil: null } :
        { kind: template.kind === 'declared-commitment' ? 'declared-future-intention' : 'source-publication-context', horizon: null },
      citation: { ...copy(citation), rawPdfSha256: evidence.raw.sha256, textSha256: page.textSha256, offsetUnit: 'unicode-code-points',
        sourceUrl: `${P.downloadUrl}#page=${page.page}`, extractor: copy(evidence.extraction.extractor) } });
  }
  selected.sort((a, b) => a.id.localeCompare(b.id));
  const value = { schemaVersion: 1, kind: 'attributed-document-statements', policyId: P.id, documentId: evidence.documentId,
    documentEvidenceRevision: evidence.revision, source: copy(evidence.source), basis: copy(evidence.basis), raw: copy(evidence.raw),
    statements: selected, knowledge: copy(evidence.knowledge), status: 'staged-local-artifact',
    attribution: 'European Commission / European Union; source statements selected and classified by this reviewed policy. Original document linked; CC BY4.0 subject to source exceptions.',
    limitations: 'No independent corroboration, legal applicability date, observed outcome, incident location, confidence or geopolitical causal inference. Relative delays retain an unknown anchor. Publication requires a separately verified durable admission and trusted producer.' };
  const artifact = { ...value, revision: await pluginFactsDigest(value) };
  if (UTF8.encode(pluginJson(artifact)).byteLength > P.artifactBytes) fail('Document artifact budget');
  return artifact;
}
