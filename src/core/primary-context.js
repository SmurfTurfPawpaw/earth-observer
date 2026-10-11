const DAY = 86400000;
export const PRIMARY_CONTEXT_MAX_BYTES = 64 * 1024;
export const PRIMARY_CONTEXT_NOTE = 'Dated primary-record context, not a live feed or current sanctions guidance. These checks add no official transcript or audio review.';
const SOURCE_URLS = Object.freeze({
  'mofcom-2025-70': 'https://www.mofcom.gov.cn/zcfb/blgg/gg/2025/art/2025/art_da147202d0934ddebe252772e95ed7b3.html',
  'mofcom-2025-18': 'https://www.mofcom.gov.cn/zcfb/blgg/gg/2025/art/2025/art_5e663d0bfec7452dabd950d0f0e42153.html',
  'ofac-iran-gl-u': 'https://ofac.treasury.gov/system/files/2026-03/iran_glu_0.pdf',
  'ofac-iran-gl-x1': 'https://ofac.treasury.gov/media/936446/download?inline=',
  'bls-q2-2026-revised': 'https://www.bls.gov/news.release/archives/prod2_09032026.htm',
});
const TOPICS = Object.freeze({
  'critical-minerals': ['geopolitics', 'economy'],
  'sanctions-and-energy': ['geopolitics', 'economy'],
  'productivity-and-labor': ['economy'],
});
const COUNTRIES = Object.freeze({ CN: 'China', IR: 'Iran', US: 'United States' });
const fail = () => { throw new Error('Dated research context is invalid'); };
const clock = (value) => { const result = typeof value === 'function' ? value() : value; if (!Number.isFinite(result)) fail(); return result; };
function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) fail();
  return value;
}
function text(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)) fail();
  return value;
}
function id(value) { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(value)) fail(); return value; }
function date(value, latest = Infinity) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value || Date.parse(value) > latest) fail();
  return value;
}
function timestamp(value, latest = Infinity, utc = false) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      (utc && !value.endsWith('Z')) || !Number.isFinite(Date.parse(value)) || Date.parse(value) > latest) fail();
  date(value.slice(0, 10));
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail();
  return value;
}
function array(value, max, normalize) {
  if (!Array.isArray(value) || !value.length || value.length > max) fail();
  return value.map(normalize);
}
function temporal(value, reviewedAt) {
  const latest = Date.parse(reviewedAt), asOf = date(value?.asOf, latest);
  if (asOf !== reviewedAt.slice(0, 10)) fail();
  if (value.kind === 'legal-instrument') {
    object(value, ['kind', 'asOf', 'suspensionStartsOn', 'suspensionEndsOn', 'statusAtReview']);
    const starts = date(value.suspensionStartsOn, latest), ends = date(value.suspensionEndsOn);
    if (value.statusAtReview !== 'within-published-suspension-period' || starts > asOf || asOf > ends || Date.parse(ends) - Date.parse(starts) > 5 * 366 * DAY) fail();
    return { ...value, suspensionStartsOn: starts, suspensionEndsOn: ends };
  }
  if (value.kind === 'expired-legal-authorizations') {
    object(value, ['kind', 'asOf', 'statusAtReview', 'authorizations']);
    if (value.statusAtReview !== 'expired') fail();
    const authorizations = array(value.authorizations, 4, (item) => {
      object(item, ['instrument', 'expiresAt', 'statusAtReview'], ['loadedNoLaterThan', 'effectiveOn']);
      const expiresAt = timestamp(item.expiresAt, latest);
      if (item.statusAtReview !== 'expired' || !['General License U', 'General License X1'].includes(item.instrument) || (!item.loadedNoLaterThan && !item.effectiveOn)) fail();
      return { instrument: item.instrument, expiresAt, statusAtReview: 'expired',
        ...(item.loadedNoLaterThan ? { loadedNoLaterThan: timestamp(item.loadedNoLaterThan, Date.parse(expiresAt)) } : {}),
        ...(item.effectiveOn ? { effectiveOn: date(item.effectiveOn, Date.parse(expiresAt)) } : {}) };
    });
    if (new Set(authorizations.map((item) => item.instrument)).size !== authorizations.length) fail();
    return { kind: value.kind, asOf, statusAtReview: 'expired', authorizations };
  }
  if (value.kind === 'statistical-release') {
    object(value, ['kind', 'asOf', 'referencePeriod', 'releasedOn', 'statusAtReview']);
    if (!/^\d{4}-Q[1-4]$/.test(value.referencePeriod) || value.statusAtReview !== 'historical-statistical-release') fail();
    const releasedOn = date(value.releasedOn, latest), periodEnd = Date.UTC(Number(value.referencePeriod.slice(0, 4)), Number(value.referencePeriod.at(-1)) * 3, 0);
    if (periodEnd > Date.parse(releasedOn)) fail();
    return { ...value, releasedOn };
  }
  fail();
}

