import test from 'node:test';
import assert from 'node:assert/strict';
import { EC_DOCUMENT_POLICY as P, createEcDocumentEvidence, createEcDocumentArtifact } from './document-evidence.js';
import { pluginBytesDigest, pluginFactsDigest } from './plugin-evidence.js';

const UTF8 = new TextEncoder(), raw = UTF8.encode('%PDF-1.4\nTEST ONLY synthetic integrity bytes, not a source PDF');
const sentences = {
  'eu-icc-position': 'The European Union has been a constant supporter of the International Criminal Court (ICC).',
  'eu-icc-commitment': 'The EU will work closely with the ICC to ensure it continues to operate effectively.',
  'reported-us-sanctions-intent': 'It is deeply regrettable that the United States has announced intentions to impose sanctions.',
  'reported-relative-delay': 'As there is a six-month delay before the measures are applicable, there is room for dialogue.',
};
const text = `TEST ONLY 😀\nEuropean Commission - Statement\n${P.title}\nBrussels, 9 October 2026\n${Object.values(sentences).join('\n')}\nSTATEMENT/26/2127`;
const itemId = `publication:ec:${await pluginBytesDigest(UTF8.encode(P.pageUrl))}`;
const basis = { pluginId: P.pluginId, scopeId: P.scopeId, item: { itemId, revision: 'a'.repeat(64), kind: 'original-publication',
  title: P.title, url: P.pageUrl, sourceRecordId: P.pageUrl, documentReference: P.documentReference, documentType: 'statement',
  publishedAt: '2026-10-09T12:14:20.000Z', publishedRaw: 'Fri, 09 Oct 2026 12:14:20 GMT', publishedPrecision: 'second',
  categories: ['POLICY_AREA=GROWTH,JFRC'], firstRecordedAt: '2026-10-12T00:00:00.000Z', lastRecordedAt: '2026-10-12T00:00:00.000Z',
  evidence: { id: `receipt:${'b'.repeat(64)}`, capturedAt: '2026-10-11T23:59:00.000Z', recordedAt: '2026-10-12T00:00:00.000Z',
    factsDigest: 'c'.repeat(64), rawSha256: 'd'.repeat(64), artifactSha256: 'e'.repeat(64), sourceUpdatedAt: null, sourceVersion: 'RSS 2.0',
    locator: { kind: 'rss-guid', guid: P.pageUrl } } } };
const extraction = { schemaVersion: 1, policyId: P.id, sourceUrl: P.downloadUrl, inputMode: 'stdin', acquiredAt: null,
  rawPdfSha256: await pluginBytesDigest(raw), rawPdfBytes: raw.byteLength,
  extractor: { name: 'pypdf', version: '6.10.0', mode: 'default-extract-text', normalization: 'none', offsetUnit: 'unicode-code-points' },
  pages: [{ page: 1, text, textSha256: await pluginBytesDigest(UTF8.encode(text)), characters: [...text].length }],
  pdfCreationDateRaw: "D:20261009171414+02'00'", runtime: { mode: 'local-supervised', wallTimeSeconds: 20, peakMemoryEnforced: false } };
const clone = value => JSON.parse(JSON.stringify(value));
const citations = Object.entries(sentences).map(([selector, exact]) => { const at = text.indexOf(exact), start = [...text.slice(0, at)].length;
  return { selector, exact, page: 1, start, end: start + [...exact].length }; });

test('source basis, original/extraction/text hashes and staged dates remain separate and immutable', async () => {
  const before = JSON.stringify([basis, extraction]), evidence = await createEcDocumentEvidence(basis, raw, extraction);
  assert.equal(evidence.raw.sha256, extraction.rawPdfSha256); assert.equal(evidence.basis.item.evidence.rawSha256, basis.item.evidence.rawSha256);
  assert.notEqual(evidence.raw.sha256, evidence.basis.item.evidence.rawSha256, 'feed raw bytes are not document raw bytes');
  assert.equal(evidence.source.publishedAt, basis.item.publishedAt); assert.equal(evidence.source.documentDated.precision, 'day');
  assert.equal(evidence.source.pdfCreationDate.meaning, 'rendering-metadata-not-publication');
  assert.equal(evidence.knowledge.documentRecordedAt, null); assert.equal(evidence.knowledge.analysisPublishedAt, null);
  assert.equal(evidence.extraction.acquiredAt, null); assert.equal(evidence.extraction.runtime.peakMemoryEnforced, false);
  assert.equal(JSON.stringify([basis, extraction]), before);
  assert.deepEqual(await createEcDocumentEvidence(clone(basis), raw, clone(extraction)), evidence);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
});

