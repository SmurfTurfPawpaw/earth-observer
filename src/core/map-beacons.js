import * as Cesium from 'cesium';
import { MAP_SYMBOL_PATHS } from './map-symbols.js';

export const BEACON_STYLE = Object.freeze({ policyId: 'surface-normal-category-beacons-v1', headPx: 24, basePx: 8,
  stemPx: 1.4, targetStemPx: 24, minimumHeightMetres: 6, maximumHeightMetres: 250000,
  durationMs: 320, maximumAnimated: 64, rememberedKeys: 1200, accent: '#78d9cc', warmAccent: '#e5b99a',
  heightMeaning: 'Decorative display height above the unchanged map anchor; not source altitude or affected extent' });
const artwork = new WeakMap(), coordinators = new WeakMap();
const glyph = symbol => Object.hasOwn(MAP_SYMBOL_PATHS, symbol) ? MAP_SYMBOL_PATHS[symbol] : MAP_SYMBOL_PATHS.notice;
const headSvg = symbol => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="#10202a" fill-opacity=".88" stroke="#c5f0e9" stroke-width="2"/><path d="${glyph(symbol)}" transform="translate(8 8) scale(1.5)" fill="none" stroke="#f4fffc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const baseSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="none" stroke="#a9e9de" stroke-width="3"/><circle cx="16" cy="16" r="3" fill="#e4fff7"/></svg>';
const dataUrl = value => 'data:image/svg+xml,' + encodeURIComponent(value);
const fallbackHeads = Object.freeze(Object.fromEntries(Object.keys(MAP_SYMBOL_PATHS).map(symbol => [symbol, dataUrl(headSvg(symbol))])));
const fallbackBase = dataUrl(baseSvg);

function texture(symbol, base, documentRef, Path = globalThis.Path2D) {
  const kind = Object.hasOwn(MAP_SYMBOL_PATHS, symbol) ? symbol : 'notice', key = base ? 'base' : kind;
  if (!documentRef?.createElement || !Path) return base ? fallbackBase : fallbackHeads[kind];
  let saved = artwork.get(documentRef); if (!saved) { saved = new Map(); artwork.set(documentRef, saved); }
  if (saved.has(key)) return saved.get(key);
  let image;
  try {
    const canvas = documentRef.createElement('canvas'); canvas.width = canvas.height = base ? 32 : 64;
    const context = canvas.getContext('2d'); if (!context) throw Error('Canvas unavailable');
    context.lineCap = context.lineJoin = 'round';
    if (base) {
      context.strokeStyle = '#a9e9de'; context.lineWidth = 3; context.beginPath(); context.arc(16, 16, 12, 0, Math.PI * 2); context.stroke();
      context.fillStyle = '#e4fff7'; context.beginPath(); context.arc(16, 16, 3, 0, Math.PI * 2); context.fill();
    } else {
      context.fillStyle = 'rgba(16,32,42,.88)'; context.strokeStyle = '#c5f0e9'; context.lineWidth = 2;
      context.beginPath(); context.arc(32, 32, 26, 0, Math.PI * 2); context.fill(); context.stroke();
      context.translate(8, 8); context.scale(1.5, 1.5); context.strokeStyle = '#f4fffc'; context.lineWidth = 2;
      context.stroke(new Path(glyph(kind)));
    }
    image = canvas;
  } catch { image = base ? fallbackBase : fallbackHeads[kind]; }
  saved.set(key, image); return image;
}
export function beaconHeadOptions(symbol = 'notice', { documentRef = globalThis.document, Path2DRef = globalThis.Path2D } = {}) {
  return { image: texture(symbol, false, documentRef, Path2DRef), width: BEACON_STYLE.headPx, height: BEACON_STYLE.headPx,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.CENTER };
}
export function beaconBaseOptions({ documentRef = globalThis.document, Path2DRef = globalThis.Path2D } = {}) {
  return { image: texture('notice', true, documentRef, Path2DRef), width: BEACON_STYLE.basePx, height: BEACON_STYLE.basePx,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.CENTER };
}