/** Validate this reviewed, metadata-only schema; dates do not establish current legal validity. */
export function normalizePrimaryContext(value, { now = Date.now() } = {}) {
  const current = clock(now);
  object(value, ['schemaVersion', 'reviewedAt', 'scope', 'countriesScope', 'records']);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PRIMARY_CONTEXT_MAX_BYTES) fail();
  if (value.schemaVersion !== 1) fail();
  const reviewedAt = timestamp(value.reviewedAt, current, true), ids = new Set();
  const records = array(value.records, 12, (record) => {
    object(record, ['id', 'title', 'topic', 'countries', 'reviewedAt', 'finding', 'temporalScope', 'relatedCreator', 'relationToCreator', 'sources', 'limitations']);
    const identity = id(record.id); if (ids.has(identity) || !Object.hasOwn(TOPICS, record.topic)) fail(); ids.add(identity);
    const reviewed = timestamp(record.reviewedAt, Date.parse(reviewedAt), true);
    const countries = array(record.countries, 4, (code) => { if (!Object.hasOwn(COUNTRIES, code)) fail(); return code; });
    if (new Set(countries).size !== countries.length) fail();
    const sources = array(record.sources, 5, (source) => {
      object(source, ['id', 'publisher', 'title', 'titleKind', 'date', 'dateKind', 'url']);
      if (!Object.hasOwn(SOURCE_URLS, source.id) || source.url !== SOURCE_URLS[source.id] ||
        !['english-paraphrase-of-chinese-title', 'document-heading', 'official-release-title'].includes(source.titleKind) ||
        !['issued', 'document-dated', 'effective', 'released'].includes(source.dateKind)) fail();
      return { id: source.id, publisher: text(source.publisher, 240), title: text(source.title, 300), titleKind: source.titleKind,
        date: date(source.date, Date.parse(reviewed)), dateKind: source.dateKind, url: source.url };
    });
    const sourceIds = new Set(sources.map((source) => source.id));
    object(record.finding, ['kind', 'text', 'sourceIds']);
    const findingIds = array(record.finding.sourceIds, 5, (sourceId) => { if (!sourceIds.has(sourceId)) fail(); return sourceId; });
    if (sourceIds.size !== sources.length || new Set(findingIds).size !== findingIds.length || record.finding.kind !== 'primary-record-paraphrase') fail();
    object(record.relationToCreator, ['kind', 'text']); if (record.relationToCreator.kind !== 'inference') fail();
    const creator = object(record.relatedCreator, ['videoId', 'url', 'publishedDate', 'reviewCoverage', 'officialTranscriptRetrieved', 'audioVerified']);
    if (typeof creator.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(creator.videoId) || creator.url !== `https://www.youtube.com/watch?v=${creator.videoId}` ||
      !['third-party-full-text-reviewed', 'official-description-reviewed'].includes(creator.reviewCoverage) || creator.officialTranscriptRetrieved !== false || creator.audioVerified !== false) fail();
    return { id: identity, title: text(record.title, 200), topic: record.topic, countries, reviewedAt: reviewed,
      finding: { kind: 'primary-record-paraphrase', text: text(record.finding.text), sourceIds: findingIds }, temporalScope: temporal(record.temporalScope, reviewed),
      relatedCreator: { ...creator, publishedDate: date(creator.publishedDate, Date.parse(reviewed)) },
      relationToCreator: { kind: 'inference', text: text(record.relationToCreator.text) }, sources,
      limitations: array(record.limitations, 6, (item) => text(item, 1000)), reviewAgeMs: current - Date.parse(reviewed) };
  });
  return { schemaVersion: 1, reviewedAt, scope: text(value.scope, 1000), countriesScope: text(value.countriesScope, 500), records,
    reviewAgeMs: current - Date.parse(reviewedAt) };
}

