# Worker runtime

`worker/index.js` exports `createEarthRuntime()`, a mountable Web API runtime for
the `/earth/` directory. It returns `null` for other routes, so the host can retain
its existing personal-site handler. Assets and `/earth/healthz` do not construct
providers or fetch datasets. Provider instances initialize on the first API request.

The host passes its approved asset handler as the fourth argument to
`runtime.fetch(request, env, ctx, assetsFetch)`. The runtime preserves manually
encoded compressed bodies. Build with `EARTH_BASE_PATH=/earth/`; the browser's
existing `/api/*` URLs need an outer dispatcher that rewrites the request path to
`/earth/api/*`. Providers receive the original canonical `/api/*` path, including
its search parameters. Requests retain headers and bodies.

Register authenticated extensions with
`createEarthRuntime({ handlers: [handleEvidence] })`. These run before the generic
GET-only provider restriction. `handleEvidence` owns its authentication, consent,
body limits and moderation rules. Its identity header must come from the trusted
Sites authentication gateway, rather than a caller-controlled direct deployment.

## Storage and configuration

- `EARTH_STORE`: private R2 binding. Provider policy/cache keys use `providers/`,
  immutable wind grids and manifests use `wind/`, and moderated contributions use
  `evidence/`. Neither pending contributions nor arbitrary objects have public routes.
- `EARTH_CACHE`: optional KV alternative for provider-policy records when R2 is
  unavailable. It does not support cross-instance atomic attempt reservations;
  the deployed R2 path uses conditional writes.
- `OVERPASS_UPSTREAMS`: explicitly configured owned or contracted endpoint(s).
  Absent configuration produces an honest unavailable response without contacting
  public Overpass infrastructure. The existing admission rules still bound queries.
- Provider credentials, including optional `FIRMS_MAP_KEY`, approved CCTV feed keys,
  `LL2_API_TOKEN` and `EARTH_MODERATION_KEY`, stay in Worker bindings.

Satellite downloads require persistent provider storage. R2 conditional writes
reserve attempts across instances, and a non-200 CelesTrak result persists a global
provider stop. An operator can inspect and clear that stop after resolving the
provider issue; restarts do not bypass it. See the [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
for the conditional-write and strong-consistency contract. No request-time database
schema creation or filesystem access is used.

## Forecasts and cache behavior

Wind reads six fixed manifest/grid pairs from the project's `wind-data` GitHub
release. It validates existing manifest rules, grid shape, byte limits and SHA-256
before serving them, then retains verified grids in R2 so another Worker instance
can serve a versioned grid URL. A failed release update can return a labeled
last-good snapshot; forecasts beyond 72 hours of retrieval age are unavailable.
See [WIND_SNAPSHOTS.md](WIND_SNAPSHOTS.md) for publication and real model timestamps.
Set a bucket lifecycle rule for the `wind/` prefix with retention of at least three
days to bound accumulated immutable grids; do not apply it to provider stop records
or contribution records.

The runtime uses Cloudflare's edge cache for successful public responses only.
Authorization, cookies, private/no-store responses and errors bypass it. Cached
feed age includes time spent in the edge cache. Cache read/write failures do not
turn successful network responses into failures. Browser snapshots remain separately
labeled by their own retrieval age.

Worker OSM context permits two concurrent acquisitions, caps each response at
4 MiB, and bounds its cache by both 40 entries and 8 MiB. Shared requests coalesce;
provider-specific timeouts and cooldowns remain in place. Transit history timers
are disabled in Worker mode. No full feed list is loaded at startup, and the Worker
bundle imports neither Node built-ins nor the ecCodes decoder.

Run `node --test worker/runtime.test.mjs` for mount boundaries, browser-platform
bundling, source normalization, conditional reservations, cross-instance satellite
policy, wind validation/restoration, cache failures and OSM memory bounds. Deployment
must also validate the final combined Worker artifact and its actual startup limits.
