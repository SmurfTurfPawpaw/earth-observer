import * as Cesium from 'cesium';
import { LAYERS } from './catalog.js';
import { cameraView, serializeViewHash, setCameraView, HOME_VIEW } from './navigation.js';
import { createIcon } from './icons.js';
import { readUiState, writeUiState, TEXT_SIZES, normalizeTextSize, createCreditLedger, cacheStatus, layerCreditNotices } from './ui-state.js';
import { createPlaceStore } from './places.js';
import { createSavedPlacesUi } from './places-ui.js';
import { commandCatalog, editableTarget } from './commands.js';
import { createCommandPalette } from './commands-ui.js';
import { chatGPTSignInPath } from './community-policy.js';
import { createWorldDossier } from './world-dossier.js';
import { createWorkspaceFocus } from './workspace-focus.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fieldLabel = (key) => ({ mag: 'Magnitude', depth: 'Depth (km)', usgsId: 'USGS event', lat: 'Latitude', lon: 'Longitude', frp: 'Fire power (MW)' })[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const categoryIcon = (category) => ({ Movement: 'movement', Space: 'space', Environment: 'environment', Weather: 'weather', Imagery: 'imagery', Infrastructure: 'infrastructure' })[category] || 'layers';
const onScreenAttribution = (value) => String(value).includes('<a') ? value : String(value).replace('© OpenStreetMap contributors', '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>');

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
    if (value === '' || typeof value === 'object' || typeof value === 'function') continue;
    let formatted = String(value);
    if ((key === 'time' || key === 'timestamp') && Number.isFinite(Number(value)) && Number(value) > 100000000000) formatted = new Date(Number(value)).toLocaleString();
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
  const rows = new Map(), mounted = new Map(), creditItems = new Map(), groups = new Map();
  const panelListeners = new Set();
  const panels = { selection: document.getElementById('selection'), news: document.getElementById('news-panel'), notebook: document.getElementById('notebook-panel') };
  const panelButtons = { news: document.getElementById('toggle-news'), notebook: document.getElementById('toggle-notebook') };
  let storage;
  try { storage = localStorage; } catch { /* Controls remain usable without browser storage. */ }
  const placeStore = createPlaceStore(storage);
  let commandPalette, savedPlaces, community, communityImport, workspaceFocus;
  const communitySection = document.getElementById('community-section');
  const signIn = document.getElementById('sign-in');
  const signInPath = () => chatGPTSignInPath(`${location.pathname}${location.search}${location.hash}`);
  const refreshSignIn = () => { signIn.href = signInPath(); };
  refreshSignIn(); signIn.addEventListener('click', refreshSignIn);
  cleanup.push(() => signIn.removeEventListener('click', refreshSignIn));
  const mobile = window.matchMedia('(max-width: 760px)');
  // Keep the desktop preference intact when a narrow screen temporarily closes it.
  const uiState = readUiState(storage);
  const ledger = createCreditLedger(viewer.cesiumWidget.creditDisplay, (html, onScreen) => new Cesium.Credit(html, onScreen));
  let noticeTimer, activePanel = null, workspace = 'data', destroyed = false, pendingTiles = 0, pendingLayerNames = [];
  const remember = () => writeUiState(storage, uiState);
  const textSizeControl = el('label', 'text-size-control');
  const textSizeMark = el('span', '', 'Aa'); textSizeMark.setAttribute('aria-hidden', 'true');
  const textSize = el('select'); textSize.id = 'text-size'; textSize.title = 'Panel and credit text size';
  textSizeControl.append(textSizeMark, el('span', 'sr-only', 'Panel and credit text size'), textSize);
  for (const choice of TEXT_SIZES) { const option = el('option', '', choice[0].toUpperCase() + choice.slice(1)); option.value = choice; textSize.append(option); }
  textSize.value = uiState.textSize; document.documentElement.dataset.textSize = uiState.textSize;
  const changeTextSize = () => {
    uiState.textSize = normalizeTextSize(textSize.value); textSize.value = uiState.textSize;
    document.documentElement.dataset.textSize = uiState.textSize; remember();
  };
  textSize.addEventListener('change', changeTextSize);
  document.getElementById('header-tools').append(textSizeControl);
  cleanup.push(() => { textSize.removeEventListener('change', changeTextSize); textSizeControl.remove(); });
  const bind = (id, handler) => {
    const node = document.getElementById(id);
    node.addEventListener('click', handler);
    cleanup.push(() => node.removeEventListener('click', handler));
  };
  const setSidebar = (open, { focus = false, persist = true } = {}) => {
    if (open) workspaceFocus?.focusWorkspace();
    if (open && activePanel) openPanel(null);
    document.body.classList.toggle('sidebar-open', open);
    document.getElementById('open-sidebar').setAttribute('aria-expanded', String(open && workspace === 'data'));
    document.getElementById('open-saved-places').setAttribute('aria-expanded', String(open && workspace === 'saved'));
    const sidebar = document.getElementById('sidebar');
    sidebar.inert = !open;
    sidebar.setAttribute('aria-hidden', String(!open));
    if (persist && !mobile.matches) { uiState.sidebarOpen = open; remember(); }
    if (focus) document.getElementById(open ? 'close-sidebar' : workspace === 'saved' ? 'open-saved-places' : 'open-sidebar').focus();
  };
  const setWorkspace = (name) => {
    workspace = name === 'saved' ? 'saved' : 'data';
    document.getElementById('sidebar').dataset.workspace = workspace;
    document.getElementById('layers-heading').textContent = workspace === 'saved' ? 'Saved places' : 'Data layers';
    document.getElementById('layer-active-count').hidden = workspace === 'saved';
    document.querySelector('#sidebar .panel-heading > .ui-icon')?.replaceWith(createIcon(workspace === 'saved' ? 'bookmark' : 'layers'));
  };
  const setNavbar = (open, { focus = false } = {}) => {
    document.getElementById('header-tools').hidden = !open;
    document.getElementById('toggle-navbar').setAttribute('aria-expanded', String(open));
    uiState.navbarOpen = open; remember();
    if (focus) document.getElementById(open ? 'toggle-basemap' : 'toggle-navbar').focus();
  };
  const emitPanel = (panel, open) => {
    if (panel === 'notebook') { if (open && communitySection.open) void openCommunity(); else community?.close(); }
    const detail = { panel, open };
    document.dispatchEvent(new CustomEvent('earth-observer:panel', { detail }));
    window.dispatchEvent(new CustomEvent('earth-observer:panel-change', { detail }));
    for (const listener of panelListeners) listener(detail);
  };
  const openCommunity = async () => {
    if (destroyed || activePanel !== 'notebook' || !communitySection.open) return;
    try {
      if (!community) {
        communityImport ||= import('./community.js');
        const { createCommunityPanel } = await communityImport;
        if (destroyed) return;
        community ||= createCommunityPanel({
          container: document.getElementById('community-content'),
          getLocation: () => { const view = cameraView(viewer); return { lat: view.lat, lon: view.lon }; },
          onNavigate: ({ lat, lon }) => { const view = cameraView(viewer); setCameraView(viewer, { ...view, lat, lon, alt: Math.min(view.alt, 25000), pitch: -90 }, true); },
          onSession: ({ signedIn }) => { signIn.hidden = signedIn; },
        });
      }
      if (activePanel === 'notebook' && communitySection.open) community.open();
    } catch { if (!destroyed) document.getElementById('community-content').textContent = 'Community contributions could not load. Close and reopen this section to retry.'; communityImport = null; }
  };
  const communityToggle = () => { if (communitySection.open) void openCommunity(); else community?.close(); };
  communitySection.addEventListener('toggle', communityToggle);
  cleanup.push(() => { communitySection.removeEventListener('toggle', communityToggle); community?.destroy(); });
  const openPanel = (name, { focus = false } = {}) => {
    if (name === activePanel) return;
    const previous = activePanel;
    activePanel = name;
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== name;
      panelButtons[key]?.setAttribute('aria-expanded', String(key === name));
    }
    document.body.classList.toggle('side-panel-open', Boolean(name));
    if (name) setSidebar(false, { persist: false });
    if (previous) emitPanel(previous, false);
    if (name) emitPanel(name, true);
    if (focus && name) panels[name].querySelector('button')?.focus();
  };
  const closePanel = (name, { restoreSelection = true, focus = false } = {}) => {
    if (activePanel !== name) return;
    if (restoreSelection && name !== 'selection' && viewer.selectedEntity) openPanel('selection');
    else openPanel(null);
    if (focus) panelButtons[name]?.focus();
  };
  bind('open-sidebar', () => {
    const open = !document.body.classList.contains('sidebar-open') || workspace !== 'data';
    setWorkspace('data');
    setSidebar(open, { focus: true });
  });
  bind('open-saved-places', () => {
    if (document.body.classList.contains('sidebar-open') && workspace === 'saved') setSidebar(false, { focus: true });
    else openSavedPlaces({ draft: false });
  });
  bind('home', () => { openPanel(null); setSidebar(false); });
  bind('close-sidebar', () => setSidebar(false, { focus: true }));
  bind('toggle-navbar', () => setNavbar(!uiState.navbarOpen));
  bind('toggle-news', () => activePanel === 'news' ? closePanel('news', { focus: true }) : openPanel('news', { focus: true }));
  bind('close-news', () => closePanel('news', { focus: true }));
  bind('toggle-notebook', () => activePanel === 'notebook' ? closePanel('notebook', { focus: true }) : openPanel('notebook', { focus: true }));
  bind('close-notebook', () => closePanel('notebook', { focus: true }));
  bind('clear-selection', () => { viewer.selectedEntity = undefined; closePanel('selection', { restoreSelection: false }); });
  const escape = (event) => {
    if (event.key !== 'Escape') return;
    if (document.getElementById('command-palette').open) return;
    if (activePanel === 'selection') { viewer.selectedEntity = undefined; closePanel('selection', { restoreSelection: false }); }
    else if (activePanel) closePanel(activePanel, { focus: true });
    else if (uiState.navbarOpen) setNavbar(false, { focus: true });
    else if (document.body.classList.contains('sidebar-open')) setSidebar(false, { focus: true });
    else if (event.target === document.getElementById('search')) { event.target.blur(); document.getElementById('search-status').textContent = ''; }
  };
  document.addEventListener('keydown', escape);
  cleanup.push(() => document.removeEventListener('keydown', escape));
  const searchShortcut = (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || editableTarget(event.target) || document.getElementById('command-palette').open) return;
    event.preventDefault(); document.getElementById('search').focus();
  };
  document.addEventListener('keydown', searchShortcut);
  cleanup.push(() => document.removeEventListener('keydown', searchShortcut));
  const onMobileChange = () => setSidebar(mobile.matches ? false : uiState.sidebarOpen, { persist: false });
  mobile.addEventListener('change', onMobileChange);
  cleanup.push(() => mobile.removeEventListener('change', onMobileChange));
  setSidebar(mobile.matches ? false : uiState.sidebarOpen, { persist: false });
  setNavbar(uiState.navbarOpen);
  workspaceFocus = createWorkspaceFocus({ calendar: document.getElementById('earth-timeline'),
    subscribePanels(listener) { panelListeners.add(listener); return () => panelListeners.delete(listener); },
    closeExpandedWorkspace() { openPanel(null); setSidebar(false, { persist: false }); },
  });
  cleanup.push(() => workspaceFocus.destroy());
  const placeSearch = document.getElementById('search');
  placeSearch.placeholder = 'Supported places or coordinates';
  placeSearch.title = 'Choose a supported place from the suggestions, or enter latitude, longitude.';
  const placeSearchLabel = document.querySelector('label[for="search"]');
  if (placeSearchLabel) placeSearchLabel.textContent = 'Find supported places or coordinates';
  document.body.classList.add('ui-ready');

  // Credits may wrap as layers are enabled. Panels always leave that legal footer visible.
  const syncCreditHeight = () => document.getElementById('app').style.setProperty('--credit-height', `${Math.ceil(document.getElementById('credits').getBoundingClientRect().height)}px`);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(syncCreditHeight);
    observer.observe(document.getElementById('credits'));
    cleanup.push(() => observer.disconnect());
  }
  syncCreditHeight();

  const renderActivity = () => {
    if (destroyed) return;
    const parts = [];
    if (pendingTiles > 0) parts.push(`Map · ${pendingTiles.toLocaleString()} tiles pending`);
    if (pendingLayerNames.length) parts.push(pendingLayerNames.length === 1 ? `Loading ${pendingLayerNames[0]}` : `Loading ${pendingLayerNames.length} layers`);
    document.getElementById('load-status').hidden = parts.length === 0;
    document.getElementById('load-status-text').textContent = parts.join(' · ');
    const count = document.getElementById('layer-loading-count');
    count.hidden = pendingLayerNames.length === 0;
    count.textContent = `${pendingLayerNames.length} loading`;
  };
  if (viewer.scene.globe.tileLoadProgressEvent) cleanup.push(viewer.scene.globe.tileLoadProgressEvent.addEventListener((count) => { pendingTiles = Math.max(0, Number(count) || 0); renderActivity(); }));
  const notify = (message) => {
    if (destroyed) return;
    const container = document.getElementById('notification');
    clearTimeout(noticeTimer); container.textContent = message; container.hidden = false;
    noticeTimer = setTimeout(() => { container.hidden = true; }, 6000);
  };
  const setLayerEnabled = (id, enabled) => {
    if (!LAYERS.some((layer) => layer.id === id)) throw new Error('This layer is unavailable.');
    if (!enabled) { viewer.selectedEntity = undefined; viewer.trackedEntity = undefined; }
    return manager.setEnabled(id, enabled);
  };
  const clearLayers = async () => {
    await Promise.allSettled(LAYERS.map((layer) => manager.setEnabled(layer.id, false)));
    viewer.selectedEntity = undefined;
  };
  bind('clear-layers', clearLayers);
  const shareView = async () => {
    const state = manager.getState();
    const ids = LAYERS.filter((layer) => state[layer.id]?.enabled).map((layer) => layer.id);
    const params = Object.fromEntries(ids.map((id) => [id, manager.getLayerParams?.(id) || {}]).filter(([, value]) => Object.keys(value).length));
    const url = new URL(location.href);
    url.hash = serializeViewHash(cameraView(viewer), ids, params);
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url.href); notify('View link copied with its camera and enabled layers.'); }
    catch {
      const message = document.getElementById('notification');
      clearTimeout(noticeTimer); message.replaceChildren(el('span', '', 'Copy this view link: '));
      const input = el('input'); input.value = url.href; input.readOnly = true; input.setAttribute('aria-label', 'View link');
      message.append(input); message.hidden = false; input.focus(); input.select();
    }
  };
  bind('share-view', shareView);

  document.getElementById('layers').replaceChildren();
  const sourceList = document.getElementById('source-list'); sourceList.replaceChildren();
  for (const layer of LAYERS) {
    if (!groups.has(layer.category)) {
      const group = el('details', 'layer-group');
      group.open = uiState.openCategories ? uiState.openCategories.includes(layer.category) : groups.size === 0;
      const summary = el('summary');
      const count = el('span', 'group-count');
      const chevron = createIcon('chevronRight'); chevron.classList.add('summary-chevron');
      summary.append(createIcon(categoryIcon(layer.category)), el('span', '', layer.category), count, chevron);
      group.append(summary); document.getElementById('layers').append(group);
      groups.set(layer.category, { group, count });
      const toggle = () => {
        uiState.openCategories = [...groups].filter(([, value]) => value.group.open).map(([category]) => category);
        remember();
      };
      group.addEventListener('toggle', toggle); cleanup.push(() => group.removeEventListener('toggle', toggle));
    }
    const row = el('div', 'layer-row'); row.dataset.layerId = layer.id;
    const label = el('label');
    const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = layer.id; checkbox.setAttribute('aria-label', layer.name);
    const text = el('span', 'layer-label');
    const name = el('span', 'layer-name', layer.name);
    const spinner = el('span', 'loading-spinner'); spinner.hidden = true; spinner.setAttribute('aria-hidden', 'true'); name.append(spinner);
    const status = el('span', 'layer-status'); status.id = `layer-status-${layer.id}`; checkbox.setAttribute('aria-describedby', status.id);
    text.append(name, status); label.append(checkbox, text);
    const options = el('details', 'layer-options'); options.hidden = true; options.append(el('summary', '', 'Details & options'));
    const optionBody = el('div', 'layer-options-body'), detailStatus = el('p', 'layer-detail-status');
    const placeholder = el('div', 'layer-placeholder'); placeholder.hidden = true; placeholder.setAttribute('aria-hidden', 'true'); placeholder.append(el('span'), el('span'));
    const controls = el('div', 'layer-controls');
    optionBody.append(detailStatus, placeholder, controls); options.append(optionBody);
    row.append(label, options); groups.get(layer.category).group.append(row);
    const toggle = () => {
      setLayerEnabled(layer.id, checkbox.checked).catch((error) => notify(`${layer.name}: ${error.message || 'Could not load data.'}`));
    };
    checkbox.addEventListener('change', toggle); cleanup.push(() => checkbox.removeEventListener('change', toggle));
    const warm = () => { void manager.preload?.(layer.id)?.catch?.(() => {}); };
    label.addEventListener('pointerenter', warm); checkbox.addEventListener('focus', warm);
    cleanup.push(() => { label.removeEventListener('pointerenter', warm); checkbox.removeEventListener('focus', warm); });
    const optionsToggle = () => { if (options.open) update(); };
    options.addEventListener('toggle', optionsToggle); cleanup.push(() => options.removeEventListener('toggle', optionsToggle));
    rows.set(layer.id, { row, checkbox, status, controls, options, spinner, detailStatus, placeholder });
    const source = el('div', 'source-item'), heading = el('h3');
    const link = el('a', '', layer.name); link.href = layer.sourceUrl === '/DATA_POLICY.md' ? `${import.meta.env?.BASE_URL || '/'}DATA_POLICY.md` : layer.sourceUrl; link.target = '_blank'; link.rel = 'noreferrer';
    heading.append(link); source.append(heading, el('p', '', layer.description), el('p', '', layer.attribution)); sourceList.append(source);
  }

  const update = (state = manager.getState()) => {
    if (destroyed) return;
    pendingLayerNames = [];
    let enabledCount = 0;
    for (const layer of LAYERS) {
      const entry = state[layer.id] || {};
      const { row, checkbox, status, controls, options, spinner, detailStatus, placeholder } = rows.get(layer.id);
      const { pending, firstLoad } = layerActivity(entry);
      if (pending) pendingLayerNames.push(layer.name);
      if (entry.enabled) enabledCount += 1;
      checkbox.checked = Boolean(entry.enabled); row.dataset.enabled = String(Boolean(entry.enabled)); row.dataset.status = entry.status || 'off'; row.dataset.loading = String(pending);
      spinner.hidden = !pending; row.setAttribute('aria-busy', String(pending));
      const count = Number(entry.count) || 0, source = layer.sourceLabel || layer.source;
      const cached = cacheStatus(entry);
      const refreshTime = entry.refreshedAt || entry.lastUpdate;
      const refreshLabel = refreshTime && !cached.label ? `Retrieved ${new Date(refreshTime).toLocaleString()}` : '';
      const observedTime = entry.observedAt || entry.observedAtMs;
      const observedLabel = observedTime ? `Observed ${new Date(observedTime).toLocaleString()}` : '';
      const archived = entry.snapshot === true || (layer.id === 'local-firms' && entry.observationDate && entry.stale);
      const freshness = archived ? `Archived${entry.observationDate ? ` · ${entry.observationDate}` : ''}` : entry.stale ? 'Older feed' : '';
      const ageMs = entry.sourceAgeMs ?? entry.ageMs;
      const ageLabel = Number.isFinite(ageMs) && ageMs >= 60000 ? `Data ${Math.round(ageMs / 60000)} min old` : '';
      const compact = [cached.label, freshness, `${count.toLocaleString()} records`, source].filter(Boolean).join(' · ');
      const summary = [compact, archived ? '' : observedLabel, archived ? '' : ageLabel, refreshLabel, cached.detail, entry.error, entry.coverage].filter(Boolean).join(' · ');
      status.textContent = firstLoad ? `${entry.refreshing ? 'Fetching data' : 'Preparing layer'}…` : entry.error ? 'Source unavailable · details below' : entry.enabled ? compact : source;
      detailStatus.textContent = firstLoad ? [status.textContent, source, layer.description].join(' · ') : entry.enabled || entry.error ? [summary, layer.description].filter(Boolean).join(' · ') : source;
      status.title = detailStatus.textContent; placeholder.hidden = !firstLoad;
      if (entry.enabled && !creditItems.has(layer.id)) {
        const credits = layerCreditNotices(layer).map(({ html, onScreen }) => ledger.retain(onScreen ? onScreenAttribution(html) : html, onScreen));
        creditItems.set(layer.id, credits);
      } else if (!entry.enabled && creditItems.has(layer.id)) {
        for (const credit of creditItems.get(layer.id)) ledger.release(credit);
        creditItems.delete(layer.id);
      }
      if (entry.enabled && options.open && manager.getLayer(layer.id) && !mounted.has(layer.id)) {
        const dispose = manager.mountControls?.(layer.id, controls); mounted.set(layer.id, typeof dispose === 'function' ? dispose : () => {});
      }
      if (!entry.enabled && mounted.has(layer.id)) { mounted.get(layer.id)(); mounted.delete(layer.id); controls.replaceChildren(); }
      options.hidden = !entry.enabled && !entry.error;
    }
    const activeCount = document.getElementById('layer-active-count'); activeCount.textContent = enabledCount; activeCount.title = `${enabledCount} active layers`;
    document.getElementById('clear-layers').disabled = enabledCount === 0;
    for (const [category, { count }] of groups) {
      const categoryLayers = LAYERS.filter((layer) => layer.category === category);
      const active = categoryLayers.filter((layer) => state[layer.id]?.enabled).length;
      count.textContent = active ? `${active} / ${categoryLayers.length}` : String(categoryLayers.length);
      count.title = `${active} active of ${categoryLayers.length} layers`;
    }
    renderActivity();
    commandPalette?.refresh();
  };
  let stopSelectionDetails = () => {};
  const select = (entity) => {
    stopSelectionDetails();
    if (!entity) { closePanel('selection', { restoreSelection: false }); return; }
    const detailFields = el('div', 'selection-fields');
    const details = document.getElementById('selection-details'); details.replaceChildren(detailFields);
    const repaint = () => {
      document.getElementById('selection-title').textContent = entity.name || String(entity.id || 'Selected feature');
      const dossier = createWorldDossier(entity, viewer.clock.currentTime);
      if (dossier) { detailFields.replaceChildren(dossier); return; }
      const fields = selectionFields(entity, viewer.clock.currentTime), list = el('dl');
      for (const [label, value] of fields) list.append(el('dt', '', label), el('dd', '', value));
      detailFields.replaceChildren(fields.length ? list : el('p', '', 'No additional details are available for this feature.'));
    };
    repaint();
    let detailTimer, lastDetailPaint = Date.now(), stopProperties = () => {};
    const queueDetails = () => {
      if (destroyed || document.hidden || activePanel !== 'selection' || detailTimer !== undefined) return;
      detailTimer = setTimeout(() => {
        detailTimer = undefined;
        if (!destroyed && !document.hidden && activePanel === 'selection' && viewer.selectedEntity === entity) {
          repaint(); lastDetailPaint = Date.now();
          // Age and model details also advance while the map itself is idle.
          if (entity.properties?.isConstant === false) queueDetails();
        }
      }, Math.max(0, 1000 - (Date.now() - lastDetailPaint)));
    };
    const bindProperties = () => {
      stopProperties();
      stopProperties = entity.properties?.definitionChanged?.addEventListener(queueDetails) || (() => {});
    };
    bindProperties();
    const stopEntity = entity.definitionChanged?.addEventListener((_entity, property) => {
      if (property === 'properties') { bindProperties(); queueDetails(); }
      else if (property === 'name' || property === 'position') queueDetails();
    });
    const showDetails = ({ panel, open }) => { if (panel === 'selection' && open) queueDetails(); };
    panelListeners.add(showDetails);
    document.addEventListener('visibilitychange', queueDetails);
    stopSelectionDetails = () => {
      clearTimeout(detailTimer); stopProperties(); stopEntity?.();
      panelListeners.delete(showDetails); document.removeEventListener('visibilitychange', queueDetails);
    };
    const frameUrl = entity.properties?.frameUrl?.getValue?.(viewer.clock.currentTime);
    if (typeof frameUrl === 'string' && /^\/api\/cctv\/frame\/[A-Za-z0-9_.%~-]+$/.test(frameUrl)) {
      const preview = el('div', 'camera-preview'), frame = el('div', 'camera-frame'), image = el('img');
      image.alt = `Latest available traffic camera image: ${entity.name || 'selected camera'}`; image.referrerPolicy = 'no-referrer';
      const caption = el('p', 'muted', 'Still image from the source. Refresh requests its latest available frame.');
      const refresh = el('button', '', 'Refresh image'); refresh.type = 'button';
      let hasFrame = false;
      const load = () => {
        refresh.disabled = true; frame.dataset.loading = 'true'; frame.setAttribute('aria-busy', 'true'); image.hidden = !hasFrame;
        caption.textContent = 'Loading the latest available image…'; image.src = `${frameUrl}?ts=${Date.now()}`;
      };
      image.addEventListener('load', () => { hasFrame = true; image.hidden = false; frame.dataset.loading = 'false'; frame.setAttribute('aria-busy', 'false'); refresh.disabled = false; caption.textContent = 'Still image from the source. Refresh requests its latest available frame.'; });
      image.addEventListener('error', () => { hasFrame = false; frame.dataset.loading = 'false'; frame.setAttribute('aria-busy', 'false'); refresh.disabled = false; image.hidden = true; caption.textContent = 'This camera image is currently unavailable.'; });
      refresh.addEventListener('click', load); frame.append(image); preview.append(frame, caption, refresh); details.prepend(preview); load();
    }
    openPanel('selection'); viewer.scene.requestRender();
  };
  cleanup.push(viewer.selectedEntityChanged.addEventListener(select));
  cleanup.push(() => stopSelectionDetails());
  if (manager.subscribe) cleanup.push(manager.subscribe(update));
  update();
  const currentPlaceView = () => {
    const view = cameraView(viewer);
    if (view.roll > 180 && view.roll <= 360) view.roll -= 360;
    return view;
  };
  const goToSavedPlace = (id) => {
    const place = placeStore.get(id);
    if (!place) throw new Error('This saved place no longer exists.');
    setCameraView(viewer, place.view, true);
    if (mobile.matches) setSidebar(false);
  };
  const openSavedPlaces = ({ draft = true } = {}) => { setWorkspace('saved'); setSidebar(true); savedPlaces.open({ draft }); if (!draft) document.getElementById('saved-place-name').focus(); };
  savedPlaces = createSavedPlacesUi({ store: placeStore, getView: currentPlaceView, onRecall: goToSavedPlace, onChange: () => commandPalette?.refresh() });
  cleanup.push(() => savedPlaces.destroy());
  commandPalette = createCommandPalette({
    dialog: document.getElementById('command-palette'), input: document.getElementById('command-search'), list: document.getElementById('command-list'), count: document.getElementById('command-count'), closeButton: document.getElementById('close-command'),
    getCatalog: () => commandCatalog({ layers: LAYERS, places: placeStore.list(), state: manager.getState() }), onError: notify,
    async execute(action) {
      switch (action.type) {
        case 'show-layers': setWorkspace('data'); setSidebar(true, { focus: true }); break;
        case 'home': setCameraView(viewer, HOME_VIEW, true); break;
        case 'news': openPanel('news', { focus: true }); break;
        case 'notebook': openPanel('notebook', { focus: true }); break;
        case 'share': await shareView(); break;
        case 'save-place': openSavedPlaces(); break;
        case 'clear-layers': await clearLayers(); break;
        case 'place': goToSavedPlace(action.id); break;
        case 'toggle-layer': {
          const result = await setLayerEnabled(action.id, !manager.getState()[action.id]?.enabled);
          if (result === false && manager.getState()[action.id]?.error) throw new Error(manager.getState()[action.id].error);
          break;
        }
        default: throw new Error('This command is unavailable.');
      }
    },
  });
  cleanup.push(() => commandPalette.destroy());
  bind('toggle-command', () => commandPalette.open());
  document.querySelector('.boot-attribution')?.remove();
  for (const button of document.querySelectorAll('#search-form button, #navigation button, #home, #share-view, #open-sidebar, #open-saved-places, #close-sidebar, #toggle-navbar, #toggle-news, #toggle-notebook, #toggle-command, #save-place, #locate, #reset-session')) button.disabled = false;
  return {
    notify, update,
    closeSidebar: () => setSidebar(false),
    openSidebar: () => { setWorkspace('data'); setSidebar(true); },
    openNews: () => openPanel('news'), closeNews: () => closePanel('news'),
    openNotebook: () => openPanel('notebook'), closeNotebook: () => closePanel('notebook'),
    openSavedPlaces, goToSavedPlace,
    openCommands: () => commandPalette.open(), closeCommands: () => commandPalette.close(),
    subscribePanels(listener) { panelListeners.add(listener); return () => panelListeners.delete(listener); },
    selectEntity(entity) { if (viewer.selectedEntity === entity) select(entity); else viewer.selectedEntity = entity; },
    setLocalStatus(text, { active = false, radiusKm } = {}) {
      const status = document.getElementById('local-status'); status.textContent = text; status.title = text;
      document.getElementById('local-context').dataset.active = String(active);
      document.querySelector('.local-radius-label').hidden = !active;
      if (radiusKm !== undefined && [10, 25, 50, 100, 250].includes(Number(radiusKm))) document.getElementById('local-radius').value = String(radiusKm);
    },
    destroy() {
      destroyed = true; clearTimeout(noticeTimer);
      cleanup.splice(0).reverse().forEach((dispose) => dispose?.());
      for (const dispose of mounted.values()) dispose();
      ledger.clear(); rows.clear(); mounted.clear(); creditItems.clear(); panelListeners.clear();
    },
  };
}
