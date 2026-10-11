# Hosted wind snapshots

The Cloudflare Worker serves compact, precomputed weather grids from this repository’s `wind-data` GitHub release. It does not fetch GRIB messages or initialize ecCodes in a visitor request. The Node hosting path continues to use its bounded provider directly.

[`wind-data.yml`](../.github/workflows/wind-data.yml) runs at 00:17, 06:17, 12:17 and 18:17 UTC, or by manual workflow dispatch. It uses the repository’s own `GITHUB_TOKEN` with release-write permission; neither NOAA nor ECMWF Open Data requires a provider API key for these selected files. The scheduled job runs only in `SmurfTurfPawpaw/earth-observer`.

[`wind-snapshot.mjs`](../scripts/wind-snapshot.mjs) mounts the existing Node wind provider on a temporary loopback server, reuses the browser source validator, and generates both supported models and every supported overlay. Model selection uses a single generation reference time, so crossing a cycle boundary cannot mix issue times between a model’s overlays. The server listens only on `127.0.0.1` and closes when generation finishes or fails. Repeated index and GRIB byte ranges are coalesced and reused within the run under a 32 MiB retained-data cap. Individual upstream messages remain capped at 8 MiB.

## Release contract

The release contains these **12 fixed-name assets**, replacing the previous set instead of accumulating forecast binaries in Git history:

| Model | Manifest / grid stems |
| --- | --- |
| NOAA GFS | `gfs-none`, `gfs-temperature`, `gfs-pressure` |
| ECMWF IFS Open Data | `ifs-none`, `ifs-temperature`, `ifs-pressure` |

Each stem has a `.manifest.json` and `.grid.bin` file. For example, `ifs-temperature.manifest.json` references the ordinary same-origin API grid route while the Worker fetches the matching `ifs-temperature.grid.bin` release asset. The API `gridUrl` and ID remain compatible with the existing browser source.

All grids are global **360 × 181 points at 1° spacing**, starting at longitude 0° / latitude 90°, with rows proceeding south. The binary layout is little-endian Float32 values: all eastward U wind values, then all northward V wind values, then optional scalar values. Wind units are m/s; scalar temperature is °C at 2 m and pressure is hPa at mean sea level. Wind-only grids are 521,280 bytes; scalar grids are 781,920 bytes. Every grid stays below the 3 MiB hosted cap, every manifest below 16 KiB, and non-finite values are rejected.

Each manifest retains `schemaVersion: 1`, model, overlay, scalar metadata, grid geometry and cycle date/hour/forecast step. It adds `gridSha256`, the lowercase SHA-256 digest of the exact binary asset, `publishedAt`, source/rights metadata and `dataType: "model-forecast"`. The Worker must compare that digest before treating a pair as valid.

`cycle.runIso` is the model issue time; `cycle.validIso` is the forecast’s valid time. `fetchedAt` is the generation run’s actual retrieval-completion time for that snapshot in epoch milliseconds. `publishedAt` is the time the complete local six-snapshot set finished validation and was ready to publish, in ISO UTC. It precedes upload completion by the upload duration; it is not a claim that GitHub had finished distributing the assets at that exact instant. Schedule times are not forecast valid times.

These are **modeled forecast fields**, not real-time wind observations. The particle animation depicts the forecast grid. A new release does not advance the model’s issue or valid time. If the schedule is delayed or upstream data is unavailable, old valid times must remain visible and be marked stale according to the hosted policy; no timestamp is fabricated to make old data appear current.

## Failure and publication behavior

All six snapshots, including both scalar fields, must validate before any output files are written or publication begins. An unavailable model, missing scalar, malformed grid or inconsistent/old cycle fails the workflow before release upload. This leaves the existing release untouched for generation failures.

GitHub replacement uploads are **not atomic**: `gh release upload --clobber` deletes an existing named asset before uploading its replacement. The workflow uploads grids first and manifests second, and serialization prevents two refresh jobs from writing simultaneously. During replacement, a reader may briefly encounter a missing asset or a new-grid/old-manifest digest mismatch. The Worker must reject that pair, preserve a validated cached snapshot where available and report stale/unavailable state when no usable cached pair exists. An upload failure can leave a partially replaced release; it is not covered by the generation-failure preservation guarantee. [GitHub CLI upload semantics](https://cli.github.com/manual/gh_release_upload).

GitHub schedules run from the default branch, may be delayed or dropped under heavy load, and public-repository schedules may be disabled after 60 days without repository activity. The 17-minute offset avoids the busiest top-of-hour window, but does not guarantee an exact refresh time. Check workflow runs and use manual dispatch when initializing the release or recovering from a failed job. [GitHub scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

For local generation, with the repository’s supported Node runtime and dependencies installed:

```sh
node --test server/hosted/wind-snapshot.test.mjs
node scripts/wind-snapshot.mjs .cache/wind-snapshots
```

The script itself writes only local artifacts. It does not create or upload a release. `.cache` is ignored; the workflow writes into its ephemeral runner directory. The focused tests inject small deterministic provider fields rather than downloading live forecasts.

## Source attribution

NOAA GFS provenance and government-data reuse evidence are in [DATA_POLICY.md](DATA_POLICY.md). The IFS subset is available under **CC BY 4.0 plus ECMWF terms**, including commercial redistribution with attribution. The IFS manifests carry the source statement, license link, resampling/unit-conversion notice and liability disclaimer; the application’s linked credit remains required when displaying the fields. These derived snapshots preserve the original issue/valid times. [ECMWF Open Data terms and available subset](https://www.ecmwf.int/en/forecasts/datasets/open-data).
