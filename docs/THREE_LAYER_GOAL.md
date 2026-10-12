# Three-layer monitoring foundation

Active implementation goal, 12 October 2026. This supersedes the old automatic-goal status in the historical release52 checkpoint; it does not change that checkpoint's release evidence.

## Product contract

The world is monitored when nobody has the page open. Source acquisition, geographic processing and display are independent clocks and owners. A camera requests detail, not permission for a place to exist in the database.

1. Coverage: 120 stable land-and-water sectors; nominal one sector every 30 seconds, 60-minute sweep. The installed minute wake admits at most two due sectors. It does not provide an exact 30-second execution runtime. Last attempt, successful processing and the cited source capture are different clocks. Failed processing cannot fabricate completion; failure also cannot keep all other sectors waiting indefinitely.
2. Priority: separately bounded, deduplicated work for urgent evidence, evolving/followed subjects and regional demand. Preserve baseline capacity. Expire demand and limit retries. A scientific threshold or source alert can trigger investigation without establishing global consequences.
3. Presentation: hierarchical geographic cells and semantic scope. World/continent/country/region/local are display lenses, not the 120 collection sectors. Cover the entire viewport with a coarser level when a detail budget is exceeded. Count-preserving clusters expand as the view narrows; their centers are summary positions. Individual source coordinates remain exact. Screen-center emphasis allocates detail, never changes factual accuracy.

## Ordered packages and dependencies

1. Durable coverage and priority queue, migration-owned D1 schema, fenced claims and bounded recovery. Shared stored-source processor for USGS and GDACS. Public status is read-only, source-specific and honest about incomplete scope. Reserve baseline progress even when the provider collector's minute admission is busy.
2. Shared viewport demand and bounded client cache/delta recovery. Cut the current live earthquake display over to the prepared scene route. One owner handles camera changes, cancellation and manager admission. Preserve separate existing History scopes. No visitor provider acquisition or full-cohort fallback.
3. Contextual significance model: distinguish observed facts, source assessments and platform analysis. Require cited dependencies/affected jurisdictions to establish reach. Combine source/domain rules with bounded investigation; popularity and geographic size alone do not establish importance. Test a second domain through the same delivery contract before generalizing the interface.
4. Improve accepted visual detail through the separate terrain/camera/imagery restoration policy. Restore progressive close detail without hiding source delay or sacrificing the initial usable view. Test actual visible native browser behavior as well as engine screenshots.
5. Hosted acceptance: independent wakes, durable restart/fairness, source/cell clocks, bounded queue and storage, complete viewport/delta equivalence, cluster expansion, multiple users, and representative rendering/load measurements. Verify operational costs before recommending larger unattended workloads.

## Re-examination loop

After each package, compare measured behavior with these contracts. A failed contract returns to the relevant foundation before adding features. A better runtime, source contract or indexing method requires revisiting dependent packages and recording why; passing a unit fixture does not substitute for hosted or native display evidence.

Deploy only immutable reviewed packages. Do not bundle unrelated retention working files. Do not mark the goal complete for a local implementation, nominal schedule or partially configured reasoning engine. Exact 30-second execution, broad news/context inference, arbitrary historical playback and whole-platform smoothness need their own acceptance evidence.

## First implementation checkpoint

The first package implements the coverage and regional-display paths, pending hosted acceptance. `coverage-store`/`coverage-scheduler` use the appended 0011 migration, primary SQL clocks, UTC minute buckets, fenced 30-second owner leases and atomic completion tokens. One wake reserves two baseline sectors and admits at most two distinct priority sectors. Each sector has a six-second processing deadline; a timed-out callback cannot publish later. A corrupt priority row closes that lane without stopping the baseline. Existing source acquisition cadence is unchanged.

The authenticated trigger starts this independent coverage owner even when provider admission is busy. Its replay nonce is consumed before either owner starts. The retained-source processor reads USGS and GDACS once per admitted wake, races each read against a five-second bound and retains available scopes when the other is unavailable. Source-based urgent candidates are bounded investigation signals, not impact or geopolitical significance judgments. `/earth/api/coverage/status` is read-only; its successful-sector counts describe the explicit retained source bases, not global factual completeness.

The live earthquake factory now loads the prepared regional client and native symbol layer. Footprint/pixel policy selects a complete bounded cell set; stored snapshots and exact-base deltas replace the previous whole-cohort browser path. A 16-view/2 MiB memory cache never regresses a source fence. During movement, the old complete edition retains its own coordinates and receipt until the new view swaps atomically. Counts represent whole selected cells, not the exact camera rectangle. Cluster centers are summaries; close features show actual seismic icons and lazy exact-source selection. Preparation and unavailability are distinct UI states, including before the first successful view.

Local gates cover actual SQLite migration/fencing, jitter, all 120 sectors over 60 restarted admissions, failure/cancellation/fairness, retained read deadlines, complete viewport selection, count-preserving snapshot/delta recovery and actual Cesium primitive/selection lifecycle. These are not measurements of native GPU responsiveness, exact 30-second execution, server cost at scale or completed contextual reasoning. Those gates and the remaining ordered packages keep the goal active.
