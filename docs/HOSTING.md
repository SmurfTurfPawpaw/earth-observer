# Hosting Earth Observer

The combined Sites deployment mounts Earth Observer at
`https://giovannicallebaut.com/earth/` and retains the personal site's existing
routes. The entry dispatches `/earth/*` to `createEarthRuntime()`, using the approved
embedded production assets. It reserves `/api/*` for Earth Observer and rewrites
those paths to `/earth/api/*` before dispatch; providers continue using their
canonical `/api/*` URLs. `/earth/healthz` checks the mount without acquiring feeds.

## Build and publish the combined site

Use the approved portfolio snapshot and the current Earth Observer checkout.
Do not replace the portfolio with the standalone Earth document. First run
`npm ci` and `npm test`, then build the mounted app:

```powershell
$env:EARTH_BASE_PATH = '/earth/'
npm run build
node scripts/worker-assets.mjs
```

The asset script generates `worker-dist/assets.js` from public production files.
The combined entry bundles it with the portable Worker runtime and the existing
portfolio handler. Publish that reviewed combined artifact to the existing Sites
project `appgprj_6ac8f0348bd88191af3151d9d31fb388`; retain the custom domain.
Validate the final artifact's source size, startup and memory limits, then check
the portfolio, `/earth/`, assets, health check and enabled provider routes.
The Node/ecCodes wind decoder belongs in the scheduled job, not this Worker.

## Bindings and authentication

Configure a private R2 binding named `EARTH_STORE` in the Sites hosting manifest
(`r2: "EARTH_STORE"`). It retains satellite provider policy under `providers/`,
verified wind snapshots under `wind/`, and moderated contributions under
`evidence/`. R2 is required for satellite acquisition and public contribution
storage. It is not a public bucket, and pending photos have no public route.

Pass `handleEvidence` in the runtime's `handlers` array. Public reads expose only
approved contributions. Submission identity uses `oai-authenticated-user-id`
from the trusted Sites gateway. The gateway must discard caller-supplied identity
headers before setting its own. A direct standalone deployment must add an actual
authentication adapter before enabling these writes; trusting a browser header
does not authenticate a user. Moderation also requires the server-side
`EARTH_MODERATION_KEY` bearer secret.

Configure `OVERPASS_UPSTREAMS` only for an owned or contracted endpoint permitted
to handle this traffic. With no endpoint, detailed OSM queries return an explicit
unavailable state and do not contact public instances. Set optional source keys
and provider terms flags in bindings, never in the browser build. See
[DATA_POLICY.md](DATA_POLICY.md) for the approved source and credential rules.

## Cadence, persistence and limits

| Data | Acquisition and retention |
| --- | --- |
| Aircraft | Shared 30-second cache; bounded geographic requests |
| Satellite elements | Six-hour cache; persistent two-hour attempt reservation; any non-200 persists a provider stop |
| Launch schedules | 15-minute cache; one-minute minimum retry gap |
| Official hazard context | USGS five-minute cache; GDACS ten minutes; provider gaps and exponential backoff |
| Scheduled GDELT metadata | Three fixed queries every 30 minutes; one shared 1 MiB release snapshot; local title filters; unavailable beyond 24-hour generation age |
| World Bank facts | Annual observations; daily acquisition cache; retrieval age shown; stale fallback limited to seven days |
| Wind forecasts | Scheduled six-hour publication; Worker checks releases every 15 minutes; five-minute failure gap; unavailable beyond 72-hour retrieval age |
| FIRMS | Dated bundled sample without a key; optional live source uses 30-minute cache and five-minute failure gap |
| Detailed OSM context | 24-hour cache; two concurrent acquisitions; 4 MiB response and 8 MiB cache byte caps |

The Worker API admits 240 requests per connecting IP per minute and 4,000 total
per instance. These are instance admission controls, not a distributed quota.
Most provider caches are per instance, supplemented by the edge cache; satellite
attempt reservations and stops persist across instances in R2. No startup sweep
fetches all feeds. Browser polling suspends when hidden, and public edge caching
excludes credentials, private responses and errors. Cached data retains explicit
age and availability states.

The wind job publishes six checked manifest/grid pairs to the repository's fixed
`wind-data` release. Verified grids persist in R2 so a different Worker instance
can serve an existing versioned URL. Release mismatches or outages retain a labeled
last-good snapshot. Add a bucket lifecycle rule for **only `wind/`**, retaining
objects for at least three days; provider-stop and evidence objects must survive
that cleanup. Details and publication checks are in
[WIND_SNAPSHOTS.md](WIND_SNAPSHOTS.md).

The discovery job publishes `intelligence-data/gdelt.snapshot.json` only after all
three fixed queries validate. Its last-good snapshot persists through `EARTH_STORE`
under `providers/`. Country/topic filtering applies to that bounded title sample,
not an exhaustive news search. `GDELT_LIVE_FALLBACK` is absent by default; set it to
`1` only for a controlled live fallback when the snapshot is unavailable. See
[GDELT_SNAPSHOTS.md](GDELT_SNAPSHOTS.md).

## Standalone Node hosting

Use Node 24.14+ in the Node 24 line, or Node 26. Build at the root base path:

```powershell
Remove-Item Env:EARTH_BASE_PATH -ErrorAction SilentlyContinue
npm ci
npm test
npm run build
$env:HOST = '0.0.0.0'
$env:PORT = '8080'
npm start
```

Serve this Node process behind HTTPS. It serves both `dist/` and same-origin
providers; static-only hosting omits API layers. Its health check is `/healthz`.
Persist `.cache/` for satellite policy and data. Set `TRUSTED_PROXY_ADDRESSES`
to the actual trusted ingress socket addresses before accepting forwarded client
IPs. The production process does not load or write `.env`; configure its environment
through the host. Public submissions require the separate authenticated Worker
extension or an equivalent authenticated backend.

See [WORKER_RUNTIME.md](WORKER_RUNTIME.md) for the mount API and targeted runtime
tests. Neither a successful local build nor these tests confirms publication;
verify the deployed combined artifact and live routes after publishing.
