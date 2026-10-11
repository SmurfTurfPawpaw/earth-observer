# Foundation run progress

Run: 2026-10-11T21:39:10Z → 2026-10-12T06:39:10Z (Brussels 23:39 → 08:39).
Plan: FOUNDATION_PLAN.md. This is the first bounded work window toward the full
platform goal. Passing a foundation slice does not complete the global objective.

## Initial verified baseline

- Production Site version 25, public, owner-accessible, existing D1/R2; no linked
  schedules at fresh get_site read. Domain and portfolio preserved.
- Existing app HEAD 822d73a, runtime commit caa2383; combined source 72c14d4.
- Working branch codex/foundation-20261011 in a clean separate checkout.
- Original unfinished offline/GDELT/aircraft work is untouched and excluded initially.
- Three agents performed read-only architecture proposals; ownership follows plan.
- Current analysis is deterministic metadata, not an investigative model.
- Continuous cloud execution, two-year backfill and whole-scene playback are unverified.

## Phase status

| Phase | Status | Evidence / next gate |
| --- | --- | --- |
| 0 Baseline and contracts | Locally established | Design/source ledgers, real production globe and zoom checked; runtime limits unresolved |
| 1 Acquisition | Pending feasibility | Native Sites execution/writer identity verification first; no unattended claim |
| 2 Evidence/world model | Local integration passes | Immutable revisions and atomic publication receipts; reducing database budget |
| 3 Shared time | Local checks pass | Continuous UTC/monotonic clock, native sunlight, calendar replay and shared weather frames |
| 4 Design/performance | In progress | Unified search/rail/dossier/time layout; actual browser gate after integration |
| 5 Investigation/release | Planned | End-to-end evidence, agent journeys, coherent package |

## Decision log

- D001: Start from the named committed baseline in a separate checkout. Reason:
  preserve paused WIP and prevent accidental release of unfinished unrelated changes.
  Consequence: integrations and builds use this checkout; each WIP inclusion is reviewed.
- D002: Past, current and future share the evidence core but have distinct semantics.
  Consequence: predictions/forecasts carry versions and assumptions; smooth rendering
  cannot create new observations or conclusions.
- D003: Evaluate native hosted operations before proposing another provider. Reason:
  existing D1/R2 and user free-first preference. Cloud cadence and authorization remain
  gates, not assumed capabilities.
- D004: The user activated the nine-hour goal through the app while plan preparation
  was running. Preserve that active goal rather than create a conflicting second goal.
  This plan is its detailed execution contract; goal tool currently updates status only.

## Initial implementation checkpoint

- Source/model, clock/timeline and source/runtime agents have exclusive new-checkout
  ownership; root owns migration, integration, design, native Sites access and release.
- Linked the existing unchanged dependency directory for read/build use; no install or
  dependency upgrade. Original working files remain untouched.
- Native cloud-agent scheduling exists, but minimum cadence/wake/runtime quotas are
  unverified. A prepared minute Cloudflare trigger would still require account access
  and would not execute the Node-only GKG decoder. No provider migration selected.

## Checkpoint template

Record timestamp, phase, files/revisions, evidence, gaps, changed assumptions,
affected downstream phases, next action, and local/deployed status. No credentials.

## Schema and design checkpoint

- Root added DESIGN_CONTRACT.md with the interaction hierarchy, palette, typography,
  accessibility, transitions and latency measurement contract before UI changes.
- Root generated 0003_world_evidence.sql and Drizzle journal/snapshot from additive
  db/schema.ts changes; nothing applied to production. Agent storage code targets
  those exact columns, with separate capture/knowledge dates and reused R2 bodies.
- Existing Sites source checkout opened through the supported helper at unchanged
  72c14d4. Short-lived credential remained in session memory, never persisted/output.
- NOAA actual capabilities were read: timed weather frame ranges exist but are not
  archived independently, so replay cannot claim two-year weather coverage. Adapter
  nearestValue behavior requires actual frame admission instead of arbitrary times.
- No deployment has occurred in this run. Production remains version 25.

## First contract re-examination

The evidence agent identified a race between partial item projection and source
watermarks that could corrupt historical membership under concurrent/late arrivals.
Before integration, revise the source publication receipt contract and evaluate
reuse of existing history versus an additive completion receipt. This changes the
schema, projection completion and historical reader gates; UI work can continue
independently. The generated migration is still unpublished and can be consolidated.

