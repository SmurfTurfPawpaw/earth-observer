# Local aircraft collection

`scripts/aircraft-collector.mjs` is a separate, serialized local collector. Importing it performs no requests. Its default scope is **Brussels, latitude 50.85, longitude 4.35, radius 250km**. Military collection is unconfigured. This is limited regional coverage, not a worldwide or uninterrupted archive.

The collector uses only the existing owned HTTPS flights endpoint and the private owned collection writer:

- `GET https://giovannicallebaut.com/earth/api/flights?lat=50.8500&lon=4.3500&radiusKm=250`
- `POST https://giovannicallebaut.com/earth/api/collector` with `{action:'aircraft',packet}`

It never chooses routes from a visitor's location, accepts arbitrary source URLs, substitutes an alternate endpoint after denial, or follows redirects. The owned flights adapter's small geographic padding may appear in archived source packets; the hosted writer clips warm regional display/history to the advertised scope.

## Packet and time meaning

The schema1 packet contains `source:'adsb.lol'`, the actual successful capture `collectedAt`, the fixed scope, `observedAtMs`, `observedAtSource`, `sourceState`, and the exact normalized observation records from the shared `readsbSnapshot` normalizer. No extrapolated positions, predictions, per-frame values or inferred aircraft facts are uploaded.

`observedAtMs` comes only from a valid numeric source `now` epoch, permitting at most five seconds of source clock lead. Missing/invalid source time remains `null` with `observedAtSource:'unknown'`. A reported position epoch additionally requires the source's explicit finite nonnegative `seen_pos`; missing age stays unknown, even when coordinates are available. Receipt and cache times never qualify a fix. Geometric/barometric altitude and compatible vertical-rate types remain distinct.

`sourceState` retains freshness, the original cache state, cache age, actual source age, completeness and rejected row count. A stale cached response stays labeled stale. Reading the same source observation again never advances its position epoch. An empty successful upstream snapshot may be uploaded; failed acquisition never publishes an invented empty replacement.

## Continuous process and retry

The running process attempts a cycle every30 seconds independently of visitor activity. Cycles are serialized, and a queued publication is retried before another acquisition. Slow requests or explicit backoff delay actual collection; the schedule does not mean the upstream produces new observations every30 seconds.

State is separate from the metadata pipeline, in `.cache/aircraft-collector/state.json`. One bounded atomic replacement stores clocks, admission/retry state and at most one hashed outbox packet. Capture dates and source facts survive publication failure and restart unchanged. A crash after server acceptance may resend the same packet; the hosted writer must acknowledge that packet idempotently. Run one instance against a state directory.

Each source and writer request has a 15-second deadline, including body reading, with real abort signals and stream cancellation. Source JSON is capped at 8MiB, snapshots at 2,000 input/normalized records, the complete POST body at **1,500,000 bytes** (the hosted API's decimal limit), acknowledgements at 64KiB, and local state at 2MiB. Oversized or invalid data is rejected atomically rather than truncated into a partial replacement.

Both acquisition and publication failures persist exponential backoff. HTTP `Retry-After`, including503 responses, is honored up to the existing24-hour bound;401/403 responses have at least a five-minute pause and never trigger endpoint substitution. Owner cancellation retains queued work without counting it as an upstream failure. Failure leaves previous capture dates unchanged.

## Launch and credentials

Launch only after the hosted private aircraft writer is published and checked. This work does not launch the process or alter an existing collector.

```powershell
node scripts/aircraft-collector.mjs --once
node scripts/aircraft-collector.mjs
```

The existing `EARTH_COLLECTION_SECRET`, or compatible `EARTH_COLLECTOR_TOKEN`, is read from the process environment. It is sent only as the private writer's bearer authorization header, never to the public source GET, on disk, in source packets or in logs. Do not place it in command arguments. The CLI accepts only `--once` or `--help`; source/region/military overrides are absent.

Logs contain allowlisted operation outcomes, scope ID, counts and collector clock metadata. They omit source records, coordinates, response bodies and credentials. The laptop needs to remain awake, running and connected to the Internet. A hosted revision stream and browser playback are separate from this acquisition process; this collector does not animate or run inference.

Focused synthetic verification:

```powershell
node --test scripts/aircraft-collector.test.mjs
```

These tests check timestamp fidelity, limited coverage, serialized collection, durable retry and restart, denial, byte/count admission, cancellation/deadlines and safe logs. They make no live provider requests and do not establish actual production availability or worldwide coverage.
