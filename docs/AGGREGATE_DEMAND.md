# Aggregate discovery demand

This optional counter helps prioritize reviewed discovery subjects. It counts accepted search **actions**, not unique people. It does not establish population interest or representative demand and must not be described as a visitor count.

## Integration

`src/core/demand.js` exports `createDemandTracker({container, fetchImpl?, documentRef?, locationRef?, testTraffic?, headers?})`, returning `{noteSearch(filters), getState(), destroy()}`. Mount it in a dedicated container below the intelligence form. Its checkbox, **Help improve topic coverage**, starts unchecked on every page. Consent exists only in page memory. No cookies, identifiers or persistent consent are created.

Call `noteSearch({category, country, q})` **only** from the form's explicit submit handler. Do not call it on panel open, refresh, category change, polling, camera moves or saved-session restoration. Mounting and opting in cause no network request. An opted-in explicit search sends one POST only when the full normalized query equals a reviewed GKG label or identifier, or when the query is blank and the filters describe a category/country overview. Publisher domains, partial matches, sentences, coordinates and every other raw query are excluded entirely. Category mismatches and unsupported countries are excluded. The only outgoing fields are `{subjectId, country, consent:true}`; `credentials:'omit'` and `redirect:'error'` prevent profile credentials or cross-host forwarding.

The finite client-safe catalog is `src/core/demand-subjects.js`: all/category/country overviews and 26 reviewed GKG subjects. Country is the explicitly entered filter, never inferred from map position, GPS, identity or network location. GKG countries denote mentions, not incident locations. The country list mirrors the reviewed economic catalog excluding World and the non-country Channel Islands aggregate; XK is explicitly supported for Kosovo.

`worker/demand.js` exports `handleDemand(request, env, {now?})`. Mount it among the runtime's extension handlers before generic GET-only admission. It returns `null` for other routes; existing global API rate admission still applies.

- `GET /api/discovery/demand`: configuration/status only, no writes or counts.
- `POST /api/discovery/demand`: same-origin JSON, maximum 512 bytes, exactly `subjectId`, `country`, and boolean `consent:true`; success is HTTP 202 `{enabled:true,accepted:true}` only after a successful conditional storage write. No individual count is returned.
- `GET /api/discovery/demand/summary`: seven UTC calendar days including today, only groups with at least 300 accepted actions, rounded down to 100-action buckets; at most 100 groups. No suppressed groups, exact totals or individual events are returned.

Production is restricted to exactly `https://giovannicallebaut.com` and `https://www.giovannicallebaut.com`. Localhost, generated Sites domains, preview hosts and requests carrying `x-earth-test` are excluded. QA can pass `testTraffic:true` or that marker in the browser helper's `headers` option to disable counting even on a production URL. The marker is not sent in normal production requests. No identity, IP or location header is inspected or persisted by this handler. Existing hosting infrastructure may maintain its own standard request logs; this counter does not claim to control those logs.

## Storage and retention

No new binding is required. `EARTH_STORE` stores one bounded JSON aggregate per UTC day under `discovery/demand/days/YYYY-MM-DD.json`. Each key is a fixed catalog subject/country pair; raw queries cannot create objects or fields. Updates use `If-None-Match:*` for first claims and `etagMatches` for existing objects, with at most five attempts. Failed/uncertain conditional results never acknowledge acceptance. Counters cap at one million actions per group per day; each object caps at 512 KiB. Corrupt or unsupported records fail closed.

Seven-day summaries always exclude expired and future days. Physical cleanup runs before successful POSTs and summary reads. `pruneDemand(env,{now?})` is also exported for the host's scheduler. It removes at most 256 old daily objects per run, stays inside this prefix and reports `complete:false` if more cleanup is needed. Repeated calls clear an old backlog. Each object includes an `expiresAt` custom metadata hint; **R2 does not automatically delete objects from that hint**.

For physical deletion during idle periods, configure an R2 lifecycle rule restricted to `discovery/demand/days/` or a daily trusted schedule that calls `pruneDemand`. No scheduler or lifecycle rule is provisioned by these source files. Without that configuration, an idle host can retain older objects until a later request performs cleanup. Do not promise unconditional seven-day physical deletion. Missing R2/configuration or storage contention is reported as unavailable, never as a successful action.

## Verification

New contract/catalog/browser tests and fake-bucket worker tests cover exact reviewed matching, unknown-query exclusion, explicit/default-off consent, preview/test exclusion, credential omission, strict fields/body bounds, missing storage, failed CAS, concurrent first claims and updates, below-threshold suppression, 100-action rounding, corrupt records and scoped/bounded retention. These tests perform no real provider calls, HTTP demand submissions or R2 writes.
