import * as Cesium from 'cesium';
import { LAYERS } from './catalog.js';
import { cameraView, serializeViewHash } from './navigation.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fieldLabel = (key) => ({ mag: 'Magnitude', depth: 'Depth (km)', usgsId: 'USGS event', lat: 'Latitude', lon: 'Longitude', frp: 'Fire power (MW)' })[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The UI reflects owned requests, never elapsed-time guesses or simulated progress. */
export function layerActivity(entry = {}) {
  const pending = Boolean(entry.enabled && (entry.status === 'loading' || entry.refreshing));
  const firstLoad = pending && !entry.lastUpdate && !entry.refreshedAt && !(Number(entry.count) > 0);
  return { pending, firstLoad };
}

/** Render only DOM text from feed values; provider HTML never enters the page. */
export function selectionFields(entity, time) {
  const values = entity.properties?.getValue?.(time) || {};
  const result = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || key.startsWith('_') || key === 'frameUrl' || key === 'cameraId') continue;
    if (value === '') continue;
    if (typeof value === 'object' || typeof value === 'function') continue;
    let formatted = String(value);
    if ((key === 'time' || key === 'timestamp') && Number.isFinite(Number(value)) && Number(value) > 100000000000) {
      formatted = new Date(Number(value)).toLocaleString();
    }
    result.push([fieldLabel(key), formatted.slice(0, 1000)]);
  }
  const position = entity.position?.getValue?.(time);
  if (position) {
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    result.push(['Location', `${Cesium.Math.toDegrees(cartographic.latitude).toFixed(5)}, ${Cesium.Math.toDegrees(cartographic.longitude).toFixed(5)}`]);
  }
  return result.slice(0, 30);
}

