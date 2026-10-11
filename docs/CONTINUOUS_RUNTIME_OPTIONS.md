# Continuous acquisition runtime options

Reviewed 11 October 2026. Reuse the current public Sites project and its managed
`EARTH_DB` D1 / `EARTH_STORE` R2. Keep acquisition, research, storage, prepared
serving and rendering separate. A ticking clock, SSE message, open browser or
exported collector function does not prove acquisition with zero visitors.

At the starting inspection, production was Site v25 with no linked automations and
no declared Site MCP server. The combined entry point handled HTTP fetch requests;
there was no verified native scheduled/queue trigger. Local acquisition/storage
and fixed-source hosted invocation were implemented. These statements describe
the phase baseline; later release/runtime evidence belongs in FOUNDATION_PROGRESS.

## Operational choices

| Route | Already available | What remains to prove | Suitable role |
| --- | --- | --- | --- |
| Native Site cloud task + owner writer/MCP | Sites `create_schedule` is callable; managed D1/R2 exists | Hosted writer access, generated plugin connection, fresh cloud write/readback without local context, accepted cadence, quota/lag/overlap | First native candidate; bounded collection or investigation runs |
| Awake laptop daemon → hosted writer | Existing fixed-source pipeline, publication outbox and persistent storage | Owner starts authorized run; restart/autostart/health/catch-up validation | Immediate acquisition/inference bridge while awake; not laptop-independent uptime |
| Independent tiny Cloudflare cron → hosted writer | Standalone collector-worker is prepared; Cloudflare supports every-minute cron | Account access is not verified; deployment, secret provisioning, measured CPU and zero-visitor trial required | Minute HTTP wake with no per-minute model call; retain existing Sites storage |
| Existing public GitHub Actions → fixed hosted collector / bounded GKG release | Authenticated repository administration and successful cloud runs are verified; standard public runners are free | New collect-only credential/contract, two persisted cloud captures, measured schedule gaps; historical recovery remains separate | Deployable laptop-independent fallback with best-effort 5/15-minute wakes; existing GKG bulk-processing bridge |