/** Source longitude/latitude/height are copied, never edited. A later terrain
 * adapter can supply its separately derived display anchor height. */
export function beaconGeometry(viewer, coordinates) {
  if (!Array.isArray(coordinates) || ![2, 3].includes(coordinates.length) || !coordinates.every(Number.isFinite) ||
      Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new TypeError('Use finite geographic beacon coordinates');
  const base = Cesium.Cartesian3.fromDegrees(coordinates[0], coordinates[1], coordinates[2] || 0);
  const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(base, new Cesium.Cartesian3());
  let pixelMetres = 1;
  try {
    const canvas = viewer.canvas || viewer.scene.canvas;
    const cssWidth = canvas?.clientWidth, cssHeight = canvas?.clientHeight;
    const cssSized = Number.isFinite(cssWidth) && cssWidth > 0 && Number.isFinite(cssHeight) && cssHeight > 0;
    const width = cssSized ? cssWidth : viewer.scene.drawingBufferWidth || canvas?.width;
    const height = cssSized ? cssHeight : viewer.scene.drawingBufferHeight || canvas?.height;
    const sphere = new Cesium.BoundingSphere(base, 0);
    let value;
    if (cssSized && typeof viewer.camera.distanceToBoundingSphere === 'function' && typeof viewer.camera.frustum?.getPixelDimensions === 'function') {
      // Camera.getPixelSize applies Cesium's physical pixel ratio. Project with
      // density one so this decorative height targets CSS rather than GPU pixels.
      const size = viewer.camera.frustum.getPixelDimensions(width, height, viewer.camera.distanceToBoundingSphere(sphere), 1, new Cesium.Cartesian2());
      value = Math.max(size.x, size.y);
    } else value = viewer.camera.getPixelSize(sphere, width, height);
    if (Number.isFinite(value) && value > 0) pixelMetres = value;
  } catch { /* A bounded small stem is valid before camera projection is ready. */ }
  const heightMetres = Math.min(BEACON_STYLE.maximumHeightMetres, Math.max(BEACON_STYLE.minimumHeightMetres, pixelMetres * BEACON_STYLE.targetStemPx));
  const tip = Cesium.Cartesian3.add(base, Cesium.Cartesian3.multiplyByScalar(normal, heightMetres, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  return Object.freeze({ base: Object.freeze(base), tip: Object.freeze(tip), normal: Object.freeze(normal), heightMetres, heightMeaning: BEACON_STYLE.heightMeaning });
}
export function beaconTipAt(geometry, progress, result = new Cesium.Cartesian3()) {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1 || [geometry.base, geometry.tip, geometry.normal].includes(result))
    throw new TypeError('Use a bounded beacon rise without mutating its anchor');
  Cesium.Cartesian3.multiplyByScalar(geometry.normal, geometry.heightMetres * progress, result);
  return Cesium.Cartesian3.add(geometry.base, result, result);
}
export function beaconStemOptions(geometry, { id } = {}) {
  // Each native Polyline destroys its material; only the shader type is shared.
  const material = Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(BEACON_STYLE.accent).withAlpha(.65) });
  return { id, positions: [geometry.base, geometry.tip], width: BEACON_STYLE.stemPx, material };
}

/** One short-lived frame listener for all beacon owners. Source clocks,
 * camera movement and minute attention editions never drive this animation. */
