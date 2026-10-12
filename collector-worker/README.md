# Independent minute collection timer

`minute-trigger.js` is the deployment entry point in `wrangler.example.jsonc`.
It sends one signed collect-only request per Cron invocation to the compiled target
`https://giovannicallebaut.com/earth/api/collector/trigger`. Source acquisition and
durable data publication stay on the existing hosted Earth service.

The timer requires only `EARTH_TRIGGER_HMAC_KEY`, separately provisioned on the
hosted service and this Worker. The broad collector/publication credential stays
on the hosted service. There are no KV, database or object-storage bindings and no
timer state writes. No request or environment value can replace the fixed target,
action or body; redirects, cookies and arbitrary source URLs are not admitted.

## Configuration readback; runtime verification pending

The initial code package did not connect an account, deploy a Worker or provision
a secret. These files alone do not establish unattended collection. The current
GitHub `hosted-collector.yml` workflow supports finite, owner-invoked verification
through `workflow_dispatch` only; it has no automatic collection schedule. Minute
execution needs independent account access and actual runtime verification.

Operator record, 12 October 2026: the account's Free plan was checked in the
dashboard and the RAM-only REST path completed six staged mutations with final
readback. Version `b8eacae6-bdf0-4ccc-9bb3-5fdb9edd23e8`, deployment
`689bfab7-10e6-4dd7-b04f-dda69f75628d`, has the timer enabled, signing secret
present, workers.dev/preview URLs disabled and one minute Cron configured. The
first actual scheduled executions subsequently reported `request_failed`. A
later routing correction configured `global_fetch_strictly_public` on version
`c1714648-fff2-4f0c-8341-6ff9962e0dff` while preserving the same original code and
key. Runtime verification then identified the original timer's `redirect:"error"`
option as unsupported by workerd. The reviewed replacement uses `manual`, rejects
every 3xx before consuming its body and reports bounded failure phase/reason
codes. Its explicit runtime upgrade is prepared locally; successful scheduled
captures with that replacement remain unproved here. This record does not establish uninterrupted
operation, a source refresh every minute or a free allowance for the Sites host.

1. Use an authenticated Cloudflare account with permission to deploy this Worker,
   manage its Cron Trigger and set its secret. Obtain account selection through the
   normal Cloudflare login/API-token flow; no credential is written in this repo.
2. Copy the example to local `wrangler.jsonc`, select a free unused Worker name and
   the actual account. To stage it without collection, set
   `EARTH_MINUTE_TIMER_ENABLED` to `"0"` and `triggers.crons` to `[]`. For a brand-new
   Worker, omit `secrets.required` only in this paused bootstrap configuration;
   otherwise missing-secret validation also blocks that initial disabled deploy.
3. Using the current Wrangler/dashboard secret workflow, provision the existing
   dedicated `EARTH_TRIGGER_HMAC_KEY` as a secret binding. Do not supply its value
   in command arguments, Git, browser code or plaintext `vars`. The example's
   `secrets.required` declaration prevents deployment with a missing key; restore
   it after provisioning and before activation.
4. Deploy the timer with `EARTH_MINUTE_TIMER_ENABLED: "1"` and
   `triggers.crons: ["* * * * *"]` and
   `compatibility_flags: ["global_fetch_strictly_public"]`. The flag makes the fixed
   target use public Internet routing when it resolves to another Worker.
   `workers_dev:false` means no public HTTP route
   is needed. The Worker still handles scheduled events.
5. Verify at least two actual consecutive unattended Cron runs with no laptop or
   browser dependency. Read the hosted source/world receipts and original source
   dates, inspect Cron outcomes/logs, and measure CPU against the selected plan.
   A manual trigger or configuration health response alone does not pass this gate.
6. Keep the manual GitHub workflow for bounded deployment acceptance. Its former
   automatic collector schedule was removed; it is not a second production timer
   or an unattended fallback if this minute Worker stops.