Sites creates a cloud **agent task**, not a verified HTTP-only timer. Official
web scheduled tasks can use connected tools without a local directory; desktop
project tasks need the machine and app running. The Learn guide documents minute
chat follow-ups, while the Help Center limits generic paid recurring tasks to
hourly execution. Exact native Site minimum cadence, wake SLA, duration,
concurrency and allowance were not established. Do not turn those different
surfaces into an always-on promise. [Scheduled tasks](https://learn.chatgpt.com/docs/automations),
[current generic task limits](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt).

MCP is the tool/control surface, not the scheduler or database. Use it to invoke
the same reviewed collector and durable operations, not a parallel ingestion
stack. A Site service-access token supplies neither a visitor identity nor consent
for connected apps; public writes require separate server authorization. Keep the
site public for anonymous readers. Native visitor sign-in establishes identity;
visitor inference/subscription eligibility and user consent are separate, and do
not provide a global collector when nobody visits. [Sites](https://learn.chatgpt.com/docs/sites),
[Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt).

## Owner-only Site MCP writer contract

This is a proposed implementation contract, not a claim that the gateway has
already passed its authorization tests. Follow the Sites skill's native MCP and
identity integration; do not implement another OAuth stack.

1. Add the native `mcp` capability and a stateless `POST /mcp` entry point using the
   supported protocol/discovery/list/call methods. Discovery/schema metadata may be
   non-sensitive; every write tool checks authorization before doing work.
2. Read the gateway-provided `oai-authenticated-user-id`. Compare it to an explicit
   server-side `EARTH_OWNER_USER_ID` captured through verified owner sign-in/tool
   access. It is site-scoped and cannot be inferred from a workspace account ID.
   Missing owner configuration or identity fails closed. Do not bootstrap ownership
   from the first caller, display name, request body, caller-supplied role or email.
3. Verify the Sites gateway's identity-header boundary on the public deployment:
   anonymous calls with forged `oai-authenticated-*` headers and authenticated
   non-owner calls must both fail with no durable mutation. Native documentation
   says Sites authenticates/checks viewing and supplies identity; it does not prove
   this application's owner check or a raw HTTP spoof test. If spoofing survives,
   disable the writer until a supported authenticated boundary is established.
4. Allow only narrow tools: read collection status/capabilities; collect the fixed
   registry; lease a bounded persisted job; submit a validated evidence-linked
   analysis version. Inputs cannot select URLs, egress hosts, executable code,
   credentials, storage keys or arbitrary SQL. Validate sizes/schema and immutable
   revision references before a write. Tool schemas do not confer permission.
5. Reuse durable D1 admission/leases, idempotency and source backoff. Store actor,
   input revision, action, bounded result and real attempt/publication dates in the
   audit trail; never tokens or full private headers. Overlapping/retried calls
   must not duplicate facts/jobs or overrun provider budgets.
6. Publish through the current Site to obtain its private generated plugin; read
   its tools first, then exercise one authorized bounded write/readback. A freshly
   launched cloud task must retrieve the saved instructions/tool connection and
   repeat a real acquisition without laptop files or setup-session credentials.
   Only after that can a Site-linked schedule be activated and observed.

The existing credentialed HTTP writer remains separate: a server-only collector
credential authorizes the fixed endpoint and action, not Site viewing. Keep it
out of browser code, schedule prompts and MCP tool arguments. Do not repurpose a
Site viewer/service-bypass token as public write permission. Any future service
principal needs an explicit narrow server permission, not an owner identity claim.

## Free-first timer fallback and limits

Cloudflare cron permits `* * * * *`, every minute, in UTC. Changes can take up to
15 minutes to propagate. Workers Free currently provides 100,000 requests/day and
10 ms CPU/invocation: a 1,440/day lightweight HTTPS timer could fit, but measured
CPU and an eligible account are still required. This does not grant managed Sites
the same quotas or make CPU-heavy GKG/LLM work fit the timer.
[Cron documentation](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/).

Use the prepared collector-worker only to POST the fixed authenticated hosted
collector. Leave optional KV unbound: the current minute policy would do about
2,880 writes/day, above Free's 1,000 writes/day. KV leases are not atomic; hosted
D1 should own admission/backoff/status. Without durable timer state, instance
memory/status is incomplete and cannot prove uptime. No account, paid plan or
resource was provisioned in this audit.

The timer can acquire the current HTTP-compatible feeds and revalidate GDELT's
owned release. It does not decode GKG ZIP archives; Node bulk ingestion still
needs a laptop, existing Action, verified native cloud runtime or another permitted
bounded compute path. Move only that missing function after measuring limits.

GitHub schedules run no faster than every five minutes and may be delayed or
dropped under load. Public-repository schedules can be disabled after 60 days
without activity. Preserve the existing workflow as a measured fallback, not the
only proof of a continuously running system.
[GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Verified existing GitHub fallback

Read-only account/repository inspection at 2026-10-11 22:13 UTC confirmed
`SmurfTurfPawpaw/earth-observer` is public, active, unarchived, with default branch
`main` and repository administration available through the existing authenticated
GitHub CLI. All four registered workflows were active. The remote default-branch
GKG workflow declares `2,17,32,47 * * * *`; EONET declares two wakes/hour, and wind
generation runs every six hours. GKG and EONET both use the `intelligence-data`
concurrency group, so their processing can contend. These workflows publish
rolling release assets, not independently acquire all four sources into Sites
D1/R2.

The API returned three successful GKG scheduled starts on 11 October at 07:10,
17:48 and 21:45 UTC, and two successful EONET scheduled starts at 17:39 and 21:50.
The latest GKG job completed in 15 seconds; this is a job-duration observation,
not schedule punctuality. The observed gaps do not establish their cause or
prove every declared slot was active earlier that day. They do establish that
the current run history cannot demonstrate a 15-minute collection service.
[Latest observed GKG run](https://github.com/SmurfTurfPawpaw/earth-observer/actions/runs/38177660001),
[latest observed EONET run](https://github.com/SmurfTurfPawpaw/earth-observer/actions/runs/38178036942).

Standard GitHub-hosted runners in a public repository have free runner minutes;
the private-repository monthly minute allowance is not the blocker here. Larger
runners are charged, and artifact/cache storage has separate allowances. Keep
the collector wake on ordinary `ubuntu-latest`, with no artifact uploads, npm
installation, build/test suite, cache churn or retained provider data in GitHub.
Store captures and prepared results in the existing Sites D1/R2 instead.
[Current Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

A small future workflow can use an off-hour-boundary 5/15-minute `schedule` plus
`workflow_dispatch`, a separate collection concurrency group, `contents: read`,
a short job timeout and a single fixed HTTPS collection request. It should check
the endpoint response and allowlisted persisted status, fail on a real storage
failure, and avoid a blind immediate retry after a timeout: the write may already
have committed. Server D1 must admit due sources, preserve conditional-fetch
validators and enforce retry/backoff; an Action wake does not itself mean every
source supplied new data. Keep GKG decoding in its separate bounded Node job.

Repository Actions secret names and environment names were both empty; no secret
values were read. The built-in `GITHUB_TOKEN` authorizes GitHub operations, not
the Sites collector. A production trigger therefore still needs securely
provisioned server authorization. Prefer a new collect-only machine capability,
shared with a GitHub Actions secret, over exporting the existing credential which
also authorizes publication/heartbeat/aircraft actions. The scoped HMAC/replay
contract described for the private controller can serve this route too. Never
place credentials in workflow text, URL arguments, browser code or logs; never
admit arbitrary target URLs, actions or publication packets from the workflow.
Use only owner-controlled `schedule`/`workflow_dispatch`, not untrusted pull
request code with a write credential.
[Actions secret handling](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

Activation requires the reviewed workflow and scoped server contract on the
default branch, secret provisioning without disclosure, one explicit dispatch
write/readback and then two actual scheduled captures with no laptop/visitor
acquisition. Record expected wake time, run start, source check, capture and
publication dates separately. Observe missing slots and alert on stale data.
GitHub documents a five-minute minimum, default-branch execution, high-load delay
or dropped jobs and 60-day inactivity disabling; moving off the top of the hour
reduces contention but supplies no freshness guarantee. Jobs are finite: standard
hosted execution ends at six hours. Do not simulate an always-on server with
long sleep loops or recurrent self-dispatch. This route is immediately feasible
on verified existing accounts once its narrow authorization is configured, but
cannot satisfy a guaranteed minute acquisition profile.
[Schedule limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[Runner execution limits](https://docs.github.com/en/actions/reference/limits).

The owner-private native Site controller remains a conditional alternative, not
a currently verified writer/runtime. It still needs the platform identity
boundary, generated plugin connection, accepted cadence and independent cloud
write/readback trial. GitHub runner availability does not resolve those gates,
and native Site creation would not repair GitHub's schedule punctuality.

The read-only audit made no account, secret, workflow, schedule or deployment
changes and did not trigger any run. The implementation package below is a later
local change; it records preparation, not activation.

### Prepared collect-only fallback package

`worker/collector-trigger.js` now implements a handler factory for normalized
`POST /api/collector/trigger`; the public client URL is compiled to
`https://giovannicallebaut.com/earth/api/collector/trigger`. Root mounts the handler
after removing the Earth prefix. It accepts no query, Origin, source list, target
URL, publication packet or executable input. The body must be empty or the exact
`{"action":"collect"}` bytes; nonempty input requires JSON content type. Request
body size is capped at 64 bytes and the whole operation at 45 seconds.

`EARTH_TRIGGER_HMAC_KEY` is a new dedicated server key, distinct from the existing
`EARTH_COLLECTOR_TOKEN`. Generate at least 32 random bytes encoded as unpadded
base64url; accepted keys have 43–128 base64url characters. Never copy/rotate the
broad existing credential to activate this path. The Node client signs an HMAC
SHA-256 canonical scope/method/normalized path/timestamp/nonce/body; the server
uses WebCrypto `verify`, permits at most 30 seconds of clock skew, and rechecks
the signature age after reading the body. Signature, nonce and signing key are
never returned. The authenticated operation internally delegates the same
`handleCollection` with its own server-only collector token and fixed collect
action. It introduces no duplicate ingestion engine.

Admission is explicitly isolate-local: at most 120 attempts/minute, one admitted
collection/minute for the retained binding and nonce replay rejection while that
isolate survives. A pending operation retains its admission until actual
settlement even when the HTTP deadline is reached. Provider fetches receive the
abort signal, but storage may finish after the response: a started write returns
an uncertain outcome and requires status readback before retrying. None of these
guards establish cross-isolate serialization or durable nonce replay admission.
The existing storage/source contracts still determine publication and provider
budgets. Durable replay admission remains a separate proposed enhancement.

`scripts/trigger-hosted-collector.mjs` uses Node built-ins only, one compiled HTTPS
target, no CLI URL/action arguments, a 55-second deadline, no redirects, a 4 KiB
response cap and allowlisted status/count output. It never prints the key, raw
response, signature, provider content or error stack. It performs no blind retry
after an uncertain request.

`.github/workflows/hosted-collector.yml` is optional and disabled unless root sets
repository variable `EARTH_HOSTED_COLLECTOR_ENABLED='1'` and provisions the new
Actions secret `EARTH_TRIGGER_HMAC_KEY`. Only the fixed client step receives the
key. It runs on ordinary `ubuntu-latest`, default `main` of the owned repository,
every five minutes at minutes 3/8/13/.../58 plus explicit dispatch, with a separate
noncanceling concurrency group and two-minute job cap. Checkout/setup-node use
official v4 commit references verified from the Actions repositories; checkout
does not persist GitHub credentials. No npm/build/artifact/cache steps run.

Focused checks cover denied-request zero side effects, Node/WebCrypto signature
agreement, fixed internal delegation, safe output, replay/minute admission,
pending writes after timeout, stalled/oversized bodies, request ceilings and
bounded client behavior. Root owns mount integration, tested publication, secure
secret/enable-variable provisioning and independent run/readback verification.
No account, secret, variable, workflow run or deployment was changed by this
package's implementation. The current one-minute prepared-data staleness policy
must not be silently presented as guaranteed fresh between five-minute wakes.

No connected Cloudflare deployment tool/account was verified. Native plugin search
found Render, Railway and Vercel as uninstalled candidates; their appearance is not
evidence of account authorization, free capacity or an active deployment. The
current native Sites connection is the first route to test.

## Admission, research and readiness budgets

One durable scheduler admits source work using next-due/retry dates and leases.
Material factual revisions enqueue research once per input digest. Severity,
context, first-hour activity and real follows can boost priority within explicit
request/bytes/CPU/model/storage limits; visible geography never removes baseline
coverage. Keep failed attempts and gaps, and retry with provider backoff. Search
demand can inform indexing and cache, not credibility. Synthetic journeys are
excluded from real demand.

AI research uses a separately capped queue: retained evidence IDs, fixed permitted
discovery routes, maximum tool calls/tokens/time, unchanged-input deduplication,
retry ceiling and distinct owner/visitor allowance. A paid API is an opt-in route;
no silent purchase or quota upgrade. Evidence-linked notes remain versioned
derivations, with their cut-off, assumptions, alternatives and later evaluation.

The independent-runtime gate passes only when: (a) an actual new fixed-source
acquisition runs with no visitors or laptop dependency; (b) its immutable evidence
and index are read back from hosted storage; (c) restart/overlap/retry preserves the
last good publication and gaps; (d) capture/store/display times and resource usage
are measured; (e) cadence and failure alerts have been observed. A saved schedule
or a successful manual call alone is insufficient.

## Native execution trial: current go/no-go gate

The second read-only account inspection still showed production v25, owner role,
public audience, zero linked automations and a schedule request ID available.
The local combined manifest now declares MCP, but this has not yet provisioned a
published connection. No HTTP-only native cron/queue trigger surfaced in the tool
inventory or Sites references: `sites_create_schedule` creates a linked cloud task.
The current Help Center explicitly confirms Site schedules run in the cloud even
when created on desktop, require ownership of the Site and schedule, and cannot
borrow a visitor's connected-app access.
[Site automation behavior](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites).

Identity research found no documented signed Site assertion/JWKS verifier, owner
provenance API or identity service binding available to this app. Native MCP refs
promise authenticated forwarding/view checks; the starter reads dispatch-injected
headers. Neither documents the exact public-header stripping behavior. The
trusted request-scoped `ctx.props.CONNECTORS` capability is for permitted app
invocations, not an owner identity verifier; BYOP is off on this public Site.
Do not enable trust from an undocumented stripping assumption. A private plugin's
positive authenticated call alone does not close the public HTTP ingress gap.

Root can execute this bounded trial after the coherent MCP package is published:

1. Publish root `/mcp` with `EARTH_MCP_TRUST_SITES_IDENTITY` disabled, owner ID unset
   and the temporary server `EARTH_MCP_IDENTITY_PROBE='1'`. Writes remain disabled.
   Check the exact production version, modern discovery/list wire format and
   portfolio routes; no collector credential is supplied by a caller.
2. Read fresh `get_site(include_mcp_connection=true)`. Copy the exact native MCP
   endpoint, OAuth resource and plugin ID. Check install/connection state through
   supported native tools; never infer connected state from a plugin ID. Reuse the
   generated private plugin, preserving the Site's public audience.
3. Compare `caller_identity` from raw public HTTP with a sentinel
   `oai-authenticated-user-id` against the actual owner's authenticated native
   plugin call. Repeat on every exposed generated/custom origin. Probe output is
   explicitly `unverified:true`; it cannot set `isOwner` or authorize a write.
   If a sentinel reaches the app, trust must stay disabled. If the positive native
   caller is unavailable, do not infer or bootstrap the owner ID.
4. Resolve the gateway provenance/authorization contract for both ingress paths;
   verify that anonymous raw calls cannot impersonate the native authenticated
   context. Only then configure the verified site-scoped owner ID and enable trust.
   Test actual non-owner access when available without creating/inviting accounts,
   plus anonymous/missing/forged owner requests. All unauthorized writes must have
   zero storage side effects. Remove the temporary probe when verification ends.
5. Invoke one `collect_sources` through the owner plugin and read back hosted
   `collection_status`, source history and current prepared data. This establishes
   the writer, not independent scheduling. Record real acquisition/status dates,
   source errors and storage results; unchanged upstream facts stay unchanged.
6. Re-read linked automations, reuse any matching schedule, otherwise create one
   authorized bounded Site-linked cloud trial using the fresh schedule request ID.
   Use the earliest verified accepted cadence. A five-minute trial is only a
   candidate if Site-linked tasks explicitly accept it, not a declared minimum
   or the final minute update policy. The prompt names only this Site's fixed
   registry and native tools, with no secrets, local paths or visitor connections.
   Use supported Run now if exposed; no run-now tool was found in this inventory.
   Saving a schedule alone does not pass the writer or execution gate.
7. On the fresh cloud run, first check `caller_identity` against the verified owner
   context; if the run has no identity or a different principal, it cannot collect.
   Do not silently grant a service account owner status. Observe two distinct cloud
   runs without a laptop collector or browser-triggered
   acquisition. Each must acquire/check the fixed sources, persist its real capture
   and read back hosted results. Keep run IDs, actual capture/check/publication
   dates, bounded source statuses and D1/R2 references; a clock/SSE response or a
   copied old publication is insufficient. Failed providers remain dated/gapped.
   A GDELT release recheck is not a fresh GKG batch acquisition.
8. Measure wake lag, run duration/overlap, data operations and model allowance.
   Reduce cadence toward source-appropriate checks only if the native platform
   accepts it and observed limits support it. Keep expensive investigation work
   separate. Two successful runs establish a demonstrated path, not indefinite
   uptime or unlimited plan capacity.

Trial task text, once native authorization is verified:

> Use this Site's connected native tools to check collection status and collect
> the fixed reviewed source registry once when due. Read back the persisted
> collection status and report actual source failures, dates and storage outcome.
> Use no visitor connections, local computer files or arbitrary URLs. Do not
> republish code, change configuration or claim source data is newer than supplied.
> If owner authorization, storage or the tool connection is unavailable, report the
> exact gap and stop that run without attempting another access route.

If gateway provenance, owner tool access or native scheduling cannot be verified,
the independent collection gate remains open. Continue storage/time/UI work and
report this dependency explicitly; do not activate a public header-only writer or
silently fall back to paid infrastructure. The awake-laptop bridge remains a
separate profile, not a substitute proof of uninterrupted cloud acquisition.

## Deployment resources and fallback readiness

Current combined generated `dist/server/index.js` measured 59,526,715 bytes
(approximately 56.8 MiB), largely embedded assets. That file size does not measure
deployed compression, isolate heap or cold-start latency. Sites publishes D1 10 GB
and R2 without a fixed storage cap; plan-wide beta usage still limits high-usage
public Sites. Specific Site CPU, heap, bundle and schedule-run quotas were not
published in the inspected tool/docs contracts. Monitor actual deployment results,
cold starts and resource usage; do not transplant Workers Free ceilings onto Sites
or treat object-storage capacity as unlimited throughput.
[Sites beta limits](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites).

Keep new evidence/history and bulk archives in existing D1/R2 rather than embedding
them into the Worker source. A future asset split must preserve portfolio URLs,
attribution and cache behavior and be reviewed separately. The optional external
timer should contain only its small HTTPS wake logic, never this large combined
application or GKG decoder.

Read-only fallback metadata checks found no Wrangler on PATH, no Wrangler package
in the three inspected project dependency directories, no standard Wrangler config
directories, and no Cloudflare API token/key/account-ID environment variables.
No token values were read. This does not prove the user lacks a Cloudflare account;
it means an authenticated CLI deployment path is not currently verified. Free cron
remains a candidate requiring an existing account connection, measured 10 ms CPU
budget and secure server credential provisioning. No install, account creation,
resource, paid plan or schedule was made by this audit.

## Plan/schedule limits and a private-controller alternative

Official Sites documentation says beta usage is included within plan-specific
limits, applied across the account, with current numeric headroom shown in Sites.
Neither the inspected Site APIs nor public docs expose a numeric Site count,
CPU/heap/bundle allowance or remaining schedule slots. The Codex usage tool has no
Sites bucket and cannot establish that headroom. Do not create/delete unrelated
resources or upgrade a plan to make room without an explicit decision.

The current Help Center scheduled-task article states active-task caps of 3 on
Free/Go, 5 on Plus, 10 on Business/Edu and 15 on Pro/Enterprise, with paid recurring
tasks up to once/hour; Free is daily. Event-triggered tasks have separate caps.
The Learn automation guide also describes minute intervals for in-chat follow-up
loops and distinguishes local/Codex automation. These are different documented
surfaces; the exact limits inherited by Site-linked cloud tasks remain unverified.
An hourly accepted task cannot satisfy a minute source-check target, regardless
of smooth client presentation. A second Site would not solve that cadence gate.
[Scheduled-task limits](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt),
[follow-up automation guide](https://learn.chatgpt.com/docs/automations).

| Scheduling surface | Execution/access boundary | What it establishes here |
| --- | --- | --- |
| Native Site-linked schedule | `sites_create_schedule` links a cloud task to a published owned Site; fresh cloud tools/data authorization required | Documented cloud execution; exact Site cadence, run quota and owner connection must still be tested |
| Generic ChatGPT Scheduled tasks | Account/workspace feature with documented active-task limits and paid hourly recurrence; cloud app/event support depends on permissions | Relevant product limits, not a proven minute Site trigger |
| Codex/local scheduled jobs and chat follow-ups | Separate automation controls; project/file work needs the laptop and desktop app running. Minute follow-up intervals are documented for chat loops | Useful local follow-up/enrichment, not proof of an independently hosted collector |

Do not use a Codex heartbeat/local goal as a workaround for an unverified Site
cloud trigger, or interpret a generic hourly task as a continuously running
minute collector. Cloud run ownership, saved source access and output persistence
must be established independently from the schedule's saved timing.

If public gateway provenance fails, a small **owner-private controller Site** in
the same existing Sites account is a possible architectural alternative. This is
a proposal, not a created or running resource. The public atlas and portfolio
remain public; the controller has no public UI or additional database. Its MCP
tool invokes only the main Site's fixed collector through a new scoped machine
capability, relying on the documented owner-private platform access boundary
instead of publicly supplied identity headers. Native Sites refs explicitly allow
confirmed owner-private shared update endpoints to rely on that boundary; public
write endpoints do not receive the same authorization from a service-bypass token.

Proposed machine contract: a new server-only HMAC secret, configured on both Sites,
signs the fixed method/path/body digest plus a short-lived timestamp and random
nonce. The main Site verifies the exact collection scope, expiry and an atomically
admitted replay nonce before delegating to its existing authenticated writer.
No URL, publication packet or arbitrary action is admitted. The existing collector
credential stays on the main Site; add the new capability without rotating or
exporting the legacy secret. Canonical bytes, replay admission, deadlines and
constant-time verification need focused implementation checks before activation.

This alternative requires verified Site quota, explicit controller ownership/
audience, supported secure configuration, generated plugin connection and two
independent cloud writer/readback runs. It introduces one native resource but no
new paid provider account; included capacity is not unlimited capacity. Creating
it is root's separate conditional decision after the public probe, with no silent
paid commitment. If cadence or cloud allowance still fails, a verified HTTP timer
remains necessary for the target acquisition profile.
[Site-hosted plugin requirements](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites),
[Site beta and cloud schedule behavior](https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites).

## Laptop collector inspection and noncritical enrichment

Read-only Windows inspection at 2026-10-11 22:09 UTC succeeded for Task Scheduler
and Node process metadata. No collector-specific registered task matched the
Earth/collector names or direct collector/pipeline action references, and no
direct Node collector-daemon, local-intelligence-pipeline or aircraft-collector
process was running. Generic/indirect startup wrappers were not exhaustively
audited. Action arguments, process command lines and credentials were not printed;
no task/process was created, resumed, changed or stopped.

The existing laptop pipeline is a prepared bridge with an outbox and optional
inference hook; its default metadata enrichment is deterministic, not proof of
an operating local LLM. A laptop may later perform noncritical enrichment or
bounded archive processing while awake, publishing separately versioned derived
artifacts through an authorized writer. Core acquisition/serving must survive
its sleep/disconnection, and model/tool/network costs need their own budget.
An optional Windows task can automate that enrichment only after an explicit
configuration decision and a real restart/readback check; it cannot satisfy the
independent always-on collection gate.