export function beaconAnimatorFor(viewer, { documentRef = globalThis.document, now = () => performance.now() } = {}) {
  if (!viewer?.scene?.preRender?.addEventListener || typeof viewer.scene.requestRender !== 'function') throw new TypeError('A native scene is required');
  if (coordinators.has(viewer)) return coordinators.get(viewer);
  const owners = new Set(), jobs = new Map(), seen = new Map(); let stopFrames, stopEvents, errors = 0, closed = false;
  const windowRef = documentRef?.defaultView || globalThis.window;
  const motion = windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const live = () => !viewer.isDestroyed?.() && !documentRef?.hidden && !motion?.matches && viewer.earthTime?.getState?.()?.mode !== 'history';
  const valid = job => { try { return owners.has(job.owner) && !viewer.isDestroyed?.() && job.isCurrent(); } catch { errors++; return false; } };
  const apply = (job, progress) => { if (!valid(job)) return; try { job.apply(progress); } catch { errors++; jobs.delete(job.key); } };
  const stop = () => { if (!jobs.size && stopFrames) { stopFrames(); stopFrames = undefined; } };
  const settle = owner => { for (const [key, job] of [...jobs]) if (!owner || job.owner === owner) { apply(job, 1); jobs.delete(key); } stop(); };
  const changed = () => { if (!live()) settle(); };
  const tick = () => {
    if (!live()) { settle(); return; }
    const time = now();
    for (const [key, job] of [...jobs]) {
      if (!valid(job)) { jobs.delete(key); continue; }
      const elapsed = Math.max(0, time - job.started), fraction = Math.min(1, elapsed / BEACON_STYLE.durationMs);
      apply(job, 1 - (1 - fraction) ** 3); if (fraction === 1) jobs.delete(key);
    }
    stop(); if (jobs.size) viewer.scene.requestRender();
  };
  const remember = (key, revision) => { seen.delete(key); seen.set(key, revision);
    while (seen.size > BEACON_STYLE.rememberedKeys) seen.delete(seen.keys().next().value); };
  const coordinator = {
    acquire(ownerKey) {
      if (closed || typeof ownerKey !== 'string' || ownerKey.length > 64 || !ownerKey) throw new TypeError('Use a live named beacon owner');
      const owner = Symbol(ownerKey); owners.add(owner);
      if (!stopEvents) {
        documentRef?.addEventListener?.('visibilitychange', changed); motion?.addEventListener?.('change', changed);
        windowRef?.addEventListener?.('earth-observer:timechange', changed);
        stopEvents = () => { documentRef?.removeEventListener?.('visibilitychange', changed); motion?.removeEventListener?.('change', changed);
          windowRef?.removeEventListener?.('earth-observer:timechange', changed); };
      }
      let released = false;
      return {
        play({ key, revision = null, apply: callback, isCurrent = () => true }) {
          if (released || typeof key !== 'string' || !key || key.length > 256 || !(revision === null || typeof revision === 'string' && revision.length > 0 && revision.length <= 160) ||
              typeof callback !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Use a bounded factual beacon identity');
          const signature = revision === null ? 'first-appearance-only' : revision, first = !seen.has(key) || seen.get(key) !== signature;
          const job = { key, owner, apply: callback, isCurrent, started: now() };
          if (!valid(job)) return () => {};
          if (jobs.has(key)) { const previous = jobs.get(key); apply(previous, 1); jobs.delete(key); }
          remember(key, signature);
          if (!first || !live() || jobs.size >= BEACON_STYLE.maximumAnimated) { apply(job, 1); stop(); return () => {}; }
          jobs.set(key, job); apply(job, 0);
          if (!stopFrames && jobs.size) stopFrames = viewer.scene.preRender.addEventListener(tick);
          if (jobs.size) viewer.scene.requestRender();
          return () => { if (jobs.get(key) === job) { apply(job, 1); jobs.delete(key); stop(); } };
        },
        settle() { if (!released) settle(owner); },
        destroy() { if (released) return; settle(owner); released = true; owners.delete(owner);
          if (!owners.size) { stopEvents?.(); stopEvents = undefined; seen.clear(); closed = true; coordinators.delete(viewer); } },
      };
    },
    getState: () => ({ active: jobs.size, remembered: seen.size, owners: owners.size, frameListener: Boolean(stopFrames), errors,
      maximumAnimated: BEACON_STYLE.maximumAnimated, durationMs: BEACON_STYLE.durationMs }),
  };
  coordinators.set(viewer, coordinator); return coordinator;
}
