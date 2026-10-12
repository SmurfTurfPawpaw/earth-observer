# Published foundation UX verification

Latest root acceptance is version 36 at 02:20 UTC on October 12, 2026. The release-27
agent record below is historical, not the latest browser status. See the dated
version-36 gate in FOUNDATION_PROGRESS.md for actual asset adoption, mobile reading,
Back/focus, retained PDF bytes, and the limits of synthetic agent API journeys.

12 October 2026. Release 27. Browser journey verification is **pending**, not a
passing result. This agent's CUA entry returned `Browser is not available: iab`;
the subsequent inventory returned no apps or browsers. No QA tab or screenshot
was created, and no existing user/root tab was changed. Browser ownership was
returned to root immediately. Local contract tests are not GPU or browser evidence.

## Release facts reported by root

Release 27 succeeded on the custom domain, with assets `index-m8toravE`,
`main-qgIn_pMv`, and `index-j4QqTKmg`. A bounded USGS M4.5+ origin interval
2025-10-01 00:00 through 2025-10-08 00:00 UTC contains 184 retained events in two
import pages, archive edition `archive:1`. Root verified a stored scene detail
against retained raw evidence and verified that current live source pointers did
not change. A 2025 Known then cutoff returns no later hosted archive evidence.
These are root-reported serving checks, not observations of visitor interactions.
Archive expansion may legitimately change the edition and available range.

## Actual browser journeys still required

Use a separate QA tab; preserve user tab 18 and root foundation tab 19. Record
viewport, edition, actions, actual result and any console/network errors. Do not
read application-internal state or manufacture telemetry. Keep aggregate search
contribution off; place/coordinate search currently resolves locally, and context
search contribution is an explicit opt-in. Do not use authentication, submission,
notification or account actions for these journeys.

| Journey | Required observable result |
| --- | --- |
| First visit and reload | Visible globe and useful controls; continuously advancing UTC; no expanded inventory on first use; explicit remembered preferences survive reload. |
| Geography | Zoom buttons and globe gestures move the actual camera. A place/coordinate search updates geography. Search is described as places/coordinates, not universal event search. |
| Keyboard | Slash focuses search; calendar disclosure responds to Enter; Play, speed and Live are independent accessible controls; focus stays visible. |
| October 2025 reconstruction | Selecting a date owns scene UTC; pins use stored source origin dates. No current earthquake snapshot substitutes for history. The coverage band depicts actual imported intervals. |
| Play and stop | Clock and calculated sunlight move together. Pin entry/expiry follows the selected seven-day origin window locally, without a network request per changing pin. Pause stops selected UTC. Observe browser/GPU work separately. |
| Known then | Calendar date remains unchanged; later hosted evidence disappears. The message distinguishes unavailable evidence from a completed empty source window. |
| Source dossier | A selected pin opens the one right dossier without changing UTC/camera. Occurrence, correction, first retention and archive publication remain separate. Original source link opens the reported USGS page. |
| Gaps | A date inside an unimported interval clears unsupported pins, keeps selected UTC and states that the period has not been imported. Unrelated global intervals cannot imply completeness. |
| Live return | Historical pins disappear; current UTC resumes and requested live-layer intent returns. Late historical responses cannot restore the old scene. |
| Mobile 390×844 | Search, rail, zoom, bottom calendar and dossier remain reachable with approximately 44px targets. Safe areas/credits remain usable; no horizontal overflow or competing sheets obscure the map. |

Save real screenshots into ignored `qa-artifacts` only after capture. No screenshot
artifact is supplied by this audit yet. Screen evidence should include desktop
reconstruction/dossier, mobile calendar, and the Live return state.

## Narrow defect corrected before release

The initial historical status used global coverage segment presence to decide
whether the selected period had some coverage. That could label a wholly unimported
window as merely partial. The UI now checks intersection with `(selected UTC −
7 days, selected UTC]`. A focused manual-date fixture selects 15 June between
completed 1–7 June and 21–30 June intervals: old pins clear, the selected UTC remains,
and the message explicitly states that the period has not been imported. The four
calendar contract checks pass. This verifies the semantic defect; the real browser
journey remains pending above.

## Stale release adoption

Root observed the published browser still using release-26 script/style assets
after ordinary reloads, while an independent HTTP document read served release 27.
Source inspection found that the active worker always preferred its fixed cached
document online; its background request only checked availability and discarded
the current HTML. Worker activation claimed clients but the document had no
controller-change adoption handler. These mechanisms can keep an open document on
old code after a completed worker upgrade; they do not prove every installation
request succeeded in that browser.

This agent independently read the public `/earth/sw.js`: HTTP 200 JavaScript,
`Cache-Control: no-cache`, release `93000627dcae2f2f`. Its declared universal public
shell artifact returned HTTP 200 JSON with immutable caching, and the response
SHA-256 matched the worker descriptor. No cookies, credentials or browser state
were read or modified. Those observations validate artifact discovery, not the
browser's registered worker/controller or the installation of all critical assets.

The worktree fix makes own-root navigation network-first without storing network
HTML. Only the verified build-time universal shell remains eligible for offline
fallback. Intentional 401/403/404, private/no-store/cookie-bearing failures and
non-HTML server responses stay server-owned. The existing atomic completion marker,
digest/header checks, failed-install cleanup and one-prior-release asset recovery
remain intact. No worker unregister or general cache purge was introduced.

Bootstrap now starts a nonblocking registration with `updateViaCache: none`, checks
updates every five minutes while visible and checks on reconnect/visibility return.
Replacing an existing own worker permits one automatic reload of the unchanged
URL/hash; first installation and other workers do not. Focused text, unsaved notebook
fields and saved notes held only in tab memory defer adoption. A legacy document
without this handler may require one ordinary reload after worker activation;
hard refresh or internal worker mutation is not the migration method.

The 39 focused runtime, update-lifecycle and production-bootstrap checks pass,
including online-new/offline-fixed separation, no private HTML persistence,
access-response preservation, deadline fallback, no boot loop, text protection and
engine startup independent of a stalled update check. Actual published browser
adoption, visual latency and GPU/frame behavior still require root's UI session.
