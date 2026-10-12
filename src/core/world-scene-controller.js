import { worldTime, worldHash, isWorldDigest } from './world-identity.js';

export const WORLD_SCENE_SCOPE = 'usgs-catalog-m4.5-v1';
export const WORLD_SCENE_REFRESH_MS = 60000;
export const WORLD_SCENE_LIMITS = Object.freeze({ events: 1000, pages: 10, bytes: 1024 * 1024, cacheBytes: 3 * 1024 * 1024, cacheEntries: 6, pointsPageLimit: 250 });
const WEEK = 7 * 86400000;
const canonical = (value) => { try { return worldTime(value); } catch { return null; } };
const count = (value) => Number.isInteger(value) && value >= 0 && value <= 10000000;
class SceneVersionConflict extends Error {
  constructor(bytes = 0) { super('Historical evidence is updating. Try again shortly.'); this.bytes = bytes; }
}
const official = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'earthquake.usgs.gov' && !url.username && !url.password && url.href.length <= 2048; }
  catch { return false; }
};
const range = (value) => {
  const from = canonical(value?.from), to = canonical(value?.to);
  if (!from || !to || from > to) throw new Error('Historical coverage has invalid dates');
  return { from, to };
};

/** Source origin coverage and hosted knowledge are deliberately different clocks. */
export function sceneCoverageAt(coverage, at, knownMode = 'none') {
  if (!at) return coverage;
  const target = { from: new Date(Date.parse(at) - WEEK + 1).toISOString(), to: at }, gaps = [];
  const clip = (piece) => ({ ...piece, from: piece.from < target.from ? target.from : piece.from,
    to: piece.to > target.to ? target.to : piece.to });
  const segments = coverage.segments.map(clip).filter((piece) => piece.from <= piece.to);
  const loaded = coverage.requestedRange;
  const edges = new Set([Date.parse(target.from), Date.parse(target.to) + 1]);
  for (const piece of [...segments, ...coverage.gaps, ...(loaded ? [loaded] : [])])
    for (const point of [Date.parse(piece.from), Date.parse(piece.to) + 1])
      if (point > Date.parse(target.from) && point <= Date.parse(target.to)) edges.add(point);
  const sorted = [...edges].sort((a,b) => a-b);
  for (let index=0; index<sorted.length-1; index++) {
    const from=sorted[index], to=sorted[index+1]-1;
    if (segments.some((piece) => Date.parse(piece.from)<=from && Date.parse(piece.to)>=to)) continue;
    const original=coverage.gaps.find((piece) => Date.parse(piece.from)<=from && Date.parse(piece.to)>=to);
    const status= !loaded || from<Date.parse(loaded.from) || to>Date.parse(loaded.to) ? 'not-evaluated' :
      original?.status || (knownMode !== 'none' && coverage.status === 'unavailable-at-cutoff' ? 'unavailable-at-cutoff' : 'not-imported');
    const last=gaps.at(-1);
    if(last?.status===status && Date.parse(last.to)+1===from) last.to=new Date(to).toISOString();
    else gaps.push({from:new Date(from).toISOString(),to:new Date(to).toISOString(),status});
  }
  const complete = !gaps.length && !coverage.truncated;
  return { ...coverage, requestedRange: target, segments, gaps, complete,
    status: complete ? 'complete' : gaps.length && gaps.every((gap) => gap.status==='unavailable-at-cutoff') ? 'unavailable-at-cutoff' :
      !segments.length && !coverage.truncated && gaps.length && gaps.every((gap) => gap.status==='not-imported') ? 'not-imported' : 'partial' };
}

