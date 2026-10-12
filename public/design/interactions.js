import { DEMO_NOW, DEMO_START, demoCategories, demoEvents, demoRelationships } from './demo-data.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PLAYBACK_RATE = 12 * HOUR; // Twelve sample hours per real second.

export function initInteractions({
  events = demoEvents,
  relationships = demoRelationships,
  map,
  onFilter,
  onTime,
  onSelect,
  onReplay,
  documentRef = document,
} = {}) {
  const windowRef = documentRef.defaultView || globalThis;
  const nodes = Object.fromEntries([
    'search-input', 'search-results', 'filter-chips', 'activity-list', 'activity-count',
    'dossier', 'dossier-title', 'dossier-meta', 'dossier-summary', 'dossier-body',
    'dossier-tabs', 'dossier-follow', 'dossier-close', 'timeline-input', 'timeline-play',
    'timeline-now', 'timeline-readout', 'timeline-date', 'timeline-ticks', 'activity-chart',
    'map-home', 'map-zoom-in', 'map-zoom-out', 'replay-arrival',
  ].map((id) => [id, documentRef.getElementById(id)]));
  const byId = new Map(events.map((event) => [event.id, event]));
  const categoryIds = new Set(demoCategories.map((category) => category.id));
  const followed = new Set();
  const cleanup = [];
  let time = DEMO_NOW;
  let category = 'all';
  let query = '';
  let selectedId = null;
  let tab = 'overview';
  let playing = false;
  let destroyed = false;
  let frame = null;
  let playbackStart = 0;
  let playbackTime = 0;
  let lastPaint = 0;
  let resultsOpen = false;
  let returnFocus = null;
  let searchKey = null;
  let dossierKey = null;

  function listen(target, name, listener) {
    if (!target) return;
    target.addEventListener(name, listener);
    cleanup.push(() => target.removeEventListener(name, listener));
  }

  function element(tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function availableEvents() {
    return events.filter((event) => event.occurredAt <= time);
  }

  function filteredEvents() {
    const term = searchText(query);
    return availableEvents()
      .filter((event) => (category === 'all' || event.category === category) && (!term || searchText(`${event.headline} ${event.place} ${event.country} ${event.kind}`).includes(term)))
      .sort((left, right) => right.occurredAt - left.occurredAt);
  }

  function renderSearch(active) {
    const host = nodes['search-results'];
    if (!host) return;
    host.hidden = !query.trim() || !resultsOpen;
    nodes['search-input']?.setAttribute('aria-expanded', String(!host.hidden));
    const matches = active.slice(0, 5);
    const key = JSON.stringify([host.hidden, query, matches.map((event) => event.id)]);
    if (key === searchKey) return;
    searchKey = key;
    host.replaceChildren();
    if (host.hidden) return;
    if (!matches.length) {
      host.append(element('p', 'search-empty', 'No sample reports at this time. Try another place or All.'));
      return;
    }
    for (const event of matches) {
      const button = element('button', 'search-result');
      button.type = 'button';
      button.append(element('span', 'search-result-title', event.place), element('span', 'search-result-detail', `${event.country} · ${event.headline}`));
      button.addEventListener('click', () => selectEvent(event.id, { focus: true }));
      host.append(button);
    }
  }

  function renderActivity(active) {
    const host = nodes['activity-list'];
    if (nodes['activity-count']) nodes['activity-count'].textContent = `${active.length} sample ${active.length === 1 ? 'report' : 'reports'}`;
    if (!host) return;
    host.replaceChildren();
    if (!active.length) {
      host.append(element('p', 'activity-empty', 'No sample reports in this view.'));
      return;
    }
    for (const event of active.slice(0, 4)) {
      const button = element('button', 'activity-item');
      button.type = 'button';
      button.dataset.category = event.category;
      button.dataset.kind = event.kind;
      button.setAttribute('aria-label', `Inspect ${event.headline}, ${event.place}`);
      const marker = element('span', 'activity-dot');
      marker.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'activity-copy');
      copy.append(element('span', 'activity-headline', event.headline), element('span', 'activity-meta', `${event.place} · ${relativeTime(time - event.occurredAt)}`));
      button.append(marker, copy);
      button.addEventListener('click', () => selectEvent(event.id, { focus: true }));
      host.append(button);
    }
  }

  function renderChart(active) {
    const host = nodes['activity-chart'];
    if (!host) return;
    const buckets = Array(56).fill(0);
    for (const event of active) {
      const bucket = Math.min(55, Math.max(0, Math.floor((event.occurredAt - DEMO_START) / (3 * HOUR))));
      buckets[bucket] += 1;
    }
    const largest = Math.max(1, ...buckets);
    host.replaceChildren();
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', `${active.length} fictional reports across the seven-day demonstration.`);
    buckets.forEach((count, index) => {
      const bar = element('span', 'activity-bar');
      bar.style.setProperty('--activity', String(count / largest));
      bar.dataset.active = String(DEMO_START + index * 3 * HOUR <= time);
      bar.title = `${formatDate(DEMO_START + index * 3 * HOUR)} · ${count} sample ${count === 1 ? 'report' : 'reports'}`;
      bar.setAttribute('aria-hidden', 'true');
      host.append(bar);
    });
  }

  function renderTime() {
    const now = time === DEMO_NOW;
    if (nodes['timeline-input']) {
      nodes['timeline-input'].value = String(time);
      nodes['timeline-input'].setAttribute('aria-valuetext', `${formatDateTime(time)} · fictional demonstration`);
    }
    if (nodes['timeline-readout']) nodes['timeline-readout'].textContent = formatClock(time);
    if (nodes['timeline-date']) nodes['timeline-date'].textContent = `${formatDate(time)}${now ? ' · Demo now' : ' · Demo history'}`;
    if (nodes['timeline-play']) {
      nodes['timeline-play'].dataset.playing = String(playing);
      nodes['timeline-play'].setAttribute('aria-pressed', String(playing));
      nodes['timeline-play'].setAttribute('aria-label', playing ? 'Pause demonstration history' : 'Play demonstration history');
      nodes['timeline-play'].title = playing ? 'Pause history' : 'Play seven days in about fourteen seconds';
      const label = nodes['timeline-play'].querySelector('[data-play-label]');
      if (label) label.textContent = playing ? 'Pause' : 'Play';
    }
    nodes['timeline-now']?.setAttribute('aria-pressed', String(now));
  }

  function renderTabs() {
    for (const button of nodes['dossier-tabs']?.querySelectorAll('[data-tab]') || []) {
      const active = button.dataset.tab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.setAttribute('tabindex', active ? '0' : '-1');
      if (active) nodes['dossier-body']?.setAttribute('aria-labelledby', button.id);
    }
  }

  function renderDossier() {
    const event = byId.get(selectedId);
    if (nodes.dossier) nodes.dossier.hidden = !event;
    if (!event) return;
    if (nodes['dossier-title']) nodes['dossier-title'].textContent = event.headline;
    if (nodes['dossier-meta']) nodes['dossier-meta'].textContent = `${event.place}, ${event.country} · ${formatDateTime(event.occurredAt)}`;
    if (nodes['dossier-summary']) nodes['dossier-summary'].textContent = event.summary;
    if (nodes['dossier-follow']) {
      const active = followed.has(event.id);
      let label = nodes['dossier-follow'].querySelector('[data-follow-label]');
      if (!label) {
        for (const child of [...nodes['dossier-follow'].childNodes]) if (child.nodeType === 3) child.remove();
        label = element('span', '', '');
        label.dataset.followLabel = '';
        nodes['dossier-follow'].append(label);
      }
      label.textContent = active ? 'Following · demo' : 'Follow demo story';
      nodes['dossier-follow'].setAttribute('aria-pressed', String(active));
      nodes['dossier-follow'].title = 'Local demonstration only. No notifications or account changes.';
    }
    renderTabs();
    const host = nodes['dossier-body'];
    if (!host) return;
    const visibleUpdates = event.updates.filter((update) => update.at <= time);
    const connections = relationships.filter((link) => (link.from === event.id || link.to === event.id) && byId.get(link.from)?.occurredAt <= time && byId.get(link.to)?.occurredAt <= time);
    const key = JSON.stringify([event.id, tab, tab === 'timeline' ? visibleUpdates.length : null, tab === 'overview' ? connections.map((link) => link.id) : null]);
    if (key === dossierKey) return;
    dossierKey = key;
    host.replaceChildren();
    if (tab === 'timeline') {
      const list = element('ol', 'story-timeline');
      for (const update of visibleUpdates) {
        const row = element('li', 'story-update');
        const stamp = element('time', 'story-update-time', formatDateTime(update.at));
        stamp.dateTime = new Date(update.at).toISOString();
        row.append(stamp, element('p', '', update.text));
        list.append(row);
      }
      host.append(list);
    } else if (tab === 'sources') {
      host.append(element('p', 'dossier-note', 'These are fictional evidence fixtures. This prototype does not fetch or verify news.'));
      for (const source of event.sources) {
        const card = element('article', 'source-card');
        card.append(element('strong', '', source.label), element('span', 'source-type', source.type), element('p', '', source.note));
        host.append(card);
      }
    } else {
      const facts = element('dl', 'dossier-facts');
      for (const [label, value] of [['Category', demoCategories.find((item) => item.id === event.category)?.label || event.category], ['Status', event.status], ['Location', event.locationMeaning]]) {
        facts.append(element('dt', '', label), element('dd', '', value));
      }
      host.append(facts);
      for (const link of connections) {
        const other = byId.get(link.from === event.id ? link.to : link.from);
        const button = element('button', 'related-story', `Related demo: ${other.place}`);
        button.type = 'button';
        button.title = link.note;
        button.addEventListener('click', () => selectEvent(other.id, { focus: true }));
        host.append(button, element('p', 'dossier-note', link.note));
      }
      host.append(element('p', 'dossier-note', 'Fictional demo · illustrative location. Source observations, consequences and relationships would remain separate in the real platform.'));
    }
  }

  function render() {
    if (destroyed) return;
    const active = filteredEvents();
    renderTime();
    renderActivity(active);
    renderSearch(active);
    renderChart(active);
    renderDossier();
    for (const button of nodes['filter-chips']?.querySelectorAll('[data-category]') || []) {
      const active = button.dataset.category === category;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    onFilter?.(active, { category, query, time });
  }

  function pause({ capture = false } = {}) {
    const frozen = capture && playing ? Math.min(DEMO_NOW, playbackTime + ((windowRef.performance?.now?.() ?? Date.now()) - playbackStart) * PLAYBACK_RATE / 1000) : null;
    playing = false;
    if (frame !== null) windowRef.cancelAnimationFrame(frame);
    frame = null;
    renderTime();
    if (frozen !== null) commitTime(frozen);
  }

  function commitTime(value) {
    const next = Number(value);
    if (destroyed || !Number.isFinite(next)) return false;
    time = Math.max(DEMO_START, Math.min(DEMO_NOW, next));
    if (selectedId && byId.get(selectedId).occurredAt > time) closeDossier({ restoreFocus: false });
    render();
    onTime?.(time, { playing, isDemoNow: time === DEMO_NOW });
    return true;
  }

  function setTime(value) {
    pause();
    return commitTime(value);
  }

  function play() {
    if (destroyed) return;
    if (playing) {
      pause({ capture: true });
      return;
    }
    if (time === DEMO_NOW) commitTime(DEMO_START);
    playing = true;
    playbackStart = windowRef.performance?.now?.() ?? Date.now();
    playbackTime = time;
    lastPaint = 0;
    renderTime();
    const tick = (stamp) => {
      if (destroyed || !playing) return;
      const next = Math.min(DEMO_NOW, playbackTime + (stamp - playbackStart) * PLAYBACK_RATE / 1000);
      if (next === DEMO_NOW) {
        pause();
        commitTime(DEMO_NOW);
        return;
      }
      if (stamp - lastPaint >= 100) {
        lastPaint = stamp;
        commitTime(next);
      }
      frame = windowRef.requestAnimationFrame(tick);
    };
    frame = windowRef.requestAnimationFrame(tick);
  }

  function closeDossier({ restoreFocus = true } = {}) {
    if (destroyed) return;
    selectedId = null;
    dossierKey = null;
    if (nodes.dossier) nodes.dossier.hidden = true;
    onSelect?.(null);
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  function selectEvent(id, { focus = false } = {}) {
    const event = byId.get(id);
    if (destroyed || !event || event.occurredAt > time) return false;
    pause({ capture: true });
    if (!selectedId) returnFocus = documentRef.activeElement;
    selectedId = id;
    tab = 'overview';
    resultsOpen = false;
    renderSearch(filteredEvents());
    renderDossier();
    onSelect?.(event);
    if (focus) map?.focus(event.lon, event.lat, 3);
    nodes['dossier-close']?.focus({ preventScroll: true });
    return true;
  }

  if (nodes['timeline-input']) {
    nodes['timeline-input'].min = String(DEMO_START);
    nodes['timeline-input'].max = String(DEMO_NOW);
    nodes['timeline-input'].step = '60000';
    nodes['timeline-input'].setAttribute('aria-label', 'Seven-day fictional demonstration timeline');
  }
  if (nodes['timeline-ticks']) {
    nodes['timeline-ticks'].replaceChildren();
    for (let day = 0; day <= 7; day += 1) nodes['timeline-ticks'].append(element('span', '', formatShortDate(DEMO_START + day * DAY)));
  }
  nodes['search-input']?.setAttribute('aria-controls', 'search-results');
  nodes['search-input']?.setAttribute('aria-expanded', 'false');
  nodes['dossier-tabs']?.setAttribute('role', 'tablist');
  for (const button of nodes['dossier-tabs']?.querySelectorAll('[data-tab]') || []) {
    button.setAttribute('role', 'tab');
    button.removeAttribute('aria-pressed');
    button.id ||= `dossier-tab-${button.dataset.tab}`;
    button.setAttribute('aria-controls', 'dossier-body');
  }
  nodes['dossier-body']?.setAttribute('role', 'tabpanel');

  listen(nodes['timeline-input'], 'input', (event) => setTime(event.target.value));
  listen(nodes['timeline-play'], 'click', play);
  listen(nodes['timeline-now'], 'click', () => setTime(DEMO_NOW));
  listen(nodes['map-home'], 'click', () => map?.home());
  listen(nodes['map-zoom-in'], 'click', () => map?.zoomBy(1.35));
  listen(nodes['map-zoom-out'], 'click', () => map?.zoomBy(1 / 1.35));
  listen(nodes['replay-arrival'], 'click', () => onReplay?.(filteredEvents()));
  listen(nodes['dossier-close'], 'click', () => closeDossier());
  listen(nodes['dossier-follow'], 'click', () => {
    if (!selectedId) return;
    if (followed.has(selectedId)) followed.delete(selectedId);
    else followed.add(selectedId);
    renderDossier();
  });
  listen(nodes['filter-chips'], 'click', (event) => {
    const button = event.target.closest('[data-category]');
    if (!button || !categoryIds.has(button.dataset.category)) return;
    category = button.dataset.category;
    render();
  });
  listen(nodes['search-input'], 'input', (event) => {
    query = event.target.value.slice(0, 80);
    resultsOpen = true;
    render();
  });
  listen(nodes['search-input'], 'focus', () => {
    pause();
    resultsOpen = true;
    renderSearch(filteredEvents());
  });
  listen(nodes['search-input'], 'keydown', (event) => {
    if (event.key === 'Escape') {
      resultsOpen = false;
      renderSearch(filteredEvents());
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === 'ArrowDown') {
      nodes['search-results']?.querySelector('button')?.focus();
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const first = filteredEvents()[0];
      if (first && query.trim()) selectEvent(first.id, { focus: true });
      event.preventDefault();
    }
  });
  listen(nodes['search-results'], 'keydown', (event) => {
    const buttons = [...nodes['search-results'].querySelectorAll('button')];
    const index = buttons.indexOf(documentRef.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      event.preventDefault();
    } else if (event.key === 'Escape') {
      nodes['search-input']?.focus();
      resultsOpen = false;
      renderSearch(filteredEvents());
      event.preventDefault();
      event.stopPropagation();
    }
  });
  listen(nodes['dossier-tabs'], 'click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button && ['overview', 'timeline', 'sources'].includes(button.dataset.tab)) {
      tab = button.dataset.tab;
      renderDossier();
    }
  });
  for (const host of [nodes['search-results'], nodes['activity-list'], nodes.dossier]) listen(host, 'focusin', pause);
  listen(nodes['dossier-tabs'], 'keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...nodes['dossier-tabs'].querySelectorAll('[data-tab]')];
    const index = buttons.findIndex((button) => button.dataset.tab === tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    tab = buttons[next].dataset.tab;
    renderDossier();
    buttons[next].focus();
    event.preventDefault();
  });
  listen(documentRef, 'keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && selectedId) closeDossier();
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !event.target.isContentEditable) {
      event.preventDefault();
      nodes['search-input']?.focus();
    }
  });
  listen(documentRef, 'pointerdown', (event) => {
    if (event.target !== nodes['search-input'] && !nodes['search-results']?.contains(event.target)) {
      resultsOpen = false;
      renderSearch(filteredEvents());
    }
  });
  listen(documentRef, 'visibilitychange', () => {
    if (documentRef.hidden) pause({ capture: true });
  });

  render();
  onTime?.(time, { playing, isDemoNow: true });

  return Object.freeze({
    selectEvent,
    setTime,
    closeDossier,
    getState: () => ({ time, category, query, selectedId, playing, followedIds: [...followed], activeEvents: filteredEvents() }),
    destroy() {
      if (destroyed) return;
      pause();
      destroyed = true;
      cleanup.splice(0).forEach((remove) => remove());
      followed.clear();
    },
  });
}

function searchText(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function relativeTime(milliseconds) {
  const hours = Math.max(0, Math.floor(milliseconds / HOUR));
  return hours < 1 ? 'just now' : hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function formatClock(value) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }).format(value) + ' UTC';
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(value);
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(value);
}

function formatDateTime(value) {
  return `${formatDate(value)} · ${formatClock(value)}`;
}
