import { createWorldMap } from './world-map.js';

const NS = 'http://www.w3.org/2000/svg';
const GLYPHS = Object.freeze({
  energy: 'm13 2-8 12h6l-1 8 8-12h-6l1-8Z',
  trade: 'm3 7 9-4 9 4-9 4-9-4Zm0 0v10l9 4 9-4V7M12 11v10',
  institution: 'm3 7 9-4 9 4H3ZM5 10v8M10 10v8M15 10v8M20 10v8M3 21h18',
  document: 'M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6',
  country: 'M6 22V3m0 0h13l-3 4 3 4H6',
  seismic: 'M2 12h5l2-6 4 13 3-9 2 2h4',
  flood: 'M2 10q3-3 6 0t6 0t6 0M2 16q3-3 6 0t6 0t6 0',
  weather: 'M5 16a4 4 0 1 1 1-8 6 6 0 0 1 11 1 3.5 3.5 0 1 1 1 7H5Zm7 2-2 4h4',
  markets: 'M4 20V12h4v8M10 20V8h4v12M16 20V4h4v16M2 21h20',
  security: 'm12 2 8 4v6c0 5-5 8-8 10-3-2-8-5-8-10V6l8-4Z',
  infrastructure: 'M4 21V7l8-4 8 4v14M8 10h2M14 10h2M8 14h2M14 14h2M10 21v-4h4v4',
  equipment: 'M6 6h12v12H6V6ZM9 9h6v6H9V9ZM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  research: 'M9 3h6M10 3v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-10V3M7 15h10',
  communications: 'M3 8a13 13 0 0 1 18 0M6 11a9 9 0 0 1 12 0M9 14a4 4 0 0 1 6 0M12 18v1',
  project: 'M12 2v3M12 19v3M2 12h3M19 12h3M17 7l-3 7-7 3 3-7 7-3ZM12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z',
  notice: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v6M12 17h.01',
});
const symbol = value => {
  const name = String(value || '').toLowerCase();
  if (/gas|oil|energy|resource|power/.test(name)) return 'energy';
  if (/port|logistic|trade|shipping|supply|transport/.test(name)) return 'trade';
  if (/document|evidence|report|policy/.test(name)) return 'document';
  if (/country|region|state|nation/.test(name)) return 'country';
  if (/earthquake|seismic/.test(name)) return 'seismic';
  if (/flood|water/.test(name)) return 'flood';
  if (/weather|storm|cyclone|climate/.test(name)) return 'weather';
  if (/market|econom|price|finance/.test(name)) return 'markets';
  if (/security|conflict|risk|geopolit/.test(name)) return 'security';
  if (/facility|terminal|infrastructure|company/.test(name)) return 'infrastructure';
  if (/institution|commission|bank|organization|actor/.test(name)) return 'institution';
  if (/equipment|hardware/.test(name)) return 'equipment';
  if (/research/.test(name)) return 'research';
  if (/communication/.test(name)) return 'communications';
  if (/project/.test(name)) return 'project';
  return 'notice';
};
const geographic = item => item && typeof item.id === 'string' && item.id.length <= 120 && item.id &&
  Number.isFinite(item.lon) && Number.isFinite(item.lat) && Math.abs(item.lon) <= 180 && Math.abs(item.lat) <= 90;
const boundedText = (value, limit = 160) => String(value || '').slice(0, limit);

/** A fictional, geographically anchored research sketch. It does not infer
 * relationships, locate people, acquire sources or establish causal proof. */
