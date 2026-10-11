import { DEMAND_SUBJECTS, demandSubject, isDemandCountry } from '../src/core/demand-subjects.js';
import { readResponseJsonCapped } from '../src/sources/httpBody.js';

export const DEMAND_SUMMARY_URL = 'https://giovannicallebaut.com/api/discovery/demand/summary';
export const MAX_DEMAND_SUMMARY_BYTES = 65536;
const DAY = 86400000, MAX_PUBLIC_GROUPS = 100;
const themes = new Map(DEMAND_SUBJECTS.filter((subject) => subject.theme).map((subject) => [subject.theme, subject]));
const balanced = (reason) => Object.freeze({ mode: 'balanced', reason, interests: Object.freeze([]) });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const day = (time) => new Date(time).toISOString().slice(0, 10);
const weight = (actions) => Math.min(4, 1 + Math.floor(Math.log2(actions / 300)));

/** Accept only the rounded, thresholded public contract, never raw/private demand events. */
export function validatePrioritySummary(payload, nowMs = Date.now()) {
  if (!exactKeys(payload, ['enabled', 'groups', 'window', 'minimumActions', 'bucketSize', 'maximumGroups', 'unit', 'rounding', 'countryMeaning']) ||
      payload.enabled !== true || !Array.isArray(payload.groups) || payload.groups.length > MAX_PUBLIC_GROUPS ||
      payload.minimumActions !== 300 || payload.bucketSize !== 100 || payload.maximumGroups !== MAX_PUBLIC_GROUPS ||
      payload.unit !== 'Accepted search actions, not unique people' || payload.rounding !== 'Rounded down to multiples of 100' ||
      payload.countryMeaning !== 'Explicit country filter, never a visitor or map location' ||
      !exactKeys(payload.window, ['firstDay', 'lastDay', 'days']) || payload.window.days !== 7 ||
      payload.window.lastDay !== day(nowMs) || payload.window.firstDay !== day(nowMs - 6 * DAY)) throw new Error('Invalid public demand summary');
  const seen = new Set(), interests = [];
  for (const group of payload.groups) {
    const subject = demandSubject(group?.subjectId);
    if (!exactKeys(group, ['subjectId', 'label', 'country', 'actions']) || !subject || group.label !== subject.label ||
        typeof group.country !== 'string' || !isDemandCountry(group.country) ||
        !Number.isSafeInteger(group.actions) || group.actions < 300 || group.actions > 7000000 || group.actions % 100 ||
        subject.id === 'overview:country' && !group.country || subject.id === 'overview:all' && group.country) throw new Error('Invalid public demand group');
    const key = `${subject.id}|${group.country}`;
    if (seen.has(key)) throw new Error('Duplicate public demand group');
    seen.add(key);
    // The global overview already owns the balanced baseline. It cannot claim
    // an additional focused reservation or change category-wide limits.
    if (subject.id !== 'overview:all') interests.push(Object.freeze({ key, subject, country: group.country, weight: weight(group.actions) }));
  }
  if (!interests.length) return balanced('No published focused demand; balanced selection retained');
  interests.sort((a, b) => a.key.localeCompare(b.key));
  return Object.freeze({ mode: 'demand-prioritized', reason: 'Published rounded demand guides bounded metadata sampling only', interests: Object.freeze(interests) });
}

/** One fixed owned-origin GET. Failure, disabled status, staleness or bad schema preserves baseline. */
export async function readDemandPriority({ enabled = true, fetchImpl = fetch, now = Date.now, signal, timeoutMs = 3000 } = {}) {
  if (!enabled) return balanced('Demand priority disabled; balanced selection retained');
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('Demand summary timed out')), Math.min(5000, Math.max(100, timeoutMs)));
  const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let abort;
  try {
    const failure = new Promise((_, reject) => {
      abort = () => reject(boundedSignal.reason || new Error('Demand summary cancelled'));
      if (boundedSignal.aborted) abort(); else boundedSignal.addEventListener('abort', abort, { once: true });
    });
    const load = (async () => {
      const response = await fetchImpl(DEMAND_SUMMARY_URL, { signal: boundedSignal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', 'User-Agent': 'earth-observer-snapshots/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)' } });
      if (boundedSignal.aborted || !response.ok || response.redirected || response.url && response.url !== DEMAND_SUMMARY_URL ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
        void response.body?.cancel().catch(() => {}); throw new Error('Demand summary unavailable');
      }
      const payload = await readResponseJsonCapped(response, MAX_DEMAND_SUMMARY_BYTES, boundedSignal);
      boundedSignal.throwIfAborted();
      return validatePrioritySummary(payload, now());
    })();
    return await Promise.race([load, failure]);
  } catch { return balanced('Demand summary unavailable or invalid; balanced selection retained'); }
  finally { clearTimeout(deadline); if (abort) boundedSignal.removeEventListener('abort', abort); }
}

function matches(row, interest) {
  const { subject, country } = interest;
  return (!country || row.mentionedCountries?.includes(country)) &&
    (subject.category === 'all' || row.category === subject.category) && (!subject.theme || row.themes?.includes(subject.theme));
}

/** Share the existing candidate budget: >=80% global hash sample, <=20% focused strata.
 * The factory is the existing bounded hash reservoir, not another acquisition pipeline. */
