import { ECONOMICS_COUNTRIES, ECONOMICS_INDICATORS, economicsCountry } from './economics-catalog.js';

export function formatEconomicValue(value, format) {
  if (!Number.isFinite(value)) return 'Not available';
  const number = new Intl.NumberFormat('en', { maximumFractionDigits: format === 'integer' || format === 'usd' ? 0 : 2 }).format(value);
  return format === 'usd' ? `US$ ${number}` : format === 'percent' ? `${number}%` : number;
}

/** Annual facts load only while this panel is open and the document is visible. */
export function createEconomicsPanel({ container, fetchImpl = (...args) => fetch(...args),
  documentRef = container?.ownerDocument || globalThis.document, now = Date.now, country = 'WLD' } = {}) {
  if (!container || !documentRef) throw new TypeError('An economics panel container is required');
  const node = (tag, className, text) => { const element = documentRef.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const link = (text, url) => { const element = node('a', '', text); element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; return element; };
  let selected = economicsCountry(country), opened = false, destroyed = false, loading = false,
    payload = null, error = null, controller, pending, generation = 0, refreshedAt = null, activeUrl;
  const heading = node('h3', '', 'Economic facts');
  const chooserLabel = node('label', 'intelligence-meta', 'Country / economy ');
  const chooser = node('select'); chooser.setAttribute('aria-label', 'Economic facts country or economy');
  for (const item of ECONOMICS_COUNTRIES) { const option = node('option', '', item.name); option.value = item.id; chooser.append(option); }
  chooser.value = selected.id; chooserLabel.append(chooser);
  const status = node('p', 'intelligence-status'); status.setAttribute('role', 'status');
  const note = node('p', 'intelligence-meta', 'Official annual series. Each value refers to the year shown; release dates and coverage differ. Values may be revised.');
  const cards = node('div', 'economics-list');
  const credit = node('p', 'intelligence-meta');
  credit.append(link('The World Bank · World Development Indicators', 'https://data.worldbank.org/'), ' · ',
    link('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'), ' · ',
    link('Data terms and provider credits', 'https://data.worldbank.org/summary-terms-of-use'));
  container.replaceChildren(heading, chooserLabel, status, note, cards, credit);
  container.hidden = true;
  const retrievedLabel = (value) => {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? `Retrieved ${date.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}` : null;
  };
  function render() {
    heading.textContent = `Economic facts · ${selected.name}`;
    chooser.value = selected.id;
    container.setAttribute('aria-busy', String(loading));
    status.textContent = loading ? 'Loading official annual indicators…' : error ? error : payload
      ? [payload.browserCache === 'OFFLINE' ? 'Saved annual data · reconnect for updates' : payload.browserCache === 'STALE' ? 'Saved annual data · updating in the background' : payload.status === 'stale' ? 'Saved annual data · refresh unavailable' : payload.status === 'unavailable' ? payload.reason : 'Annual facts',
          payload.datasetUpdatedDate ? `WDI dataset updated ${payload.datasetUpdatedDate}` : null,
          retrievedLabel(payload.retrievedAt)].filter(Boolean).join(' · ')
      : 'Select a country or the World aggregate.';
    if (loading && payload) return;
    cards.replaceChildren();
    if (!payload) return;
    for (const definition of ECONOMICS_INDICATORS) {
      const item = payload.indicators.find((value) => value.id === definition.id);
      if (!item) continue;
      const article = node('article', 'intelligence-card');
      const title = node('h4');
      title.append(link(definition.label, `${definition.url}?locations=${selected.iso2 || selected.id}`));
      article.append(title, node('p', 'economics-value', formatEconomicValue(item.value, definition.format)),
        node('p', 'intelligence-meta', item.year === null ? `No available value in the requested period · ${definition.unit}` : `Reference year ${item.year} · ${definition.unit}`),
        node('p', 'intelligence-meta', definition.description), node('p', 'intelligence-meta', definition.attribution));
      if (item.footnote) article.append(node('p', 'intelligence-meta', `Source note: ${item.footnote}`));
      if (item.history?.length) {
        const details = node('details'), summary = node('summary', '', 'Recent annual values');
        const table = node('table'); table.append(node('caption', 'intelligence-meta', `${definition.label} · ${definition.unit}`));
        const row = node('tr'); row.append(node('th', '', 'Year'), node('th', '', 'Value')); table.append(row);
        for (const value of item.history.slice(0, 10)) {
          const entry = node('tr'); entry.append(node('td', '', String(value.year)), node('td', '', formatEconomicValue(value.value, definition.format))); table.append(entry);
        }
        details.append(summary, table); article.append(details);
      }
      cards.append(article);
    }
  }
  function cancel() { generation += 1; controller?.abort(); controller = null; pending = null; loading = false; }
  function refresh(force = false) {
    if (!opened || destroyed || documentRef.hidden) return Promise.resolve(false);
    if (pending) return pending;
    if (!force && payload?.status === 'ready' && refreshedAt !== null && now() - refreshedAt < (payload.nextRefreshMs || 86400000)) { render(); return Promise.resolve(true); }
    const request = new AbortController(), owner = ++generation;
    controller = request; loading = true; error = null; render();
    const work = (async () => {
      try {
        const url = `/api/economics?country=${selected.id}`;
        activeUrl = new URL(url, globalThis.location?.origin || 'http://localhost').href;
        const response = await fetchImpl(url, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(20000)]), headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Economic data HTTP ${response.status}`);
        const next = await response.json();
        if (!Array.isArray(next?.indicators) || next.country?.id !== selected.id || next.frequency !== 'annual') throw new Error('Economic data response is invalid');
        if (owner !== generation || !opened || destroyed || documentRef.hidden) return false;
        const mode = response.headers?.get?.('x-browser-cache');
        const cachedAt = Number(response.headers?.get?.('x-browser-cached-at')) || null;
        payload = ['STALE', 'OFFLINE'].includes(mode) ? { ...next, status: 'stale', browserCache: mode } : next;
        refreshedAt = cachedAt || now(); error = null; return true;
      } catch (failure) {
        if (request.signal.aborted || owner !== generation) return false;
        error = `${failure.message || 'Economic data is temporarily unavailable'}${payload ? ' · Previous annual values remain displayed.' : ''}`; return false;
      } finally {
        if (owner === generation && !destroyed) { loading = false; controller = null; pending = null; render(); }
      }
    })();
    pending = work; return work;
  }
  function setCountry(value = 'WLD') {
    const next = economicsCountry(value);
    if (next.id === selected.id) return refresh();
    cancel(); selected = next; payload = null; error = null; refreshedAt = null; render(); return refresh();
  }
  chooser.addEventListener('change', () => void setCountry(chooser.value));
  const visibility = () => { if (documentRef.hidden) { cancel(); render(); } else if (opened) void refresh(); };
  documentRef.addEventListener?.('visibilitychange', visibility);
  const unsubscribe = fetchImpl?.subscribe?.((url) => {
    if (!opened || destroyed || documentRef.hidden || url !== activeUrl) return;
    const owner = generation;
    if (pending) void pending.then(() => { if (opened && !destroyed && owner === generation) void refresh(true); });
    else void refresh(true);
  });
  return {
    refresh, setCountry,
    getState: () => ({ opened, country: selected, loading, payload, error, refreshedAt }),
    open(value) { if (destroyed) return Promise.resolve(false); opened = true; container.hidden = false; return value ? setCountry(value) : refresh(); },
    close() { opened = false; container.hidden = true; cancel(); },
    destroy() { if (destroyed) return; destroyed = true; opened = false; cancel(); unsubscribe?.(); documentRef.removeEventListener?.('visibilitychange', visibility); container.replaceChildren(); },
  };
}
