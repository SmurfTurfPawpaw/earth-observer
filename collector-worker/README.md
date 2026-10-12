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

## Ready code, pending activation

No Cloudflare account was connected, Worker deployed or secret provisioned by this
change. These files alone do not establish unattended collection. The current
GitHub `hosted-collector.yml` workflow supports finite, owner-invoked verification
through `workflow_dispatch` only; it has no automatic collection schedule. Minute
execution needs independent account access and actual runtime verification.

1. Use an authenticated Cloudflare account with permission to deploy this Worker,
   manage its Cron Trigger and set its secret. Obtain account selection through the
   normal Cloudflare login/API-token flow; no credential is written in this repo.
2. Copy the example to local `wrangler.jsonc`, select a free unused Worker name and
   the actual account. To stage it without collection, set
   `EARTH_MINUTE_TIMER_ENABLED` to `"0"` and `triggers.crons` to `[]`.
3. Using the current Wrangler/dashboard secret workflow, provision the existing
   dedicated `EARTH_TRIGGER_HMAC_KEY` as a secret binding. Do not supply its value
   in command arguments, Git, browser code or plaintext `vars`. The example's
   `secrets.required` declaration prevents deployment with a missing key.
4. Deploy the timer with `EARTH_MINUTE_TIMER_ENABLED: "1"` and
   `triggers.crons: ["* * * * *"]`. `workers_dev:false` means no public HTTP route
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
Wrangler version is needed for required-secret validation. No CLI installation,
account creation, resource purchase or deployment was performed here.
[Cloudflare secret provisioning](https://developers.cloudflare.com/workers/configuration/secrets/).

## Bounds and cancellation

Each invocation signs the same canonical protocol as the existing hosted client:
method/path/fixed body, current request timestamp and random 128-bit nonce. It
performs at most one POST and streams at most 4 KiB of JSON within a 55-second
wall deadline. Network or response failures never trigger an immediate retry.
The next regular minute remains the next attempt. Aborted or uncertain requests
report `stored:null`; late storage may still finish on the hosted service.

Scheduled handling awaits that single operation and calls `controller.noRetry()`
when the runtime provides it. This avoids retry fan-out after an uncertain write.
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
```

The checks exercise existing server HMAC interoperability, fixed target/action,
no broad-token/KV access, bounded and stalled responses, misleading success bodies,
cancelled/paused Cron, deadlines and credential-free logs. They use injected
synthetic HTTP responses; they make no provider/Cloudflare request or deployment.

The old `index.js` module is retained only for the already-existing local
`scripts/collector-daemon.mjs` compatibility import. It is not the Wrangler entry
point. Its legacy broad-credential/KV deployment recipe has been removed from this
README; new external runners use the narrow stateless timer above.
