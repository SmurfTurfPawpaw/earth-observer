import { Credit, Event, Request, RequestScheduler, WebMercatorTilingScheme } from 'cesium';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { readResponseBytesCapped, readResponseJsonCapped } from '../sources/httpBody.js';

export const OPEN_FREE_MAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OPEN_FREE_MAP_CREDIT = '<a href="https://openfreemap.org/">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>';
const SIZE = 256, MAX_BYTES = 4 * 1024 * 1024, MAX_FEATURES = 30000, MAX_POINTS = 200000;
const LAYERS = ['landcover', 'landuse', 'park', 'water', 'waterway', 'building', 'boundary', 'transportation', 'place', 'transportation_name'];
const abortError = () => new DOMException('Map tile request cancelled', 'AbortError');
const cachedAt = (response) => {
  const value = Number(response.headers.get('x-earth-map-cached-at'));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};
const nameOf = (properties) => String(properties['name:en'] || properties.name_en || properties.name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);

export function validateOpenFreeMapMetadata(value) {
  const template = value?.tiles?.[0];
  if (typeof template !== 'string' || template.length > 512 || !['{z}', '{x}', '{y}'].every((token) => template.includes(token))) throw new Error('OpenFreeMap metadata is invalid');
  const url = new URL(template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
  if (url.origin !== 'https://tiles.openfreemap.org' || url.username || url.password || !url.pathname.startsWith('/planet/') || url.search || url.hash || !Number.isInteger(value.maxzoom) || value.maxzoom < 0 || value.maxzoom > 14 || Number(value.minzoom || 0) !== 0) throw new Error('OpenFreeMap metadata does not match the approved source');
  return { template, maxzoom: value.maxzoom };
}

/** Decode tile-local geometry only; no GeoJSON conversion, font, sprite or map SDK. */
export function decodeBasemapTile(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new Error('Map tile byte limit exceeded');
  const tile = new VectorTile(new PbfReader(bytes));
  const layers = {};
  let count = 0, points = 0;
  for (const name of LAYERS) {
    const layer = tile.layers[name];
    if (!layer) continue;
    count += layer.length;
    if (count > MAX_FEATURES) throw new Error('Map tile feature limit exceeded');
    if (!Number.isFinite(layer.extent) || layer.extent <= 0 || layer.extent > 65536) throw new Error('Map tile extent is invalid');
    const features = [];
    for (let index = 0; index < layer.length; index++) {
      const feature = layer.feature(index);
      if (!feature.type || feature.type > 3) continue;
      const geometry = feature.loadGeometry();
      for (const part of geometry) {
        points += part.length;
        if (points > MAX_POINTS) throw new Error('Map tile geometry limit exceeded');
        if (part.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new Error('Map tile geometry is invalid');
      }
      const p = feature.properties;
      features.push({ type: feature.type, geometry, properties: { class: p.class, subclass: p.subclass,
        brunnel: p.brunnel, admin_level: p.admin_level, disputed: p.disputed, rank: p.rank, capital: p.capital,
        name: nameOf(p), ref: String(p.ref || '').slice(0, 20) } });
    }
    layers[name] = { extent: layer.extent, features };
  }
  return { layers, featureCount: count, pointCount: points, bytesEstimate: points * 24 + count * 160 + bytes.byteLength };
}

export function nativeBasemapTile(x, y, level, maximum = 14) {
  if (![x, y, level].every(Number.isInteger) || level < 0 || level > 18 || x < 0 || y < 0 || x >= 2 ** level || y >= 2 ** level) throw new TypeError('Invalid map tile coordinates');
  const z = Math.min(level, maximum), scale = 2 ** (level - z);
  return { z, x: Math.floor(x / scale), y: Math.floor(y / scale), scale, offsetX: x % scale, offsetY: y % scale };
}

function placeStyle(properties, level) {
  const kind = properties.class, rank = properties.rank == null ? Infinity : Number(properties.rank);
  if (kind === 'country') {
    if (level < 1 || level > 4 || !Number.isFinite(rank) || rank < 0 || rank > level) return;
    return { size: level <= 2 ? 9 : 10, priority: rank, bold: true };
  }
  if (kind === 'city' || kind === 'town') {
    if (level < (kind === 'city' ? 5 : 8)) return;
    const maximumRank = level < 6 ? 1 : level < 7 ? 2 : level < 9 ? 4 : level < 11 ? 8 : Infinity;
    if (rank > maximumRank) return;
    return { size: kind === 'city' ? 10 : 9, priority: Number.isFinite(rank) ? rank + 5 : 25, bold: kind === 'city' };
  }
  if (kind === 'state' || kind === 'province') {
    if (level < 5 || level > 9 || level < 7 && (!Number.isFinite(rank) || rank > 3)) return;
    return { size: 9, priority: 30, bold: false };
  }
  if (['village', 'hamlet'].includes(kind) && level >= 12 || ['suburb', 'quarter', 'neighbourhood'].includes(kind) && level >= 13)
    return { size: 9, priority: 40, bold: false };
}
const labelLimit = (level) => level < 1 ? 0 : level < 3 ? 4 : level < 5 ? 6 : level < 9 ? 10 : level < 12 ? 16 : level < 14 ? 24 : 32;

/** A deliberately small original map style; labels use installed browser fonts. */
export function paintBasemapTile(decoded, tile, { canvasFactory = () => document.createElement('canvas') } = {}) {
  const canvas = canvasFactory(); canvas.width = SIZE; canvas.height = SIZE;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Map canvas is unavailable');
  context.fillStyle = '#22343e'; context.fillRect(0, 0, SIZE, SIZE);
  const layer = (name) => decoded.layers[name];
  const transform = (point, extent) => ({ x: point.x / extent * SIZE * tile.scale - tile.offsetX * SIZE,
    y: point.y / extent * SIZE * tile.scale - tile.offsetY * SIZE });
  function path(feature, extent) {
    context.beginPath();
    for (const part of feature.geometry) {
      for (let index = 0; index < part.length; index++) { const p = transform(part[index], extent); if (!index) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y); }
      if (feature.type === 3) context.closePath();
    }
  }
  function polygons(name, color, minLevel = 0) {
    const data = layer(name); if (!data || tile.level < minLevel) return;
    for (const feature of data.features) if (feature.type === 3) {
      const fill = typeof color === 'function' ? color(feature.properties) : color; if (!fill) continue;
      path(feature, data.extent); context.fillStyle = fill; context.fill('evenodd');
    }
  }
  polygons('landcover', (p) => ['wood', 'grass', 'wetland'].includes(p.class) ? '#2b473e' : p.class === 'ice' ? '#859da3' : null);
  polygons('landuse', (p) => ['residential', 'commercial', 'retail', 'industrial'].includes(p.class) ? '#2c3e48' : p.class === 'cemetery' ? '#2b473e' : null, 6);
  polygons('park', '#2b473e', 7); polygons('water', '#132b40'); polygons('building', '#43545d', 14);
  const waterways = layer('waterway');
  if (waterways && tile.level >= 9) for (const feature of waterways.features) if (feature.type === 2) { path(feature, waterways.extent); context.strokeStyle = '#34576b'; context.lineWidth = 1; context.stroke(); }
  const boundaries = layer('boundary');
  if (boundaries) for (const feature of boundaries.features) if (feature.type === 2 && (Number(feature.properties.admin_level) === 2 || tile.level >= 7 && Number(feature.properties.admin_level) <= 4)) {
    path(feature, boundaries.extent); context.strokeStyle = '#68818d'; context.lineWidth = 0.8; context.setLineDash(feature.properties.disputed ? [2, 3] : [5, 3]); context.stroke();
  }
  context.setLineDash([]);
  const roadWidth = (properties) => {
    const major = ['motorway', 'trunk'].includes(properties.class), primary = ['primary', 'secondary', 'tertiary'].includes(properties.class);
    if (properties.class === 'rail') return tile.level >= 9 ? 0.8 : 0;
    if (!major && !primary && tile.level < 12 || primary && tile.level < 7 || major && tile.level < 4) return 0;
    if (['path', 'track', 'service'].includes(properties.class) && tile.level < 14) return 0;
    return major ? tile.level >= 12 ? 3 : 1.6 : primary ? tile.level >= 13 ? 2 : 1.2 : tile.level >= 15 ? 1.8 : 0.8;
  };
  const roads = layer('transportation');
  if (roads) for (const pass of [0, 1]) for (const feature of roads.features) if (feature.type === 2) {
    const width = roadWidth(feature.properties); if (!width) continue;
    path(feature, roads.extent); context.lineWidth = width + (pass === 0 ? 1.2 : 0); context.lineJoin = 'round'; context.lineCap = 'round';
    context.strokeStyle = pass === 0 ? '#1c2a34' : ['motorway', 'trunk'].includes(feature.properties.class) ? '#c9b58d' : ['primary', 'secondary'].includes(feature.properties.class) ? '#afbab7' : '#6f8994';
    context.globalAlpha = feature.properties.brunnel === 'tunnel' ? 0.45 : 1; context.stroke();
  }
  context.globalAlpha = 1;
  const labels = [];
  const places = layer('place');
  if (places) for (const feature of places.features) if (feature.type === 1 && feature.properties.name) {
    const style = placeStyle(feature.properties, tile.level); if (!style) continue;
    const point = feature.geometry[0]?.[0]; if (!point) continue;
    const position = transform(point, places.extent);
    labels.push({ ...position, text: feature.properties.name, ...style });
  }
  const names = layer('transportation_name');
  if (names && tile.level >= 14) for (const feature of names.features) if (feature.type === 2 && feature.properties.name) {
    let anchor, longest = 0;
    for (const part of feature.geometry) for (let index = 1; index < part.length; index++) {
      const a = transform(part[index - 1], names.extent), b = transform(part[index], names.extent);
      const distance = Math.hypot(b.x - a.x, b.y - a.y), x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      if (distance > longest && x > 0 && x < SIZE && y > 0 && y < SIZE) { longest = distance; let angle = Math.atan2(b.y - a.y, b.x - a.x); if (angle > Math.PI / 2) angle -= Math.PI; if (angle < -Math.PI / 2) angle += Math.PI; anchor = { x, y, angle }; }
    }
    if (anchor) labels.push({ ...anchor, text: feature.properties.name, size: 8, priority: 100, segmentLength: longest });
  }
  const occupied = [], drawn = new Set(), limit = labelLimit(tile.level); context.textAlign = 'center'; context.textBaseline = 'middle';
  for (const label of labels.sort((a, b) => a.priority - b.priority || a.text.localeCompare(b.text))) {
    if (occupied.length >= limit) break;
    if (drawn.has(label.text) || label.x < 0 || label.x > SIZE || label.y < 0 || label.y > SIZE) continue;
    context.font = `${label.bold ? '600 ' : ''}${label.size}px system-ui, sans-serif`;
    const metrics = context.measureText(label.text);
    const inkWidth = Number.isFinite(metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) ? 2 * Math.max(Math.abs(metrics.actualBoundingBoxLeft), Math.abs(metrics.actualBoundingBoxRight)) : 0;
    const inkHeight = Number.isFinite(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) ? 2 * Math.max(Math.abs(metrics.actualBoundingBoxAscent), Math.abs(metrics.actualBoundingBoxDescent)) : 0;
    const width = Math.max(metrics.width, inkWidth) + 10, height = Math.max(label.size * 1.3, inkHeight) + 8;
    if (!Number.isFinite(width) || width <= 0 || label.segmentLength && label.segmentLength < width) continue;
    const cosine = Math.abs(Math.cos(label.angle || 0)), sine = Math.abs(Math.sin(label.angle || 0));
    const halfWidth = (width * cosine + height * sine) / 2, halfHeight = (width * sine + height * cosine) / 2;
    const box = { left: label.x - halfWidth, right: label.x + halfWidth, top: label.y - halfHeight, bottom: label.y + halfHeight };
    // Keep the full text and halo inside its tile, including rotated road names.
    // Omitting a seam-adjacent label is preferable to drawing isolated letters.
    if (box.left < 3 || box.right > SIZE - 3 || box.top < 3 || box.bottom > SIZE - 3) continue;
    if (occupied.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
    occupied.push(box); drawn.add(label.text); context.save(); context.translate(label.x, label.y); if (label.angle) context.rotate(label.angle);
    context.lineJoin = 'round'; context.lineWidth = 2; context.strokeStyle = '#1a2e3b'; context.fillStyle = '#edf4f3'; context.strokeText(label.text, 0, 0); context.fillText(label.text, 0, 0); context.restore();
  }
  return canvas;
}

/** Cesium imagery adapter with bounded shared tile reads, cancellation and raster cache. */
export async function createOpenFreeMapImageryProvider({ fetchImpl = (...args) => fetch(...args), canvasFactory,
  scheduler = RequestScheduler, metadata, signal, maxRasterEntries = 64, maxNativeBytes = 16 * 1024 * 1024,
  maxConcurrent = 4, onTile = () => {} } = {}) {
  const lifetime = new AbortController();
  const parentAbort = () => lifetime.abort(signal.reason);
  signal?.throwIfAborted(); signal?.addEventListener('abort', parentAbort, { once: true });
  const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(12000)]);
  let meta, savedMetadataAt = null, savedTileReads = 0, latestCachedAt = null;
  try {
    if (metadata) meta = validateOpenFreeMapMetadata(metadata);
    else {
      const response = await fetchImpl(OPEN_FREE_MAP_TILEJSON, { signal: combined, redirect: 'error', credentials: 'omit' });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenFreeMap metadata HTTP ${response.status}`); }
      meta = validateOpenFreeMapMetadata(await readResponseJsonCapped(response, 256 * 1024, combined));
      savedMetadataAt = cachedAt(response);
    }
    combined.throwIfAborted();
  } catch (error) { signal?.removeEventListener('abort', parentAbort); lifetime.abort(); throw error; }
  const nativeCache = new Map(), rasterCache = new Map(), flights = new Map(), jobs = new Set();
  let nativeBytes = 0, destroyed = false, enabled = true;
  function nativeValue(tile, ownerSignal) {
    ownerSignal.throwIfAborted();
    const key = `${tile.z}/${tile.x}/${tile.y}`, cached = nativeCache.get(key);
    if (cached) { nativeCache.delete(key); nativeCache.set(key, cached); return Promise.resolve(cached); }
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController(); flight = { controller, users: 0, settled: false };
      const ownedSignal = AbortSignal.any([controller.signal, lifetime.signal, AbortSignal.timeout(12000)]);
      flight.promise = (async () => {
        const url = meta.template.replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);
        const response = await fetchImpl(url, { signal: ownedSignal, redirect: 'error', credentials: 'omit' });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenFreeMap tile HTTP ${response.status}`); }
        const bytes = await readResponseBytesCapped(response, MAX_BYTES, ownedSignal);
        // Yield between network completion and bounded CPU work during navigation.
        await new Promise((resolve) => setTimeout(resolve, 0)); ownedSignal.throwIfAborted();
        const decoded = decodeBasemapTile(bytes); ownedSignal.throwIfAborted();
        const restoredAt = cachedAt(response);
        if (restoredAt) {
          savedTileReads = Math.min(1000000, savedTileReads + 1);
          latestCachedAt = Math.max(latestCachedAt || 0, restoredAt);
        }
        if (decoded.bytesEstimate <= maxNativeBytes && !destroyed) {
          nativeCache.set(key, decoded); nativeBytes += decoded.bytesEstimate;
          while (nativeBytes > maxNativeBytes) { const oldest = nativeCache.keys().next().value; nativeBytes -= nativeCache.get(oldest).bytesEstimate; nativeCache.delete(oldest); }
        }
        return decoded;
      })().finally(() => { flight.settled = true; if (flights.get(key) === flight) flights.delete(key); });
      flights.set(key, flight);
    }
    flight.users++;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(ownerSignal.reason);
      ownerSignal.addEventListener('abort', cancel, { once: true });
      flight.promise.then(resolve, reject).finally(() => ownerSignal.removeEventListener('abort', cancel));
    }).finally(() => { if (--flight.users === 0 && !flight.settled) flight.controller.abort(); });
  }
  const tilingScheme = new WebMercatorTilingScheme();
  return {
    tileWidth: SIZE, tileHeight: SIZE, minimumLevel: 0, maximumLevel: 18, tilingScheme, rectangle: tilingScheme.rectangle,
    hasAlphaChannel: false, errorEvent: new Event(), credit: new Credit(OPEN_FREE_MAP_CREDIT, true),
    tileDiscardPolicy: undefined, proxy: undefined,
    requestImage(x, y, level, cesiumRequest = new Request({ throttle: false, throttleByServer: true })) {
      if (destroyed || !enabled || lifetime.signal.aborted) return undefined;
      let tile;
      try { tile = { ...nativeBasemapTile(x, y, level, meta.maxzoom), level }; } catch (error) { return Promise.reject(error); }
      const key = `${level}/${x}/${y}`, cached = rasterCache.get(key);
      if (cached) { rasterCache.delete(key); rasterCache.set(key, cached); return Promise.resolve(cached); }
      if (jobs.size >= maxConcurrent) return undefined;
      const controller = new AbortController(), ownerSignal = AbortSignal.any([controller.signal, lifetime.signal]);
      cesiumRequest.url = meta.template.replace('{z}', tile.z).replace('{x}', tile.x).replace('{y}', tile.y);
      cesiumRequest.cancelFunction = () => controller.abort(abortError());
      cesiumRequest.requestFunction = async () => {
        const job = { controller, request: cesiumRequest }; jobs.add(job);
        try {
          const decoded = await nativeValue(tile, ownerSignal); ownerSignal.throwIfAborted();
          const canvas = paintBasemapTile(decoded, tile, { canvasFactory }); ownerSignal.throwIfAborted();
          rasterCache.set(key, canvas);
          while (rasterCache.size > maxRasterEntries) rasterCache.delete(rasterCache.keys().next().value);
          onTile(); return canvas;
        } finally { jobs.delete(job); }
      };
      return scheduler.request(cesiumRequest);
    },
    getTileCredits() { return undefined; },
    pickFeatures() { return undefined; },
    getStats: () => ({ nativeEntries: nativeCache.size, nativeBytes, rasterEntries: rasterCache.size, rasterBytes: rasterCache.size * SIZE * SIZE * 4, activeRequests: jobs.size,
      savedMetadataAt, savedTileReads, latestCachedAt }),
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) {
        for (const job of jobs) job.request.cancel?.();
        // Let Cesium mark requests CANCELLED before aborting their transport,
        // so hidden tiles remain retryable when the layer is shown again.
        scheduler.update?.();
      }
    },
    destroy() {
      if (destroyed) return; destroyed = true; enabled = false; lifetime.abort(abortError());
      for (const job of jobs) { job.request.cancel?.(); job.controller.abort(abortError()); }
      signal?.removeEventListener('abort', parentAbort); nativeCache.clear(); rasterCache.clear(); nativeBytes = 0;
    },
    isDestroyed: () => destroyed,
  };
}
