const PATHS = Object.freeze({
  globe: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M3 12h18', 'M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z'],
  layers: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 12 9 5 9-5', 'm3 16 9 5 9-5'],
  sidebar: ['M3 4h18v16H3Z', 'M8 4v16', 'm14 9-3 3 3 3'],
  chevronLeft: ['m14 6-6 6 6 6'], chevronRight: ['m10 6 6 6-6 6'],
  search: ['M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', 'm15 15 6 6'],
  share: ['M21 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M9 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M21 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'm9 10 6-4', 'm9 14 6 4'],
  north: ['m12 3 6 17-6-4-6 4 6-17Z', 'M12 3v13'],
  plus: ['M12 5v14', 'M5 12h14'], minus: ['M5 12h14'],
  tilt: ['m4 16 5-10 11 10-5 5-11-5Z', 'm9 6 6 15'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  locate: ['M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z', 'M12 2v4', 'M12 18v4', 'M2 12h4', 'M18 12h4', 'M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z'],
  news: ['M5 3h16v17a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V7h2', 'M5 7v12', 'M9 7h8', 'M9 11h8', 'M9 15h3', 'M15 15h2'],
  notebook: ['M6 3h14v18H6V3Z', 'M3 7h5', 'M3 12h5', 'M3 17h5', 'M11 8h5', 'M11 12h5', 'M11 16h3'],
  person: ['M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z', 'M4 21v-2a8 8 0 0 1 16 0v2'],
  bookmark: ['M6 3h12v18l-6-4-6 4V3Z'],
  edit: ['m16 3 5 5-12 12-6 1 1-6L16 3Z', 'm13 6 5 5'],
  command: ['M8 8h8v8H8V8Z', 'M8 8H5a3 3 0 1 1 3-3v3Z', 'M16 8V5a3 3 0 1 1 3 3h-3Z', 'M16 16h3a3 3 0 1 1-3 3v-3Z', 'M8 16v3a3 3 0 1 1-3-3h3Z'],
  reset: ['M3 10a9 9 0 1 1 1 7', 'M3 4v6h6', 'M12 7v5l3 2'],
  refresh: ['M20 12a8 8 0 0 0-14-5', 'm6 3-1 4 4 1', 'M4 12a8 8 0 0 0 14 5', 'm18 21 1-4-4-1'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  info: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 11v6', 'M12 7h.01'],
  movement: ['m3 17 18-10', 'm3 7 18 10', 'M7 4 3 7l4 3', 'm17 14 4 3-4 3'],
  space: ['m8 4 12 12-4 4L4 8l4-4Z', 'm11 7 5-5 6 6-5 5', 'm7 11-5 5 6 6 5-5', 'm10 16-4 4'],
  environment: ['m3 19 6-13 4 8 3-5 5 10H3Z', 'm6 12 3 2 2-1'],
  weather: ['M7 17h10a4 4 0 0 0 0-8h-1a6 6 0 0 0-11 2 3 3 0 0 0 2 6Z', 'M8 20v1', 'M12 20v1', 'M16 20v1'],
  imagery: ['M3 4h18v16H3V4Z', 'm3 16 6-6 5 5 3-3 4 4', 'M17 8h.01'],
  infrastructure: ['M3 21V8h7v13', 'M10 21V3h11v18', 'M6 12h1', 'M6 16h1', 'M14 7h3', 'M14 11h3', 'M14 15h3', 'M2 21h20'],
  check: ['m5 12 4 4L19 6'],
});
export const ICON_NAMES = Object.freeze(Object.keys(PATHS));
const paths = (name) => { if (!PATHS[name]) throw new TypeError(`Unknown icon: ${name}`); return PATHS[name]; };
export function createIcon(name, documentRef = globalThis.document) {
  const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ui-icon' })) svg.setAttribute(key, value);
  for (const d of paths(name)) { const path = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
/** Build-time-only markup from the fixed icon set; no provider input is accepted. */
export function iconMarkup(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths(name).map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}