/** Reject an incompatible scope, future observation, or an unbound source projection. */
export async function normalizeWorldScene(value, { at = null, lens = 'reconstruction', metadata = false, buffered = false, pageLimit = 100 } = {}) {
  if (value?.schemaVersion !== 1 || typeof value.configured !== 'boolean' || typeof value.available !== 'boolean') throw new Error('Historical scene response is invalid');
  if (value.configured && !value.available && value.errorCode === 'scene-delivery-byte-budget' && value.scope?.id === WORLD_SCENE_SCOPE)
    throw new Error('Stored historical point metadata and one record exceed the delivery budget.');
  if (!value.configured || !value.available) throw new Error(value.configured ? 'Stored historical evidence is unavailable.' : 'The historical archive is not configured on this host.');
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > (buffered ? WORLD_SCENE_LIMITS.pointsPageLimit : 100)) throw new Error('Historical page limit is invalid');
  const delivery = value.delivery === undefined ? null : value.delivery;
  if (delivery !== null && (!delivery || typeof delivery !== 'object' || Array.isArray(delivery) || ![100, WORLD_SCENE_LIMITS.pointsPageLimit].includes(delivery.pointsPageLimit)))
    throw new Error('Historical delivery capability is invalid');
  const mode = lens === 'known-then' ? 'as-known' : 'reconstruction', knownMode = lens === 'known-then' ? 'scene' : 'none';
  if (value.scope?.id !== WORLD_SCENE_SCOPE || value.scope.sourceId !== 'usgs' || value.window !== '7d' || value.mode !== mode ||
      value.knownMode !== knownMode || (metadata ? value.at !== null : canonical(value.at) !== at) ||
      (knownMode === 'none' ? value.knownAt !== null : canonical(value.knownAt) !== at) ||
      !/^archive:\d+$/.test(value.version || '') || !/^archive:\d+$/.test(value.currentVersion || '')) throw new Error('Historical scene does not match the selected time and evidence mode');
  const raw = value.coverage;
  if (!raw || !Array.isArray(raw.segments) || raw.segments.length > 2048 || !Array.isArray(raw.gaps) || raw.gaps.length > 4096 ||
      !['complete', 'partial', 'unavailable-at-cutoff', 'not-imported'].includes(raw.status) || typeof raw.truncated !== 'boolean') throw new Error('Historical coverage is invalid');
  const requestedRange = raw.requestedRange === null ? null : range(raw.requestedRange);
  const segments = raw.segments.map(range);
  if (segments.some((item, index) => index && item.from <= segments[index - 1].to)) throw new Error('Historical coverage overlaps or is unordered');
  const coverage = { availableRange: raw.availableRange === null ? null : range(raw.availableRange), requestedRange, segments,
    gaps: raw.gaps.map((item) => {
      if (!['not-imported', 'unavailable-at-cutoff', 'not-evaluated'].includes(item.status) || item.status === 'not-evaluated' && !raw.truncated) throw new Error('Historical coverage gap is invalid');
      return { ...range(item), status: item.status };
    }), complete: raw.complete === true, truncated: raw.truncated, status: raw.status };
  if ([...coverage.segments,...coverage.gaps].some((piece) => !requestedRange || piece.from < requestedRange.from || piece.to > requestedRange.to))
    throw new Error('Historical coverage leaves its loaded date window');
  const members = buffered ? value.points : value.events;
  if (!Array.isArray(members) || members.length > pageLimit || !count(value.counts?.returned) || value.counts.returned !== members.length ||
      (!metadata && (value.counts.eligible !== null && !count(value.counts.eligible) || value.counts.omitted !== null && !count(value.counts.omitted))) ||
      typeof value.complete !== 'boolean' || typeof value.truncated !== 'boolean' ||
      value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value.cursor))) throw new Error('Historical scene membership is invalid');
  const bufferFrom = buffered ? canonical(value.bufferFrom) : null, bufferTo = buffered ? canonical(value.bufferTo) : null;
  if (buffered && (lens !== 'reconstruction' || bufferFrom !== at || canonical(value.bufferWindowFrom) !== new Date(Date.parse(at) - WEEK).toISOString() ||
      value.bufferTo !== null && (!bufferTo || bufferTo <= at || Date.parse(bufferTo) > Date.parse(at) + WEEK))) throw new Error('Historical time buffer is invalid');
  const points = buffered ? await Promise.all(members.map(async (point) => {
    const origin = canonical(point?.originAt);
    if (point?.sourceId !== 'usgs' || !/^usgs:[a-zA-Z0-9_-]{1,100}$/.test(point.sourceRecordId || '') || !official(point.url) ||
        !isWorldDigest(point.revision) || !isWorldDigest(point.snapshotId) || !origin ||
        origin > (bufferTo || at) || Date.parse(origin) <= Date.parse(at) - WEEK ||
        !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180 ||
        !Number.isFinite(point.magnitude) || point.magnitude < 4.5) throw new Error('Historical point is invalid');
    const identity = await worldHash(['usgs', point.sourceRecordId]);
    if (point.id !== `event:usgs:${identity}` || point.itemId !== `item:${identity}`) throw new Error('Historical point identity is invalid');
    return { ...point, originAt: origin, _originMs: Date.parse(origin) };
  })) : null;
  const events = buffered ? [] : await Promise.all(value.events.map(async (event) => {
    const sourceRecordId = event?.evidence?.sourceRecordId, origin = canonical(event?.eventTime?.at);
    const recorded = canonical(event?.knowledge?.firstRecordedAt), published = canonical(event?.archive?.publishedAt);
    if (event?.schemaVersion !== 1 || event.kind !== 'earthquake' || event.source?.id !== 'usgs' || !official(event.source.url) ||
        typeof sourceRecordId !== 'string' || !/^usgs:[a-zA-Z0-9_-]{1,100}$/.test(sourceRecordId) ||
        !isWorldDigest(event.evidence.revision) || !isWorldDigest(event.evidence.snapshotId) || event.evidence.sourceId !== 'usgs' ||
        event.archive?.scopeId !== WORLD_SCENE_SCOPE || !isWorldDigest(event.archive.chunkId) || !published || !recorded || recorded > published ||
        !origin || !at || origin > at || Date.parse(origin) <= Date.parse(at) - WEEK ||
        !Number.isFinite(event.place?.lat) || Math.abs(event.place.lat) > 90 || !Number.isFinite(event.place?.lon) || Math.abs(event.place.lon) > 180 ||
        !Number.isFinite(event.reportedFacts?.magnitude) || event.reportedFacts.magnitude < 4.5 ||
        knownMode === 'scene' && (published > at || recorded > at)) throw new Error('Historical event disagrees with its source or selected time');
    const identity = await worldHash(['usgs', sourceRecordId]);
    if (event.id !== `event:usgs:${identity}` || event.evidence.itemId !== `item:${identity}`) throw new Error('Historical event identity is invalid');
    return event;
  }));
  if (new Set((points || events).map((event) => event.id)).size !== (points || events).length) throw new Error('Historical scene has duplicate events');
  const validFrom = canonical(value.validFrom), validTo = canonical(value.validTo);
  if ((value.validFrom !== null || value.validTo !== null) && (!validFrom || !validTo || !at || validFrom > at || validTo <= at)) throw new Error('Historical cache interval is invalid');
  return { ...value, at, events, delivery, ...(buffered ? { points, bufferFrom, bufferTo } : {}), coverage, validFrom, validTo, nextSceneChangeAt: validTo,
    membershipComplete: value.membershipComplete === true, counts: { ...value.counts } };
}

