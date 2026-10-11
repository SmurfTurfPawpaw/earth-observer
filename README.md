# Earth Observer

A globe for public Earth observation feeds. Sources, timestamps, uncertainty,
and attribution stay visible. No cinematic filters, invented road traffic,
voice control, or local credential setup.

The personal-site edition lives at [giovannicallebaut.com/earth/](https://giovannicallebaut.com/earth/).
Browsing is public. It includes a compact collapsible interface, keyboard commands
(Ctrl/Cmd+K), named saved views, disaster/news discovery, official annual economic
facts, and a private evidence notebook. Public contributions require sign-in,
explicit publication consent, and a separate moderator's approval.

On a new visit the browser asks for location permission without blocking the globe.
When permission is granted, the app selects a rounded local position and a 10 km
area; searching a place works without sharing device location. Camera position,
radius and layer choices restore on reload. View preferences and private notes
stay in the browser; rounded map coordinates are used to acquire nearby feeds.
Raw searches, identity and precise location are excluded from the optional,
default-off topic-interest counter. It records only explicit searches for reviewed
subjects and selected country filters as bounded daily totals. Public summaries
require 300 actions and round down to 100-action buckets; these are not unique-user
counts. Private sessions and notebook contents are never uploaded by this counter.

The static interface paints while the 3D engine loads. Production builds
precompress text and JSON Lines using Brotli and gzip, cache versioned engine
assets, and validate other assets with ETags. Layer code warms on hover or
keyboard focus when the connection allows it; data loads only after enabling
that layer. Shared scene services initialize only when needed. Loading labels
reflect actual requests and tile queues; existing data stays visible during
refreshes. Large camera, fire, and infrastructure point sets prepare in batches to keep controls
responsive.

Bounded IndexedDB snapshots show saved observations immediately while background
requests update them. A scoped service worker retains the interface, required code
and a limited basemap cache for returning/offline visits. Optional module warming
stops on hidden tabs, data-saving connections and slow networks. Rendering pauses
when hidden and runs on demand otherwise. Saved scene previews remain labeled as
saved views while the real scene initializes. New locations, first visits and live
provider responses still require work; caching does not guarantee instant data.

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
Browsing has no login requirement or external font dependency. Community
publication uses the separate authenticated Worker extension.

The actual personal-site deployment bundles this application under `/earth/`
with its existing portfolio Worker. See [HOSTING.md](docs/HOSTING.md) and
[WORKER_RUNTIME.md](docs/WORKER_RUNTIME.md) for that deployment and storage.

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

## Intelligence, evidence and research

USGS and GDACS retain their observed/retrieved times. GDELT supplies only linked
news metadata through one scheduled public snapshot every 30 minutes; unavailable
or outdated sources are labeled. Related links are indicative matches, not
independent confirmation. World Bank indicators are annual facts with their own
reference years. Forecast wind grids refresh every six hours and retain model,
run, valid time and source credits; predictions are not measured wind.

- [Intelligence sources and limitations](docs/INTELLIGENCE_SOURCES.md)
- [Local metadata search and ranking](docs/DISCOVERY_SEARCH.md), [optional aggregate interest](docs/AGGREGATE_DEMAND.md), and [demand-guided sampling](docs/INTELLIGENCE_PRIORITY.md)
- [Economic facts](docs/ECONOMIC_FACTS.md), [scheduled news](docs/GDELT_SNAPSHOTS.md), and [forecast grids](docs/WIND_SNAPSHOTS.md)
- [Private/public evidence and moderation](docs/COMMUNITY.md)
- [Maxinomics research and exact coverage](docs/MAXINOMICS_RESEARCH.md): 65 dated videos in the requested window; official transcripts were unavailable. Unverified reposts and primary-source checks are distinguished explicitly.
- [Upstream feature review](docs/UPSTREAM_FEEDBACK.md) and [300-comment YouTube sample](docs/YOUTUBE_FEEDBACK.md)

The goal is an attributable investigation workspace. Neither this app nor a
creator's commentary can establish a claim merely by aggregating several links.
