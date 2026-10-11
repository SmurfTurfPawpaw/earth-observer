/** Reviewed product-integration feeds only; operator-host wildcards are absent. */
const APPROVED_SYSTEMS = [
  { id: 'nyc-citibike', city: 'New York, NY', centerLat: 40.7484, centerLon: -73.9967, loadRadiusKm: 140, system: 'bkn', provider: 'New York bikeshare', licenseUrl: 'https://citibikenyc.com/data-sharing-policy' },
  { id: 'chicago-divvy', city: 'Chicago, IL', centerLat: 41.8781, centerLon: -87.6298, loadRadiusKm: 120, system: 'chi', provider: 'Chicago bikeshare', licenseUrl: 'https://divvybikes.com/data-license-agreement' },
  { id: 'dc-capital-bikeshare', city: 'Washington, DC', centerLat: 38.9072, centerLon: -77.0369, loadRadiusKm: 120, system: 'dca-cabi', provider: 'Washington bikeshare', licenseUrl: 'https://capitalbikeshare.com/data-license-agreement' },
];

export const GBFS_CITY_REGISTRY = Object.freeze(APPROVED_SYSTEMS.map(({ system, ...entry }) => Object.freeze({
  ...entry,
  stationInformationUrl: `https://gbfs.lyft.com/gbfs/2.3/${system}/en/station_information.json`,
  stationStatusUrl: `https://gbfs.lyft.com/gbfs/2.3/${system}/en/station_status.json`,
  hosts: Object.freeze(['gbfs.lyft.com']),
})));

export const CITY_BY_ID = new Map(GBFS_CITY_REGISTRY.map((entry) => [entry.id, entry]));
