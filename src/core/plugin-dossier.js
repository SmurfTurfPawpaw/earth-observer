import { worldTime, isWorldDigest } from './world-model.js';
import { pluginRevision, newerPluginRevision, PLUGIN_UPDATE_SCOPES } from './live-updates.js';
import { createGasExposureScenario } from './gas-scenario.js';

export const PLUGIN_DOSSIER_LIMITS = Object.freeze({ bytes: 256 * 1024, publications: 40, years: 10, origins: 20, refreshMs: 300000 });
const VIEWS = Object.freeze({ gas: { label: 'Belgian gas', pluginId: 'eurostat-gas-origins-v1', url: '/api/dossiers/belgium-natural-gas-origins', kind: 'dataset-dossier' },
  publications: { label: 'ECB releases', title: 'ECB institutional releases', subtitle: 'Original publications · European Central Bank', pluginId: 'ecb-press-v1', url: '/api/publications?plugin=ecb-press-v1&limit=20', kind: 'publication-feed-overview' },
  commission: { label: 'Commission', title: 'European Commission publications', subtitle: 'Original publication metadata · European Commission / European Union', pluginId: 'ec-press-v1', url: '/api/publications?plugin=ec-press-v1&limit=20', kind: 'publication-feed-overview' } });
const EC_DOCUMENT_TYPES = Object.freeze({ ip: 'Press release', statement: 'Statement', read: 'Readout', qanda: 'Questions and answers', fs: 'Factsheet', mex: 'Daily news', speech: 'Speech' });
const EC_REFERENCE = /^https:\/\/ec\.europa\.eu\/commission\/presscorner\/detail\/en\/([a-z]+)_([0-9]{2})_([0-9]{1,7})$/;
const time = (value) => { try { return worldTime(value); } catch { return null; } };
const displayTime = (value) => time(value)?.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') || 'Not supplied';
const text = (value, bound = 1000) => typeof value === 'string' && value.length > 0 && value.length <= bound;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const sourceUrl = (value, view) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048 &&
    (view === 'publications' ? url.hostname === 'www.ecb.europa.eu' : url.hostname === 'ec.europa.eu') ? url.href : null; } catch { return null; }
};

