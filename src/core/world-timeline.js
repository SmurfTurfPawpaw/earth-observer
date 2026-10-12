import * as Cesium from 'cesium';
import { createSceneClock } from './scene-clock.js';
import { worldTime } from './world-model.js';
import { createWorldSceneController } from './world-scene-controller.js';

const stamp = (value) => { try { return worldTime(value); } catch { return null; } };
/** datetime-local omits zero seconds; its calendar is explicitly interpreted as UTC. */
export const timelineDateUtc = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?$/.test(value)) return null;
  return stamp(`${value.length === 16 ? `${value}:00` : value}Z`);
};
const utc = (value) => stamp(value)?.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') || 'Time unavailable';
const members = (scene) => scene?.points || scene?.events || [];
const origin = (item) => item.originAt || item.eventTime?.at;
const latitude = (item) => item.lat ?? item.place?.lat;
const longitude = (item) => item.lon ?? item.place?.lon;
const magnitude = (item) => item.magnitude ?? item.reportedFacts?.magnitude;
const sourceId = (item) => item.sourceRecordId || item.evidence?.sourceRecordId;

/** One calm calendar; frame-local origin filtering never fetches source data. */
export function createTimeline({ container, viewer, fetchImpl, onTimeChange = () => {}, onNavigate,
  documentRef = container?.ownerDocument || globalThis.document, setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout, now = Date.now, monotonicNow,
  windowRef = documentRef?.defaultView || globalThis.window } = {}) {
  if (!container || !viewer?.earthTime || !documentRef) throw new TypeError('Timeline needs a container and astronomical clock');
  const node = (tag, className, value) => { const item = documentRef.createElement(tag); if (className) item.className = className; if (value !== undefined) item.textContent = value; return item; };
  const existingDock = container.parentElement?.className?.split(/\s+/).includes('earth-time-dock');
  const dock = existingDock ? container.parentElement : node('div', 'earth-time-dock');
  if (!existingDock) { container.replaceWith?.(dock); dock.append(container); }
  const summary = node('summary', 'timeline-summary'); summary.setAttribute('aria-label', 'Calendar and historical coverage'); summary.setAttribute('aria-controls', 'timeline-calendar');
  summary.append(node('span', 'timeline-chevron', '⌃'));
  const icon = node('span', 'timeline-clock-icon', '◷'); icon.setAttribute('aria-hidden', 'true');
  const mode = node('span', 'timeline-mode', 'Live'), clock = node('time', 'timeline-clock');
  const timeLabels = node('div', 'timeline-time-labels'), scopeCaption = node('span', 'timeline-current-scope', 'USGS · M4.5+ · 7d'); scopeCaption.hidden = true;
  scopeCaption.setAttribute('aria-describedby', 'timeline-history-scope-description'); timeLabels.append(clock, scopeCaption);
  const readout = node('div', 'timeline-readout'); readout.setAttribute('role', 'group'); readout.setAttribute('aria-label', 'Scene UTC time'); readout.append(icon, mode, timeLabels);
  const transport = node('span', 'timeline-transport'); transport.setAttribute('role', 'group'); transport.setAttribute('aria-label', 'World time controls');
  const play = node('button', 'icon-button timeline-play', '▶'); play.type = 'button'; play.id = 'timeline-play';
  const live = node('button', 'timeline-live', 'Live'); live.type = 'button'; live.setAttribute('aria-label', 'Return to current UTC and live layers');
  const rate = node('select', 'timeline-rate'); rate.id = 'timeline-rate'; rate.setAttribute('aria-label', 'History playback speed'); rate.title = 'Elapsed world time per second';
  for (const [value, label] of [[1, '1 s / s'], [60, '1 min / s'], [3600, '1 h / s'], [86400, '1 day / s']]) { const option = node('option', '', label); option.value = String(value); rate.append(option); }
  transport.append(play, rate, live);
  const body = node('div', 'timeline-body'); body.id = 'timeline-calendar';
  const controls = node('div', 'timeline-controls');
  const back = node('button', 'icon-button', '‹'); back.type = 'button'; back.setAttribute('aria-label', 'Step backward in historical time');
  const forward = node('button', 'icon-button', '›'); forward.type = 'button'; forward.setAttribute('aria-label', 'Step forward in historical time');
  const date = node('input', 'timeline-date'); date.id = 'timeline-date'; date.type = 'datetime-local'; date.step = '1'; date.setAttribute('aria-label', 'Historical date and time in UTC'); date.title = 'UTC';
  const sunlight = node('button', 'timeline-sunlight', '☀'); sunlight.type = 'button'; sunlight.setAttribute('aria-label', 'Show or hide calculated UTC day and night'); sunlight.setAttribute('aria-pressed', 'true');
  const reload = node('button', 'icon-button', '↻'); reload.type = 'button'; reload.setAttribute('aria-label', 'Refresh historical coverage and source revisions');
  controls.append(back, date, forward, sunlight, reload);
  const lensBar = node('div', 'timeline-lens-bar'), lensLabel = node('label', '', 'Evidence'); lensLabel.htmlFor = 'timeline-lens';
  const lens = node('select', 'timeline-lens'); lens.id = 'timeline-lens'; lens.setAttribute('aria-label', 'Historical evidence mode');
  for (const [value, label] of [['reconstruction', 'Reconstruction'], ['known-then', 'Known then']]) { const option = node('option', '', label); option.value = value; lens.append(option); }
  lens.value = 'reconstruction';
  lensBar.append(lensLabel, lens, node('span', 'timeline-scope', 'USGS earthquakes · M4.5+ · preceding 7 days'));
  const slider = node('input', 'timeline-range'); slider.type = 'range'; slider.min = '0'; slider.max = '0'; slider.step = '1'; slider.value = '0'; slider.disabled = true; slider.setAttribute('aria-label', 'Choose historical UTC time');
  const coverageBand = node('div', 'timeline-coverage-band'); coverageBand.setAttribute('role', 'img');
  const ruler = node('div', 'timeline-ruler'), firstLabel = node('time'), lastLabel = node('time'); ruler.append(firstLabel, node('span', '', 'UTC'), lastLabel);
  const status = node('p', 'timeline-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const coverage = node('p', 'timeline-coverage');
  const note = node('p', 'timeline-note'); note.id = 'timeline-history-scope-description';
  const explanation = node('details', 'timeline-method'); explanation.append(node('summary', '', 'History scope'), note);
  const reportDisclosure = node('details', 'timeline-reports'), reportSummary = node('summary', '', 'Source reports');
  reportDisclosure.append(reportSummary);
  const records = node('div', 'timeline-records'); records.setAttribute('aria-label', 'Reported historical earthquakes');
  reportDisclosure.append(records);
  body.append(controls, lensBar, slider, coverageBand, ruler, status, coverage, explanation, reportDisclosure); container.replaceChildren(summary, body); dock.replaceChildren(readout, transport, container);
  let destroyed = false, controller, dragging = false, selecting = false, playIntent = false, seekOwner = 0, renderedCards = '', coverageSignature = '', renderedMarkers = '';
  const fallbackClock = typeof viewer.earthTime.subscribeClock === 'function' ? null : createSceneClock({ documentRef, now, monotonicNow, setTimeoutImpl, clearTimeoutImpl });
  const sceneTime = fallbackClock || viewer.earthTime;
  if (fallbackClock && viewer.earthTime.getState().mode === 'history') fallbackClock.seek(viewer.earthTime.getState().at);
  const setTime = (at) => { viewer.earthTime.setTime(at); fallbackClock?.setTime(at); };
  const markers = new Map(), markerColor = Cesium.Color.fromCssColorString('#9ddcc9'), markerOutline = Cesium.Color.fromCssColorString('#17212c');
  function clearMarkers() {
    renderedMarkers = '';
    if (!markers.size) return;
    for (const { entity } of markers.values()) { if (viewer.selectedEntity === entity) viewer.selectedEntity = undefined; viewer.entities?.remove(entity); }
    markers.clear(); viewer.scene.requestRender();
  }
  function showMarkers(scene) {
    if (!scene) { clearMarkers(); return; }
    if (scene._markersKey && renderedMarkers === scene._markersKey) return;
    renderedMarkers = scene._markersKey || '';
    const wanted = new Map(members(scene).map((item) => [item.id, item])); let changed = false;
    viewer.entities?.suspendEvents?.();
    try {
      for (const [id, entry] of markers) {
        const next = wanted.get(id), revision = next?.revision || next?.evidence?.revision;
        if (!next || revision !== entry.revision) { if (viewer.selectedEntity === entry.entity) viewer.selectedEntity = undefined; viewer.entities.remove(entry.entity); markers.delete(id); changed = true; }
      }
      for (const [id, item] of wanted) {
        const existing = markers.get(id);
        if (existing) {
          // Serving editions can change without changing this source revision.
          // Keep the feature and facts stable, but use the new detail-read edition.
          if (existing.context.version !== scene.version) {
            existing.context = { ...existing.context, version: scene.version };
            const property = existing.entity.properties._worldScene;
            if (typeof property?.setValue === 'function') property.setValue(existing.context);
            else existing.entity.properties._worldScene = existing.context;
          }
          continue;
        }
        const recordId = sourceId(item), observedAt = origin(item), revision = item.revision || item.evidence.revision;
        const context = { schemaVersion: 1, scopeId: scene.scope.id, mode: scene.mode, knownMode: scene.knownMode, window: scene.window, version: scene.version,
          revision, sourceRecordId: recordId, eventId: id };
        const entity = viewer.entities.add({ id: `history:${id}`, name: item.title || `Magnitude ${magnitude(item)} earthquake`,
          position: Cesium.Cartesian3.fromDegrees(longitude(item), latitude(item), 0),
          point: { pixelSize: 7, color: markerColor, outlineColor: markerOutline, outlineWidth: 1.5 },
          properties: { source: 'USGS', observedAt, url: item.url || item.source.url, usgsId: recordId.slice(5), mag: magnitude(item), time: Date.parse(observedAt),
            _worldScene: context, ...(item.eventTime ? { _worldEvent: item } : {}) } });
        markers.set(id, { entity, revision, context }); changed = true;
      }
    } finally { viewer.entities?.resumeEvents?.(); }
    if (changed) viewer.scene.requestRender();
  }
  function retainPausedScene(at) {
    // The last presentation frame and one-second UI tick can both precede the
    // exact pause instant. Publish one admissible retained scene before close()
    // emits its selection again. This path cannot request source or scene data.
    if (controller.advance(at)) return;
    const selected = controller.getState();
    if (selected.selection && selected.selection.at !== at) {
      controller.prepare(at, selected.lens); clearMarkers();
    }
    // A pending request with no retained scene remains pending while expanded;
    // its guarded completion may populate the same frozen UTC without resuming.
  }
  function syncClock() {
    if (destroyed || documentRef.hidden) return;
    const state = sceneTime.getState(), selected = controller?.getState();
    clock.dateTime = state.at; clock.textContent = utc(state.at); mode.textContent = state.mode === 'live' ? 'Live' : state.playing ? 'Playing' : 'History';
    scopeCaption.hidden = state.mode !== 'history';
    const scopeDescription = `Historical USGS earthquakes, magnitude 4.5 or greater, in the preceding seven days. ${selected?.lens === 'known-then' ?
      'Only evidence published by this platform by the selected UTC.' : 'Reconstruction using retained source corrections.'}`;
    scopeCaption.title = scopeDescription; scopeCaption.setAttribute('aria-label', scopeDescription);
    readout.setAttribute('aria-label', state.mode === 'history' ? `Scene UTC time. ${scopeDescription}` : 'Scene UTC time');
    container.dataset.mode = dock.dataset.mode = state.mode; container.dataset.playing = dock.dataset.playing = String(Boolean(state.playing));
    summary.setAttribute('aria-expanded', String(Boolean(container.open))); summary.title = container.open ? 'Hide calendar and historical coverage' : 'Show calendar and historical coverage';
    const running = state.playing || selecting && playIntent; play.textContent = running ? 'Ⅱ' : '▶';
    const playLabel = running ? 'Pause historical playback' : 'Play historical world time'; play.setAttribute('aria-label', playLabel); play.title = playLabel; play.setAttribute('aria-pressed', String(Boolean(state.playing)));
    rate.value = String(state.rate || 3600); live.setAttribute('aria-pressed', String(state.mode === 'live'));
    const available = selected?.metadata?.coverage.availableRange;
    play.disabled = typeof sceneTime.play !== 'function' || Boolean(selected?.metadata && (!available || available.from === available.to));
    if (available && !dragging) {
      const at = state.mode === 'history' ? state.at : available.to;
      slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), Math.floor(Date.parse(at) / 1000)))); slider.setAttribute('aria-valuetext', utc(at));
      if (documentRef.activeElement !== date) date.value = at.slice(0, 19);
    }
    if (playIntent && !selecting && !state.playing && state.mode === 'history') { playIntent = false; retainPausedScene(state.at); if (!container.open) controller?.close(); }
    if (!playIntent || selecting || !state.playing || !selected?.opened) return;
    if (controller.advance(state.at)) void controller.prefetch(); else void selectTime(state.at, true);
  }
  function render(state) {
    const available = state.metadata?.coverage.availableRange;
    if (available) {
      slider.min = String(Date.parse(available.from) / 1000); slider.max = String(Date.parse(available.to) / 1000); date.min = available.from.slice(0, 19); date.max = available.to.slice(0, 19);
      firstLabel.dateTime = available.from; firstLabel.textContent = utc(available.from).slice(0, 16); lastLabel.dateTime = available.to; lastLabel.textContent = utc(available.to).slice(0, 16);
      const current = sceneTime.getState();
      if (current.mode === 'live' || current.at >= available.from && current.at <= available.to) sceneTime.setCoverage?.({ firstAt: available.from, lastAt: available.to });
    }
    slider.disabled = !available; back.disabled = forward.disabled = !available; reload.disabled = state.loading; lens.value = state.lens;
    const data = state.selection?.coverage || state.metadata?.coverage, coverageKey = JSON.stringify([available, data?.segments]);
    if (coverageKey !== coverageSignature) {
      coverageSignature = coverageKey; coverageBand.replaceChildren(); coverageBand.hidden = !available;
      if (available) {
        const start = Date.parse(available.from), span = Math.max(1, Date.parse(available.to) - start);
        for (const segment of data?.segments || []) {
          const mark = node('span', 'timeline-coverage-segment'); const left = Math.max(0, (Date.parse(segment.from) - start) / span * 100), right = Math.min(100, (Date.parse(segment.to) - start) / span * 100);
          mark.setAttribute('style', `left:${left}%;width:${Math.max(.15, right - left)}%`); coverageBand.append(mark);
        }
        coverageBand.setAttribute('aria-label', `${data?.segments?.length || 0} completed source intervals within ${utc(available.from)} to ${utc(available.to)}. Unfilled intervals have no complete retained coverage.`);
      }
    }
    coverage.textContent = available ? `Retained origin coverage: ${utc(available.from).slice(0, 16)} — ${utc(available.to).slice(0, 16)} UTC.` : state.metadata ? 'No historical catalog interval has been imported yet.' : 'Open the calendar or press Play to check historical coverage.';
    note.textContent = 'History currently covers USGS earthquakes of magnitude 4.5 or greater in the preceding seven days. ' + (state.lens === 'known-then' ?
      'Known then uses only evidence published by this platform by the selected UTC. Sunlight follows that UTC; base map imagery is not historical.' :
      'Reconstruction uses retained source corrections for events in the selected period. Sunlight follows selected UTC; base map imagery is not historical.');
    const scene = state.selection, n = members(scene).length;
    const hasWindowCoverage = scene?.coverage.segments.some((segment) => segment.from <= scene.at && Date.parse(segment.to) > Date.parse(scene.at) - 7 * 86400000);
    const message = state.loading ? 'Loading stored historical data…' : state.error || (!scene ? sceneTime.getState().mode === 'history' ? 'No stored scene is available at the selected UTC.' : 'Current UTC · live layers use their own source update times.' :
      scene.coverage.status === 'unavailable-at-cutoff' ? 'No complete archive evidence was available at this knowledge cutoff.' :
      !hasWindowCoverage ? 'This period has not been imported; no current data substitutes for it.' :
      scene.truncated ? `${n} reported earthquakes shown · bounded result is incomplete.` :
      !scene.coverage.complete ? `${n} reported earthquakes · part of this seven-day period has no complete retained coverage.` :
      n ? `${n} reported earthquakes in the preceding seven days.` : 'No qualifying earthquakes in this completed seven-day source window.');
    if (status.textContent !== message) status.textContent = message;
    reportDisclosure.hidden = !n; reportSummary.textContent = `Source reports · ${n}${n > 40 ? ' · first 40 listed' : ''}`;
    showMarkers(scene);
    const cardKey = members(scene).slice(0, 40).map((item) => `${item.id}:${item.revision || item.evidence.revision}`).join('|');
    if (cardKey !== renderedCards) {
      renderedCards = cardKey; const cards = members(scene).slice(0, 40).map((item) => {
        const card = node('article', 'timeline-card'), anchor = node('a', '', item.title || `Magnitude ${magnitude(item)} earthquake`); anchor.href = item.url || item.source.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; card.append(anchor);
        card.append(node('p', '', `USGS · occurred ${utc(origin(item))}`));
        if (typeof onNavigate === 'function') { const locate = node('button', '', 'View reported location'); locate.type = 'button'; locate.addEventListener('click', () => onNavigate({ ...item, lat: latitude(item), lon: longitude(item) })); card.append(locate); }
        return card;
      }); records.replaceChildren(...cards);
      if (n > cards.length) records.append(node('p', 'timeline-note', `Showing ${cards.length} of ${n} source reports here; all retained points in this result remain on the map.`));
    }
  }
  controller = createWorldSceneController({ fetchImpl, documentRef, windowRef, now, setTimeoutImpl, clearTimeoutImpl, onChange: render });
  async function selectTime(at, resume = false, selectedLens = lens.value) {
    const canonical = stamp(at); if (!canonical || destroyed) return false;
    const owner = ++seekOwner; playIntent = resume; selecting = true; dragging = false; sceneTime.pause?.(); clearMarkers(); controller.prepare(canonical, selectedLens);
    const currentCoverage = sceneTime.getState().coverage;
    if (currentCoverage && (canonical < currentCoverage.firstAt || canonical > currentCoverage.lastAt)) sceneTime.setCoverage?.(null);
    setTime(canonical); syncClock();
    try {
      await onTimeChange({ mode: 'history', at: canonical, lens: selectedLens, phase: 'loading' });
      if (destroyed || owner !== seekOwner) return false;
      if (!controller.getState().opened) await controller.open();
      if (destroyed || owner !== seekOwner) return false;
      const accepted = await controller.select(canonical, selectedLens);
      if (destroyed || owner !== seekOwner) return false;
      selecting = false;
      if (accepted && playIntent && controller.peek(canonical, selectedLens)) playIntent = sceneTime.play?.() === true; else playIntent = false;
      if (accepted && playIntent) void controller.prefetch();
      if (!container.open && !playIntent) controller.close(); syncClock(); return accepted;
    } finally { if (owner === seekOwner) { selecting = false; syncClock(); } }
  }
  const toggle = () => { syncClock(); if (container.open) void controller.open(); else if (!playIntent && !selecting) controller.close(); };
  const drag = () => { dragging = true; playIntent = false; sceneTime.pause?.(); slider.setAttribute('aria-valuetext', utc(new Date(Number(slider.value) * 1000).toISOString())); };
  const choose = () => { dragging = false; void selectTime(new Date(Number(slider.value) * 1000).toISOString()); };
  const step = (direction) => {
    const available = controller.getState().metadata?.coverage.availableRange; if (!available) return;
    const start = Date.parse(available.from), end = Date.parse(available.to), span = end - start;
    const distance = span <= 7200000 ? 60000 : span <= 172800000 ? 3600000 : 86400000;
    const current = sceneTime.getState().mode === 'history' ? Date.parse(sceneTime.getState().at) : end;
    void selectTime(new Date(Math.max(start, Math.min(end, current + direction * distance))).toISOString());
  };
  const previous = () => step(-1), next = () => step(1);
  const goLive = (event) => { event?.stopPropagation?.(); ++seekOwner; playIntent = false; selecting = false; dragging = false; setTime(null); controller.live(); clearMarkers(); syncClock(); void onTimeChange({ mode: 'live', at: null }); if (!container.open) controller.close(); };
  const playPause = async (event) => {
    event?.stopPropagation?.();
    if (sceneTime.getState().playing || selecting && playIntent) {
      ++seekOwner; playIntent = false; selecting = false; sceneTime.pause?.();
      const frozen = sceneTime.getState(); if (frozen.mode === 'history') retainPausedScene(frozen.at);
      syncClock(); if (!container.open) controller.close(); return;
    }
    const owner = ++seekOwner; playIntent = true; selecting = true; syncClock();
    await controller.open(); if (destroyed || owner !== seekOwner || !playIntent) return;
    const available = controller.getState().metadata?.coverage.availableRange;
    if (!available || available.from === available.to) { selecting = false; playIntent = false; syncClock(); return; }
    const state = sceneTime.getState(), at = state.mode === 'history' && state.at < available.to ? state.at : available.from;
    void selectTime(at, true);
  };
  const changeRate = (event) => { event?.stopPropagation?.(); sceneTime.setRate?.(Number(rate.value)); };
  const chooseDate = () => { const at = timelineDateUtc(date.value); if (at) void selectTime(at); };
  const changeLens = () => { if (sceneTime.getState().mode === 'history') void selectTime(sceneTime.getState().at, playIntent, lens.value); else controller.setLens(lens.value); };
  const light = () => { const enabled = !viewer.earthTime.getState().lighting; viewer.earthTime.setLighting(enabled); sunlight.setAttribute('aria-pressed', String(enabled)); };
  const refresh = async () => { await controller.refresh(); if (sceneTime.getState().mode === 'history') void selectTime(sceneTime.getState().at, playIntent, lens.value); };
  const bindings = [[container, 'toggle', toggle], [slider, 'input', drag], [slider, 'change', choose], [date, 'change', chooseDate], [back, 'click', previous], [forward, 'click', next], [play, 'click', playPause], [rate, 'change', changeRate], [live, 'click', goLive], [lens, 'change', changeLens], [sunlight, 'click', light], [reload, 'click', refresh]];
  for (const [element, name, callback] of bindings) element.addEventListener(name, callback);
  const unsubscribeClock = fallbackClock ? fallbackClock.subscribe(syncClock) : viewer.earthTime.subscribeClock(syncClock);
  // Accelerated playback filters retained origin/expiry dates locally at render
  // time. This hook cannot initiate requests, change the camera or advance UTC.
  const unsubscribeFrame = viewer.scene.preUpdate?.addEventListener(() => {
    const state = sceneTime.getState(); if (!destroyed && !documentRef.hidden && state.mode === 'history' && state.playing) showMarkers(controller.frame(state.at));
  });
  render(controller.getState()); syncClock(); if (container.open) void controller.open();
  return { getState: controller.getState, live: goLive, seek: (at) => selectTime(at), destroy() {
    if (destroyed) return; destroyed = true; ++seekOwner; sceneTime.pause?.(); controller.destroy(); clearMarkers(); unsubscribeClock?.(); unsubscribeFrame?.(); fallbackClock?.destroy();
    for (const [element, name, callback] of bindings) element.removeEventListener(name, callback);
    readout.remove?.(); transport.remove?.(); if (!existingDock) dock.replaceWith?.(container);
  } };
}
