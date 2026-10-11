# Offline data fixtures

These files verify parsing and source behavior; they are not live feeds.

- `firms-viirs-noaa20-sample.csv` contains 45 NASA FIRMS NOAA-20 VIIRS detections dated 2026-07-16. `firms-csv-cases.json` exercises CSV edge cases. Credit: NASA FIRMS / NOAA-20 VIIRS; see the [NASA FIRMS citation guidance](https://firms.modaps.eosdis.nasa.gov/citation/).
- `ofm-austin-{14-3743-6745,12-935-1686}.pbf` and `ofm-camp-mabry-12-935-1685.pbf` are trimmed OpenFreeMap / OpenMapTiles fixtures retrieved 2026-09-23, preserving source geometry and dictionaries. Credit: OpenFreeMap, OpenMapTiles and © OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright).
- `traffic-road-access.json` contains representative OpenStreetMap transportation properties and original vertices near Austin, retrieved 2026-09-25. Each record identifies its source tile. This modified test database retains the same ODbL attribution and share-alike terms.
