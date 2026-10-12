# Focus delivery and geographic beacons

This package separates retained observations, viewport detail, and marker presentation. It does not increase provider coverage or invent observations between updates.

## Display contract

The fixed stored-only `/api/layers/focus-scenes` endpoint serves the same USGS and GDACS source editions used by the shared prepared-scene pipeline. Mixed quadtree leaves form a disjoint whole-cell cover, bounded to 128 leaves through level18. Center refinement replaces each parent with all four children. The cover may conservatively extend beyond the view; it never silently drops a parent footprint.

At most64 compact point reports are shown: up to16 recent source attention highlights, up to6 center reports, and up to42 sufficiently refined singleton details. True coincident positions remain exact and get one point marker; all other reports remain in residual groups. Counts satisfy `sourceTotal = mappedTotal + unmappedTotal`, `mappedTotal = selectedMapped + outsideMapped`, and `selectedMapped = pointReports + residualReports`.

The compact view is limited to112KiB and its delivery to128KiB. A source title is a declared UTF-8 excerpt of at most256bytes. Full source evidence is fetched only when a user inspects a report, correlated with its exact source edition, factual revision, location, display values and original provenance. A compact marker is not a substitute for that proof.

Residual pages contain at most50 exact members. Their source version, view version, display-priority minute, group and cursor are bound together; expired editions request an area refresh. The display minute is not a historical knowledge timestamp. Public reads perform no provider acquisition or persistence writes.

## Visual language

Numerical map cards are replaced by compact category glyphs above thin WGS84-normal stems, with a small anchor ring. Heads use pale teal with source-supported color where present. Decorative height targets24CSS pixels, bounded to6m–250km; it is separate from source altitude and affected extent. Longitude and latitude are unchanged. Normal native depth and globe occlusion remain enabled.

Multiple category groups in one source cell share an area beacon. Their original groups/counts remain in the detail panel and layer records. Zoom normally refines the area; a category chooser and direct inspection recover dense, coincident, maximum-depth or repeated non-refining groups. Cross-source identity reconciliation remains separate work.

Arrival animation lasts320ms, uses one shared viewer listener, and is capped at64 simultaneous arrivals. Source points animate on first display or a new factual revision. Area summaries animate only on first appearance, not each refresh or attention reshuffle. Reduced motion, hidden pages and History settle the animation.

Seven category images and one base image use fixed native atlas IDs, with shared64px/32px artwork. Each native polyline owns its material. A bounded2s readiness fence updates staged individually hidden billboards and checks the public `Billboard.ready` property before the complete edition replaces the previous one. Cancellation or timeout retains the previous edition. This is image-resource admission, not a claim of completed GPU rendering.

## Evidence and remaining gates

The admitted500-report fixture preserves six center points plus494 residual reports in a5.5KiB view. True coincident500 yields one point plus499 residual reports. A128-leaf spread fixture remains under52KiB. Native browser preview of16 sample markers verified visible glyphs after the actual readiness gate, both tilted and above; observed gate times79ms and88ms are local preview measurements, not whole-site load or global performance benchmarks.

Durable followed subjects, evidence-backed contextual reach, detailed terrain/aerial restoration, comprehensive historical acquisition and long-run operating-cost proof remain active goal dependencies. Global significance must not be inferred from a marker's decorative size or source alert alone.
