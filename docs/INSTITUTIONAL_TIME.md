# Institutional context and globe time

The ECB and Commission publication views use the globe's selected UTC. They are
stored source publications, not inferred incidents, policy effects or a complete
publisher archive. Their source publication dates are distinct from the dates this
platform captured and retained the evidence.

## Views

- Live reads the current retained publication projection and receives existing
  source update invalidations, with a five-minute fallback check while visible.
- Historical reconstruction filters publication dates through the selected UTC,
  using the latest admissible retained revisions. Later platform knowledge can be
  used to reconstruct an earlier publication view.
- Platform knew then additionally restricts complete receipt and item evidence
  dates to the selected UTC. A publication dated earlier does not imply the
  platform knew it before its first actual completed receipt.
- Future publication views are unavailable; the client does not invent forthcoming
  releases, borrow current publications or request a provider as a fallback.

An empty retained view is not evidence that no publication existed. Existing
rolling-feed coverage and bounded historical query limitations remain explicit.
Publication date is not a law's effective date, and institutional publications are
original assertions rather than independent corroboration.

## Continuous interaction

Opening context, choosing a source or purpose, committing a seek or evidence lens,
pausing, and returning Live capture actual scene time. During accelerated playback
the globe continues, while the publication panel clearly names its captured UTC.
Refresh at globe time updates that snapshot. Clock ticks and buffered historical
frame advances issue no institutional request. This separates smooth rendering
from source delivery without silently changing the meaning of the evidence.

The fixed Commission PDF examination currently represents its latest retained
source edition. Its inspection action is unavailable in historical publication
views and returns when Live is selected. Annual Belgian gas context remains a
separately labelled annual dataset; it does not pretend to follow globe time.

## Ownership and bounds

The selected, opened, visible view owns at most one stored-data request. Source,
time or lens changes abort obsolete delivery; late responses cannot replace the
new context. Hidden or closed panels cancel work. Terminal disposal removes timer,
update and lazy-document ownership before any later continuation can read the viewer.

Publication responses retain the existing 15-second, 256 KiB and 40-item bounds.
An LRU cache keys institutional entries by source, mode, lens and canonical UTC,
with at most six entries and 256 KiB total decoded response bodies. Those limits
do not measure JavaScript heap or the network's latency. Historical context does
not poll or automatically refetch on Live source events; explicit action updates
its captured snapshot. Known-then cache entries do not become dirty from later
knowledge. Reconstruction may indicate newly retained context without acquiring it.

Implementation: src/core/institutional-context-time.js, plugin-dossier.js,
world-timeline.js and the narrow main.js wiring. The existing retained publication
API owns complete receipt, query and storage admission; no provider access or new
backend route is introduced.

## Acceptance

The prepared package passed exact cutoff admission, same-source canceled delivery,
cache count/byte eviction, playback without per-tick acquisition, terminal cleanup,
latest-PDF History exclusion and Live restoration checks. Source/lens/time switches
participate in presentation identity even when underlying publication facts match.
Actual hosted query and browser proof must be recorded separately after deployment;
local checks alone do not establish a shipped or operating feature.

Version 43 was deployed at 2026-10-12 04:37:54.986Z. Six fixed hosted reads
confirmed independent reconstruction/publication and known-then receipt cutoffs.
The browser confirmed dated snapshots during local playback, actual-UTC source
selection and Refresh, exact pause commit, honest missing knowledge and restored
Live-only actions. FOUNDATION_PROGRESS.md records the bounded evidence and limits.

The readability follow-up retains UTC and lens in the visible snapshot. Its
publication cutoff, later-revision meaning and playback/Refresh explanation remain
in the tooltip and the closed feed receipt disclosure. Removing repeated prose
does not change query, cutoff or cache behavior.
