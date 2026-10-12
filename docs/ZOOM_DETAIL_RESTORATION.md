# Zoom and visual-detail restoration gate

The user expects the original close-up capability to survive optimization. Reducing
source resolution, removing terrain or permanently restricting camera distance is
a capability change, not evidence of an efficient renderer.

## Verified difference

The first lean rebuild, c2453ac, introduced a 250-metre minimum in viewer controls,
navigation buttons and saved-view validation. The original uses Cesium's native
one-metre minimum clearance. The current imagery mode uses NASA Blue Marble's
level-eight overview; it cannot gain aerial detail by requesting nonexistent
levels. Street mode has OpenFreeMap native level-fourteen vector geometry, redrawn
through level eighteen, with flat building outlines. The original uses Esri aerial
imagery and actual Re:Earth or configured Cesium terrain; optional Google 3D needs
its own access. The current viewer uses a flat ellipsoid.

The root-owned diagnostic on port4191 is a separate low-resolution Natural Earth
benchmark. Its level-two imagery must never stand in for production-detail acceptance.
The later shared work and point-batch release does not cause the older downgrade.

## Ordered restoration

1. Define one camera policy for buttons, gestures, links, saved sessions and flights.
   Serialized camera height is above the WGS84 ellipsoid; minimum clearance is above
   the available terrain. Restore close navigation while safely admitting mountain
   and below-sea-level views. A terrain promotion may adjust clearance, but must not
   reset the selected scene date, historical lens or source edition.
2. Add a viewer-owned progressive terrain lane using the existing admitted Re:Earth
   source and upstream retry/cooldown mechanics. First paint stays inexpensive;
   regional refinement loads on demand. Preserve native metadata attribution,
   cancellation, last-good rendering and a recoverable flat fallback. A best-effort
   source is not a guaranteed service or unlimited hosting entitlement.
3. Integrate common ground anchoring before terrain promotion. Current static
   primitives use ellipsoid heights and cannot automatically clamp to terrain.
   Display anchors must preserve exact geographic/source measurements and keep
   derived surface height separate. Bound visible candidates rather than sample
   terrain independently for every retained global record.
4. Admit detailed aerial imagery with verified coverage, attribution, public access
   and operating budget. Keep overview imagery as the initial/fallback tier. Do
   not silently substitute street outlines for aerial photographs or invent pixels.
5. Reduce temporary movement work, then restore settled-view detail. Cache and
   prefetch a bounded visible region and neighbor ring; hold completed coarse tiles
   until finer tiles are actually ready. Central event processing remains separate
   from these imagery/terrain/GPU concerns.

## Acceptance and phase loop

Compare identical city and mountain views with upstream: close navigation, image
sharpness, terrain shape, markers, picking, reload and offline/partial recovery.
Measure startup, frame/input work and cache pressure separately from resolution.
Never accept a performance improvement solely because the view became less detailed.
If terrain/source/graphics gates expose a better approach or unmet dependency,
revise the downstream scene delivery and renderer plan before expanding it.

This document is a plan. No new terrain, camera minimum or aerial provider has
been activated by the server-prepared-scene pilot.