test('reviewed full-sentence citations resolve in Unicode code points and never imply legal dates or outcome verification', async () => {
  const evidence = await createEcDocumentEvidence(basis, raw, extraction), artifact = await createEcDocumentArtifact(evidence, citations);
  assert.equal(artifact.statements.length, 4); assert.equal(artifact.documentEvidenceRevision, evidence.revision);
  for (const statement of artifact.statements) {
    assert.equal(statement.claimantId, 'organization:european-commission'); assert.equal(statement.meaning, 'attributed-source-statement');
    assert.equal(statement.citation.offsetUnit, 'unicode-code-points'); assert.equal(statement.citation.rawPdfSha256, evidence.raw.sha256);
    assert.equal([...text].slice(statement.citation.start, statement.citation.end).join(''), statement.citation.exact);
    assert.equal('confidence' in statement, false); assert.equal('geometry' in statement, false);
  }
  const relative = artifact.statements.find(item => item.kind === 'source-relative-time-assertion');
  assert.deepEqual(relative.temporal, { kind: 'source-relative-duration', duration: 'P6M', anchor: null, applicableFrom: null, applicableUntil: null });
  assert.equal(artifact.knowledge.analysisPublishedAt, null);
  const { revision, ...content } = artifact; assert.equal(revision, await pluginFactsDigest(content));
});

test('PDF/text digest, page count, producer version and declared acquisition tampering fail closed', async () => {
  for (const change of [value => { value.rawPdfSha256 = 'f'.repeat(64); }, value => { value.rawPdfBytes++; },
    value => { value.pages[0].text += 'tampered'; }, value => { value.pages[0].characters++; }, value => { value.pages[0].page = 2; },
    value => { value.extractor.version = 'different'; }, value => { value.extractor.offsetUnit = 'utf16'; },
    value => { value.acquiredAt = '2026-10-12T00:01:00.000Z'; }, value => { value.runtime.peakMemoryEnforced = true; },
    value => { value.pages = Array.from({ length: 5 }, () => value.pages[0]); }, value => { value.sourceUrl = 'https://evil.example/doc.pdf'; }]) {
    const value = clone(extraction); change(value); await assert.rejects(createEcDocumentEvidence(basis, raw, value), { code: 'document_evidence_invalid' });
  }
  await assert.rejects(createEcDocumentEvidence(basis, UTF8.encode('%PDF-1.4 altered'), extraction), { code: 'document_evidence_invalid' });
});

test('unretained/mismatched identities, fake snapshot references and temporal substitutions cannot enter the source basis', async () => {
  for (const change of [value => { value.item.itemId = `publication:ec:${'f'.repeat(64)}`; }, value => { value.scopeId = 'other'; },
    value => { value.item.sourceRecordId += '?other'; }, value => { value.item.evidence.locator.guid = 'different'; },
    value => { value.item.snapshotId = 'fake'; }, value => { value.item.publishedAt = value.item.evidence.recordedAt; },
    value => { value.item.evidence.recordedAt = '2026-10-12'; }, value => { value.item.firstRecordedAt = '2026-10-13T00:00:00.000Z'; }]) {
    const value = clone(basis); change(value); await assert.rejects(createEcDocumentEvidence(value, raw, extraction), { code: 'document_evidence_invalid' });
  }
});

test('citation drift, cherry-picked fragments, arbitrary claims and extra legal/geographic/confidence fields are rejected', async () => {
  const evidence = await createEcDocumentEvidence(basis, raw, extraction);
  for (const change of [value => { value.start++; }, value => { value.end++; }, value => { value.exact = 'different'; },
    value => { value.selector = 'invented-causality'; }, value => { value.confidence = 1; }, value => { value.applicableFrom = '2027-04-09'; },
    value => { value.geometry = { lat: 50, lon: 4 }; }, value => { value.page = 2; }]) {
    const value = clone(citations[0]); change(value); await assert.rejects(createEcDocumentArtifact(evidence, [value]), { code: 'document_evidence_invalid' });
  }
  await assert.rejects(createEcDocumentArtifact(evidence, [citations[0], citations[0]]), { code: 'document_evidence_invalid' });
  const altered = clone(evidence); altered.source.publishedAt = '2026-10-12T00:00:00.000Z';
  await assert.rejects(createEcDocumentArtifact(altered, citations), { code: 'document_evidence_invalid' });
});

test('rehashed evidence still requires the closed source/date/text contract before producing an artifact', async () => {
  const evidence = await createEcDocumentEvidence(basis, raw, extraction);
  for (const change of [value => { value.source.geometry = { lat: 50, lon: 4 }; },
    value => { value.source.publishedAt = value.basis.item.evidence.recordedAt; },
    value => { value.knowledge.documentRecordedAt = value.basis.item.evidence.recordedAt; },
    value => { value.extraction.pages[0].textSha256 = 'f'.repeat(64); },
    value => { value.basis.item.snapshotId = 'fabricated'; },
    value => { value.raw.mediaType = 'text/plain'; },
    value => { value.status = 'published'; }]) {
    const altered = clone(evidence); change(altered);
    const { revision, ...content } = altered; altered.revision = await pluginFactsDigest(content);
    await assert.rejects(createEcDocumentArtifact(altered, citations), { code: 'document_evidence_invalid' });
  }
});