async function readBounded(response, signal, maximum) {
  if (Number(response.headers?.get?.('content-length')) > maximum) throw new Error('Historical scene exceeds the browser budget');
  let body, bytes;
  if (!response.body?.getReader) {
    const value = await response.json(); signal.throwIfAborted(); body = JSON.stringify(value); bytes = new TextEncoder().encode(body).byteLength;
  } else {
    const reader = response.body.getReader(), parts = []; bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maximum) throw new Error('Historical scene exceeds the browser budget');
        parts.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
    body = new TextDecoder().decode(joined);
  }
  if (bytes > maximum) throw new Error('Historical scene exceeds the browser budget');
  const value = JSON.parse(body);
  if (response.status === 409 && value?.schemaVersion === 1 && value.errorCode === 'scene-version-changed' && value.scope?.id === WORLD_SCENE_SCOPE &&
      /^archive:\d+$/.test(value.requestedVersion || '') && /^archive:\d+$/.test(value.currentVersion || '')) throw new SceneVersionConflict(bytes);
  if (!response.ok && value?.configured !== false && value?.available !== false) throw new Error(`Historical scene HTTP ${response.status}`);
  return { value, bytes };
}

/** Stored-only delivery. No render frame, source URL, or popularity causes acquisition. */
export function createWorldSceneController({ fetchImpl = globalThis.fetch, documentRef = globalThis.document,
  windowRef = documentRef?.defaultView || globalThis.window, now = Date.now, onChange = () => {},
  setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout,
  url = `${import.meta.env?.BASE_URL || '/'}api/world/scene` } = {}) {
  let opened = false, destroyed = false, generation = 0, request, pending, metadataRequest, metadataPending, metadataGeneration = 0;
  let prefetchRequest, prefetchPending, metadata = null, selection = null, selectedAt = null, lens = 'reconstruction';
  let loading = false, error = null, metadataError = null, checkedAt = null, timer, cacheBytes = 0, prefetchAttempt;
  const cache = new Map();
  const state = () => ({ opened, metadata, selection, selectedAt, lens, loading, error: error || metadataError });
  const emit = () => { if (!destroyed) onChange(state()); };
  const stopTimer = () => { if (timer !== undefined) clearTimeoutImpl(timer); timer = undefined; };
  const cancelPrefetch = () => { prefetchRequest?.abort(); prefetchRequest = null; prefetchPending = null; };
  const cancel = () => { ++generation; request?.abort(); request = null; pending = null; loading = false; cancelPrefetch(); };
  const cancelMetadata = () => { ++metadataGeneration; metadataRequest?.abort(); metadataRequest = null; metadataPending = null; stopTimer(); };
  const clearCache = () => { cache.clear(); cacheBytes = 0; };
  const query = (at, selectedLens, extra = {}) => new URLSearchParams({ scope: WORLD_SCENE_SCOPE, window: '7d',
    ...(at ? { at } : {}), ...(selectedLens === 'known-then' ? { knownMode: 'scene' } : at ? { points: '1', span: '7d' } : {}), ...extra });
  const materialize = (result, at, selectedLens, includeCoverage = true) => {
    const atMs = Date.parse(at), points = result.points;
    const after = (time) => {
      let low = 0, high = points.length;
      while (low < high) { const middle = (low + high) >>> 1; if (points[middle]._originMs <= time) low = middle + 1; else high = middle; }
      return low;
    };
    const first = points ? after(atMs - WEEK) : 0, last = points ? after(atMs) : 0, visible = points?.slice(first, last);
    const coverage = includeCoverage ? sceneCoverageAt(result.coverage, at, selectedLens === 'known-then' ? 'scene' : 'none') : result.coverage;
    return { ...result, at, knownAt: selectedLens === 'known-then' ? at : null, coverage,
      _markersKey: `${result._cacheKey}:${first}:${last}`,
      ...(visible ? { points: visible, bufferCounts: result.counts, counts: { ...result.counts, returned: visible.length,
        eligible: result.membershipComplete && !result.cursor && result.counts.omitted === 0 ? visible.length : null,
        omitted: result.counts.omitted === 0 ? 0 : null } } : {}), complete: coverage.complete && !result.truncated };
  };
  const admit = (result, bytes, selectedLens) => {
    const from = result.points ? result.bufferFrom : result.validFrom, to = result.points ? result.bufferTo : result.validTo;
    if (!result.membershipComplete || result.cursor || result.counts.omitted !== 0 || !from || !to || result.coverage.truncated) return;
    const key = `${selectedLens}:${result.version}:${from}:${to}`;
    result._cacheKey = key;
    if (cache.has(key)) cacheBytes -= cache.get(key).bytes;
    cache.delete(key); cache.set(key, { result, bytes, lens: selectedLens, cachedAt: now() }); cacheBytes += bytes;
    while (cache.size > WORLD_SCENE_LIMITS.cacheEntries || cacheBytes > WORLD_SCENE_LIMITS.cacheBytes) {
      const [oldest, entry] = cache.entries().next().value; cache.delete(oldest); cacheBytes -= entry.bytes;
    }
  };
  function cachedAt(at, selectedLens, includeCoverage = true) {
    if (!at) return null;
    for (const [key, entry] of cache) {
      const from = entry.result.points ? entry.result.bufferFrom : entry.result.validFrom, to = entry.result.points ? entry.result.bufferTo : entry.result.validTo;
      if (entry.lens !== selectedLens || !metadata && now() - entry.cachedAt >= WORLD_SCENE_REFRESH_MS ||
          metadata && entry.result.currentVersion !== metadata.currentVersion || at < from || at >= to) continue;
      cache.delete(key); cache.set(key, entry);
      return { ...materialize(entry.result, at, selectedLens, includeCoverage), _cacheKey: key };
    }
    return null;
  }
  async function load(at, selectedLens, signal) {
    let result, bytes = 0, cursor, pages = 0, restarts = 0; const events = new Map(), seen = new Set();
    while (true) {
      pages++; signal.throwIfAborted();
      try {
        const capacity = selectedLens === 'reconstruction' ? metadata?.delivery?.pointsPageLimit || 100 : 100;
        const pageLimit = Math.min(capacity, WORLD_SCENE_LIMITS.events - events.size);
        const response = await fetchImpl(`${url}?${query(at, selectedLens, { limit: String(pageLimit), ...(cursor ? { cursor } : {}) })}`,
          { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
        const body = await readBounded(response, signal, WORLD_SCENE_LIMITS.bytes - bytes); bytes += body.bytes;
        const page = await normalizeWorldScene(body.value, { at, lens: selectedLens, buffered: selectedLens === 'reconstruction', pageLimit }); signal.throwIfAborted();
        if (result && page.version !== result.version) throw new SceneVersionConflict();
        if (result && (page.counts.eligible !== result.counts.eligible || page.validFrom !== result.validFrom || page.validTo !== result.validTo || page.bufferTo !== result.bufferTo)) {
          if (page.currentVersion !== result.currentVersion) throw new SceneVersionConflict();
          throw new Error('Historical page bounds or membership are inconsistent');
        }
        result ||= page;
        for (const event of page.points || page.events) {
          if (events.has(event.id)) throw new Error('Historical pages overlap');
          events.set(event.id, event);
        }
        cursor = page.cursor;
        if (cursor && seen.has(cursor)) throw new Error('Historical pagination did not advance');
        if (cursor) seen.add(cursor);
        if (!cursor || pages >= WORLD_SCENE_LIMITS.pages || events.size >= WORLD_SCENE_LIMITS.events) break;
      } catch (failure) {
        if (!(failure instanceof SceneVersionConflict)) throw failure;
        bytes += failure.bytes; signal.throwIfAborted();
        if (restarts || pages >= WORLD_SCENE_LIMITS.pages || bytes >= WORLD_SCENE_LIMITS.bytes) throw failure;
        restarts++; result = undefined; cursor = undefined; events.clear(); seen.clear();
        // Only an explicit edition conflict restarts from page one. The same
        // deadline, request/byte budget and selected UTC still own both chains.
        continue;
      }
    }
    result = { ...result, ...(selectedLens === 'reconstruction' ? { points: [...events.values()].sort((a, b) => a._originMs - b._originMs || a.id.localeCompare(b.id)), events: [] } : { events: [...events.values()] }), cursor,
      counts: { ...result.counts, returned: events.size, omitted: result.counts.eligible === null ? null : Math.max(0, result.counts.eligible - events.size) } };
    result.truncated = !result.membershipComplete || result.coverage.truncated || Boolean(cursor) || result.counts.omitted !== 0;
    result.complete = !result.truncated && result.coverage.complete;
    result._cacheKey = `${selectedLens}:${result.version}:${result.validFrom || at}:${result.validTo || at}`;
    return { result, bytes };
  }
  function arm() {
    stopTimer(); if (!opened || destroyed || documentRef?.hidden || metadataPending) return;
    timer = setTimeoutImpl(() => { timer = undefined; void refresh(); }, WORLD_SCENE_REFRESH_MS);
  }
  async function refresh() {
    if (!opened || destroyed || documentRef?.hidden) return false;
    if (metadataPending) return metadataPending;
    cancelPrefetch(); stopTimer(); const owner = ++metadataGeneration, controller = new AbortController(); metadataRequest = controller;
    const work = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
        const response = await fetchImpl(`${url}?${query(null, 'reconstruction', { metadata: '1' })}`, { signal, cache: 'no-store', headers: { Accept: 'application/json' } });
        const body = await readBounded(response, signal, WORLD_SCENE_LIMITS.bytes);
        const result = await normalizeWorldScene(body.value, { metadata: true }); signal.throwIfAborted();
        if (destroyed || owner !== metadataGeneration || !opened || documentRef?.hidden) return false;
        const changed = metadata && metadata.currentVersion !== result.currentVersion;
        metadata = result; metadataError = null;
        if (changed) { clearCache(); if (selectedAt && !pending) void select(selectedAt, lens); }
        else for (const entry of cache.values()) if (entry.result.currentVersion === result.currentVersion) entry.cachedAt = now();
        return true;
      } catch (failure) {
        if (controller.signal.aborted || owner !== metadataGeneration) return false;
        metadataError = failure.message || 'Historical coverage is unavailable'; return false;
      } finally {
        if (!destroyed && owner === metadataGeneration) { metadataRequest = null; metadataPending = null; checkedAt = now(); emit(); arm(); }
      }
    })();
    metadataPending = work; return work;
  }
  function select(at, selectedLens = lens) {
    const canonicalAt = canonical(at);
    if (!canonicalAt || !['reconstruction', 'known-then'].includes(selectedLens) || !opened || destroyed || documentRef?.hidden) return Promise.resolve(false);
    if (pending && selectedAt === canonicalAt && lens === selectedLens) return pending;
    const previous = selection?.at === canonicalAt && lens === selectedLens ? selection : null;
    cancel(); selectedAt = canonicalAt; lens = selectedLens; error = null;
    const cached = cachedAt(canonicalAt, lens);
    selection = cached || previous; loading = !cached; emit(); if (cached) return Promise.resolve(true);
    const owner = generation, controller = new AbortController(); request = controller;
    const work = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
        const loaded = await load(canonicalAt, selectedLens, signal); signal.throwIfAborted();
        if (destroyed || owner !== generation || !opened || documentRef?.hidden) return false;
        if (metadata && metadata.currentVersion !== loaded.result.currentVersion) {
          clearCache(); checkedAt = null;
          // A selected seven-day scene cannot relabel the calendar's loaded
          // coverage. Keep all retained seek limits, invalidate the old band,
          // and let the existing bounded metadata refresh refill it.
          metadata = { ...metadata, currentVersion: loaded.result.currentVersion,
            coverage: { ...metadata.coverage, availableRange: loaded.result.coverage.availableRange,
              requestedRange: null, segments: [], gaps: [], complete: false, status: 'not-evaluated', stale: true } };
        }
        admit(loaded.result, loaded.bytes, selectedLens); selection = materialize(loaded.result, canonicalAt, selectedLens); metadataError = null; return true;
      } catch (failure) {
        if (controller.signal.aborted || owner !== generation) return false;
        error = failure.message || 'Historical scene is unavailable'; return false;
      } finally { if (!destroyed && owner === generation) { request = null; pending = null; loading = false; emit(); } }
    })();
    pending = work; return work;
  }
  function prefetch() {
    if (!opened || destroyed || documentRef?.hidden || pending || metadataPending || prefetchPending || lens !== 'reconstruction' ||
        !selection?.membershipComplete || selection.truncated || !(selection.bufferTo || selection.validTo) ||
        !metadata?.coverage.availableRange || (selection.bufferTo || selection.validTo) >= metadata.coverage.availableRange.to || cachedAt(selection.bufferTo || selection.validTo, lens)) return Promise.resolve(false);
    const controller = new AbortController(); prefetchRequest = controller;
    const at = selection.bufferTo || selection.validTo, owner = generation;
    if (prefetchAttempt?.at === at && now() - prefetchAttempt.checkedAt < 5000) { prefetchRequest = null; return Promise.resolve(false); }
    prefetchAttempt = { at, checkedAt: now() };
    const work = (async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), loaded = await load(at, 'reconstruction', signal); signal.throwIfAborted();
        if (destroyed || owner !== generation || !opened || documentRef?.hidden || loaded.result.currentVersion !== selection?.currentVersion) return false;
        admit(loaded.result, loaded.bytes, 'reconstruction'); return true;
      } catch { return false; }
      finally { if (prefetchRequest === controller) { prefetchRequest = null; prefetchPending = null; } }
    })();
    prefetchPending = work; return work;
  }
  const visibility = () => { if (documentRef?.hidden) { cancel(); cancelMetadata(); emit(); } else if (opened) { void refresh(); if (selectedAt && !selection) void select(selectedAt, lens); } };
  const online = () => { if (opened) void refresh(); };
  documentRef?.addEventListener?.('visibilitychange', visibility); windowRef?.addEventListener?.('online', online);
  return {
    getState: state, peek: (at, selectedLens = lens) => cachedAt(canonical(at), selectedLens),
    frame: (at) => cachedAt(canonical(at), lens, false),
    advance(at) { const next = cachedAt(canonical(at), lens); if (!next) return false; selectedAt = next.at; selection = next; emit(); return true; },
    prepare(at, selectedLens = lens) { cancel(); selectedAt = canonical(at); lens = selectedLens; selection = null; error = null; emit(); },
    setLens(value) { if (['reconstruction', 'known-then'].includes(value)) { lens = value; emit(); } },
    select, prefetch, refresh,
    open() { opened = true; emit(); if (!metadata || checkedAt === null || now() - checkedAt >= WORLD_SCENE_REFRESH_MS) return refresh(); arm(); return Promise.resolve(true); },
    close() { opened = false; cancel(); cancelMetadata(); emit(); },
    live() { cancel(); selectedAt = null; selection = null; error = null; emit(); },
    destroy() { if (destroyed) return; destroyed = true; opened = false; cancel(); cancelMetadata(); clearCache(); documentRef?.removeEventListener?.('visibilitychange', visibility); windowRef?.removeEventListener?.('online', online); },
  };
}