## 2026-10-11T22:01Z integration checkpoint

- The additive completion receipt fixes late-arrival membership; SQL publication
  transaction time fixes a historical availability leak from queued writes. First
  source capture, event and source revision dates remain independent and unchanged.
- Actual migrated SQLite publication -> world index -> update stream integration
  passes; reading the stored event performs zero provider requests. The older
  /api/history view still describes collection checks; it is not relabeled as a
  strict hosted-publication knowledge cutoff. /api/world/events owns that contract.
- Full archive as-of responses now prove the next capture boundary, allowing
  playback across days without requests on every second. A recent R2-only index
  continues to disclose its bounded coverage; no two-year data is invented.
- One shared scene clock now drives native sunlight and dated weather frames.
  Weather stays available in history only inside genuine provider frame coverage;
  unavailable dates hide frames. Other live-only layers remain suspended.
- Root checks cover weather frame boundaries, gaps, cancellation and absence of
  independent playback timers. Ordinary time ticks cause no product reapplication
  or control rebuilding. Existing manager/history checks pass after integration.
- Production browser baseline shows the globe and real terminator; Zoom in reduced
  displayed altitude from 16,161.8 to 10,505.2 km. No claim about all devices follows.
- The first world publisher's 500-item budget was too large (215 SQL statements).
  Re-examine this before release: bounded JSON1 inputs/bulk queries are being built.
- Root /mcp is mounted in the combined build and declared in its manifest. Writes
  remain disabled. A temporary read-only identity probe is configured for the next
  deployment (runtime revision 3); no owner ID/trust is enabled. Site schedules are
  still empty and cloud execution remains unverified.
- No new release has been deployed yet; live Site remains version 25. The original
  checkout's unfinished changes remain untouched.

Decisions: D005 use full-source completion receipts and database publication time;
D006 share one scene time while keeping discrete source observations; D007 reject
an expensive publisher despite correctness checks; D008 verify cloud identity and
execution before activating owner collection, without adding paid accounts.

## 2026-10-11T22:15Z dependency re-examination

- Bulk evidence publication now passes 23 focused checks: the realistic 500-item
  package uses 16 SQL statements, maximum JSON bind 260,858 bytes, and a proved
  capture/database-clock bound. Historical source/capture queries seek an index.
- Public prepared promotion and its notification need an additional release gate:
  no pointer may advance before that exact packet completes history/evidence.
  A second race lets an obsolete compact heartbeat regress world facts. The
  approved correction treats a compact heartbeat as operational checkedAt metadata,
  with exact baseline CAS, separate check age and no new factual history/revision.
  Phase 2 therefore remains in progress; no release is promoted around this failure.
- Actual desktop/mobile browser review confirms the cartographic night material
  compiles without console errors and keeps night geography readable. Sun/Moon
  remain calculated from shared scene UTC; no city lights are invented. Calendar
  keyboard disclosure and independent transport controls work at 390x844.
- Selection now reads a stored USGS dossier only when identity, epicenter,
  magnitude and origin time match the displayed feature. Cancellation and knowledge
  cutoff checks pass. It has no constructor/provider/per-frame acquisition.
- Current context cards are explicitly scoped to latest retained metadata in
  historical mode. This is an interim scope boundary, not complete historical
  investigation support. Calendar coverage still awaits production integration QA.
- Unconditional warming of every optional engine is removed. Small common code
  warms after startup; other modules already warm on pointer/keyboard intent.
- GitHub's existing public repository can provide free standard-runner collection
  without the laptop, but observed schedule delays mean it cannot promise a
  continuous or minute-level SLA. A new narrowly scoped HMAC trigger is being
  prepared as an optional fallback; no credential/schedule/run is activated yet.
- Site MCP remains read-only/owner-write-disabled pending actual gateway and cloud
  identity verification. No paid provider, new account or unverified free quota.
- Re-examined future phases: independent invocation and publication gates precede
  backfill/investigation; spatial delivery and scenario work may be designed in
  parallel but cannot claim source coverage or complete production behavior.

Decisions: D009 compact heartbeat is a check, not a factual capture; D010 readability
is a bounded solar cartographic treatment; D011 warm by intent instead of importing
all engines; D012 retain explicit runtime/coverage gaps and adapt downstream phases.
