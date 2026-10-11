# Minute acquisition activation gate

Prepared implementation: `collector-worker/minute-trigger.js`. It is an independent
Cloudflare scheduled Worker whose only machine capability is the hosted service's
fixed collect-only HMAC endpoint. It has no storage bindings or broad publishing
credential. Deployable configuration and cancellation steps are in
[`collector-worker/README.md`](../collector-worker/README.md).

Current status is **prepared, not deployed**. Root's read-only environment inspection
found no verified Cloudflare CLI/account credentials; this adapter does not assume
an account exists or create one. Required next access is an authenticated existing
Cloudflare account and permission to deploy/configure this named timer and its
secret. The owner can provision the existing dedicated trigger key securely once
connected; no key value is saved in project files.

Current Sites capabilities include Site-linked cloud-task scheduling. The inspected
Sites recurring-update instructions and available tool catalog did not expose a
verified native minute HTTP Cron runner. Saving a Site-linked task, keeping a Codex
goal running, or using a laptop daemon does not prove minute unattended acquisition.
Native task cadence, connection authorization, runtime quotas and actual writer
readback remain a separate trial. The existing five-minute GitHub trigger is a
clearly identified fallback, not a minute service.

Activation passes only after a supported deployment, secure scoped-key provisioning,
two actual consecutive no-visitor/no-laptop minute runs, exact hosted receipt readback,
measured CPU within the selected plan and observed failure/cancellation behavior.
Local authentication/bounds tests establish readiness, not execution. Do not mark
this gate complete until those observations exist.

Cloudflare documents minute Cron, `scheduled(controller,env,ctx)` and awaited
execution; configuration changes can take up to 15 minutes to propagate. Its Free
CPU budget requires real runtime measurement. Current account capacity is shared;
no paid plan or quota increase is assumed.
[Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
