# Earth Observer

A globe for public Earth observation feeds. Sources, timestamps, uncertainty,
and attribution stay visible. No cinematic filters, invented road traffic,
voice control, or local credential setup.

The static interface paints while the 3D engine loads. Production builds
precompress text and JSON Lines using Brotli and gzip, cache versioned engine
assets, and validate other assets with ETags. Layer code warms on hover or
keyboard focus when the connection allows it; data loads only after enabling
that layer. Shared scene services initialize only when needed. Loading labels
reflect actual requests and tile queues; existing data stays visible during
refreshes. Large camera, fire, and infrastructure point sets prepare in batches to keep controls
responsive.

The interface loads each layer on demand. Measured vehicle locations stay at
their reported positions between updates. Satellite positions are predictions
from dated orbital elements. Camera views are real licensed stills. Fire data
without a NASA key is explicitly labeled as an archived sample.

## Run locally

Use Node 24.14 or newer in the Node 24 release line, or Node 26.

```sh
npm ci
npm run dev
```

Open `http://localhost:4174`. Search supports coordinates and an offline city
catalog. Select entities for details; share links preserve the view and layers.

## Host online

```sh
npm ci
npm test
npm run build
HOST=0.0.0.0 PORT=8080 npm start
```

On Windows, set `HOST` and `PORT` using your shell or host configuration.
The production server serves `dist/` and the same-origin `/api/` providers.
Deploy this Node service behind your host's HTTPS ingress; serving `dist/`
alone will omit the API-dependent layers. `/healthz` is the health check.
There is no paid platform, login requirement, or external font dependency.

```sh
docker build -t earth-observer .
docker run --rm -p 8080:8080 earth-observer
```

Persist `.cache/` when deploying. CelesTrak results cache for six hours;
non-200 upstream responses pause requests until an operator resolves the
cause and removes `.cache/celestrak-stopped.json`. Restarts preserve that stop.
Other feeds use bounded shared caches and provider-specific refresh intervals.
Set `TRUSTED_PROXY_ADDRESSES` only to the actual socket addresses of your
trusted ingress, which must append or overwrite `X-Forwarded-For`. Otherwise
API requests share a limit per connecting socket address (240 per minute).

Optional provider configuration is documented in `.env.example` and
[the data policy](docs/DATA_POLICY.md). Set environment variables in the host;
the production server does not read or write `.env` files. Defaults use
explicit camera, transit, and bikeshare allowlists. Operator-specific keys or
agreements are never inferred from a public endpoint being reachable.

## Source and data rights

This project is derived from
[Bilawal Sidhu's original repository](https://github.com/bilawalsidhu/gods-eye-view).
The original copyright and MIT grant remain in [LICENSE](LICENSE).
Provider data and bundled datasets have separate terms, described in
[DATA_POLICY.md](docs/DATA_POLICY.md). Free hosting does not waive those terms.
ODbL source extracts remain available in `src/data/local_data/` with attribution
and share-alike obligations. NASA imagery and data, USGS, NOAA, ECMWF,
OpenStreetMap, and every selected provider must retain their applicable credits.

The app excludes OpenSky operational feeds, unlicensed vessel data, Google and
Esri imagery, commercial-only enrichment, noncommercial event/cable assets,
and providers without adequate documented permissions for this baseline.

Tests cover layer cancellation/disposal, polling suspension, view links,
provider allowlists, production routing, bounded feed bodies, shared caches,
and upstream failure behavior. Third-party availability, geographic coverage,
and provider capacity still determine which live data can be displayed.