`wrangler secret put EARTH_TRIGGER_HMAC_KEY` is an interactive provisioning option;
it also deploys a new Worker version. Stage the disabled configuration first and
use that command only when account access and activation are approved. A modern
Wrangler version is needed for required-secret validation. This recipe does not
install a CLI or create an account; those are separate operator actions.
[Cloudflare secret provisioning](https://developers.cloudflare.com/workers/configuration/secrets/).

## Optional RAM-only REST deployment helper

`deploy-api.mjs` is a narrow operator alternative to Wrangler. It never creates an
account, purchases a plan, signs in, accepts terms or grants permissions. Existing
dashboard deployment can proceed without creating an API token for this helper.
The configuration record above came from its actual authenticated REST path.
Its focused automated checks still use synthetic responses and the actual signer
compiled locally; those checks do not contact Cloudflare.

It accepts bounded control JSON only through a trusted launcher's private stdin.
Do not type credentials in command text, arguments, environment variables, files
or chat. Its library also accepts credentials explicitly in RAM. The control
fields are `schemaVersion:1`, `mode`, `accountId` and `apiToken`; `deploy` additionally
requires the preceding plan's `planId` and the existing narrow `hmacKey`.
`upgrade-routing` and `upgrade-runtime` require `planId` and reject a replacement
HMAC key. `plan`,
`verify` and `inspect-bootstrap` never require the HMAC key and perform GETs only. Unknown fields,
command-line arguments and interactive terminal input are rejected. No credential
is read from the process environment, local Wrangler profiles or `.env` files.

The token requires account-scoped **Workers Scripts Edit**, restricted to the
intended account. This is an account-wide script permission, not a verified
single-Worker grant. No zone, DNS, route, database, object-storage or AI permission
is requested. The only permitted API host is `https://api.cloudflare.com`, and the
only writable script name is `earth-observer-collector`.

The input artifact is fixed to the ignored local file
`.qa/cloudflare-minute-trigger-runtime-20261012.mjs`, SHA-256
`05142ebac2aac381db1a1ed799318d6176c8453cdef3c94b5a5157abc0bf0449`.
It is the reviewed 11,163-byte bundle of `minute-trigger.js` and its acknowledgment
codec. No caller-supplied path, code, URL, Worker name or secret name is admitted.
An artifact change requires a new explicit code review and pin update.

On a clean clone, use Node 24 with the already-installed project dependencies to
recreate the ignored artifact. No new CLI dependency is required:

```sh
node node_modules/esbuild/bin/esbuild collector-worker/minute-trigger.js --bundle --format=esm --platform=browser --target=es2022 --outfile=.qa/cloudflare-minute-trigger-runtime-20261012.mjs
node --input-type=module -e "import {readDeploymentArtifact} from './collector-worker/deploy-api.mjs'; console.log({bytes:(await readDeploymentArtifact()).byteLength,pin:'verified'});"
```

The second command verifies the exact compiled SHA and size before printing safe
metadata. The tests compile this same entry point in memory, so they do not depend
on the ignored artifact being present.

1. Invoke `node collector-worker/deploy-api.mjs` with `mode:"plan"` through private
   stdin. An authenticated unfiltered script listing establishes absence. A
   generic 404, unavailable account, rejected token or incomplete pagination
   metadata never authorizes creation.
2. Review the sanitized plan. Existing names must match both the ownership tags
   and the downloaded pinned code, with the allowed bindings, one active version
   and reviewed runtime configuration. The latest uploaded version must equal
   that active head before secret inheritance; an undeployed upload is rejected.
   Flags must be exactly empty or the single reviewed
   `global_fetch_strictly_public` flag. Any other flag is rejected, and actual flag
   state is included in the plan fingerprint. The current `/settings` GET must
   explicitly confirm flags after active/latest heads agree; optional omission
   from version runtime resources alone never means an empty flag list. Present
   version flags, runtime date and reviewed observability must agree across those
   readers. A dashboard HelloWorld placeholder is
   rejected by default. Metadata tags alone are insufficient.
   Code admission recognizes only the new target above and original SHA
   `cac8817f512df979a71cb6c1b2c95703c5226c000e5d78be02435d18ac28d803`,
   each with its own matching SHA tag. The plan binds the actual downloaded code
   SHA and `runtimeReady`, rather than trusting a tag or version label alone.
3. For a new or incomplete configuration, invoke `mode:"deploy"` through private
   stdin with that `planId` and HMAC key.
   The helper rechecks the plan, uploads the disabled timer, explicitly removes
   schedules, disables both public Worker and preview URLs, and verifies readback.
   It provisions only `EARTH_TRIGGER_HMAC_KEY`, checks that the timer remains
   disabled, uploads the enabled code with strict secret inheritance, checks its
   configuration, then attaches the one-minute schedule and checks the final head.
4. Invoke `mode:"verify"` for configuration-only readback. A successful result is
   `configured_pending_runtime_verification`, with `freePlanVerified:false` and
   `runtimeVerified:false`. An otherwise configured original-code timer with the
   desired public routing flag returns `runtime_upgrade_required`. Only the new
   reviewed runtime with a missing flag returns `routing_upgrade_required`; an
   empty flag list never passes configuration.
   Independently verify the account's selected Free plan,
   actual Cron executions, CPU and advancing hosted receipts before declaring
   autonomous collection ready.

### Observed deployment checkpoint, 12 October 2026

The reviewed runtime artifact is deployed as version
`22c68258-0b06-49da-a649-1ed5bce187b7`, with the strict-public routing flag,
one minute Cron, existing scoped secret and disabled public Worker URLs preserved.
The Free-plan dashboard recorded an actual stored invocation with 3 ms CPU.
The temporary laptop collector stopped at 07:31:08 UTC. Later scheduled wakes
at 07:38:51 and 07:39:51 UTC succeeded; the latter stored a new factual collection
at 07:40:02.282 UTC and published world/update editions. A further stored heartbeat
at 08:20:01.170 UTC retained source collection dated 08:16:10.981 UTC.

This is initial unattended proof for the four admitted collection sources, not
a claim that every minute wake captures new provider data. The current server's
rolling admission window can return busy under wake jitter. Separate Node/Python
producers, sustained cadence and broad source migration remain independent gates.
Configuration helper results deliberately remain configuration-only; this runtime
evidence was observed separately, and must not be inferred from a successful PUT.

For the known original runtime with its desired routing flag, a fresh GET-only
`plan` exposes exactly one `runtime-upgrade` operation. Approve
`mode:"upgrade-runtime"` with that plan ID and **no HMAC field**. One bounded PUT
uploads the new reviewed module, retains the desired flag and inherits the
existing HMAC strictly, preserving the enabled value, reviewed observability,
Cron and disabled public URLs. No secret, schedule or subdomain endpoint is
written. Readback must download the new exact code SHA with its matching tag and
prove its other configuration unchanged. A response acknowledging upload while
leaving the old code active fails readback. Unknown code, mismatched tags, absent
routing or a changed head is rejected; code and flag migration are not silently
combined. An uncertain upload stops without a resend. The original module is
embedded as a compressed public-code golden fixture in the test, so legacy
identity gates remain testable on a clean clone.

For the new reviewed runtime with a missing flag, a fresh GET-only `plan` exposes
exactly one `routing-upgrade` operation. Approve `mode:"upgrade-routing"` with that
plan ID through private stdin or the imported RAM-only helper. It performs one
bounded multipart PUT of the **identical pinned module**, enabled variable and
desired routing flag, with the existing HMAC binding declared `type:"inherit"`
and `bindings_inherit=strict`. No secret, schedule or subdomain endpoint is
written. It then checks code, tags, flag, active/latest version, binding presence,
enabled value, Cron and disabled public URLs. A desired configuration is a
zero-write result. A changed plan or uncertain upload stops for readback without
automatic retry. Metadata-only PATCH binding-omission preservation was not
established, so this path uses the already reviewed module-upload contract.
`upgrade-routing` requires `runtimeReady:true` and cannot quietly adopt different
code; `upgrade-runtime` requires the already desired routing flag. The desired
runtime and routing configuration returns a zero-write result.
Existing observability must remain enabled and match the bounded reviewed API
shape (logging enabled, optional documented sampling/persistence settings and
disabled traces). Its complete supported shape is bound in the plan and preserved
exactly during upload and readback. Disabled or unfamiliar settings are rejected;
the helper never silently re-enables them or adds an external log destination.

There is one explicit task-owned bootstrap exception. The operator created the
fixed-name HelloWorld shell with active version
`efe3d7d3-f133-4884-9d8a-cbf272a86e02` and inspected it through
`mode:"inspect-bootstrap"`. This GET-only mode reports full active version and
deployment IDs, downloaded source SHA/byte count, compatibility date, binding
names/types/counts, schedule/tail/custom-domain counts and subdomain booleans. It
never returns source code, binding values, raw errors or credentials.

For that shell only, an approved `plan`/`deploy` may include
`bootstrapProof:{versionId,sourceSha256,taskOwnedNoZoneRoutes:true}`. The UUID must
retain the task-created `efe3d7d3-` prefix; its full value and exact downloaded SHA
must match fresh readback. The current head must have one 100% deployment, zero
bindings/secrets, schedules, tail consumers and matching custom domains. The
plan fingerprint includes this proof and the complete inspected state, and
deployment refetches it before writing. The exception cannot be replayed after
the first replacement changes that version/code. An unrelated existing Worker
still fails closed. API custom-domain results are checked for completeness;
`zoneRoutes:"unverified"` remains explicit because no zone-read grant was used.
The operator's dashboard inspection established no zone routes for this new shell;
the boolean is a task-specific attestation, not an API verification claim.

The library entry point can be imported in a Node REPL without global `process`.
Byte validation accepts genuine cross-realm Uint8Array/Buffer views while
rejecting clamped, signed and DataView inputs. Uploads use a bounded multipart byte
body and explicit JSON/module media types, so they do not depend on global
FormData or Blob. The deterministic boundary is tied to the artifact pin and
enable flag, checked against both parts; authentication and write order are the
same in CLI and imported-library execution.

Every request has a ten-second deadline and a 96 KiB response cap; the whole
sequence has a two-minute deadline. Redirects are denied. A failed, malformed,
aborted or uncertain mutation stops the sequence without automatic resends or
cleanup. The safe summary identifies the phase and whether readback is required;
it excludes API response text, credentials, signatures and error stacks. Preserve
that summary and inspect the actual account before approving a new plan. Secret
readback proves the binding's presence, not equality of its hidden value; actual
authenticated hosted captures prove interoperability. A fully configured Worker
is left untouched even if a key is supplied again; wrong-key repair or rotation
requires a separately approved operator action rather than an automatic resend.

The Cloudflare upload API has no create-only or conditional-version write
condition verified by this package.
Its absence check followed by upload therefore requires one coordinated operator
for the fixed name; it is not an atomic lock against another simultaneous creator
or staged-version writer. Strict inheritance defaults to the latest upload, so
the active/latest-head check also requires that coordinated operator boundary.
No route or domain mutation is performed. `publicSubdomain` covers workers.dev
and preview URLs only; `customRoutesVerified:false` keeps other route/domain
attachments explicitly unverified in normal owned-timer readback. The bootstrap
inspection separately checks account custom domains while retaining the zone
route limitation. The operator must inspect those attachments
before resuming an existing Worker. Known code/configuration must pass every
readback; unsupported provider response formats fail closed rather than being
silently treated as deployment success.

Official contracts: [module upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/),
[script listing](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/),
[active deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/),
[latest uploaded version](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/),
[version bindings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/),
[current script/version settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/),
[original code](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/),
[secrets](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/),
[public URL settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/),
and [Cron schedules](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/).
The [public-fetch compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
and [Worker fetch contract](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
explain the routing requirement; only actual scheduled capture readback can prove
this deployment interoperates with the hosted collector.

## Private handoff between separate RAM runtimes

`private-deploy-handoff.mjs` is an optional one-use local transport when the token
and signing key are held in different authorized processes. Start its CLI with
a TTY and no arguments. It prints `awaiting_private_initialization`, disables
terminal echo, and accepts one newline-terminated private JSON initialization:
`schemaVersion`, `mode`, `accountId`, `hmacKey`, `nonce`, plus `planId` for deploy
or either reviewed upgrade
and an explicitly approved `bootstrapProof` when applicable. Its imported
`startPrivateDeployHandoff` library also works without global `process`.

The listener binds only to `127.0.0.1` on an ephemeral port. Ready output contains
that port and a bounded lifetime; it never contains the private nonce or keys.
Post to the fixed `/minute-deploy/token` path with `x-earth-deploy-nonce` and the
exact body `{schemaVersion:1,apiToken}` using an authorized backend HTTP client.
Browser Origin/CORS, foreign Host, other methods/queries, duplicate/extra fields
and bodies above 4 KiB are rejected. The first valid submission closes listening
before invoking the deployment helper. Initialization plus operation expires
within 120 seconds; cancellation closes sockets and stops pending work. Result
and stdout are independently sanitized. Private references are cleared when the
handoff finishes; JavaScript strings are not claimed to support secure erasure.
The relay's initialization key is not forwarded for read-only or either upgrade
modes; the upgrade inherits the existing server secret instead of replacing it.

The actual operator handoff used X25519 ephemeral key agreement between the CUA
and Node REPL runtimes. Only their public keys and the local port were exchanged
through tool results. Each side derived the same private 32-byte nonce in RAM;
the token stayed in CUA RAM, and the HMAC stayed in the deployment runtime until
used. No private key, shared nonce, API token or HMAC appeared in chat, tool output,
files, command arguments or environment variables. This was an operator transport
procedure, not built-in account authentication or a new permission grant. Do not
replace it with copying credentials into visible output or saved configuration.

## Bounds and cancellation

Each invocation signs the same canonical protocol as the existing hosted client:
method/path/fixed body, current request timestamp and random 128-bit nonce. It
performs at most one POST and streams at most 4 KiB of JSON within a 55-second
wall deadline. Network or response failures never trigger an immediate retry.
The next regular minute remains the next attempt. Aborted or uncertain requests
report `stored:null`; late storage may still finish on the hosted service.

Scheduled handling awaits that single operation and calls `controller.noRetry()`
when the runtime provides it. This avoids retry fan-out after an uncertain write.
Outbound Fetch uses workerd's supported `redirect:"manual"` option. Every 3xx is
rejected before body consumption; no Location is followed or logged. Failure
diagnostics expose only reviewed phase/reason enums and safe counts, never raw
response bodies, request headers, signatures or tokens.
The timer has no global lock or durable last-success state; server admission,
provider cadence/backoff and exact publication gates remain authoritative. It does
not guarantee exactly one distributed execution or make a slow source update
every minute. A `busy` result is an explicit skipped collection opportunity.

To stop collection, deploy `EARTH_MINUTE_TIMER_ENABLED: "0"` and explicitly set
`triggers.crons: []`. Removing/commenting out the Cron field does not remove an
already deployed trigger. Configuration propagation can take up to 15 minutes;
already admitted hosted storage may still settle. Revoking the dedicated key on
the hosted service also stops future authenticated admission, while affecting
other runners using that same scoped key.
[Cloudflare Cron configuration and removal](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Public HTTP handlers, if deliberately exposed later, provide read-only
configuration health at `/`, `/healthz` or `/status`. They never collect or write.
They do not report shared last-success timestamps from isolate memory. Logs contain
only the allowlisted status/count summary, never credentials, signatures, source
text, raw responses or error stacks. Failed runs become safe scheduled errors;
paused and busy outcomes remain explicit skips.

## Free-plan capacity

Official Cloudflare documentation checked on 12 October 2026 lists 100,000 daily
requests, five account Cron Triggers, 50 subrequests per invocation and 10 ms CPU
per Free-plan Cron invocation. The minute timer uses one Cron and approximately
1,440 invocations/one outbound request daily. Network wait does not count as CPU,
so its 55-second wall deadline is distinct from that 10 ms CPU limit. These numbers
suggest a small fit; local Node checks do not prove hosted CPU or shared account
headroom. The hosted Sites application's storage/CPU allowances are separate.
[Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/).

## Focused verification and compatibility

```sh
node --test collector-worker/minute-trigger.test.mjs collector-worker/index.test.mjs worker/collector-trigger.test.mjs
node --test collector-worker/deploy-api.test.mjs
node --test collector-worker/private-deploy-handoff.test.mjs
```

The checks exercise existing server HMAC interoperability, fixed target/action,
no broad-token/KV access, bounded and stalled responses, misleading success bodies,
cancelled/paused Cron, deadlines and credential-free logs. They use injected
synthetic HTTP responses; they make no provider/Cloudflare request or deployment.

The old `index.js` module is retained only for the already-existing local
`scripts/collector-daemon.mjs` compatibility import. It is not the Wrangler entry
point. Its legacy broad-credential/KV deployment recipe has been removed from this
README; new external runners use the narrow stateless timer above.
