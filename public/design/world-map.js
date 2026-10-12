const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1200, HEIGHT = 620, MAX_ZOOM = 8, MAX_BYTES = 500 * 1024;
let instance = 0;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const coordinates = point => {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)
    throw new TypeError('Use geographic longitude, latitude');
  return point;
};
// Full-latitude equirectangular projection. Geometry, markers and inverse picking
// use this same definition; this generalized overview is not a distance measure.
const project = point => { const [lon, lat] = coordinates(point); return [(lon + 180) * WIDTH / 360, (90 - lat) * HEIGHT / 180]; };
const inverse = ([x, y]) => [x * 360 / WIDTH - 180, 90 - y * 180 / HEIGHT];

function geographyPaths(value) {
  if (value?.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length > 250 || !value.features.length)
    throw new TypeError('Bundled geography is incompatible');
  let pointCount = 0;
  return value.features.map(feature => {
    const name = feature.properties?.name;
    if (typeof name !== 'string' || name.length > 100 || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type))
      throw new TypeError('Bundled country geometry is invalid');
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (!Array.isArray(polygons) || polygons.length > 200) throw new TypeError('Bundled polygon geometry is invalid');
    let path = '';
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || polygon.length > 100) throw new TypeError('Bundled polygon rings are invalid');
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 4 || ring.length > 10000) throw new TypeError('Bundled ring is invalid');
        const first = ring[0], last = ring.at(-1);
        if (first[0] !== last[0] || first[1] !== last[1]) throw new TypeError('Bundled ring must close');
        path += ring.map((point, index) => {
          if (++pointCount > 20000) throw new RangeError('Bundled geography exceeds its point budget');
          const [x, y] = project(point);
          return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
        }).join('') + 'Z';
      }
    }
    return { id: String(feature.id || name), name, path };
  });
}
async function readGeography(response, signal) {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Bundled map could not load');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Bundled map body is unavailable');
  let length = 0, chunks = 0, text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted(); if (done) break;
      if (!(value instanceof Uint8Array) || !value.length || ++chunks > 1024 || (length += value.length) > MAX_BYTES)
        throw new RangeError('Bundled map exceeds its delivery budget');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Dependency-free design prototype. The map controller owns geography and one
 * transform; the caller owns sample events, relationships, timeline and dossier. */
