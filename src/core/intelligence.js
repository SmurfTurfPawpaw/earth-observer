import { createEconomicsPanel } from './economics.js';

const CATEGORIES = [['all', 'All topics'], ['disasters', 'Disasters'], ['geopolitics', 'Geopolitics'], ['economy', 'Economics & trade']];

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
  const topic = report.kind === 'topic-mention';
  const countries = topic && Array.isArray(report.mentionedCountries) ? report.mentionedCountries.map((code) => {
    try { return COUNTRY_NAMES.of(code) || code; } catch { return code; }
  }).join(', ') : '';
  return { topic, source: `${report.source || 'Source unspecified'}${report.aggregator ? ` · found by ${report.aggregator}` : ''}${report.publisherCountry ? ` · publisher country: ${report.publisherCountry}` : ''}`,
    countries: countries ? `Countries mentioned: ${countries}. These mentions do not establish an incident location or publisher country.` : '',
    dates: [['Published', report.publishedAt], ['Event', report.observedAt], ['Updated', report.updatedAt], [topic ? 'GDELT batch' : 'Indexed', report.indexedAt], ['Retrieved', report.retrievedAt]],
    canNavigate: !topic && Number.isFinite(report.lat) && Number.isFinite(report.lon) && Math.abs(report.lat) <= 90 && Math.abs(report.lon) <= 180 };
}