export function createResearchMap({ svg, onSelect = () => {}, onViewChange = () => {} } = {}) {
  if (!svg?.ownerDocument || typeof onSelect !== 'function' || typeof onViewChange !== 'function')
    throw new TypeError('Research map needs an SVG and callbacks');
  const documentRef = svg.ownerDocument, windowRef = documentRef.defaultView;
  const make = (tag, attributes = {}, text) => {
    const element = documentRef.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text; return element;
  };
  let destroyed = false, scene = { mode: 'world', nodes: [], edges: [], worldSignals: [], depth: 1, time: null, selectedNodeId: null };
  const overlay = make('g', { class: 'research-map-layer' }), lines = make('g', { class: 'research-map-edges', 'pointer-events': 'none' }),
    markers = make('g', { class: 'research-map-markers' }); overlay.append(lines, markers);
  let views = [], markerScales = [], nodeLabels = [], worldSignature = null;
  const cssScale = () => {
    const matrix = svg.getScreenCTM?.(), value = matrix && Math.hypot(matrix.a, matrix.b);
    if (Number.isFinite(value) && value > 0) return value;
    const rect = svg.getBoundingClientRect?.(); return rect?.width > 0 && rect.height > 0 ? Math.min(rect.width / 1200, rect.height / 620) : 1;
  };
  const map = createWorldMap({ svg, onViewChange(view) {
    if (destroyed) return;
    if (scene.mode === 'world') draw(false); else resizeMarkers(view);
    onViewChange(view);
  } });
  svg.querySelector('#map-world').append(overlay);
  function resizeMarkers(view = map.getView()) {
    const scale = 1 / (view.zoom * cssScale());
    for (const marker of markerScales) marker.setAttribute('transform', `scale(${scale})`);
    if (scene.mode === 'research') layoutLabels();
  }
  function layoutLabels() {
    const viewport = svg.getBoundingClientRect();
    if (!(viewport.width > 0 && viewport.height > 0)) return;
    const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const stage = svg.closest?.('.map-stage'), heading = stage?.querySelector('.map-heading')?.getBoundingClientRect(), stageBox = stage?.getBoundingClientRect() || viewport;
    const reserved = { left: heading?.left ?? stageBox.left, top: heading?.top ?? stageBox.top,
      right: (heading?.left ?? stageBox.left) + Math.max(450, heading?.width || 0),
      bottom: (heading?.top ?? stageBox.top) + Math.max(90, heading?.height || 0) };
    const placed = [], located = nodeLabels.map(record => {
      const matrix = record.outer.getScreenCTM?.();
      return { ...record, x: matrix?.e, y: matrix?.f };
    }).filter(record => Number.isFinite(record.x) && Number.isFinite(record.y));
    const icons = located.map(record => ({ id: record.id, left: record.x - 19, right: record.x + 19, top: record.y - 19, bottom: record.y + 19 }));
    for (const record of [...located.filter(value => value.selected), ...located.filter(value => !value.selected)]) {
      record.label.setAttribute('visibility', 'hidden'); record.secondary.setAttribute('visibility', 'hidden');
      const width = Math.max(record.label.getComputedTextLength?.() || record.label.textContent.length * 7.5,
        record.selected ? record.secondary.getComputedTextLength?.() || record.secondary.textContent.length * 6 : 0);
      const height = record.selected ? 34 : 20;
      const candidates = [[22, -3, 'start'], [-22, -3, 'end'], [0, 36, 'middle'], [0, -32, 'middle'],
        [22, 27, 'start'], [-22, 27, 'end'], [22, -31, 'start'], [-22, -31, 'end']];
      let chosen = null;
      for (const [x, y, anchor] of candidates) {
        const offset = anchor === 'end' ? width : anchor === 'middle' ? width / 2 : 0;
        const box = { left: record.x + x - offset - 5, right: record.x + x - offset + width + 5,
          top: record.y + y - 16, bottom: record.y + y - 16 + height };
        if (box.left < viewport.left + 8 || box.right > viewport.right - 8 || box.top < viewport.top + 8 || box.bottom > viewport.bottom - 8 ||
          intersects(box, reserved) || placed.some(value => intersects(box, value)) || icons.some(value => value.id !== record.id && intersects(box, value))) continue;
        chosen = { x, y, anchor, box }; break;
      }
      if (!chosen) continue;
      for (const [element, y] of [[record.label, chosen.y], [record.secondary, chosen.y + 17]]) {
        element.setAttribute('x', chosen.x); element.setAttribute('y', y); element.setAttribute('text-anchor', chosen.anchor);
      }
      record.label.setAttribute('visibility', 'visible');
      if (record.selected) record.secondary.setAttribute('visibility', 'visible');
      placed.push(chosen.box);
    }
  }
  function marker(item, kind, position, { grouped = false, count = 1, action } = {}) {
    const selected = !grouped && scene.selectedNodeId === item.id, category = symbol(item.type || item.symbol || item.kind || item.category);
    const outer = make('g', { class: `research-map-${grouped ? 'group' : kind}${selected ? ' is-selected' : ''}`,
      transform: `translate(${position[0]} ${position[1]})`, role: 'button', tabindex: 0,
      'data-id': item.id, 'data-type': category, 'aria-pressed': String(selected) });
    if (item.severity != null) outer.setAttribute('data-severity', boundedText(item.severity, 32));
    const description = grouped ? `${count} fictional sample signals in this area. Zoom to explore.` :
      `${kind === 'node' ? 'Fictional research node' : 'Fictional sample signal'}: ${boundedText(item.label || item.headline)}${item.region ? ` · ${boundedText(item.region, 80)}` : ''}${kind === 'signal' && Number.isFinite(item.ageMinutes) && item.ageMinutes >= 0 ? ` · ${item.ageMinutes} minutes old in the sample scene` : ''}`;
    outer.setAttribute('aria-label', description); outer.append(make('title', {}, description));
    const inner = make('g', { class: 'research-marker-body' }); markerScales.push(inner);
    inner.append(make('circle', { r: 24, fill: 'transparent', class: 'research-marker-hit', 'pointer-events': 'all' }),
      make('circle', { r: selected ? 20 : 17, fill: 'none', stroke: selected ? '#e4be7a' : '#6ab9bb', opacity: selected ? .9 : .3,
        'stroke-width': 1, class: 'research-marker-halo' }),
      make('circle', { r: 13, fill: '#112b37', stroke: selected ? '#e4be7a' : '#80cbd0', 'stroke-width': 1.2, class: 'research-marker-shell' }),
      make('path', { d: GLYPHS[category], transform: 'translate(-9 -9) scale(.75)', fill: 'none', stroke: '#e9f6f7',
        'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'research-marker-glyph', 'pointer-events': 'none' }));
    if (kind === 'node') {
      const label = make('text', { x: 22, y: -3, fill: '#f0f6f8', 'font-size': 14, 'font-weight': 600, class: 'research-marker-label', 'pointer-events': 'none' }, boundedText(selected ? item.label : item.region || item.label, selected ? 160 : 34)),
        secondary = make('text', { x: 22, y: 14, fill: '#9db7c2', 'font-size': 10, class: 'research-marker-type', 'pointer-events': 'none' }, boundedText(item.type, 34));
      inner.append(label, secondary); nodeLabels.push({ id: item.id, outer, label, secondary, selected });
    }
    outer.append(inner);
    const select = () => { if (!destroyed) action ? action() : onSelect(Object.freeze({ kind, id: item.id })); };
    outer.addEventListener('click', select);
    outer.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); select(); } });
    return outer;
  }
  function worldGroups() {
    const zoom = map.getView().zoom, scale = cssScale(), groups = new Map(), selected = [];
    for (const item of scene.worldSignals) {
      if (item.id === scene.selectedNodeId) { selected.push({ item, position: map.project([item.lon, item.lat]) }); continue; }
      const point = map.project([item.lon, item.lat]);
      // Screen-space grouping is presentation only, never an event location.
      const key = zoom >= 7.99 ? item.id : `${Math.floor(point[0] * zoom * scale / 20)}:${Math.floor(point[1] * zoom * scale / 20)}`;
      const group = groups.get(key) || []; group.push({ item, point }); groups.set(key, group);
    }
    const items = [];
    for (const group of groups.values()) {
      if (group.length === 1) items.push({ item: group[0].item, position: group[0].point });
      else {
        const position = group.reduce((point, value) => [point[0] + value.point[0] / group.length, point[1] + value.point[1] / group.length], [0, 0]);
        const [lon, lat] = map.unproject(position), category = group.every(value => value.item.category === group[0].item.category) ? group[0].item.category : 'notice';
        items.push({ item: { id: `group:${group.map(value => value.item.id).join('|')}`, lon, lat, category }, position, count: group.length,
          grouped: true, action: () => map.focus(lon, lat, Math.min(8, map.getView().zoom * 2)) });
      }
    }
    return [...items, ...selected];
  }
  function draw(force = true) {
    if (destroyed) return;
    const groupedSignals = scene.mode === 'world' ? worldGroups() : null;
    const signature = groupedSignals && JSON.stringify(groupedSignals.map(value => [value.item.id, value.count || 1]));
    // Camera translation does not alter anchored grouping. Keep keyboard focus
    // and the marker DOM while only the shared map transform is changing.
    if (!force && signature !== null && signature === worldSignature) { resizeMarkers(); return; }
    worldSignature = signature;
    markerScales = []; nodeLabels = []; lines.replaceChildren(); markers.replaceChildren();
    svg.dataset.sceneMode = scene.mode; svg.dataset.sceneDepth = String(scene.depth);
    if (scene.time != null) svg.dataset.sceneTime = String(scene.time); else delete svg.dataset.sceneTime;
    if (scene.mode === 'world') {
      for (const value of groupedSignals) markers.append(marker(value.item, 'signal', value.position, value));
    } else {
      const limit = scene.depth === 1 ? 3 : scene.depth === 2 ? 4 : 8;
      views = scene.nodes.slice(0, limit); const visible = new Map(views.map(node => [node.id, node]));
      for (const edge of scene.edges) {
        if (!visible.has(edge.from) || !visible.has(edge.to)) continue;
        const from = visible.get(edge.from), to = visible.get(edge.to), a = map.project([from.lon, from.lat]), b = map.project([to.lon, to.lat]);
        const lift = Math.min(100, Math.hypot(b[0] - a[0], b[1] - a[1]) * .22);
        const path = make('path', { d: `M${a[0]},${a[1]}Q${(a[0] + b[0]) / 2},${(a[1] + b[1]) / 2 - lift} ${b[0]},${b[1]}`,
          fill: 'none', stroke: edge.kind === 'hypothesis' ? '#a28ac7' : '#63bcc4', 'stroke-width': 1.4,
          'stroke-dasharray': edge.kind === 'hypothesis' ? '5 5' : 'none', 'vector-effect': 'non-scaling-stroke',
          class: `research-map-edge is-${edge.kind}` });
        const note = edge.kind === 'hypothesis' ? 'Sample hypothesis' : 'Fictional sample relationship';
        path.append(make('title', {}, `${note}: ${boundedText(edge.label)} · ${boundedText(from.label)} ↔ ${boundedText(to.label)}${edge.evidenceIds.length ? ` · fixture evidence: ${edge.evidenceIds.join(', ')}` : ''}`));
        lines.append(path);
      }
      const ordered = [...views.filter(node => node.id !== scene.selectedNodeId), ...views.filter(node => node.id === scene.selectedNodeId)];
      for (const node of ordered) markers.append(marker(node, 'node', map.project([node.lon, node.lat])));
    }
    resizeMarkers();
  }
  const resize = () => { if (!destroyed) scene.mode === 'world' ? draw(false) : resizeMarkers(); };
  windowRef.addEventListener('resize', resize);
  const api = {
    map,
    setScene(value = {}) {
      if (destroyed) return false;
      if (!['world', 'research'].includes(value.mode) || !Number.isInteger(value.depth) || value.depth < 1 || value.depth > 5)
        throw new TypeError('Choose a world or research scene with depth one to five');
      const nodes = value.nodes || [], edges = value.edges || [], signals = value.worldSignals || [];
      if (![nodes, edges, signals].every(Array.isArray) || nodes.length > 8 || edges.length > 64 || signals.length > 200 ||
          !nodes.every(node => geographic(node) && typeof node.label === 'string' && typeof node.type === 'string') || !signals.every(geographic))
        throw new TypeError('Use a bounded fictional research scene');
      const ids = new Set(nodes.map(node => node.id));
      if (ids.size !== nodes.length || new Set(signals.map(signal => signal.id)).size !== signals.length ||
          !edges.every(edge => edge && typeof edge.from === 'string' && typeof edge.to === 'string' && ['documented', 'hypothesis'].includes(edge.kind) &&
            (!edge.evidenceIds || Array.isArray(edge.evidenceIds) && edge.evidenceIds.length <= 12 && edge.evidenceIds.every(id => typeof id === 'string' && id.length <= 120))))
        throw new TypeError('Research fixture identities or relationships are invalid');
      scene = { mode: value.mode, depth: value.depth, time: value.time ?? null, selectedNodeId: value.selectedNodeId ?? null,
        nodes: nodes.map(node => ({ ...node })), edges: edges.map(edge => ({ ...edge, evidenceIds: [...(edge.evidenceIds || [])] })), worldSignals: signals.map(signal => ({ ...signal })) };
      draw(); return true;
    },
    destroy() {
      if (destroyed) return; destroyed = true; windowRef.removeEventListener('resize', resize);
      lines.replaceChildren(); markers.replaceChildren(); overlay.remove(); markerScales = []; nodeLabels = []; views = [];
      delete svg.dataset.sceneMode; delete svg.dataset.sceneDepth; delete svg.dataset.sceneTime; map.destroy();
    },
  };
  api.ready = map.ready.then(() => { if (destroyed) throw new DOMException('Research map closed', 'AbortError'); draw(); return api; });
  return api;
}