/** Admit reviewed stored projections; external strings never become markup or map features. */
export function normalizePluginDossier(value, view) {
  const spec = VIEWS[view];
  if (!spec || value?.schemaVersion !== 1 || typeof value.configured !== 'boolean' || typeof value.available !== 'boolean' ||
    value.plugin?.id !== spec.pluginId || value.plugin.scopeId !== PLUGIN_UPDATE_SCOPES[spec.pluginId] || !sourceUrl(value.plugin.sourceUrl, view) ||
    view === 'commission' && value.plugin.sourceUrl !== 'https://ec.europa.eu/commission/presscorner/api/rss?') throw new Error('Stored source context has an incompatible contract');
  if (!value.available) return value;
  if (!value.configured) throw new Error('Stored source context is unavailable');
  const receipt = value.receipt, artifact = value.artifact;
  if (!receipt || !text(receipt.id, 256) || !time(receipt.capturedAt) || !time(receipt.recordedAt) ||
    !['factsDigest', 'rawSha256', 'artifactSha256'].every((key) => isWorldDigest(receipt[key])) ||
    artifact?.schemaVersion !== 1 || artifact.kind !== spec.kind) throw new Error('Stored source context has no compatible evidence receipt');
  if (view === 'gas') {
    if (value.plugin.id !== 'eurostat-gas-origins-v1' || value.plugin.scopeId !== 'belgium-natural-gas-origins' || artifact.dossierId !== 'belgium-natural-gas-origins' || artifact.reportingCountry?.code !== 'BE' || artifact.resource?.code !== 'G3000' ||
      artifact.unit?.code !== 'TJ_GCV' || !text(artifact.unit.label, 160) || !sourceUrl(artifact.source?.url, view) || !sourceUrl(artifact.source?.datasetUrl, view) ||
      !Array.isArray(artifact.years) || artifact.years.length > PLUGIN_DOSSIER_LIMITS.years || !Array.isArray(artifact.referenceYears) ||
      !text(artifact.formula, 1000) || !text(artifact.limitations, 4000)) throw new Error('Annual gas context has an incompatible scope');
    for (const year of artifact.years) {
      if (!/^\d{4}$/.test(year.year) || !artifact.referenceYears.includes(year.year) || !time(year.period?.from) || !time(year.period?.until) ||
        year.period.meaning !== 'calendar-year' || !year.total || year.total.value !== null && !finite(year.total.value) ||
        !Array.isArray(year.shares) || year.shares.length > PLUGIN_DOSSIER_LIMITS.origins || !year.coverage || year.coverage.reconciled !== null && typeof year.coverage.reconciled !== 'boolean') throw new Error('Annual gas period is invalid');
      for (const row of year.shares) if (!text(row.partner?.code, 40) || !text(row.partner.label, 160) || !finite(row.quantity) || row.sharePercent !== null && !finite(row.sharePercent)) throw new Error('Annual gas origin row is invalid');
    }
  } else {
    if (artifact.pluginId !== spec.pluginId || artifact.scopeId !== PLUGIN_UPDATE_SCOPES[spec.pluginId] || !Array.isArray(value.items) || value.items.length > PLUGIN_DOSSIER_LIMITS.publications ||
      value.counts?.returned !== value.items.length || typeof value.counts?.more !== 'boolean') throw new Error('Institutional publication context is invalid');
    const ids = new Set();
    for (const item of value.items) {
      const url = sourceUrl(item.url, view);
      if (!text(item.itemId, 256) || ids.has(item.itemId) || !isWorldDigest(item.revision) || item.kind !== 'original-publication' || !text(item.title, 1000) ||
        !url || (view === 'commission' ? !EC_REFERENCE.test(url) : !/^\/{1,2}press\/pr\/date\//.test(new URL(url).pathname)) || !time(item.publishedAt) || item.publishedPrecision !== 'second' ||
        !time(item.firstRecordedAt) || !time(item.lastRecordedAt)) throw new Error('Institutional publication record is invalid');
      if (view === 'commission') {
        const reference = EC_REFERENCE.exec(url), documentReference = `${reference[1]}_${reference[2]}_${reference[3]}`;
        if (!/^publication:ec:[a-f0-9]{64}$/.test(item.itemId) || item.publisherId !== 'european-commission' ||
          !Object.hasOwn(EC_DOCUMENT_TYPES, item.documentType) || item.documentType !== reference[1] || item.documentReference !== documentReference ||
          !text(item.publishedRaw, 128) || Date.parse(item.publishedRaw.trim()) !== Date.parse(item.publishedAt) ||
          !Array.isArray(item.categories) || item.categories.length > 8 || new Set(item.categories).size !== item.categories.length ||
          item.categories.some((category, index) => !text(category, 256) || !/^POLICY_AREA=[A-Z][A-Z0-9]{0,63}(?:,[A-Z][A-Z0-9]{0,63}){0,15}$/.test(category) ||
            index > 0 && item.categories[index - 1] >= category)) throw new Error('Commission publication metadata is incompatible with its source reference');
      }
      const own = item.evidence;
      if (!own || !/^receipt:[a-f0-9]{64}$/.test(own.id || '') || !time(own.capturedAt) || !time(own.recordedAt) ||
        !['factsDigest', 'rawSha256', 'artifactSha256'].every((key) => isWorldDigest(own[key])) ||
        own.sourceUpdatedAt != null && !time(own.sourceUpdatedAt) || own.sourceVersion != null && !text(own.sourceVersion, 100) ||
        !text(item.sourceRecordId, 2048) || item.sourceRecordId !== item.url || own.locator?.kind !== 'rss-guid' || own.locator.guid !== item.sourceRecordId ||
        time(own.recordedAt) !== time(item.lastRecordedAt) || time(item.firstRecordedAt) > time(own.recordedAt) || time(own.recordedAt) > time(receipt.recordedAt))
        throw new Error('Institutional publication has no compatible source receipt');
      ids.add(item.itemId);
    }
  }
  return value;
}

async function readStored(response, signal) {
  if (!response.ok) throw new Error(`Stored context HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > PLUGIN_DOSSIER_LIMITS.bytes) throw new Error('Stored context exceeds its delivery bound');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Stored context body is unavailable');
  const chunks = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      size += value.byteLength; if (size > PLUGIN_DOSSIER_LIMITS.bytes) { cancel(); throw new Error('Stored context exceeds its delivery bound'); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** One existing context workspace; only its selected, visible source owns delivery. */
export function createPluginDossierPanel({ container, createFeed, subscribeUpdates, fetchImpl = (...args) => fetch(...args), documentRef = container?.ownerDocument || globalThis.document,
  windowRef = documentRef?.defaultView || globalThis.window, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!container || !documentRef || typeof createFeed !== 'function') throw new TypeError('Source context needs a container and current-feed delegate');
  const node = (tag, className, value) => { const el = documentRef.createElement(tag); if (className) el.className = className; if (value !== undefined) el.textContent = value; return el; };
  const link = (label, url) => { const el = node('a', '', label); el.href = url; el.target = '_blank'; el.rel = 'noopener noreferrer'; return el; };
  const nav = node('nav', 'context-navigation'); nav.setAttribute('aria-label', 'Source context views');
  const feedHost = node('section', 'context-feed'), dossierHost = node('section', 'plugin-dossier'); dossierHost.id = 'plugin-context-details'; feedHost.id = 'current-context-feeds';
  const scope = node('p', 'plugin-note'); scope.hidden = true; scope.textContent = 'Context follows its own reporting and publication dates. It is not a historical globe layer.';
  const buttons = new Map(), bindings = [], cache = new Map();
  for (const [id, label] of [['feeds', 'Current feeds'], ...Object.entries(VIEWS).map(([id, spec]) => [id, spec.label])]) {
    const button = node('button', '', label); button.type = 'button'; button.setAttribute('aria-controls', id === 'feeds' ? feedHost.id : dossierHost.id);
    const click = () => { void select(id); }; button.addEventListener('click', click); bindings.push([button, click]); buttons.set(id, button); nav.append(button);
  }
  const title = node('h3', 'plugin-title'), subtitle = node('p', 'plugin-subtitle'), status = node('p', 'plugin-status'); status.setAttribute('role', 'status');
  const content = node('div', 'plugin-content'), refresh = node('button', 'plugin-refresh', 'Refresh stored context'); refresh.type = 'button';
  dossierHost.append(title, subtitle, status, content, refresh); container.replaceChildren(nav, scope, feedHost, dossierHost);
  let view = 'feeds', opened = false, destroyed = false, generation = 0, request, pending, timer, feed, feedPending, mode = 'live', rendered = null, followupRequested = false;
  const dirty = new Set(), updates = new Map(); let evidenceBindings = [], scenario;
  const stopTimer = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  const cancel = () => { ++generation; scenario?.suspend(); request?.abort(); request = null; pending = null; followupRequested = false; stopTimer(); dossierHost.setAttribute('aria-busy', 'false'); refresh.disabled = false; };
  function arm() {
    stopTimer(); if (!opened || destroyed || documentRef.hidden || view === 'feeds') return;
    timer = setTimeoutImpl(() => { timer = undefined; void load(true); }, PLUGIN_DOSSIER_LIMITS.refreshMs);
  }
  function evidence(payload, extra = [], label = 'Source and retained evidence') {
    const details = node('details', 'plugin-evidence'); details.append(node('summary', '', label));
    details.append(link(payload.plugin.name || 'Original source', payload.plugin.sourceUrl));
    const facts = node('dl', 'plugin-facts');
    bindFacts(facts, payload, [['Source retrieved', p => displayTime(p.receipt.capturedAt)], ['Receipt recorded', p => displayTime(p.receipt.recordedAt)],
      ['Source revised', p => p.receipt.sourceUpdatedAt ? displayTime(p.receipt.sourceUpdatedAt) : null],
      ['Stored source checked', p => displayTime(p.check?.checkedAt)], ...extra,
      ['Raw SHA-256', p => p.receipt.rawSha256], ['Facts SHA-256', p => p.receipt.factsDigest], ['Artifact SHA-256', p => p.receipt.artifactSha256]]);
    details.append(facts); return details;
  }
  function bindFacts(host, payload, fields) {
    for (const [label, value] of fields) {
      const getter = typeof value === 'function' ? value : () => value, title = node('dt', '', label), data = node('dd');
      host.append(title, data); evidenceBindings.push({ title, data, getter });
      const current = getter(payload); title.hidden = data.hidden = current == null; data.textContent = current == null ? '' : String(current);
    }
  }
  function refreshEvidence(payload) {
    for (const { title, data, getter } of evidenceBindings) {
      const current = getter(payload); if (title) title.hidden = current == null;
      data.hidden = current == null; data.textContent = current == null ? '' : String(current);
    }
  }
  function gasScenario() {
    const details = node('details', 'plugin-evidence plugin-scenario'); details.append(node('summary', '', 'Explore a scenario'));
    details.append(node('p', 'plugin-note', 'Hypothetical · 2024 reported imports. Other origins stay fixed; replacement is an assumption.'));
    const controls = node('div', 'intelligence-filters'), origin = node('select'), reduction = node('input'), replacement = node('input');
    origin.name = 'gas-scenario-origin'; reduction.name = 'gas-scenario-reduction'; replacement.name = 'gas-scenario-replacement';
    for (const [label, input] of [['Reported origin', origin], ['Reduce this origin’s imports (%)', reduction], ['Replace the lost volume (%)', replacement]]) {
      input.setAttribute('aria-label', label); const field = node('label', '', label); field.append(input); controls.append(field);
    }
    for (const [input, value] of [[reduction, '25'], [replacement, '40']]) { input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '0.1'; input.value = value; input.required = true; }
    const notice = node('p', 'plugin-note plugin-scenario-status'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const output = node('div', 'plugin-scenario-result'), values = node('dl', 'plugin-facts'), fields = new Map(); output.hidden = true;
    for (const [key, label] of [['lostOriginVolume', 'Lost origin volume'], ['replacementVolume', 'Assumed replacement'], ['residualGapVolume', 'Remaining gap'], ['residualGapPercentOfReportedTotal', 'Gap as share of 2024 TOTAL']]) {
      const value = node('dd'); values.append(node('dt', '', label), value); fields.set(key, value);
    }
    const proof = node('details', 'plugin-item-evidence'), proofFacts = node('dl', 'plugin-facts');
    proof.append(node('summary', '', 'Assumptions and evidence'), proofFacts); output.append(values, proof); details.append(controls, notice, output);
    let baseline, baselineKey, epoch = 0, resultKey, calculatingKey, waiting = false, baselineChanged = false, originChanged = false;
    const eligible = payload => payload?.available ? (payload.artifact.years.find(year => year.year === '2024')?.shares || []).filter(row =>
      row.partner.type === 'reported-country-or-territory' && /^[A-Z]{2}$/.test(row.partner.code) && !['EU', 'EA', 'UN', 'ZZ'].includes(row.partner.code) &&
      row.status === null && finite(row.quantity) && row.quantity > 0 && finite(row.sharePercent)) : [];
    const clearResult = () => { ++epoch; resultKey = calculatingKey = null; output.hidden = true; };
    const visible = () => opened && !destroyed && !documentRef.hidden && view === 'gas' && details.open;
    const percent = input => String(input.value ?? '').trim() === '' ? NaN : Number(input.value);
    function compute() {
      if (!visible()) return;
      if (waiting || dirty.has('gas')) { notice.textContent = 'Stored evidence changed. Waiting for the updated 2024 baseline…'; return; }
      if (!origin.value) { notice.textContent = 'A qualifying 2024 reported origin is unavailable for this scenario.'; return; }
      const assumptions = { year: '2024', originCode: origin.value, reductionPercent: percent(reduction), replacementPercent: percent(replacement) };
      const key = JSON.stringify([baselineKey, assumptions.originCode, reduction.value, replacement.value]);
      if (resultKey === key || calculatingKey === key) return;
      clearResult(); const owner = epoch; calculatingKey = key; notice.textContent = 'Calculating from the retained 2024 evidence…';
      void createGasExposureScenario(baseline, assumptions).then(value => {
        if (owner !== epoch || !visible() || waiting || dirty.has('gas')) return;
        resultKey = key; calculatingKey = null;
        for (const [field, el] of fields) el.textContent = `${number.format(value.result[field])}${field === 'residualGapPercentOfReportedTotal' ? '%' : ' TJ'}`;
        proofFacts.replaceChildren();
        for (const [label, fact] of [['Origin', value.baseline.origin.label], ['Reference year', value.baseline.referenceYear],
          ['Origin reduction', `${value.assumptions.originReductionPercent}%`], ['Lost volume replaced', `${value.assumptions.replacementPercentOfLostVolume}%`],
          ['Assumptions', value.assumptions.meaning], ['Reported origin volume', `${number.format(value.baseline.originVolume)} TJ`],
          ['Reported TOTAL', `${number.format(value.baseline.reportedTotal)} TJ`], ['Source unit', value.baseline.unit.code],
          ['Source receipt', value.provenance.receiptId], ['Receipt recorded', displayTime(value.provenance.recordedAt)], ['Input revision', value.provenance.inputRevision],
          ['Input SHA-256', value.provenance.inputDigest], ['Raw SHA-256', value.provenance.rawSha256], ['Artifact SHA-256', value.provenance.artifactSha256],
          ['Origin cell', value.provenance.locators.originValue], ['TOTAL cell', value.provenance.locators.reportedTotal],
          ['Method', value.methodId], ['Scenario ID', value.id], ['Method limits', value.limitations]]) proofFacts.append(node('dt', '', label), node('dd', '', fact));
        output.hidden = false;
        notice.textContent = `${baselineChanged ? 'Stored evidence updated; scenario recalculated. ' : ''}${originChanged ? 'The previous origin is unavailable; the selected origin changed. ' : ''}Hypothetical result against 2024 reported imports.`;
      }).catch(error => {
        if (owner !== epoch || !visible()) return;
        calculatingKey = null; notice.textContent = `Scenario unavailable: ${error.message || 'The retained evidence cannot support this calculation.'}`;
      });
    }
    const change = () => { baselineChanged = originChanged = false; clearResult(); compute(); };
    const toggle = () => { if (details.open) compute(); else { ++epoch; calculatingKey = null; } };
    origin.addEventListener('change', change); reduction.addEventListener('input', change); replacement.addEventListener('input', change); details.addEventListener('toggle', toggle);
    return { element: details,
      update(payload) {
        const key = payload.available ? JSON.stringify([payload.receipt.id, payload.receipt.artifactSha256, payload.artifact.inputRevision]) : 'unavailable';
        waiting = dirty.has('gas'); baseline = payload;
        if (key !== baselineKey) {
          baselineChanged = baselineKey !== undefined; baselineKey = key; clearResult();
          const rows = eligible(payload), previousOrigin = origin.value;
          origin.replaceChildren(...rows.map(row => { const option = node('option', '', row.partner.label); option.value = row.partner.code; return option; }));
          origin.value = rows.some(row => row.partner.code === previousOrigin) ? previousOrigin : rows[0]?.partner.code || '';
          originChanged = !!previousOrigin && previousOrigin !== origin.value;
          origin.disabled = reduction.disabled = replacement.disabled = !rows.length;
          notice.textContent = baselineChanged ? 'Stored evidence updated. The scenario uses the updated 2024 baseline.' : 'Choose assumptions for the retained 2024 baseline.';
        }
        compute();
      },
      invalidate() { waiting = true; clearResult(); notice.textContent = 'Stored evidence changed. Waiting for the updated 2024 baseline…'; },
      suspend() { ++epoch; calculatingKey = null; },
      destroy() { clearResult(); origin.removeEventListener('change', change); reduction.removeEventListener('input', change); replacement.removeEventListener('input', change); details.removeEventListener('toggle', toggle); }
    };
  }
  function render(payload) {
    const signature = JSON.stringify([view, payload.available, payload.explanation, payload.available && (view === 'gas' ?
      [payload.receipt.factsDigest, payload.artifact.policyId] : payload.items.map(item => [item.itemId, item.revision]))]);
    if (rendered === signature) { refreshEvidence(payload); if (view === 'gas') scenario?.update(payload); return; }
    rendered = signature; evidenceBindings = []; content.replaceChildren();
    if (!payload.available) { if (view === 'gas') scenario?.update(payload); content.append(node('p', 'plugin-note', text(payload.explanation, 2000) ? payload.explanation : 'No retained source artifact is available yet.')); return; }
    const artifact = payload.artifact;
    if (view === 'gas') {
      title.textContent = 'Belgian natural-gas origins'; subtitle.textContent = `Annual reported imports · ${artifact.referenceYears.join(', ')} · TJ`;
      content.append(node('p', 'plugin-note', 'Annual imports by reported country of origin.'));
      const methods = evidence(payload, [['Unit', 'terajoules · gross calorific value'], ['Source unit code', artifact.unit.code],
        ['Source unit label', artifact.unit.label], ['Share formula', artifact.formula]], 'Source and method');
      for (const year of artifact.years) {
        const block = node('section', 'plugin-year'); block.append(node('h4', '', `${year.year} reported imports`));
        const total = node('p', 'plugin-total', year.total.value === null ? 'Reported total unavailable' : `${number.format(year.total.value)} TJ`);
        total.title = 'terajoules · gross calorific value'; block.append(total);
        if (year.total.status) block.append(node('p', 'plugin-note', `Reported TOTAL source flag: ${year.total.status}`));
        const table = node('table', 'plugin-origins'); table.append(node('caption', '', `${year.year} · ${year.omittedShareRows ? 'largest ' : ''}reported origin quantities and shares of TOTAL`));
        const head = node('thead'), headings = node('tr'); for (const label of ['Reported origin', 'TJ', 'Share']) { const th = node('th', '', label); th.scope = 'col'; if (label === 'TJ') th.title = 'terajoules · gross calorific value'; headings.append(th); } head.append(headings);
        const body = node('tbody');
        for (const row of year.shares) { const tr = node('tr'), partner = node('th', '', row.partner.label); partner.scope = 'row';
          if (row.status) partner.append(node('span', 'plugin-source-flag', `Source flag: ${row.status}`));
          const share = node('td', '', row.sharePercent === null ? 'Unavailable' : `${number.format(row.sharePercent)}%`);
          if (row.sharePercent === null && row.shareUnavailableReason) share.append(node('span', 'plugin-source-flag', row.shareUnavailableReason));
          tr.append(partner, node('td', '', number.format(row.quantity)), share); body.append(tr); }
        table.append(head, body); block.append(table);
        if (!year.shares.length) block.append(node('p', 'plugin-note', 'No qualifying origin shares are available for this period.'));
        const c = year.coverage; methods.append(node('p', 'plugin-note', `${year.year}: ${c.partnerRows ?? 'Unknown'} partner rows · ${c.missingRows ?? 'Unknown'} missing · ${c.flaggedRows ?? 'Unknown'} source-flagged${year.omittedShareRows ? ` · ${year.omittedShareRows} smaller reported origins not listed` : ''}.`));
        if (c.reconciled === false) { block.append(node('p', 'plugin-caution', 'Reported quantities require review.')); methods.append(node('p', 'plugin-caution', 'Reported partner quantities do not reconcile with the source TOTAL. Shares retain the reported denominator.')); }
        if (c.reconciled === null) methods.append(node('p', 'plugin-note', 'Reconciliation is unavailable for the retained source breakdown. Missing quantities are not treated as zero.'));
        content.append(block);
      }
      methods.append(node('p', 'plugin-note', artifact.limitations), link('Open Eurostat dataset', artifact.source.datasetUrl)); content.append(methods);
      scenario ||= gasScenario(); content.append(scenario.element); scenario.update(payload);
    } else {
      title.textContent = VIEWS[view].title; subtitle.textContent = VIEWS[view].subtitle;
      if (view === 'commission') content.append(node('p', 'plugin-note', 'Source: European Commission / European Union. Publication metadata only; document body language is unknown.'));
      const list = node('div', 'plugin-publications');
      for (const item of payload.items) {
        const article = node('article', 'plugin-publication'), heading = node('h4'); heading.append(link(item.title, item.url)); article.append(heading);
        article.append(node('p', 'plugin-publication-date', `Published ${displayTime(item.publishedAt)}`));
        if (view === 'commission') article.append(node('p', 'plugin-note', `${EC_DOCUMENT_TYPES[item.documentType]} · ${item.documentReference}`));
        const knowledge = node('p', 'plugin-note', `First retained ${displayTime(item.firstRecordedAt)} · latest retained ${displayTime(item.lastRecordedAt)}`);
        const currentItem = p => p.items.find(value => value.itemId === item.itemId);
        evidenceBindings.push({ data: knowledge, getter: p => `First retained ${displayTime(currentItem(p).firstRecordedAt)} · latest retained ${displayTime(currentItem(p).lastRecordedAt)}` });
        const details = node('details', 'plugin-item-evidence'); details.append(node('summary', '', 'Retained publication evidence'), knowledge,
          node('p', 'plugin-hash', `Revision ${item.revision}`));
        const facts = node('dl', 'plugin-facts'), own = p => currentItem(p).evidence;
        bindFacts(facts, payload, [['Source receipt', p => own(p).id], ['Source retrieved', p => displayTime(own(p).capturedAt)], ['Receipt recorded', p => displayTime(own(p).recordedAt)],
          ['Source revised', p => own(p).sourceUpdatedAt ? displayTime(own(p).sourceUpdatedAt) : null], ['Raw SHA-256', p => own(p).rawSha256],
          ['Facts SHA-256', p => own(p).factsDigest], ['Artifact SHA-256', p => own(p).artifactSha256], ['RSS GUID locator', p => own(p).locator.guid],
          ...(view === 'commission' ? [['Source publication date', p => currentItem(p).publishedRaw], ['Document reference', p => currentItem(p).documentReference],
            ['Source document type', p => currentItem(p).documentType], ['Source policy tags', p => currentItem(p).categories.join(' · ') || 'None supplied']] : [])]);
        details.append(facts); article.append(details); list.append(article);
      }
      if (!payload.items.length) list.append(node('p', 'plugin-note', 'No institutional releases are retained in this bounded view.'));
      const feedEvidence = evidence(payload, [], 'Latest feed receipt');
      if (view === 'commission') {
        feedEvidence.append(node('p', 'plugin-note', 'Policy tags are publisher metadata, not verified claims or incident locations. The linked publication is an original institutional source, not independent corroboration.'),
          node('p', 'plugin-note', text(artifact.limitations, 4000) ? artifact.limitations : 'The rolling provider feed is not a complete historical archive.'));
      }
      content.append(list, node('p', 'plugin-note', `${payload.counts.returned} retained original publications${payload.counts.more ? ' · more retained records exist beyond this view' : ''}. The provider feed is rolling; absence is not withdrawal or a complete historical archive.`));
      if (view === 'publications') content.append(node('p', 'plugin-note', 'Euro-area context reflects the publisher’s institutional remit; it does not identify an incident location.'));
      content.append(feedEvidence);
    }
  }
  function presentation() {
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === view));
    feedHost.hidden = view !== 'feeds'; dossierHost.hidden = view === 'feeds'; scope.hidden = mode !== 'history';
    if (view !== 'feeds') {
      title.textContent = view === 'gas' ? 'Belgian natural-gas origins' : VIEWS[view].title;
      subtitle.textContent = view === 'gas' ? 'Annual reported imports · source-backed dataset' : VIEWS[view].subtitle;
      const saved = cache.get(view); rendered = null; if (saved) render(saved.payload); else content.replaceChildren(node('p', 'plugin-note', 'Stored source context loads when selected.'));
    }
  }
  async function openFeed() {
    if (!feed) {
      feedPending ||= Promise.resolve().then(() => createFeed(feedHost));
      try { feed = await feedPending; } catch (error) { feedPending = null; if (opened && view === 'feeds' && !destroyed) feedHost.textContent = error.message || 'Current source context could not load.'; return false; }
      if (destroyed) { feed?.destroy(); return false; } feed.setSceneMode?.(mode);
    }
    if (opened && view === 'feeds' && !documentRef.hidden) return feed.open(); return false;
  }
  function load(force = false) {
    if (!opened || destroyed || documentRef.hidden || view === 'feeds') return Promise.resolve(false);
    if (pending) return pending;
    const saved = cache.get(view); if (!force && !dirty.has(view) && saved && now() - saved.at < PLUGIN_DOSSIER_LIMITS.refreshMs) { render(saved.payload); status.textContent = saved.payload.available ? 'Retained source context' : 'Source artifact unavailable'; arm(); return Promise.resolve(true); }
    const selected = view, owner = ++generation, initialUpdate = updates.get(view), controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    followupRequested = false;
    request = controller; stopTimer(); refresh.disabled = true; dossierHost.setAttribute('aria-busy', 'true'); status.textContent = saved ? 'Checking stored updates · previous context remains available…' : 'Loading stored source context…';
    const work = (async () => {
      try {
        const response = await fetchImpl(VIEWS[selected].url, { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
        const payload = normalizePluginDossier(await readStored(response, signal), selected); signal.throwIfAborted();
        if (destroyed || !opened || documentRef.hidden || selected !== view || owner !== generation) return false;
        cache.set(selected, { payload, at: now() });
        if (updates.get(selected) === initialUpdate || updates.get(selected)?.receiptId === payload.receipt?.id) dirty.delete(selected);
        render(payload); status.textContent = payload.available ? 'Retained source context' : 'Source artifact unavailable'; return true;
      } catch (error) {
        if (controller.signal.aborted || owner !== generation) return false;
        status.textContent = `${error.message || 'Stored context could not load.'}${saved ? ' · Previous retained context keeps its original dates.' : ''}`; return false;
      } finally {
        if (!destroyed && owner === generation) {
          pending = null; request = null; refresh.disabled = false; dossierHost.setAttribute('aria-busy', 'false');
          if (followupRequested && dirty.has(selected) && opened && !documentRef.hidden && selected === view) void load(true); else arm();
        }
      }
    })(); pending = work; return work;
  }
  async function select(id) { if (destroyed || !buttons.has(id)) return false; if (id !== view) { cancel(); feed?.close(); view = id; presentation(); }
    return opened ? view === 'feeds' ? openFeed() : load() : false; }
  const refreshClick = () => { void load(true); }; refresh.addEventListener('click', refreshClick);
  const visibility = () => { if (documentRef.hidden) { cancel(); feed?.close(); } else if (opened) void (view === 'feeds' ? openFeed() : load()); };
  const reconnect = () => { if (opened && view !== 'feeds') void load(true); };
  const unsubscribeUpdates = typeof subscribeUpdates === 'function' ? subscribeUpdates(event => {
    if (destroyed || event?.type !== 'plugin') return;
    const revision = pluginRevision(event), selected = revision && Object.keys(VIEWS).find(id => VIEWS[id].pluginId === revision.pluginId);
    if (!revision || !selected || !newerPluginRevision(revision, updates.get(selected))) return;
    updates.set(selected, revision);
    if (cache.get(selected)?.payload.receipt?.id === revision.receiptId) return;
    dirty.add(selected);
    if (selected === 'gas') scenario?.invalidate();
    if (!opened || documentRef.hidden || view !== selected) return;
    if (pending) followupRequested = true; else void load(true);
  }) : null;
  documentRef.addEventListener?.('visibilitychange', visibility); windowRef?.addEventListener?.('online', reconnect); presentation();
  return { select, getView: () => view, setSceneMode(value) { mode = value === 'history' ? 'history' : 'live'; scope.hidden = mode !== 'history'; feed?.setSceneMode?.(mode); },
    open() { if (destroyed) return Promise.resolve(false); opened = true; return view === 'feeds' ? openFeed() : load(); },
    close() { opened = false; cancel(); feed?.close(); }, refresh: refreshClick,
    destroy() { if (destroyed) return; destroyed = true; opened = false; cancel(); scenario?.destroy(); feed?.destroy(); unsubscribeUpdates?.(); cache.clear(); dirty.clear(); updates.clear(); evidenceBindings = [];
      for (const [button, fn] of bindings) button.removeEventListener('click', fn); refresh.removeEventListener('click', refreshClick);
      documentRef.removeEventListener?.('visibilitychange', visibility); windowRef?.removeEventListener?.('online', reconnect); container.replaceChildren(); } };
}