/** An opened, visible panel owns its requests; no constructor or closed-panel fetch. */
export function createIntelligenceFeed({ fetchImpl = (...args) => fetch(...args), documentRef = globalThis.document,
  onChange = () => {}, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let opened = false, destroyed = false, request, pending, timer, generation = 0, activeUrl;
  let payload = null, error = null, loading = false, refreshedAt = null;
  let filters = { category: 'all', country: '', q: '' };
  const getState = () => ({ opened, loading, payload, error, refreshedAt, filters: { ...filters } });
  const emit = () => { if (!destroyed) onChange(getState()); };
  function stopTimer() { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; }
  function arm() {
    stopTimer();
    if (!opened || documentRef?.hidden || destroyed) return;
    const interval = Math.max(60000, Math.min(1800000, Number(payload?.nextRefreshMs) || 300000));
    const delay = error || refreshedAt === null || payload?.browserCache ? interval : Math.max(1000, interval - (now() - refreshedAt));
    timer = setTimeoutImpl(() => { timer = undefined; void refresh(true); }, delay);
  }
  function cancel() { ++generation; request?.abort(); request = null; pending = null; loading = false; stopTimer(); }
  function refresh(force = false) {
    if (destroyed || !opened || documentRef?.hidden) return Promise.resolve(false);
    if (pending) return pending;
    if (!force && payload && refreshedAt !== null && now() - refreshedAt < (Number(payload.nextRefreshMs) || 300000)) { arm(); return Promise.resolve(true); }
    const controller = new AbortController(), owner = ++generation;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    request = controller; loading = true; error = null; stopTimer(); emit();
    const work = (async () => {
      try {
        const query = new URLSearchParams({ category: filters.category });
        if (filters.country) query.set('country', filters.country);
        if (filters.q) query.set('q', filters.q);
        activeUrl = new URL(`/api/intelligence?${query}`, globalThis.location?.origin || 'http://localhost').href;
        const response = await fetchImpl(`/api/intelligence?${query}`, { signal, headers: { Accept: 'application/json' } });
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
        payload = stored ? { ...next, browserCache: mode, sources: next.sources.map((source) => ({ ...source, stale: true,
          reason: [source.reason, mode === 'OFFLINE' ? 'Saved browser copy; reconnect for updates' : 'Saved browser copy; updating in the background'].filter(Boolean).join(' · ') })) } : next;
        refreshedAt = cachedAt || now(); error = null; return true;
      } catch (failure) {
        if (controller.signal.aborted || generation !== owner) return false;
        error = failure.message || 'Intelligence sources are temporarily unavailable'; return false;
      } finally {
        if (generation === owner && !destroyed) { request = null; pending = null; loading = false; emit(); arm(); }
      }
    })();
    pending = work; return work;
  }
  function visibility() {
    if (documentRef?.hidden) { cancel(); emit(); }
    else if (opened) void refresh();
  }
  documentRef?.addEventListener?.('visibilitychange', visibility);
  const unsubscribe = fetchImpl?.subscribe?.((url) => {
    if (!opened || destroyed || documentRef?.hidden || url !== activeUrl) return;
    const owner = generation;
    if (pending) void pending.then(() => { if (opened && !destroyed && generation === owner) void refresh(true); });
    else void refresh(true);
  });
  return {
    getState, refresh,
    open() { if (destroyed) return Promise.resolve(false); opened = true; emit(); return refresh(); },
    close() { opened = false; cancel(); emit(); },
    setFilters(values) {
      const next = { category: values.category || 'all', country: String(values.country || '').trim().toUpperCase(), q: String(values.q || '').trim().slice(0, 65) };
      if (JSON.stringify(next) === JSON.stringify(filters)) return refresh(true);
      cancel(); filters = next; payload = null; refreshedAt = null; error = null; emit(); return refresh();
    },
    destroy() { if (destroyed) return; destroyed = true; opened = false; cancel(); unsubscribe?.(); documentRef?.removeEventListener?.('visibilitychange', visibility); },
  };
}

/** Source-linked metadata cards, never full article text, images, or verification claims. */
export function createIntelligencePanel({ container, fetchImpl, viewer, onNavigate, onStatus = () => {}, documentRef = container?.ownerDocument || globalThis.document } = {}) {
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
  const country = node('input'); country.type = 'text'; country.placeholder = 'Country code, e.g. BE'; country.maxLength = 2; country.setAttribute('aria-label', 'Country mentions, two-letter code');
  const query = node('input'); query.type = 'search'; query.placeholder = 'Reviewed topic or publisher'; query.maxLength = 64; query.setAttribute('aria-label', 'Search reviewed topics and publisher domains in the sample');
  const search = node('button', '', 'Apply filters'); search.type = 'submit';
  form.append(category, country, query, search);
  const note = node('p', 'intelligence-meta', 'GDELT cards show machine-extracted topic mentions and source links, with no copied headlines or article text. Search matches reviewed topics and publisher domains. Country filters match countries mentioned, while GDACS uses reported countries; neither establishes the location of a news claim.');
  const status = node('p', 'intelligence-status'); status.setAttribute('role', 'status');
  const sources = node('div', 'intelligence-sources');
  const actions = node('div', 'intelligence-actions');
  const refresh = node('button', '', 'Refresh sources'); refresh.type = 'button'; actions.append(refresh);
  const list = node('div', 'intelligence-list');
  const economicFacts = node('section', 'economics-section');
  const footer = node('p', 'intelligence-meta'); footer.append('News discovery: ', link('The GDELT Project', 'https://www.gdeltproject.org/'), '. Original publishers retain their rights. No article text or images are copied. ',
    link('Research and coverage notes', 'https://github.com/SmurfTurfPawpaw/earth-observer/blob/main/docs/MAXINOMICS_RESEARCH.md'));
  container.replaceChildren(form, note, economicFacts, status, sources, actions, list, footer);
  const economics = createEconomicsPanel({ container: economicFacts, fetchImpl, documentRef });
  let renderedPayload;
  function reportContent(report, related = false) {
    const detail = intelligenceReportDetails(report);
    const block = node(related ? 'li' : 'article', related ? '' : 'intelligence-card');
    const heading = node(related ? 'p' : 'h3'); heading.append(link(String(report.title || 'Source report'), report.url)); block.append(heading);
    const meta = node('p', 'intelligence-meta');
    meta.textContent = detail.source;
    block.append(meta);
    if (detail.countries) block.append(node('p', 'intelligence-meta', detail.countries));
    block.append(node('p', 'intelligence-meta', detail.dates.map(([label, value]) => { const stamp = intelligenceTime(value); return stamp ? `${label} ${stamp}` : null; }).filter(Boolean).join(' · ') || 'Publication and event times are unavailable'));
    if (report.timeMeaning) block.append(node('p', 'intelligence-meta', String(report.timeMeaning)));
    if (report.verification) block.append(node('p', 'intelligence-meta', String(report.verification)));
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
    refresh.disabled = state.loading; search.disabled = state.loading;
    container.setAttribute('aria-busy', String(state.loading));
    const message = state.loading ? 'Loading source metadata…' : state.error ? `${state.error}${state.payload ? ' · Previous results remain displayed.' : ''}` : state.payload ? `${state.payload.reports.length} report groups · ${state.payload.coverage || 'Bounded source sample'}` : 'Open this panel to load public intelligence sources.';
    status.textContent = message; onStatus(message);
    if (!state.payload) { renderedPayload = null; list.replaceChildren(); sources.replaceChildren(); return; }
    if (renderedPayload === state.payload) return;
    renderedPayload = state.payload;
    const discovery = state.payload.sources.find((source) => source.id === 'gdelt');
    note.textContent = discovery?.mode && discovery.mode !== 'scheduled-gkg' ?
      'This discovery source supplies bounded headline and link metadata. Country filters search news mentions or GDACS reported countries. A mention does not establish a news claim’s location.' :
      'GDELT cards show machine-extracted topic mentions and source links, with no copied headlines or article text. Search matches reviewed topics and publisher domains. Country filters match countries mentioned, while GDACS uses reported countries; neither establishes the location of a news claim.';
    const sourceRows = state.payload.sources.map((source) => {
      const row = node('p', 'intelligence-meta');
      row.append(link(String(source.name || source.id), source.url), ` · ${source.status || 'unknown'}${source.stale ? ' · older cached data' : ''}`);
      const retrieved = intelligenceTime(source.retrievedAt);
      if (retrieved) row.append(` · retrieved ${retrieved}`);
      if (source.reason) row.append(` · ${String(source.reason)}`);
      if (source.retryAt) row.append(` · retry after ${intelligenceTime(source.retryAt)}`);
      return row;
    });
    sources.replaceChildren(...sourceRows);
    if (!state.payload.reports.length) {
      list.replaceChildren(node('p', 'intelligence-meta', state.payload.sources.some((source) => source.status === 'unavailable') ? 'No matching reports are available. Some providers are unavailable; their official websites remain linked above.' : 'No reports match the current filters in this bounded sample.'));
    } else list.replaceChildren(...state.payload.reports.slice(0, 80).map((report) => reportContent(report)));
  }
  const feed = createIntelligenceFeed({ fetchImpl, documentRef, onChange: render });
  const apply = () => {
    if (category.value === 'economy') void economics.open(country.value || 'WLD'); else economics.close();
    void feed.setFilters({ category: category.value, country: country.value, q: query.value });
  };
  const submit = (event) => { event.preventDefault(); apply(); };
  const refreshClick = () => { void feed.refresh(true); if (category.value === 'economy') void economics.refresh(true); };
  form.addEventListener('submit', submit); refresh.addEventListener('click', refreshClick);
  category.addEventListener('change', apply);
  render(feed.getState());
  return {
    open() { if (category.value === 'economy') void economics.open(country.value || 'WLD'); return feed.open(); },
    close() { economics.close(); feed.close(); },
    refresh: refreshClick,
    destroy() { economics.destroy(); feed.destroy(); form.removeEventListener('submit', submit); category.removeEventListener('change', apply); refresh.removeEventListener('click', refreshClick); container.replaceChildren(); }
  };
}
