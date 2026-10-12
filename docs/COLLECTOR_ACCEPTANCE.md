# Finite hosted collection acceptance

The optional `collector-acceptance.yml` workflow exercises the existing fixed,
collect-only signed capability for a chosen 10, 20 or 30 minutes. It has no schedule,
successor job, arbitrary URL/action, broad publication credential or self-renewal.
It is a deployment acceptance trial, not permanent application hosting.

The public fork uses the standard Linux runner. Public standard runners do not
consume a private repository's monthly minute allowance, but GitHub's execution
limits and Actions terms still apply. No runner upgrade or paid service is requested.
[Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[limits](https://docs.github.com/en/actions/reference/limits),
[terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions).

The process spaces starts by at least 61 seconds, serializes requests, reserves the
55-second request budget before starting another, backs off after failure and has
a finite attempt budget. Logs contain only public redacted acknowledgments. The
signing secret remains in the existing repository secret and process memory.
Cancellation prevents another acquisition and interrupts idle backoff; an already
running bounded HTTP request can still finish. Repository concurrency serializes
the trial with the existing one-shot hosted collector.

For actual unattended proof, stop the temporary laptop bridge first, leave ordinary
visitor reads separate from acquisition, then inspect cloud acknowledgments and
stored source/check receipts. Source checks and new facts remain distinct. Restart
temporary collection only after the finite job has stopped. Record the run, exact
commit, dates, outcomes and any failures; do not infer long-term availability from
one successful trial. A permanently deployed Cloudflare timer or another verified
independent runtime remains a separate dependency.
