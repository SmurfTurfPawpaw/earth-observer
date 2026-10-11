/** Public-hosting baseline. A layer is imported only when explicitly enabled. */
const layer = (id, name, category, description, source, sourceUrl, attribution, defaults = {}, detailedAttribution = '') =>
  Object.freeze({ id, name, category, description, source, sourceLabel: source, sourceUrl, attribution, detailedAttribution, defaults: Object.freeze(defaults) });

const ECMWF_ATTRIBUTION = 'This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF). ' +
  '<a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener">ECMWF Open Data</a> · ' +
  'This ECMWF data is published under a <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">Creative Commons Attribution 4.0 International (CC BY 4.0)</a> licence. ' +
  'Modified: resampled forecast wind, temperature and pressure fields, with animated wind display. ' +
  'ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use.';

export const LAYERS = Object.freeze([
  layer('flights', 'Aircraft', 'Movement', 'Observed aircraft around the current view. Coverage depends on public receivers.', 'adsb.lol', 'https://www.adsb.lol/', 'adsb.lol · ODbL', { models3d: false }),
  layer('military', 'Military aircraft', 'Movement', 'Aircraft classified as military by the public receiver feed.', 'adsb.lol', 'https://www.adsb.lol/', 'adsb.lol · ODbL', { models3d: false }),
  layer('transit', 'Public transit', 'Movement', 'Vehicle positions from the explicitly approved agency feed catalog.', 'Approved transit agencies', 'https://gtfs.org/', 'Attribution is shown for the selected agency'),
  layer('bikeshare', 'Bikeshare', 'Movement', 'Station locations and availability from approved GBFS feeds.', 'Approved GBFS operators', 'https://gbfs.org/', 'Attribution is shown for each approved operator'),
  layer('satellites', 'Satellites', 'Space', 'Predicted satellite positions from orbital elements, not live position measurements.', 'CelesTrak', 'https://celestrak.org/', 'CelesTrak · satellite.js', { catalog: 'curated' }),
  layer('rocket-launches', 'Space missions', 'Space', 'Published launch records at their real launch sites. Dates are mission schedules, not rocket positions.', 'The Space Devs', 'https://thespacedevs.com/', 'The Space Devs / Launch Library 2'),
  layer('earthquakes', 'Earthquakes · 24 hours', 'Environment', 'Recent earthquake reports from the USGS.', 'USGS', 'https://earthquake.usgs.gov/', 'U.S. Geological Survey'),
  layer('fire-perimeters', 'Wildfire perimeters', 'Environment', 'Published U.S. wildfire boundaries. Reporting may lag conditions.', 'NIFC WFIGS', 'https://data-nifc.opendata.arcgis.com/', 'NIFC / WFIGS'),
  layer('local-firms', 'Fire detections', 'Environment', 'An archived NASA FIRMS sample dated 2026-07-16. A provider key enables current detections.', 'NASA FIRMS', 'https://firms.modaps.eosdis.nasa.gov/', 'NASA FIRMS / NOAA-20 VIIRS'),
  layer('weather-radar', 'Rain radar · U.S.', 'Weather', 'Observed radar reflectivity in the contiguous United States.', 'NOAA / NWS', 'https://www.weather.gov/', 'NOAA / National Weather Service'),
  layer('weather-satellite', 'Satellite clouds', 'Weather', 'Infrared satellite imagery; observation time and coverage are shown.', 'NOAA / NASA', 'https://www.noaa.gov/', 'NOAA GOES / NASA GIBS'),
  layer('weather-lightning', 'Lightning density', 'Weather', 'A derived density product covering the Americas and Pacific.', 'NOAA / NWS', 'https://www.weather.gov/', 'NOAA / National Weather Service'),
  layer('wind', 'Forecast wind', 'Weather', 'GFS and ECMWF forecast fields with clearly labeled issue and valid times.', 'NOAA / ECMWF', 'https://www.ecmwf.int/en/forecasts/datasets/open-data', 'NOAA GFS · ECMWF open data CC BY 4.0', {}, ECMWF_ATTRIBUTION),
  layer('weather-cyclones', 'Tropical cyclones', 'Weather', 'Official forecast tracks for Atlantic and eastern/central North Pacific storms.', 'NOAA NHC / CPHC', 'https://www.nhc.noaa.gov/', 'NOAA National Hurricane Center / CPHC'),
  layer('recent-imagery', 'Recent satellite imagery', 'Imagery', 'Compare NASA HLS and VIIRS imagery for a small area in the current view.', 'NASA GIBS / HLS', 'https://earthdata.nasa.gov/', 'NASA GIBS · HLS · VIIRS'),
  layer('cctv', 'Public traffic cameras', 'Infrastructure', 'Only cameras in the approved, licensed provider catalog.', 'Approved public camera providers', '/DATA_POLICY.md', 'Attribution is shown for the selected source'),
  layer('alpr-cameras', 'Mapped ALPR locations', 'Infrastructure', 'Camera locations tagged in OpenStreetMap; no plate recognition or personal tracking.', 'OpenStreetMap', 'https://www.openstreetmap.org/copyright', '© OpenStreetMap contributors · ODbL'),
  layer('military-installations', 'Mapped military sites', 'Infrastructure', 'Publicly mapped sites from OpenStreetMap, not an authoritative facility inventory.', 'OpenStreetMap / OpenFreeMap', 'https://www.openstreetmap.org/copyright', '© OpenStreetMap contributors · ODbL'),
  layer('local-datacenters', 'Datacenters', 'Infrastructure', 'Bundled OpenStreetMap-derived datacenter locations.', 'OpenStreetMap', 'https://www.openstreetmap.org/copyright', '© OpenStreetMap contributors · ODbL'),
  layer('local-dams', 'Dams', 'Infrastructure', 'Bundled dam locations from Open Infrastructure Map and OpenStreetMap.', 'Open Infrastructure Map / OpenStreetMap', 'https://www.openstreetmap.org/copyright', 'Open Infrastructure Map · © OpenStreetMap contributors · ODbL'),
]);

export const LAYER_BY_ID = new Map(LAYERS.map((entry) => [entry.id, entry]));
