# Dedicated collection timer

This standalone Cloudflare Worker invokes the hosted Earth's authenticated
collection endpoint once per minute, including when no browser is open. Its
deployment is **not active merely because these files exist**. Cloudflare
account access, the shared server secret, deployment and actual scheduled
execution still require verification.

The only write action is the Worker `scheduled()` handler's fixed HTTPS POST
to `https://giovannicallebaut.com/earth/api/collector`, with
`Authorization: Bearer <EARTH_COLLECTOR_TOKEN>` and body `{ "action": "collect" }`.
The one other explicitly allowed origin is the user's existing generated host,
`https://giovanni-callebaut.giovanni-callebautt.chatgpt.site`. Origin configuration
rejects other hosts, paths, credentials, queries and fragments; request inputs
cannot change the target. Redirects are rejected and secrets never appear in
the public status or configuration example.

## Configuration and deployment

Use a current Wrangler CLI and an authenticated Cloudflare account. Run from
this directory. These instructions do not install, create resources or deploy
anything automatically.

1. Copy `wrangler.example.jsonc` to your own `wrangler.jsonc`. The example's
   `* * * * *` is a valid every-minute Cron Trigger. If another existing Worker
   uses the same name, choose an unused name in your account before deploying.
2. Set the same strong, random, 32-or-more-character `EARTH_COLLECTOR_TOKEN`
   secret in the hosted Sites application's server environment and this
   dedicated Worker. Do not put it in `vars`, a Git commit or browser code.
   Wrangler's interactive `wrangler secret put EARTH_COLLECTOR_TOKEN` avoids
   passing the value in command history. Tokens may use standard bearer-token
   characters; a random base64url or hexadecimal token is suitable.
3. For retry state across instances, create a Workers KV namespace and add its
   actual ID under binding `COLLECTOR_STATE`. It stores a small normalized
   status/attempt policy, never visitors, source bodies or the secret.
4. Deploy the configured Worker with `wrangler deploy`. Cron configuration
   changes can take time to propagate; inspect a real scheduled invocation and
   the hosted collection/source status before calling the timer active.

Official references: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
[KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/).

## Bounded execution and status

One invocation performs at most one authenticated POST, with a 25-second
deadline, no redirect or cookies, and a 16 KiB response-body limit. No immediate
retry or extra provider call is made. Failure backoff starts at one minute and
increases to an hour; HTTP Retry-After can extend it up to 24 hours. Configured
KV reads/writes have one-second deadlines and failures before acquisition
prevent the POST. Same-instance invocations coalesce. A 60-second attempt lease
and retry policy survive through KV when available.

KV is eventually consistent and its lease is **not atomic**. It cannot prove
that distributed or duplicate Cron executions cause exactly one global POST.
The hosted collector must retain its own atomic R2/provider admission and
backoff. Without KV, this timer's memory policy lasts only for that instance.
Neither the lease nor a successful trigger guarantees any provider's freshness.

The attempt lease and completed status use separate KV keys, each written at
most once by an invocation, to avoid the provider's one-write-per-second limit
for a fast response. A continuously successful minute schedule uses about
2,880 KV writes per day; the published Workers Free KV allowance is 1,000/day,
so that binding needs adequate allowance or a different persistent scheduler
design. The example leaves KV unbound and never purchases a plan.
[KV write rules](https://developers.cloudflare.com/kv/api/write-key-value-pairs/),
[KV allowances](https://developers.cloudflare.com/kv/platform/pricing/).

`GET /status` (also `GET /`) reads last attempt/success, response status and retry
times. It does not collect, refresh providers or write KV. POST and other methods
on these public routes return 405. Success means the authenticated target
accepted the trigger and returned bounded JSON; it does not claim every feed
was fetched or every source succeeded. Dated per-source results remain on the
hosted Earth API. A scheduled invocation logs only this compact status, never
authentication headers or target JSON. An unavailable/missing configuration
remains explicit. Without KV, a public status request may reach a different
instance whose local history is empty.

This timer moves routine triggering away from GitHub Actions and visitors.
Actual source acquisition, normalization, persistent snapshots and freshness
remain in the hosted Sites endpoint. Existing Node-based GKG ZIP ingestion and
its scheduled artifact are a separate pipeline: this Worker does not decode
GKG, copy publisher pages or make all world reporting an exact real-time feed.

## Focused verification

From the repository root:

```sh
node --test collector-worker/index.test.mjs
```

This test injects synthetic responses and storage. It makes no production,
Cloudflare or provider requests and does not establish a deployed schedule.
