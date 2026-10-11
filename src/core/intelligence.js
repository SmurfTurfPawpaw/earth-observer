import { createEconomicsPanel } from './economics.js';
import { ECONOMICS_COUNTRIES } from './economics-catalog.js';
import { canonicalDiscoveryRecord, createDiscoveryIndex, discoveryQueryText, DISCOVERY_INDEX_NOTE } from './discovery-index.js';
import { createDemandTracker } from './demand.js';
import { groupReports } from './intelligence-grouping.js';
import { createPrimaryContextPanel } from './primary-context.js';

const CATEGORIES = [['all', 'All topics'], ['disasters', 'Disasters'], ['geopolitics', 'Geopolitics'], ['economy', 'Economics & trade']];
// Delivery checks are independent of each provider's publication or retrieval cadence.
export const INTELLIGENCE_REFRESH_MS = 60000;

export function safeIntelligenceUrl(value) {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
export function intelligenceTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : null;
}
const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
export function intelligenceReportDetails(report) {
  const topic = report.kind === 'topic-mention', curated = report.kind === 'curated-event';
  const countries = topic && Array.isArray(report.mentionedCountries) ? report.mentionedCountries.map((code) => {
    try { return COUNTRY_NAMES.of(code) || code; } catch { return code; }
  }).join(', ') : '';
  return { topic, curated, source: `${report.source || 'Source unspecified'}${curated ? ' · curated event metadata' : ''}${report.aggregator ? ` · found by ${report.aggregator}` : ''}${report.publisherCountry && !curated ? ` · publisher country: ${report.publisherCountry}` : ''}`,
    countries: countries ? `Countries mentioned: ${countries}. These mentions do not establish an incident location or publisher country.` : '',
    dates: curated ? [['EONET geometry date', report.sourceGeometryAt], ['EONET closed date', report.closedAt], ['Retrieved', report.retrievedAt]] : [['Published', report.publishedAt], ['Event', report.observedAt], ['Updated', report.updatedAt], [topic ? 'GDELT batch' : 'Indexed', report.indexedAt], ['Retrieved', report.retrievedAt]],
    canNavigate: !topic && !curated && Number.isFinite(report.lat) && Number.isFinite(report.lon) && Math.abs(report.lat) <= 90 && Math.abs(report.lon) <= 180 };
}

