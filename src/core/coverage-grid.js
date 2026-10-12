/** Acquisition coverage sectors are separate from the finer display grid. */
export const COVERAGE_GRID = Object.freeze({ columns: 12, bands: 10, sectors: 120 });
export function coverageSector(id) {
  if (!Number.isInteger(id) || id < 1 || id > COVERAGE_GRID.sectors) throw new TypeError('Invalid coverage sector');
  const column = (id - 1) % COVERAGE_GRID.columns, band = Math.floor((id - 1) / COVERAGE_GRID.columns);
  const latitude = edge => Math.asin(-1 + 2 * edge / COVERAGE_GRID.bands) * 180 / Math.PI;
  return Object.freeze({ id, column, band, bounds: Object.freeze({ west: -180 + column * 30, east: -150 + column * 30,
    south: latitude(band), north: latitude(band + 1) }) });
}
export function coverageSectorAt(point) {
  if (!Number.isFinite(point?.lon) || !Number.isFinite(point.lat) || Math.abs(point.lon) > 180 || Math.abs(point.lat) > 90) return null;
  const lon = ((point.lon + 180) % 360 + 360) % 360 - 180;
  const column = Math.floor((lon + 180) / 30);
  const band = Math.min(9, Math.max(0, Math.floor((Math.sin(point.lat * Math.PI / 180) + 1) * 5)));
  return band * COVERAGE_GRID.columns + column + 1;
}
/** A coarse center sector is sufficient for functional interest; precise
 * visitor positions, camera coordinates and identity are never transmitted. */
export function coverageDemandSectors(demand) {
  if (!demand || !['country', 'region', 'local'].includes(demand.tier) || demand.extraction?.reason) return [];
  const id = coverageSectorAt(demand.center);
  return id === null ? [] : [id];
}