export function createWorldMap({ svg, onViewChange = () => {}, onSelect = () => {} } = {}) {
  if (!svg?.ownerDocument || svg.namespaceURI !== NS || typeof onViewChange !== 'function' || typeof onSelect !== 'function')
    throw new TypeError('World map needs an SVG surface and callbacks');
  const documentRef = svg.ownerDocument, windowRef = documentRef.defaultView;
  const prefix = `world-map-${++instance}`, cleanup = [], controller = new AbortController();
  const make = (tag, attributes = {}) => {
    const element = documentRef.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  };
  const original = new Map(['viewBox', 'tabindex', 'role', 'aria-label'].map(key => [key, svg.getAttribute(key)]));
  const previousTouchAction = svg.style.touchAction;
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`); svg.setAttribute('tabindex', svg.getAttribute('tabindex') || '0');
  if (!svg.hasAttribute('role')) svg.setAttribute('role', 'application');
  if (!svg.hasAttribute('aria-label')) svg.setAttribute('aria-label', 'World map. Drag to pan, scroll to zoom, use arrow keys, plus, minus or Home.');
  svg.style.touchAction = 'none'; svg.dataset.mapState = 'loading';
  let world = svg.querySelector('#map-world'); const createdWorld = !world;
  if (!world) { world = make('g', { id: 'map-world' }); svg.append(world); }
  const defs = make('defs'), geography = make('g', { class: 'map-geography' });
  const pattern = make('pattern', { id: `${prefix}-dots`, width: 7, height: 7, patternUnits: 'userSpaceOnUse' });
  pattern.append(make('circle', { cx: 3.5, cy: 3.5, r: .8, fill: '#6ea8a9', opacity: .72 }));
  const mask = make('clipPath', { id: `${prefix}-land`, clipPathUnits: 'userSpaceOnUse' });
  defs.append(pattern, mask); svg.prepend(defs); world.prepend(geography);
  let view = { lon: 0, lat: 0, zoom: 1 }, destroyed = false, frame = null, flight = null, gesture = null, deadline;
  const now = () => windowRef.performance?.now() ?? performance.now();
  const reducedMotion = () => windowRef.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const state = () => {
    const [x, y] = project([view.lon, view.lat]), tx = WIDTH / 2 - x * view.zoom, ty = HEIGHT / 2 - y * view.zoom;
    const topLeft = inverse([-tx / view.zoom, -ty / view.zoom]), bottomRight = inverse([(WIDTH - tx) / view.zoom, (HEIGHT - ty) / view.zoom]);
    return Object.freeze({ ...view, transform: `translate(${tx} ${ty}) scale(${view.zoom})`,
      bounds: Object.freeze({ west: topLeft[0], north: topLeft[1], east: bottomRight[0], south: bottomRight[1] }) });
  };
  const render = (timestamp = now()) => {
    frame = null; if (destroyed) return;
    if (flight) {
      const fraction = reducedMotion() ? 1 : clamp((timestamp - flight.started) / 450, 0, 1), ease = 1 - (1 - fraction) ** 3;
      view = normalized({ lon: flight.from.lon + (flight.to.lon - flight.from.lon) * ease,
        lat: flight.from.lat + (flight.to.lat - flight.from.lat) * ease,
        zoom: Math.exp(Math.log(flight.from.zoom) + (Math.log(flight.to.zoom) - Math.log(flight.from.zoom)) * ease) });
      if (fraction === 1) { view = flight.to; flight = null; }
    }
    const next = state(); world.setAttribute('transform', next.transform); onViewChange(next);
    if (flight) schedule();
  };
  const schedule = () => { if (!destroyed && frame === null) frame = windowRef.requestAnimationFrame(render); };
  const normalized = next => {
    const lon = Number(next.lon ?? view.lon), lat = Number(next.lat ?? view.lat), requestedZoom = Number(next.zoom ?? view.zoom);
    if (![lon, lat, requestedZoom].every(Number.isFinite) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || requestedZoom <= 0)
      throw new TypeError('Use a finite geographic map view');
    const zoom = clamp(requestedZoom, 1, MAX_ZOOM);
    // The finite atlas never invents geography beyond its edges. Edge targets
    // remain visible; panning stops where the complete rectangular world ends.
    return { lon: clamp(lon, -180 + 180 / zoom, 180 - 180 / zoom), lat: clamp(lat, -90 + 90 / zoom, 90 - 90 / zoom), zoom };
  };
  const cancelFlight = () => { if (!flight) return; flight = null;
    if (frame !== null) windowRef.cancelAnimationFrame(frame); frame = null; };
  const apply = (next, immediate = true) => {
    if (destroyed) return state();
    const target = normalized(next); cancelFlight(); view = target;
    if (immediate) { if (frame !== null) windowRef.cancelAnimationFrame(frame); render(); } else schedule();
    return state();
  };
  const animate = next => {
    if (destroyed) return state();
    const target = normalized(next); cancelFlight();
    if (reducedMotion()) return apply(target);
    flight = { from: { ...view }, to: target, started: now() }; schedule(); return state();
  };
  const localPoint = event => {
    const matrix = svg.getScreenCTM?.();
    if (matrix?.inverse && svg.createSVGPoint) {
      const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const local = point.matrixTransform(matrix.inverse()); return [local.x, local.y];
    }
    const rect = svg.getBoundingClientRect(), scale = Math.min(rect.width / WIDTH, rect.height / HEIGHT);
    return [(event.clientX - rect.left - (rect.width - WIDTH * scale) / 2) / scale,
      (event.clientY - rect.top - (rect.height - HEIGHT * scale) / 2) / scale];
  };
  const worldPoint = point => {
    const [centerX, centerY] = project([view.lon, view.lat]);
    return [centerX + (point[0] - WIDTH / 2) / view.zoom, centerY + (point[1] - HEIGHT / 2) / view.zoom];
  };
  const zoomAt = (factor, point = [WIDTH / 2, HEIGHT / 2], immediate = true, animated = false) => {
    if (!Number.isFinite(factor) || factor <= 0) throw new TypeError('Use a positive map zoom factor');
    const anchor = worldPoint(point), zoom = clamp(view.zoom * factor, 1, MAX_ZOOM);
    const [lon, lat] = inverse([anchor[0] - (point[0] - WIDTH / 2) / zoom, anchor[1] - (point[1] - HEIGHT / 2) / zoom]);
    const target = { lon: clamp(lon, -180, 180), lat: clamp(lat, -90, 90), zoom };
    return animated ? animate(target) : apply(target, immediate);
  };
  const bind = (name, handler, options) => { svg.addEventListener(name, handler, options); cleanup.push(() => svg.removeEventListener(name, handler, options)); };
  bind('wheel', event => { if (destroyed) return; event.preventDefault(); const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? HEIGHT : 1;
    zoomAt(Math.exp(-clamp(event.deltaY * units, -400, 400) * .002), localPoint(event), false); }, { passive: false });
  bind('pointerdown', event => {
    if (event.button !== 0 || gesture || destroyed) return;
    cancelFlight();
    const point = localPoint(event); gesture = { id: event.pointerId, point, origin: { ...view }, moved: false };
  });
  bind('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId || destroyed) return;
    const point = localPoint(event), dx = point[0] - gesture.point[0], dy = point[1] - gesture.point[1];
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    if (!gesture.moved) { gesture.moved = true; svg.setPointerCapture?.(event.pointerId); svg.dataset.dragging = 'true'; }
    const origin = project([gesture.origin.lon, gesture.origin.lat]);
    const [lon, lat] = inverse([origin[0] - dx / gesture.origin.zoom, origin[1] - dy / gesture.origin.zoom]);
    apply({ lon: clamp(lon, -180, 180), lat: clamp(lat, -90, 90), zoom: gesture.origin.zoom }, false);
  });
  const endPointer = (event, canceled = false) => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const old = gesture; gesture = null; delete svg.dataset.dragging;
    if (svg.hasPointerCapture?.(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    // Overlay events keep their own native click handlers. Only bare map/land
    // clicks use this geographic selection callback.
    if (!canceled && !old.moved && (event.target === svg || event.target?.closest?.('.map-geography'))) {
      const [lon, lat] = inverse(worldPoint(localPoint(event)));
      if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) onSelect(Object.freeze({ lon, lat, country: event.target?.closest?.('[data-country]')?.getAttribute('data-country') || null, event }));
    }
  };
  bind('pointerup', event => endPointer(event)); bind('pointercancel', event => endPointer(event, true));
  bind('lostpointercapture', event => endPointer(event, true));
  bind('keydown', event => {
    if (destroyed || event.ctrlKey || event.metaKey || event.altKey) return;
    const dx = 40 * 360 / WIDTH / view.zoom, dy = 40 * 180 / HEIGHT / view.zoom;
    const moves = { ArrowLeft: [-dx, 0], ArrowRight: [dx, 0], ArrowUp: [0, dy], ArrowDown: [0, -dy] };
    if (moves[event.key]) { event.preventDefault(); const [x, y] = moves[event.key]; apply({ lon: clamp(view.lon + x, -180, 180), lat: clamp(view.lat + y, -90, 90) }); }
    else if (['+', '='].includes(event.key)) { event.preventDefault(); zoomAt(1.4); }
    else if (event.key === '-') { event.preventDefault(); zoomAt(1 / 1.4); }
    else if (event.key === 'Home') { event.preventDefault(); apply({ lon: 0, lat: 0, zoom: 1 }); }
  });
  const api = {
    project, unproject(point) { if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) throw new TypeError('Use a finite projected point'); return inverse(point); },
    focus(lon, lat, zoom = 3) { coordinates([lon, lat]); return animate({ lon, lat, zoom }); },
    zoomBy: factor => zoomAt(factor, [WIDTH / 2, HEIGHT / 2], true, true), home: () => animate({ lon: 0, lat: 0, zoom: 1 }),
    getView: state, setView: next => apply(next),
    destroy() {
      if (destroyed) return; destroyed = true; controller.abort(); clearTimeout(deadline);
      if (frame !== null) windowRef.cancelAnimationFrame(frame); frame = null; flight = null;
      const active = gesture; gesture = null; if (active && svg.hasPointerCapture?.(active.id)) svg.releasePointerCapture(active.id);
      cleanup.splice(0).reverse().forEach(dispose => dispose()); defs.remove(); geography.remove(); if (createdWorld) world.remove();
      delete svg.dataset.dragging; delete svg.dataset.mapState; svg.style.touchAction = previousTouchAction;
      for (const [key, value] of original) value === null ? svg.removeAttribute(key) : svg.setAttribute(key, value);
    },
  };
  // Initial callbacks occur after the controller has been returned to its owner.
  world.setAttribute('transform', state().transform);
  deadline = setTimeout(() => controller.abort(), 10000);
  api.ready = fetch(new URL('./world.json', import.meta.url), { signal: controller.signal, credentials: 'omit' })
    .then(response => readGeography(response, controller.signal)).then(value => {
      const paths = geographyPaths(value); if (destroyed) throw new DOMException('Map closed', 'AbortError');
      const maskPath = make('path', { d: paths.map(country => country.path).join(''), 'clip-rule': 'evenodd' }); mask.append(maskPath);
      for (const country of paths) {
        const path = make('path', { d: country.path, class: 'map-country', 'data-country': country.name, fill: '#10232e',
          'fill-rule': 'evenodd', stroke: '#35515c', 'stroke-width': .65, 'vector-effect': 'non-scaling-stroke' });
        const title = make('title'); title.textContent = country.name; path.append(title); geography.append(path);
      }
      geography.append(make('rect', { width: WIDTH, height: HEIGHT, fill: `url(#${prefix}-dots)`,
        'clip-path': `url(#${prefix}-land)`, 'pointer-events': 'none', class: 'map-land-dots' }));
      svg.dataset.mapState = 'ready'; if (frame !== null) windowRef.cancelAnimationFrame(frame); render(); return api;
    }).catch(error => { if (!destroyed) svg.dataset.mapState = 'unavailable'; throw error; })
    .finally(() => clearTimeout(deadline));
  return api;
}
