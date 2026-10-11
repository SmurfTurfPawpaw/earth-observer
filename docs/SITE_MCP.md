# Native Site MCP control surface

`worker/site-mcp.js` exports `createSiteMcpHandler(options)` and the exact root path
`SITE_MCP_PATH = '/mcp'`. The returned async handler accepts `(request, env, ctx)`
and returns `null` off that path. Mount it at the combined Site root before Earth
prefix normalization. Root integration owns the entry point, `mcp` hosting
capability, configuration, publication, generated plugin and cloud runtime trial.
This module does not provision any of them or add a new dependency.

| Tool | Operation and scope |
| --- | --- |
| `source_capabilities` | Frozen reviewed ledger or one named source; no network/storage |
| `collection_status` | Existing prepared-storage status reader; no provider acquisition |
| `list_world_events` | Existing retained world reader, max 50 events, optional UTC knowledge cutoff |
| `event_detail` | One validated event ID at the cutoff; no URL/object-key input |
| `caller_identity` | Caller identity/permission state; optional explicitly unverified header probe; no email/name/configured owner ID |
| `collect_sources` | Narrow owner-only call into existing `handleCollection` with action `collect` |

Reads do not trigger collection. Missing world storage or historical membership is
reported as unavailable; no present-day source data is substituted. Source text
and evidence links remain untrusted data. The tools cannot run arbitrary SQL,
publisher URLs, uploaded code, model prompts or storage keys. The underlying
source registry, history and writer remain the single data engine.

## Authentication and activation

The Site stays public for viewing. Native Sites authenticates MCP viewing and
provides `oai-authenticated-user-id`; collection authorization is an additional
server check. All three conditions are required for writing:

- `EARTH_MCP_TRUST_SITES_IDENTITY` is exactly `'1'` after gateway verification.
- `EARTH_OWNER_USER_ID` is explicitly configured and exactly equals the gateway's
  site-scoped caller ID; no first-caller registration, email or display-name grants.
- The request has no browser `Origin` header, and the existing server-only
  `EARTH_COLLECTOR_TOKEN` is valid. It is passed only to an internal Request consumed
  by the existing handler, never returned or accepted as a tool argument.

Before owner activation, keep `EARTH_OWNER_USER_ID` unset and trust disabled.
All writes fail. By default caller header IDs are hidden. For a bounded deployment
probe only, server `EARTH_MCP_IDENTITY_PROBE='1'` adds `candidateHeaderId` and
`unverified:true` to the read-only identity result. It grants no permission and
does not change `identityTrusted`, `siteScopedUserId` or `isOwner`. It accepts no
probe setting from tool arguments, URLs or caller headers.

Use the disabled-trust probe to compare public anonymous forged-header requests
against the owner's actual generated private-plugin call. Public sentinel headers
must not become an authenticated owner; the plugin's candidate ID is still a
candidate until its authenticated context and gateway boundary are established.
Resolve the native identity provenance contract and both ingress paths before
enabling trust. Set the explicit owner ID only from the verified owner connection.
Before any write, test anonymous forged-owner headers, an actual non-owner and
missing identity: each must produce zero mutation. Unit tests cannot prove the
hosted gateway strips/replaces public caller-supplied headers. If this boundary
fails or remains unverified, leave the writer disabled. Remove the probe flag after
the bounded verification; it is not a visitor-facing identity feature.

An MCP client identity/version in protocol metadata is self-reported and never an
authorization input. Private plugin installation, Site viewing, service-bypass
access and connected-app consent do not automatically confer owner write access.
Cloud tasks require their own verified tool connection; visitor sign-in or visitor
subscription inference does not provide a zero-visitor runtime.

## Protocol and bounds

The narrow stateless JSON HTTP adapter implements Sites discovery, tool listing
and calls for revision `2026-07-28`. Modern requests validate the protocol envelope
and mirrored version/method/tool-name headers. Completed results carry the required
wire discriminator/server identity; discover/list cache hints are private with
zero TTL. A bare Sites JSON-RPC discovery/list/call compatibility path remains for
the simplified native contract; it is not a legacy initialize/session server.

Limits are 16 KiB request bodies, 256 KiB final tool envelopes, 45-second request
deadlines, 60 requests/caller/minute and 600/isolate/minute. Collection has one
pending operation and at most one admitted call/minute per env object in the
isolate, in addition to existing persistent provider admission/backoff. Isolate
limits are not a global quota or distributed lease; retain server-side durable
source policy. Arguments fail closed rather than accepting undocumented fields.

A deadline aborts pending body/provider fetches and stops a successful response.
It cannot undo a storage operation that has already started: a write timeout is
an indeterminate outcome, so inspect stored status before retrying. Existing
immutable identities and source policies remain responsible for safe recovery.
No credential or raw collection packet is included in the write result.

Compatibility risks to check on the generated plugin: supported protocol revision,
strict modern envelope/header forwarding, identity preservation, tool schema
refresh and response size/deadline. No SSE subscriptions, sessions, legacy
`initialize`, client notifications, resources/prompts, elicitation or MCP Events
are advertised. The minimal adapter covers this tool surface; it does not claim
full SDK/spec conformance. Use the official SDK if the verified client requires a
larger protocol surface rather than silently accepting unsupported behavior.

Primary protocol reference: [current SDK revision support](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).
[MCP Events](https://developers.openai.com/plugins/build/mcp-events) is a separate
supported-cloud webhook capability, not implemented here or equivalent to a cron
trigger. The native Sites skill's `site-mcp-server.md` and `identity-and-secrets.md`
define hosted identity and publication requirements.

Activation evidence must identify the published version, owner identity probe,
denied callers, actual bounded collection and persisted readback. Only a fresh
cloud invocation with no laptop/browser dependency can establish unattended
writer readiness; a local test or saved schedule cannot establish always-on
acquisition.