export function filterPrimaryContext(payload, { q = '', category = 'all', country = '' } = {}) {
  const query = String(q).trim();
  if (query.length > 64 || /[<>\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(query) || !['all', 'disasters', 'geopolitics', 'economy'].includes(category) || (country && !/^[A-Z]{2}$/.test(country))) return [];
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return payload.records.filter((record) => (category === 'all' || TOPICS[record.topic].includes(category)) && (!country || record.countries.includes(country)) &&
    terms.every((term) => [record.title, record.topic.replaceAll('-', ' '), record.finding.text, record.relationToCreator.text,
      ...record.countries.flatMap((code) => [code, COUNTRIES[code]]), ...record.sources.flatMap((source) => [source.title, source.publisher])].join(' ').toLocaleLowerCase().includes(term)));
}
function active(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
async function jsonBytes(response, signal) {
  const reader = response.body?.getReader(); if (!reader) fail();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const chunks = []; let length = 0;
  try {
    if (Number(response.headers.get('content-length')) > PRIMARY_CONTEXT_MAX_BYTES) fail();
    for (;;) {
      const { done, value } = await active(reader.read(), signal); if (done) break;
      length += value.byteLength; if (length > PRIMARY_CONTEXT_MAX_BYTES) fail(); chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) { cancel(); throw error; } finally { reader.releaseLock(); }
}
function contextUrl(value, origin) {
  const url = new URL(value || `${import.meta.env?.BASE_URL || '/'}research/primary-context.json`, origin);
  if (url.origin !== new URL(origin).origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^\/(?:[a-z0-9-]+\/)*research\/primary-context\.json$/.test(url.pathname)) fail();
  return url.href;
}

/** One request per opened panel/session; optional device fallback never changes the review date. */
export function createPrimaryContextLoader({ fetchImpl = (...args) => fetch(...args), store, now = Date.now,
  origin = globalThis.location?.origin || 'http://localhost', url, timeoutMs = 8000 } = {}) {
  const address = contextUrl(url, origin), key = `research:primary-context:v1:${address}`;
  let memory, pending, generation = 0, destroyed = false;
  const result = (entry, loadedFrom) => ({ data: normalizePrimaryContext(entry.data, { now: clock(now) }), retrievedAt: entry.retrievedAt, loadedFrom });
  function cancel() { ++generation; pending?.controller.abort(); pending = null; }
  function load({ signal, force = false } = {}) {
    if (destroyed) return Promise.reject(new DOMException('Research panel closed', 'AbortError'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (memory && !force) return Promise.resolve(result(memory, 'memory'));
    if (pending && !pending.signal.aborted) return active(pending.work, signal || pending.signal);
    const controller = new AbortController(), baseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const entry = { controller, signal: baseSignal }, owner = ++generation;
    const work = (async () => {
      try {
        const requestSignal = AbortSignal.any([baseSignal, AbortSignal.timeout(timeoutMs)]);
        const response = await active(Promise.resolve().then(() => {
          requestSignal.throwIfAborted();
          return fetchImpl(address, { signal: requestSignal, credentials: 'omit', redirect: 'error', mode: 'same-origin', headers: { Accept: 'application/json' } });
        }), requestSignal);
        if (response.status !== 200 || response.redirected || ['opaque', 'opaqueredirect', 'error'].includes(response.type) ||
            (response.url && response.url !== address) || (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') fail();
        const data = await jsonBytes(response, requestSignal), saved = { data, retrievedAt: new Date(clock(now)).toISOString() };
        const normalized = result(saved, 'network'); baseSignal.throwIfAborted();
        if (destroyed || generation !== owner) throw new DOMException('Research panel closed', 'AbortError');
        memory = saved;
        if (store && !/private|no-store/i.test(response.headers.get('cache-control') || '')) void Promise.resolve().then(() => {
          if (!destroyed && generation === owner && !baseSignal.aborted) return store.put(key, saved);
        }).catch(() => {});
        return normalized;
      } catch (failure) {
        baseSignal.throwIfAborted();
        if (destroyed || generation !== owner) throw new DOMException('Research panel closed', 'AbortError');
        if (store) try {
          const cached = await active(Promise.resolve().then(() => store.get(key)), AbortSignal.any([baseSignal, AbortSignal.timeout(1000)]));
          const retrievedAt = timestamp(cached?.retrievedAt, clock(now), true);
          if (clock(now) - Date.parse(retrievedAt) <= 7 * DAY && new TextEncoder().encode(JSON.stringify(cached.data)).byteLength <= PRIMARY_CONTEXT_MAX_BYTES) {
            const normalized = result(cached, 'device');
            if (Date.parse(retrievedAt) < Date.parse(normalized.data.reviewedAt)) fail();
            baseSignal.throwIfAborted(); memory = cached; return normalized;
          }
        } catch { baseSignal.throwIfAborted(); }
        throw new Error('Dated research context is unavailable. Live reports remain separate.');
      } finally { if (pending === entry) pending = null; }
    })();
    entry.work = work; pending = entry; return work;
  }
  return { load, cancel, destroy() { destroyed = true; cancel(); memory = null; } };
}

const age = (ms) => ms < DAY ? 'less than 1 day since review' : `${Math.floor(ms / DAY)} days since review`;
/** Plain-text, source-linked details. No article body, picture, map point or transcript is fetched. */
export function renderPrimaryContextDetails(payload, { documentRef = globalThis.document, filters = {}, now = Date.now() } = {}) {
  // Revalidate even for direct helper callers; derived age fields are not source facts.
  const { reviewAgeMs, ...raw } = payload;
  payload = normalizePrimaryContext({ ...raw, records: raw.records.map(({ reviewAgeMs, ...record }) => record) }, { now });
  const node = (tag, value, className = 'intelligence-meta') => { const element = documentRef.createElement(tag); if (className) element.className = className; if (value !== undefined) element.textContent = value; return element; };
  const link = (label, url) => { const element = node('a', label, ''); element.href = url; element.target = '_blank'; element.rel = 'noopener noreferrer'; return element; };
  const details = node('details', undefined, 'intelligence-coverage'); details.append(node('summary', 'Research context · dated primary records', ''));
  details.append(node('p', `${PRIMARY_CONTEXT_NOTE} Reviewed ${payload.reviewedAt} · ${age(clock(now) - Date.parse(payload.reviewedAt))}.`), node('p', payload.scope), node('p', payload.countriesScope));
  const records = filterPrimaryContext(payload, filters);
  if (!records.length) details.append(node('p', 'No dated research context matches these filters. This is a separate, limited reference set.'));
  for (const record of records) {
    const article = node('article', undefined, 'intelligence-card'); article.append(node('h4', record.title, ''),
      node('p', `Primary-record paraphrase · reviewed ${record.reviewedAt} · ${age(clock(now) - Date.parse(record.reviewedAt))} · jurisdictions/subjects: ${record.countries.map((code) => COUNTRIES[code]).join(', ')}`), node('p', record.finding.text, ''));
    const period = record.temporalScope;
    if (period.kind === 'legal-instrument') {
      article.append(node('p', `Published suspension window: ${period.suspensionStartsOn} through ${period.suspensionEndsOn}. Within that published period at the ${period.asOf} review.`));
      if (new Date(clock(now)).toISOString().slice(0, 10) > period.suspensionEndsOn) article.append(node('p', 'The published deadline has passed. This dated check does not establish subsequent policy; recheck official instruments.'));
    } else if (period.kind === 'expired-legal-authorizations') {
      for (const authorization of period.authorizations) article.append(node('p', `${authorization.instrument} · expired at the ${period.asOf} review · ${authorization.loadedNoLaterThan ? `cargo loaded no later than ${authorization.loadedNoLaterThan}` : `effective ${authorization.effectiveOn}`} · authorization ended ${authorization.expiresAt}`));
    } else article.append(node('p', `Reference period ${period.referencePeriod} · released ${period.releasedOn} · historical release reviewed ${period.asOf}`));
    const list = node('ul', undefined, '');
    for (const source of record.sources) { const item = node('li', undefined, ''); item.append(link(source.title, source.url), ` · ${source.publisher} · ${source.dateKind}: ${source.date} · title: ${source.titleKind.replaceAll('-', ' ')}`); list.append(item); }
    article.append(list, node('p', `Creator comparison · inference: ${record.relationToCreator.text}`));
    const creator = node('p'); creator.append(link('Related Maxinomics commentary', record.relatedCreator.url), ` · published ${record.relatedCreator.publishedDate} · ${record.relatedCreator.reviewCoverage === 'third-party-full-text-reviewed' ? 'unverified third-party text reviewed' : 'official description only reviewed'} · no official transcript retrieved; audio not verified.`); article.append(creator);
    for (const limitation of record.limitations) article.append(node('p', `Limit: ${limitation}`));
    details.append(article);
  }
  return details;
}

/** Mount separately from live report groups; open/filters own no polling or query telemetry. */
export function createPrimaryContextPanel(container, { documentRef = container?.ownerDocument || globalThis.document, now = Date.now, ...options } = {}) {
  if (!container || !documentRef) throw new TypeError('A research context container is required');
  const loader = createPrimaryContextLoader({ ...options, now });
  let opened = false, destroyed = false, pending, controller, generation = 0, snapshot, filters = {}, failure = null;
  const details = documentRef.createElement('details'); details.className = 'intelligence-coverage';
  const summary = documentRef.createElement('summary'); summary.textContent = 'Research context · dated primary records';
  const status = documentRef.createElement('p'); status.className = 'intelligence-meta'; status.setAttribute('role', 'status');
  const body = documentRef.createElement('div'); details.append(summary, status, body); container.replaceChildren(details);
  function render() {
    container.setAttribute('aria-busy', String(Boolean(pending)));
    status.textContent = failure || (pending ? 'Loading dated research context…' : snapshot?.loadedFrom === 'device' ? 'Saved device copy · review dates unchanged; no live refresh available.' : 'Separate dated research context; original review and source dates remain visible.');
    if (!snapshot) return;
    const content = renderPrimaryContextDetails(snapshot.data, { documentRef, filters, now: clock(now) });
    // Keep the user's outer disclosure state and focus when local filters change.
    body.replaceChildren(...Array.from(content.children).slice(1));
  }
  function close() { opened = false; ++generation; controller?.abort(); loader.cancel(); pending = null; render(); }
  function open() {
    if (destroyed || documentRef.hidden) return Promise.resolve(false);
    opened = true;
    if (pending) return pending;
    failure = null;
    const request = new AbortController(), owner = ++generation; controller = request;
    const work = (async () => {
      try { const value = await loader.load({ signal: request.signal }); if (destroyed || !opened || owner !== generation) return false; snapshot = value; return true; }
      catch (error) { if (!request.signal.aborted && !destroyed && owner === generation) failure = error.message; return false; }
      finally { if (!destroyed && owner === generation) { pending = null; controller = null; render(); } }
    })();
    pending = work; render(); return work;
  }
  const visibility = () => { if (documentRef.hidden) { const resume = opened; close(); opened = resume; } else if (opened) void open(); };
  documentRef.addEventListener?.('visibilitychange', visibility);
  return { open, close, setFilters(value = {}) { filters = { ...value }; if (!destroyed) render(); },
    destroy() { if (destroyed) return; close(); destroyed = true; loader.destroy(); documentRef.removeEventListener?.('visibilitychange', visibility); container.replaceChildren(); } };
}
