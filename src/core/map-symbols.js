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
export const MAP_SYMBOL_PATHS = PATHS;
export const MAP_SYMBOL_LABELS = Object.freeze({ seismic: 'Seismic', flood: 'Flooding', cyclone: 'Storms',
  volcano: 'Volcanic activity', wildfire: 'Wildfires', drought: 'Drought', notice: 'Other reports' });
const IMAGES = Object.freeze(Object.fromEntries(Object.entries(PATHS).map(([kind, path]) => [kind,
  'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="8" fill="#15212c" stroke="#ffffff" stroke-opacity=".65" stroke-width="1.3"/><path d="${path}" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`)])));

export const MAP_SYMBOL_KINDS = Object.freeze(Object.keys(IMAGES));
export const mapSymbolImage = kind => IMAGES[kind] || IMAGES.notice;
export const MAP_CLUSTER_BADGE_LIMITS = Object.freeze({ maximumCount: 500, entries: 64, bytes: 262144 });
// Fixed vector numerals avoid an external font load or an overlapping label.
// These image references are bounded here; a native billboard atlas is owned
// and released by the renderer's complete-edition lifecycle, independently.
const DIGITS = Object.freeze({
  0: 'M2 1h3c1 0 2 1 2 3v6c0 2-1 3-2 3H2c-1 0-2-1-2-3V4c0-2 1-3 2-3Z',
  1: 'M1 3 4 1v12M1 13h6',
  2: 'M0 3c0-3 7-3 7 0 0 3-7 5-7 8v2h7',
  3: 'M0 2c2-2 7-1 7 2 0 2-2 3-5 3 3 0 5 1 5 3 0 3-5 4-7 2',
  4: 'M5 13V1L0 9h7',
  5: 'M7 1H0v6h4c4 0 4 6 0 6H0',
  6: 'M7 2c-4-3-7 0-7 5v3c0 4 7 4 7 0 0-4-7-4-7 0',
  7: 'M0 1h7L2 13',
  8: 'M3.5 7C-1 7-1 1 3.5 1S8 7 3.5 7Zm0 0C-1 7-1 13 3.5 13S8 7 3.5 7Z',
  9: 'M0 12c4 3 7 0 7-5V4C7 0 0 0 0 4s7 4 7 0',
});
const badges = new Map(); let badgeBytes = 0;
/** A cell summary has an exact count, separate from its category glyph.
 * The returned image has no geography, source text, or inferred alert color. */
export function mapClusterBadge(count, symbol = 'notice') {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAP_CLUSTER_BADGE_LIMITS.maximumCount) {
    throw new RangeError('Cluster count must be an exact integer from 1 to 500');
  }
  const kind = Object.hasOwn(PATHS, symbol) ? symbol : 'notice', key = `${kind}:${count}`;
  if (badges.has(key)) { const saved = badges.get(key); badges.delete(key); badges.set(key, saved); return saved; }
  const digits = String(count), start = (48 - (digits.length * 10 - 3)) / 2;
  const numeral = [...digits].map((digit, index) =>
    `<path d="${DIGITS[digit]}" transform="translate(${start + index * 10} 25)"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="42" viewBox="0 0 48 42"><rect x="1" y="1" width="46" height="40" rx="10" fill="#15212c" stroke="#a8d8e8" stroke-width="1.5"/><path d="${PATHS[kind]}" transform="translate(14.4 1) scale(.6)" fill="none" stroke="#d9f4fb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="4" y="22" width="40" height="17" rx="5" fill="#e7f5fb"/><g fill="none" stroke="#15212c" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${numeral}</g></svg>`;
  const value = Object.freeze({ image: 'data:image/svg+xml,' + encodeURIComponent(svg), width: 48, height: 42 });
  const bytes = value.image.length * 2;
  while (badges.size && (badges.size >= MAP_CLUSTER_BADGE_LIMITS.entries || badgeBytes + bytes > MAP_CLUSTER_BADGE_LIMITS.bytes)) {
    const oldest = badges.keys().next().value; badgeBytes -= badges.get(oldest).image.length * 2; badges.delete(oldest);
  }
  badges.set(key, value); badgeBytes += bytes; return value;
}
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