export function createShell(viewer, manager) {
  const cleanup = [];
  const rows = new Map();
  const mounted = new Map();
  const creditItems = new Map();
  let noticeTimer;
  let destroyed = false;
  let pendingTiles = 0;
  let pendingLayerNames = [];
  const renderActivity = () => {
    if (destroyed) return;
    const activity = document.getElementById('load-status');
    const parts = [];
    if (pendingTiles > 0) parts.push(`Loading map · ${pendingTiles.toLocaleString()} tiles pending`);
    if (pendingLayerNames.length) parts.push(pendingLayerNames.length === 1 ? `Loading ${pendingLayerNames[0]}` : `Loading ${pendingLayerNames.length} layers`);
    activity.hidden = parts.length === 0;
    document.getElementById('load-status-text').textContent = parts.join(' · ');
    const count = document.getElementById('layer-loading-count');
    count.hidden = pendingLayerNames.length === 0;
    count.textContent = `${pendingLayerNames.length} loading`;
  };
  if (viewer.scene.globe.tileLoadProgressEvent) cleanup.push(viewer.scene.globe.tileLoadProgressEvent.addEventListener((count) => {
    pendingTiles = Math.max(0, Number(count) || 0);
    renderActivity();
  }));
  const notify = (message) => {
    if (destroyed) return;
    const container = document.getElementById('notification');
    clearTimeout(noticeTimer);
    container.textContent = message;
    container.hidden = false;
    noticeTimer = setTimeout(() => { container.hidden = true; }, 6000);
  };
  const bind = (id, handler) => {
    const node = document.getElementById(id);
    node.addEventListener('click', handler);
    cleanup.push(() => node.removeEventListener('click', handler));
  };
  const setSidebar = (open, focus = false) => {
    document.body.classList.toggle('sidebar-open', open);
    document.getElementById('open-sidebar').setAttribute('aria-expanded', String(open));
    if (focus) document.getElementById(open ? 'search' : 'open-sidebar').focus();
  };
  bind('open-sidebar', () => setSidebar(true, true));
  bind('close-sidebar', () => setSidebar(false, true));
  const escape = (event) => {
    if (event.key !== 'Escape') return;
    viewer.selectedEntity = undefined;
    setSidebar(false);
  };
  document.addEventListener('keydown', escape);
  cleanup.push(() => document.removeEventListener('keydown', escape));
  bind('clear-selection', () => { viewer.selectedEntity = undefined; });
  bind('clear-layers', async () => {
    await Promise.allSettled(LAYERS.map((layer) => manager.setEnabled(layer.id, false)));
    viewer.selectedEntity = undefined;
  });
  bind('share-view', async () => {
    const state = manager.getState();
    const ids = LAYERS.filter((layer) => state[layer.id]?.enabled).map((layer) => layer.id);
    const params = Object.fromEntries(ids.map((id) => [id, manager.getLayerParams?.(id) || {}]).filter(([, value]) => Object.keys(value).length));
    const url = new URL(location.href);
    url.hash = serializeViewHash(cameraView(viewer), ids, params);
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url.href);
      notify('View link copied. It includes the camera and enabled layers.');
    } catch {
      // Clipboard permissions vary. Expose the URL in a selectable input.
      const message = document.getElementById('notification');
      clearTimeout(noticeTimer);
      message.replaceChildren(el('span', '', 'Copy this view link: '));
      const input = el('input'); input.value = url.href; input.readOnly = true; input.setAttribute('aria-label', 'View link');
      message.append(input); message.hidden = false; input.focus(); input.select();
    }
  });

  const groups = new Map();
  document.getElementById('layers').replaceChildren();
  const sourceList = document.getElementById('source-list');
  sourceList.replaceChildren();
  for (const layer of LAYERS) {
    if (!groups.has(layer.category)) {
      const group = el('details', 'layer-group');
      group.open = true;
      group.append(el('summary', '', layer.category));
      document.getElementById('layers').append(group);
      groups.set(layer.category, group);
    }
    const row = el('div', 'layer-row');
    row.dataset.layerId = layer.id;
    const label = el('label');
    const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = layer.id;
    const text = el('span', 'layer-label');
    const name = el('span', 'layer-name', layer.name);
    const spinner = el('span', 'loading-spinner'); spinner.hidden = true; spinner.setAttribute('aria-hidden', 'true');
    name.append(spinner); text.append(name);
    const status = el('span', 'layer-status', layer.sourceLabel || layer.source);
    status.id = `layer-status-${layer.id}`;
    checkbox.setAttribute('aria-describedby', status.id);
    text.append(status); label.append(checkbox, text);
    const options = el('details', 'layer-options'); options.hidden = true;
    options.append(el('summary', '', 'Details & options'));
    const optionBody = el('div', 'layer-options-body');
    const detailStatus = el('p', 'layer-detail-status');
    const placeholder = el('div', 'layer-placeholder'); placeholder.hidden = true; placeholder.setAttribute('aria-hidden', 'true');
    placeholder.append(el('span'), el('span'));
    const controls = el('div', 'layer-controls');
    optionBody.append(detailStatus, placeholder, controls); options.append(optionBody);
    row.append(label, options); groups.get(layer.category).append(row);
    const toggle = () => {
      if (!checkbox.checked) { viewer.selectedEntity = undefined; viewer.trackedEntity = undefined; }
      manager.setEnabled(layer.id, checkbox.checked).catch((error) => notify(`${layer.name}: ${error.message || 'Could not load data.'}`));
    };
    checkbox.addEventListener('change', toggle);
    cleanup.push(() => checkbox.removeEventListener('change', toggle));
    const warm = () => { void manager.preload?.(layer.id)?.catch?.(() => {}); };
    checkbox.addEventListener('pointerenter', warm);
    checkbox.addEventListener('focus', warm);
    cleanup.push(() => { checkbox.removeEventListener('pointerenter', warm); checkbox.removeEventListener('focus', warm); });
    const optionsToggle = () => { if (options.open) update(); };
    options.addEventListener('toggle', optionsToggle);
    cleanup.push(() => options.removeEventListener('toggle', optionsToggle));
    rows.set(layer.id, { row, checkbox, status, controls, options, spinner, detailStatus, placeholder });
    const source = el('div', 'source-item');
    const heading = el('h3');
    const link = el('a', '', layer.name); link.href = layer.sourceUrl; link.target = '_blank'; link.rel = 'noreferrer';
    heading.append(link); source.append(heading, el('p', '', layer.description), el('p', '', layer.attribution)); sourceList.append(source);
  }

  const update = (state = manager.getState()) => {
    if (destroyed) return;
    pendingLayerNames = [];
    for (const layer of LAYERS) {
      const entry = state[layer.id] || {};
      const { row, checkbox, status, controls, options, spinner, detailStatus, placeholder } = rows.get(layer.id);
      const { pending, firstLoad } = layerActivity(entry);
      if (pending) pendingLayerNames.push(layer.name);
      checkbox.checked = Boolean(entry.enabled);
      row.dataset.enabled = String(Boolean(entry.enabled));
      row.dataset.status = entry.status || 'off';
      row.dataset.loading = String(pending);
      spinner.hidden = !pending;
      row.setAttribute('aria-busy', String(pending));
      const count = Number(entry.count) || 0;
      const source = layer.sourceLabel || layer.source;
      const refreshTime = entry.refreshedAt || entry.lastUpdate;
      const stamp = refreshTime ? ` · refreshed ${new Date(refreshTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
      const observedTime = entry.observedAt || entry.observedAtMs;
      const observedLabel = observedTime ? ` · observed ${new Date(observedTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
      const archived = entry.snapshot === true || (layer.id === 'local-firms' && entry.observationDate && entry.stale);
      const archiveLabel = archived ? `Archived${entry.observationDate ? ` · ${entry.observationDate}` : ''} · ` : '';
      const staleLabel = entry.stale && !archived ? 'Older feed · ' : '';
      const ageMs = entry.sourceAgeMs ?? entry.ageMs;
      const ageLabel = Number.isFinite(ageMs) && ageMs >= 60000 ? ` · data ${Math.round(ageMs / 60000)} min old` : '';
      const summary = `${archiveLabel}${staleLabel}${count.toLocaleString()} records · ${source}${archived ? '' : observedLabel + ageLabel + stamp}`;
      status.textContent = firstLoad ? `${entry.refreshing ? 'Fetching data' : 'Preparing layer'}… · ${source}` : entry.error ? String(entry.error) : !entry.enabled ? source : summary;
      detailStatus.textContent = entry.enabled && !firstLoad ? [summary, entry.error, entry.coverage].filter(Boolean).join(' · ') : status.textContent;
      status.title = [status.textContent, layer.description, entry.coverage].filter(Boolean).join(' ');
      placeholder.hidden = !firstLoad;
      checkbox.setAttribute('aria-label', layer.name);
      if (entry.enabled && !creditItems.has(layer.id)) {
        const credits = [new Cesium.Credit(layer.attribution, true)];
        if (layer.detailedAttribution) credits.push(new Cesium.Credit(layer.detailedAttribution, false));
        creditItems.set(layer.id, credits);
        for (const credit of credits) viewer.cesiumWidget.creditDisplay.addStaticCredit(credit);
      } else if (!entry.enabled && creditItems.has(layer.id)) {
        for (const credit of creditItems.get(layer.id)) viewer.cesiumWidget.creditDisplay.removeStaticCredit(credit);
        creditItems.delete(layer.id);
      }
      if (entry.enabled && options.open && manager.getLayer(layer.id) && !mounted.has(layer.id)) {
        const dispose = manager.mountControls?.(layer.id, controls);
        mounted.set(layer.id, typeof dispose === 'function' ? dispose : () => {});
      }
      if (!entry.enabled && mounted.has(layer.id)) {
        mounted.get(layer.id)(); mounted.delete(layer.id); controls.replaceChildren();
      }
      options.hidden = !entry.enabled;
    }
    renderActivity();
  };
  const select = (entity) => {
    const panel = document.getElementById('selection');
    panel.hidden = !entity;
    if (!entity) return;
    document.getElementById('selection-title').textContent = entity.name || String(entity.id || 'Selected feature');
    const fields = selectionFields(entity, viewer.clock.currentTime);
    const list = el('dl');
    for (const [label, value] of fields) list.append(el('dt', '', label), el('dd', '', value));
    const details = document.getElementById('selection-details');
    details.replaceChildren(fields.length ? list : el('p', '', 'No additional details are available for this feature.'));
    const frameUrl = entity.properties?.frameUrl?.getValue?.(viewer.clock.currentTime);
    if (typeof frameUrl === 'string' && /^\/api\/cctv\/frame\/[A-Za-z0-9_.%~-]+$/.test(frameUrl)) {
      const preview = el('div', 'camera-preview');
      const frame = el('div', 'camera-frame');
      const image = el('img'); image.alt = `Latest available traffic camera image: ${entity.name || 'selected camera'}`; image.referrerPolicy = 'no-referrer';
      const caption = el('p', 'muted', 'Still image from the source. Refresh requests its latest available frame.');
      const refresh = el('button', '', 'Refresh image'); refresh.type = 'button';
      let hasFrame = false;
      const load = () => {
        refresh.disabled = true;
        frame.dataset.loading = 'true';
        frame.setAttribute('aria-busy', 'true');
        image.hidden = !hasFrame;
        caption.textContent = 'Loading the latest available image…';
        image.src = `${frameUrl}?ts=${Date.now()}`;
      };
      image.addEventListener('load', () => { hasFrame = true; image.hidden = false; frame.dataset.loading = 'false'; frame.setAttribute('aria-busy', 'false'); refresh.disabled = false; caption.textContent = 'Still image from the source. Refresh requests its latest available frame.'; });
      image.addEventListener('error', () => { hasFrame = false; frame.dataset.loading = 'false'; frame.setAttribute('aria-busy', 'false'); refresh.disabled = false; image.hidden = true; caption.textContent = 'This camera image is currently unavailable.'; });
      refresh.addEventListener('click', load);
      frame.append(image); preview.append(frame, caption, refresh); details.prepend(preview); load();
    }
    viewer.scene.requestRender();
  };
  cleanup.push(viewer.selectedEntityChanged.addEventListener(select));
  if (manager.subscribe) cleanup.push(manager.subscribe(update));
  update();
  // These controls appear in the initial HTML; enable them once their handlers exist.
  for (const button of document.querySelectorAll('#search-form button, #navigation button, #share-view, #open-sidebar, #close-sidebar, #clear-layers')) button.disabled = false;
  return {
    notify,
    update,
    closeSidebar: () => setSidebar(false),
    destroy() {
      destroyed = true; clearTimeout(noticeTimer);
      cleanup.splice(0).reverse().forEach((dispose) => dispose?.());
      for (const dispose of mounted.values()) dispose();
      for (const credits of creditItems.values()) for (const credit of credits) viewer.cesiumWidget.creditDisplay.removeStaticCredit(credit);
      rows.clear(); mounted.clear(); creditItems.clear();
    },
  };
}
