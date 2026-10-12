import * as Cesium from 'cesium';

// Fixed source-category artwork: provider text never becomes SVG markup or a URL.
// Each distinct image is reused by Cesium's billboard collection texture atlas.
const PATHS = Object.freeze({
  seismic: 'M6 17h5l2-6 4 11 3-9 2 4h4',
  flood: 'M7 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M7 18c2-2 4-2 6 0s4 2 6 0 4-2 6 0M7 24c2-2 4-2 6 0s4 2 6 0 4-2 6 0',
  cyclone: 'M17 7c-8-1-13 8-8 14M25 13c3 7-4 14-11 11M10 9c6-5 15-1 15 6M19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  volcano: 'm6 25 7-12h6l7 12H6Zm7-12 3 3 3-3M16 9c-3-2 3-3 0-6',
  wildfire: 'M17 6c1 5 6 7 6 13a7 7 0 0 1-14 0c0-4 2-6 4-8 0 4 2 5 2 5 3-4 2-7 2-10Zm-1 13c-2 2-3 4-1 6 3 0 4-3 1-6Z',
  drought: 'M19 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM15 3V2M15 16v1M8 9H7M23 9h1M10 4 9 3M20 4l1-1M7 24h6l2-4 3 7 2-3h5',
  notice: 'm16 7 10 9-10 9L6 16l10-9ZM16 12v6M16 21h.01',
});
const IMAGES = Object.freeze(Object.fromEntries(Object.entries(PATHS).map(([kind, path]) => [kind,
  'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="8" fill="#15212c" stroke="#ffffff" stroke-opacity=".65" stroke-width="1.3"/><path d="${path}" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`)])));

export const MAP_SYMBOL_KINDS = Object.freeze(Object.keys(IMAGES));
export const mapSymbolImage = kind => IMAGES[kind] || IMAGES.notice;
const GDACS_TYPES = Object.freeze({ EQ: 'seismic', FL: 'flood', TC: 'cyclone', VO: 'volcano', WF: 'wildfire', DR: 'drought' });
export const gdacsMapSymbol = record => GDACS_TYPES[record?.eventType] || 'notice';
/** Color encodes only the reported alert declaration, never inferred impact. */
export const gdacsAlertColor = level => ({ green: '#9ddcc9', orange: '#d7b073', red: '#e79588' })[String(level ?? '').toLowerCase()] || '#d7b073';

/** Constant, centered screen symbols keep source positions and normal occlusion.
 * Distance scaling is bounded; it creates no geographic footprint or animation. */
export function createMapBillboard(kind, { color = Cesium.Color.WHITE, heightReference = Cesium.HeightReference.NONE } = {}) {
  return new Cesium.BillboardGraphics({
    image: mapSymbolImage(kind), color, width: 22, height: 22,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER, verticalOrigin: Cesium.VerticalOrigin.CENTER,
    heightReference, scaleByDistance: new Cesium.NearFarScalar(1000, 1, 20000000, .8),
  });
}