/** An opened, visible panel owns its requests; no constructor or closed-panel fetch. */
export function createIntelligenceFeed({ fetchImpl = (...args) => fetch(...args), documentRef = globalThis.document,
  windowRef = documentRef?.defaultView || globalThis.window,
  subscribeUpdates, onChange = () => {}, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let opened = false, destroyed = false, request, pending, timer, generation = 0, activeUrl;
  let payload = null, sourcePayload = null, error = null, acquisitionError = null, loading = false, refreshedAt = null, indexed = false;
  let deliveryStatus = 'unsupported', updateVersion = 0, acceptedVersion = 0;
  const index = createDiscoveryIndex({ now });
  let filters = { category: 'all', country: '', q: '' };
  const getState = () => ({ opened, loading, payload, error, refreshedAt, deliveryStatus, filters: { ...filters } });
  const emit = () => { if (!destroyed) onChange(getState()); };
  function stopTimer() { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; }
  function arm() {
    stopTimer();
    if (!opened || documentRef?.hidden || destroyed || deliveryStatus === 'connected') return;
    const interval = INTELLIGENCE_REFRESH_MS;
    const delay = error || refreshedAt === null || payload?.browserCache ? interval : Math.max(1000, interval - (now() - refreshedAt));
    timer = setTimeoutImpl(() => { timer = undefined; void refresh(true); }, delay);
  }
  function cancel() { ++generation; request?.abort(); request = null; pending = null; loading = false; stopTimer(); }
  function derive() {
    if (!sourcePayload) { payload = null; return; }
    if (indexed) {
      const result = index.search({ ...filters, limit: 500 });
      const key = (record) => `${record.sourceId}|${record.kind}|${record.url}`;
      const retained = new Set(index.getState().records.map(key));
      const current = (record) => { const canonical = canonicalDiscoveryRecord(record); return canonical && retained.has(key(canonical)); };
      const grouped = sourcePayload.reports.flatMap((report) => {
        const related = (report.relatedReports || []).filter(current);
        if (current(report)) return [{ ...report, relatedReports: related }];
        if (related.length) { const [primary, ...rest] = related; return [{ ...primary, relatedReports: rest }]; }
        return [];
      });
      payload = { ...sourcePayload, ...(filters.q ? { ...result, reports: groupReports(result.reports, 80, { preserveOrder: true }) } : { reports: grouped }), indexedRecords: result.indexedRecords,
        indexVersion: result.indexVersion, localSearch: true, searchCoverage: result.coverage, ranking: result.ranking };
    } else if (filters.q) {
      const terms = filters.q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const reports = sourcePayload.reports.filter((report) => terms.every((term) =>
        [report.title, report.source, report.country, ...report.mentionedCountries || []].join(' ').toLocaleLowerCase().includes(term)));
      payload = { ...sourcePayload, reports, localSearch: true, searchCoverage: 'This older response contains only the displayed report sample. Refresh online for the full metadata index.', matchCount: reports.length };
    } else payload = sourcePayload;
    if (acquisitionError) payload = { ...payload, sources: payload.sources.map((source) => ({ ...source,
      stale: true, status: source.status === 'ready' ? 'stale' : source.status,
      reason: [source.reason, 'Latest refresh failed; retained metadata keeps its original dates'].filter(Boolean).join(' · ') })) };
  }
  function accept(next) {
    indexed = false;
    try { if (next.indexCoverage?.schemaVersion === 1 && Array.isArray(next.indexRecords)) { index.replacePayload(next); indexed = true; } } catch { index.clear(); }
    if (!indexed) index.clear();
    sourcePayload = next; derive();
  }
  function refresh(force = false, background = false) {
    if (destroyed || !opened || documentRef?.hidden) return Promise.resolve(false);
    if (pending) return pending;
    const revalidate = force || updateVersion > acceptedVersion || Boolean(acquisitionError || sourcePayload?.browserCache);
    if (!revalidate && sourcePayload && refreshedAt !== null && now() - refreshedAt < INTELLIGENCE_REFRESH_MS) { derive(); emit(); arm(); return Promise.resolve(true); }
    const controller = new AbortController(), owner = ++generation;
    const requestedVersion = updateVersion;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    request = controller; loading = !background || !sourcePayload; error = null; stopTimer(); derive(); emit();
    const work = (async () => {
      try {
        const query = new URLSearchParams({ category: filters.category });
        if (filters.country) query.set('country', filters.country);
        // Free-text stays in this browser. Shared acquisition is bounded by category/country.
        activeUrl = new URL(`/api/intelligence?${query}`, globalThis.location?.origin || 'http://localhost').href;
        const response = await fetchImpl(`/api/intelligence?${query}`, { signal,
          headers: { Accept: 'application/json', ...(revalidate ? { 'Cache-Control': 'no-cache' } : {}) }, ...(revalidate ? { cache: 'no-cache' } : {}) });
        if (!response.ok) {
          const detail = response.status === 400 ? await response.json().catch(() => null) : null;
          throw new Error(detail?.error || `Intelligence feed HTTP ${response.status}`);
        }
        const next = await response.json(); signal.throwIfAborted();
        if (!Array.isArray(next?.reports) || !Array.isArray(next?.sources)) throw new Error('The intelligence response is invalid');
        if (destroyed || !opened || documentRef?.hidden || generation !== owner) return false;
        const mode = response.headers?.get?.('x-browser-cache');
        const cachedAt = Number(response.headers?.get?.('x-browser-cached-at')) || null;
        const stored = ['STALE', 'OFFLINE'].includes(mode);
        acquisitionError = null;
        acceptedVersion = requestedVersion;
        accept(stored ? { ...next, browserCache: mode, sources: next.sources.map((source) => ({ ...source, stale: true,
          reason: [source.reason, mode === 'OFFLINE' ? 'Saved browser copy; reconnect for updates' : 'Saved browser copy; updating in the background'].filter(Boolean).join(' · ') })) } : next);
        refreshedAt = cachedAt || now(); error = null; return true;
      } catch (failure) {
        if (controller.signal.aborted || generation !== owner) return false;
        acquisitionError = error = failure.message || 'Intelligence sources are temporarily unavailable'; derive(); return false;
      } finally {
        if (generation === owner && !destroyed) {
          request = null; pending = null; loading = false; emit(); arm();
          // A publication arriving during a read cannot disappear behind that
          // older in-flight result. Coalesce it into one following read.
          if (updateVersion > requestedVersion && opened && !documentRef?.hidden) void refresh(true, true);
        }
      }
    })();
    pending = work; return work;
  }
  function visibility() {
    if (documentRef?.hidden) { cancel(); emit(); }
    else if (opened) void refresh();
  }
  const reconnect = () => { if (opened && !destroyed && !documentRef?.hidden) void refresh(true); };
  documentRef?.addEventListener?.('visibilitychange', visibility);
  windowRef?.addEventListener?.('online', reconnect);
  const unsubscribe = fetchImpl?.subscribe?.((url) => {
    if (!opened || destroyed || documentRef?.hidden || url !== activeUrl) return;
    const owner = generation;
    if (pending) void pending.then(() => { if (opened && !destroyed && generation === owner) void refresh(true); });
    else void refresh(true);
  });
  const unsubscribeUpdates = subscribeUpdates?.((event) => {
    if (destroyed) return;
    if (event.type === 'status') {
      deliveryStatus = event.status; arm(); emit(); return;
    }
    if (event.type !== 'collection' || sourcePayload?.collectedAt >= event.collectedAt) return;
    ++updateVersion;
    if (opened && !documentRef?.hidden) void refresh(true, true);
  });
  return {
    getState, refresh,
    open() { if (destroyed) return Promise.resolve(false); opened = true; derive(); emit(); return refresh(); },
    close() { opened = false; cancel(); emit(); },
    setFilters(values) {
      const next = { category: values.category || 'all', country: String(values.country || '').trim().toUpperCase(), q: discoveryQueryText(values.q).slice(0, 65) };
      const invalid = !CATEGORIES.some(([id]) => id === next.category) ? 'Choose an available topic' : next.country && !/^[A-Z]{2}$/.test(next.country) ? 'Choose a country' :
        next.q && (next.q.length > 64 || !/^[\p{L}\p{N}\s'.’\-]+$/u.test(next.q) || (next.q.match(/[\p{L}\p{N}]/gu)?.length || 0) < 2) ? 'Search needs 2–64 letters, digits, spaces, periods, apostrophes or hyphens' : null;
      if (invalid) { error = invalid; emit(); return Promise.resolve(false); }
      const sameAcquisition = next.category === filters.category && next.country === filters.country;
      filters = next; error = sameAcquisition ? acquisitionError : null;
      if (sameAcquisition) {
        derive(); emit();
        // A pending coarse acquisition will derive using the latest local query when it arrives.
        if (pending) return pending;
        if (sourcePayload) { arm(); return Promise.resolve(true); }
        return refresh();
      }
      cancel(); index.clear(); indexed = false; sourcePayload = null; payload = null; acquisitionError = null; refreshedAt = null; emit(); return refresh();
    },
    destroy() { if (destroyed) return; destroyed = true; opened = false; cancel(); index.clear(); sourcePayload = null; unsubscribe?.(); unsubscribeUpdates?.(); documentRef?.removeEventListener?.('visibilitychange', visibility); windowRef?.removeEventListener?.('online', reconnect); },
  };
}

/** Source-linked metadata cards, never full article text, images, or verification claims. */
export function createIntelligencePanel({ container, fetchImpl, store, viewer, onNavigate, subscribeUpdates, onStatus = () => {}, documentRef = container?.ownerDocument || globalThis.document } = {}) {
  if (!container || !documentRef) throw new TypeError('An intelligence panel container is required');
  const node = (tag, className, text) => { const element = documentRef.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const link = (title, href) => {
    const url = safeIntelligenceUrl(href);
    if (!url) return node('span', '', title);
    const element = node('a', '', title); element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; return element;
  };
  const form = node('form', 'intelligence-filters');
  const category = node('select'); category.setAttribute('aria-label', 'Intelligence topic');
  for (const [value, label] of CATEGORIES) { const option = node('option', '', label); option.value = value; category.append(option); }
  const country = node('select'); country.setAttribute('aria-label', 'Country mentioned or reported');
  const allCountries = node('option', '', 'All countries'); allCountries.value = ''; country.append(allCountries);
  for (const item of ECONOMICS_COUNTRIES.filter((item) => item.iso2 && item.iso2 !== 'JG').sort((a, b) => a.name.localeCompare(b.name))) {
    const option = node('option', '', item.name); option.value = item.iso2; country.append(option);
  }
  const query = node('input'); query.type = 'search'; query.placeholder = 'Topic, country or publisher'; query.maxLength = 64; query.setAttribute('aria-label', 'Search collected metadata locally');
  const search = node('button', '', 'Search'); search.type = 'submit';
  form.append(category, country, query, search);
  const note = node('p', 'intelligence-meta', 'Search stays in this browser and covers collected metadata. GDELT links are machine-extracted topic mentions; country mentions do not establish incident locations.');
  const status = node('p', 'intelligence-status'); status.setAttribute('role', 'status');
  const coverage = node('details', 'intelligence-coverage'); coverage.append(node('summary', '', 'Sources, coverage and freshness'));
  const delivery = node('p', 'intelligence-meta'); coverage.append(delivery);
  const sources = node('div', 'intelligence-sources'); coverage.append(sources);
  const demandContainer = node('details', 'intelligence-demand-options'); demandContainer.append(node('summary', '', 'Help improve coverage · optional'));
  const actions = node('div', 'intelligence-actions');
  const refresh = node('button', '', 'Refresh sources'); refresh.type = 'button'; actions.append(refresh);
  const list = node('div', 'intelligence-list');
  const economicFacts = node('section', 'economics-section');
  const researchContainer = node('section', 'intelligence-research');
  const footer = node('p', 'intelligence-meta'); footer.append('News discovery: ', link('The GDELT Project', 'https://www.gdeltproject.org/'), '. Original publishers retain their rights. No article text or images are copied. ',
    link('Research and coverage notes', 'https://github.com/SmurfTurfPawpaw/earth-observer/blob/main/docs/MAXINOMICS_RESEARCH.md'));
  container.replaceChildren(form, note, economicFacts, status, coverage, actions, demandContainer, researchContainer, list, footer);
  const economics = createEconomicsPanel({ container: economicFacts, fetchImpl, documentRef });
  const demand = createDemandTracker({ container: demandContainer, fetchImpl, documentRef });
  const research = createPrimaryContextPanel(researchContainer, { fetchImpl, store, documentRef,
    url: `${import.meta.env?.BASE_URL || '/'}research/primary-context.json` });
  let renderedPayload, renderedReports;
  function reportContent(report, related = false) {
    const detail = intelligenceReportDetails(report);
    const block = node(related ? 'li' : 'article', related ? '' : 'intelligence-card');
    const heading = node(related ? 'p' : 'h3'); heading.append(link(String(report.title || 'Source report'), report.url)); block.append(heading);
    const meta = node('p', 'intelligence-meta');
    meta.textContent = detail.source;
    block.append(meta);
    if (detail.countries) block.append(node('p', 'intelligence-meta', detail.countries));
    if (detail.curated && Array.isArray(report.referencedSources) && report.referencedSources.length) {
      const references = node('p', 'intelligence-meta', 'Referenced sources: ');
      for (const [i, reference] of report.referencedSources.slice(0, 4).entries()) { if (i) references.append(' · '); references.append(link(String(reference.id || 'Source'), reference.url)); }
      block.append(references);
    }
    block.append(node('p', 'intelligence-meta', detail.dates.map(([label, value]) => { const stamp = intelligenceTime(value); return stamp ? `${label} ${stamp}` : null; }).filter(Boolean).join(' · ') || 'Publication and event times are unavailable'));
    if (Array.isArray(report.matchReasons) && report.matchReasons.length) block.append(node('p', 'intelligence-meta', report.matchReasons.slice(0, 3).join(' ')));
    if (report.timeMeaning || report.verification) {
      const sourceDetail = node('details'); sourceDetail.append(node('summary', '', 'Source context'));
      if (report.timeMeaning) sourceDetail.append(node('p', 'intelligence-meta', String(report.timeMeaning)));
      if (report.verification) sourceDetail.append(node('p', 'intelligence-meta', String(report.verification)));
      block.append(sourceDetail);
    }
    if (report.relatedReason) block.append(node('p', 'intelligence-meta', String(report.relatedReason)));
    if (!related && detail.canNavigate && typeof onNavigate === 'function') {
      const button = node('button', '', 'View reported location'); button.type = 'button';
      button.addEventListener('click', () => onNavigate({ lat: report.lat, lon: report.lon, title: report.title, report })); block.append(button);
    }
    if (!related && Array.isArray(report.relatedReports) && report.relatedReports.length) {
      const details = node('details', 'intelligence-related'); details.append(node('summary', '', `${report.relatedReports.length} related source link${report.relatedReports.length === 1 ? '' : 's'} · indicative match`));
      const relatedList = node('ul'); for (const item of report.relatedReports.slice(0, 5)) relatedList.append(reportContent(item, true));
      details.append(relatedList, node('p', 'intelligence-meta', 'Related coverage can share one source. These links are not independent confirmation.')); block.append(details);
    }
    return block;
  }
  function render(state) {
    refresh.disabled = state.loading;
    container.setAttribute('aria-busy', String(state.loading));
    const message = state.loading ? state.payload ? 'Checking for updates · previous results remain available…' : 'Loading source metadata…' : state.error ? `${state.error}${state.payload ? ' · Previous results remain displayed.' : ''}` : state.payload ?
      `${state.payload.reports.length} groups${Number.isFinite(state.payload.matchCount) ? ` · ${state.payload.matchCount} matching records` : ''}${Number.isFinite(state.payload.indexedRecords) ? ` · ${state.payload.indexedRecords} indexed records` : ''}${state.payload.browserCache ? ' · saved browser copy' : ''}` : 'Open this panel to load public intelligence sources.';
    status.textContent = message; onStatus(message);
    if (!state.payload) { renderedPayload = null; renderedReports = undefined; list.replaceChildren(); sources.replaceChildren(); return; }
    if (renderedPayload === state.payload) return;
    renderedPayload = state.payload;
    const discovery = state.payload.sources.find((source) => source.id === 'gdelt');
    note.textContent = discovery?.mode && !['scheduled-gkg', 'local-gkg'].includes(discovery.mode) ?
      'Search stays in this browser. These source cards contain bounded headline and link metadata; country mentions do not establish incident locations.' :
      'Search stays in this browser. GDELT links are machine-extracted topic mentions, without copied headlines or article text; country mentions do not establish incident locations.';
    const sourceRows = state.payload.sources.map((source) => {
      const row = node('p', 'intelligence-meta');
      row.append(link(String(source.name || source.id), source.url), ` · ${source.status || 'unknown'}${source.stale ? ' · older cached data' : ''}`);
      const retrieved = intelligenceTime(source.retrievedAt);
      if (retrieved) row.append(` · retrieved ${retrieved}`);
      if (source.reason) row.append(` · ${String(source.reason)}`);
      if (source.retryAt) row.append(` · retry after ${intelligenceTime(source.retryAt)}`);
      return row;
    });
    sources.replaceChildren(node('p', 'intelligence-meta', state.payload.coverage || 'Bounded source sample'),
      node('p', 'intelligence-meta', state.payload.searchCoverage || DISCOVERY_INDEX_NOTE), ...sourceRows);
    // Revalidation must not recreate unchanged cards and collapse an investigation
    // the visitor has open. Freshness/source notices can update independently.
    const reportSignature = JSON.stringify([state.payload.reports.slice(0, 80), !state.payload.reports.length && state.payload.sources.some((source) => source.status === 'unavailable')]);
    if (renderedReports === reportSignature) return;
    renderedReports = reportSignature;
    if (!state.payload.reports.length) {
      list.replaceChildren(node('p', 'intelligence-meta', state.payload.sources.some((source) => source.status === 'unavailable') ? 'No matching reports are available. Some providers are unavailable; their official websites remain linked above.' : 'No reports match the current filters in this bounded sample.'));
    } else list.replaceChildren(...state.payload.reports.slice(0, 80).map((report) => reportContent(report)));
  }
  const feed = createIntelligenceFeed({ fetchImpl, documentRef, subscribeUpdates, onChange(state) {
    delivery.textContent = state.deliveryStatus === 'connected'
      ? 'Connected to stored collection updates. New publications arrive through the update stream; source observation dates stay separate.'
      : 'Update stream disconnected or unavailable. Visible metadata uses periodic recovery checks; retained records keep their original dates.';
    render(state);
  } });
  const apply = () => {
    research.setFilters({ category: category.value, country: country.value, q: query.value });
    if (category.value === 'economy') void economics.open(country.value || 'WLD'); else economics.close();
    void feed.setFilters({ category: category.value, country: country.value, q: query.value });
  };
  const submit = (event) => { event.preventDefault(); apply(); void demand.noteSearch({ category: category.value, country: country.value, q: query.value }); };
  const refreshClick = () => { void feed.refresh(true); if (category.value === 'economy') void economics.refresh(true); };
  form.addEventListener('submit', submit); refresh.addEventListener('click', refreshClick);
  category.addEventListener('change', apply);
  country.addEventListener('change', apply);
  render(feed.getState());
  return {
    open() { void research.open(); if (category.value === 'economy') void economics.open(country.value || 'WLD'); return feed.open(); },
    close() { research.close(); economics.close(); feed.close(); },
    refresh: refreshClick,
    destroy() { research.destroy(); demand.destroy(); economics.destroy(); feed.destroy(); form.removeEventListener('submit', submit); category.removeEventListener('change', apply); country.removeEventListener('change', apply); refresh.removeEventListener('click', refreshClick); container.replaceChildren(); }
  };
}