export function createPriorityReservoir(priority, reservoirFactory, limit = 10000) {
  if (priority?.mode !== 'demand-prioritized' || !priority.interests?.length) return null;
  if (!Number.isSafeInteger(limit) || limit < 100 || limit > 10000) throw new Error('Invalid priority candidate limit');
  const focusedBudget = Math.floor(limit / 5), global = reservoirFactory(limit);
  const totalWeight = priority.interests.reduce((sum, interest) => sum + interest.weight, 0);
  const groups = priority.interests.map((interest) => ({ interest, slots: Math.floor(focusedBudget * interest.weight / totalWeight) }));
  let remaining = focusedBudget - groups.reduce((sum, group) => sum + group.slots, 0);
  for (let index = 0; remaining; index++, remaining--) groups[index % groups.length].slots++;
  for (const group of groups) group.reservoir = group.slots ? reservoirFactory(group.slots) : null;
  let focusedCount = 0;
  return {
    add(row) {
      const matching = groups.filter((group) => group.reservoir && matches(row, group.interest));
      const growth = matching.reduce((sum, group) => sum + Number(group.reservoir.size < group.slots), 0);
      // Loan unused focused capacity to the global sampler. Trim before adding
      // new focused entries, so combined stored candidates never exceed limit.
      if (growth) { focusedCount += growth; global.resize(limit - focusedCount); }
      global.add(row);
      for (const group of matching) group.reservoir.add(row);
    },
    values() {
      const unique = new Map();
      for (const row of [...global.values(), ...groups.flatMap((group) => group.reservoir?.values() || [])]) {
        const key = `${row.category}|${row.url}`, previous = unique.get(key);
        if (!previous || row.indexedAt > previous.indexedAt) unique.set(key, row);
      }
      return [...unique.values()];
    },
  };
}

const primaryCountry = (row) => row.mentionedCountries[0] || '?';
const rowThemes = (row) => row.themes.filter((theme) => themes.get(theme)?.category === row.category);
const add = (counts, key) => counts.set(key, (counts.get(key) || 0) + 1);
const sorted = (rows) => rows.sort((a, b) => b.indexedAt.localeCompare(a.indexedAt) || a.url.localeCompare(b.url));

/** Preserve >=75% of the original balanced category, reserve <=25% for demand.
 * Demand additions have hard caps: 2/publisher, 8/primary country, 8/theme.
 * Coarse weights 1..4 guide fair allocation; attention never changes record fields. */
export function prioritizeCategory(baseline, candidates, priority, category, limit = 80) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new Error('Invalid priority snapshot limit');
  if (priority?.mode !== 'demand-prioritized' || !priority.interests?.length) return baseline;
  const reservation = Math.floor(limit / 4), preserved = baseline.slice(0, limit - reservation);
  const selectedUrls = new Set(preserved.map((row) => row.url));
  const unique = new Map();
  for (const row of sorted(candidates.filter((row) => row.category === category).slice())) if (!unique.has(row.url)) unique.set(row.url, row);
  const groups = priority.interests.filter((interest) => interest.subject.category === 'all' || interest.subject.category === category).map((interest) => ({
    ...interest, served: 0, exhausted: false, rows: [...unique.values()].filter((row) => matches(row, interest)),
  }));
  const publisherCounts = new Map(), countryCounts = new Map(), themeCounts = new Map();
  const extraPublishers = new Map(), extraCountries = new Map(), extraThemes = new Map(), additions = [];
  const countRow = (row, publishers, countries, topics) => { add(publishers, row.source); add(countries, primaryCountry(row)); for (const theme of rowThemes(row)) add(topics, theme); };
  for (const row of preserved) countRow(row, publisherCounts, countryCounts, themeCounts);
  while (additions.length < reservation) {
    const group = groups.filter((entry) => !entry.exhausted && entry.served < 8).sort((a, b) => a.served / a.weight - b.served / b.weight || b.weight - a.weight || a.key.localeCompare(b.key))[0];
    if (!group) break;
    let chosen, chosenScore = Infinity;
    for (const row of group.rows) {
      const country = primaryCountry(row), topics = rowThemes(row);
      if (selectedUrls.has(row.url) || (extraPublishers.get(row.source) || 0) >= 2 || (extraCountries.get(country) || 0) >= 8 || topics.some((theme) => (extraThemes.get(theme) || 0) >= 8)) continue;
      const score = (publisherCounts.get(row.source) || 0) * 100 + (countryCounts.get(country) || 0) * 10 + Math.min(...topics.map((theme) => themeCounts.get(theme) || 0));
      if (score < chosenScore) { chosen = row; chosenScore = score; }
    }
    if (!chosen) { group.exhausted = true; continue; }
    additions.push(chosen); selectedUrls.add(chosen.url); group.served++;
    countRow(chosen, publisherCounts, countryCounts, themeCounts); countRow(chosen, extraPublishers, extraCountries, extraThemes);
  }
  if (!additions.length) return baseline;
  const selected = [...preserved, ...additions];
  for (const row of baseline) if (selected.length < limit && !selectedUrls.has(row.url)) { selected.push(row); selectedUrls.add(row.url); }
  return sorted(selected);
}

/** Snapshot contract and provenance stay unchanged; only retained rows change. */
export function applyDemandPriority(snapshot, reports, priority) {
  if (priority?.mode !== 'demand-prioritized' || !priority.interests?.length) return snapshot;
  const retained = new Set(snapshot.coverage.processedBatches.map((batch) => batch.id));
  const candidates = reports.filter((row) => retained.has(row.batch));
  const categories = Object.fromEntries(Object.entries(snapshot.categories).map(([category, entry]) => [category,
    { reports: prioritizeCategory(entry.reports, candidates, priority, category) }]));
  return { ...snapshot, categories };
}
