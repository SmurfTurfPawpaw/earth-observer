# Initial atlas design review

Local foundation worktree, 12 October 2026. This document describes the implemented
interface and remaining integration checks; it does not claim publication or visual
acceptance in a browser.

## Coherent hierarchy

The globe remains the dominant surface. A floating search field is always reachable,
and accurately advertises the existing places/coordinates path. Slash focuses it;
the adjacent command button and Control/Command K retain the existing native modal
for saved places, data layers and actions. No unsupported AI or global event search
is presented as an implemented capability.

A compact left rail provides Explore, Data, Saved, Context, Notes and Tools. Explore
reuses the real home camera action. Data and Saved are modes of one drawer; Context,
Notes and selected features reuse the existing mutually exclusive right panels.
Opening either workspace closes the competing one without changing scene time.
Source context retains its original provenance and independence limitations. The
world-event dossier presents the actual retained source record, not a fictional
investigation result. Secondary basemap, account, sharing, reset and text preferences
live in a small tools popover.

First use starts with a closed inventory. Explicit saved desktop open/closed intent
still wins. Narrow screens temporarily close the inventory without rewriting the
desktop preference. All 77 original HTML element IDs survive the structural move;
the new rail and saved-mode button add two IDs. Source/legal notices stay present.

The bottom time dock keeps the shared UTC clock, play/pause, speed and Live visible
when collapsed. Expansion reveals the UTC calendar, calendar ruler and actual source
coverage. The source evidence list remains secondary. Sunlight and recorded evidence
retain their different temporal semantics; the presentation adds no synthetic facts.

## Visual and responsive implementation

Root `style.css` consolidates application layout, transport and responsive rules
instead of appending another override layer. Existing source controls and attributable
record components remain, with larger readable typography and input targets.

- Ink canvas, deep slate surfaces, restrained teal focus and warm neutral text follow
  the design contract. Amber remains associated with historical time or source caution.
- Reading surfaces start at approximately 15px, headings at 18px, metadata at 12px.
  Existing larger-text preferences affect reading surfaces without scaling the globe.
- Icon controls and form actions use approximately 44px minimum targets. Existing
  consistent SVG icons have accessible labels; the time transport retains its real
  play state and accessible names.
- Panels use short 180ms transitions. Reduced motion disables CSS transitions and
  loading animation; navigation already respects reduced-motion flight duration.
- Desktop keeps the right dossier and left drawer above the time/credit region.
  Mobile uses a compact top search, horizontal tool rail, reachable navigation, and
  bounded bottom detail sheets above the time dock. Safe areas and dynamically measured
  credit height reserve actual space.
- The layout introduces no new font download, image generation or visual dependency.

## Checks completed locally

The focused UI-state and command suite passes 11 checks, including explicit saved
preferences, closed mobile reading, text scaling, keyboard command ownership, focus
restoration, credit ownership and provenance-preserving cache labels. Shell JavaScript
syntax and the consolidated stylesheet parse successfully. Structural rewrite checks
confirmed that original IDs are retained and that no duplicate IDs were introduced.

The separate clock/timeline package passes 19 focused checks. That package verifies
monotonic playback, hidden suspension, native calculated sunlight, midnight and
multi-day UTC selection, stored full-range calendar coverage, immutable source dates,
safe older archive intervals, cancellation and Return Live. These checks establish
contracts; they do not establish measured frame performance or a successful deployment.

## Browser acceptance gate

Use the integrated revision with real source data, on desktop and a narrow viewport:

1. First visit exposes globe/search/time immediately, with a closed data drawer unless
   an explicit saved desktop preference says otherwise. No blocking or black overlay.
2. Place/coordinate search works from the floating field, invalid input gives readable
   feedback, slash yields to editors, and Escape/command-modal focus remains sensible.
3. Data/Saved/Context/Notes are individually reachable, only one workspace expands,
   and switching views retains usable controls without moving or retiming the globe.
4. An actual source event opens a readable dossier and official citation. Evidence
   hashes wrap; long names and large-text preferences do not create horizontal overflow.
5. Collapsed time controls play/pause and return Live; expanded date/ruler selects UTC.
   Coverage refresh preserves selected dates and source evidence. No second-by-second
   networking inside one confirmed capture interval.
6. Wheel, north, zoom buttons, pinch and interrupted flight remain responsive. Source
   credits, loading status and safe-area padding do not obscure the transport or sheet.
7. Mobile search and rail fit approximately 360px width, detail sheets scroll within
   their bounds, and map navigation stays above them. Check short screens and expanded
   time as well as the initial state.

The global search remains intentionally limited to its working path; richer world
record search can use the same prominent surface when its backend contract is ready.
The layout is a foundation release, with source and investigation capabilities still
determining the contents of each workspace. Frame/tile/startup measurements and final
visual acceptance belong to the integrated browser and release review.

## Read-only follow-up from the integrated desktop review

The root agent's actual local screenshot showed the intended hierarchy and readable
search/rail/time dock. It also showed very dark geography on the night-facing hemisphere.
This is a legibility finding, distinct from a missing canvas or a failed globe startup.
Mobile and keyboard journeys remain owned by the root agent. No runtime change was made
for this follow-up.

### Night legibility: confirmed cause and proposed choice

`src/core/viewer.js:25` selects `EllipsoidTerrainProvider`, which has no terrain vertex
normals. Installed `GlobeSurfaceShaderSet.js:305` therefore selects day/night shading,
not vertex lighting. `GlobeFS.glsl:441` hard-codes its intensity as
`clamp(Lambert * 5.0 + 0.3, 0.0, 1.0)`. The reviewed astronomy implementation set lighting
fade distances to zero and one, applying that full shade at all useful camera distances. The already
dark basemap colors are consequently multiplied by 0.3 at night. Changing
`vertexShadowDarkness` would affect the other shader path and does not fix this one.
Atmosphere brightness is also a different control. The public API documents the
[lighting fade controls and custom globe material](https://cesium.com/learn/cesiumjs/ref-doc/Globe.html).

Recommended initial choice: a cartographic day/night appearance, with a bounded
approximately 35% dark tint on the night side and a smooth twilight band. Keep actual
solar direction, selected UTC, native Sun/Moon and all source data intact. Use the
public `Globe.material`/Fabric route, with native globe lighting disabled while this
presentation is active; do not double-apply both shading systems. The tint's alpha
blend preserves a substantially brighter basemap, rather than adding invented lights.
No extra tile feed or networking is needed for this appearance.

Implementation detail to verify before choosing this route: a material using
`materialInput.normalEC` or slope is skipped for the current terrain by installed
`Globe.js:642`. Derive a geodetic surface direction from the documented
`materialInput.positionToEyeEC`, inverse view transform and ellipsoid inverse squared
radii, then compare it with `czm_sunDirectionWC`. This uses actual calculated solar
geometry without requiring terrain normals. Keep the material's lighting-enabled state
separate from native `globe.enableLighting`, so the existing sunlight control does not
accidentally re-enable the dark native shader. Prove compilation/rendering in the real
WebGL viewer and verify unlit/off cleanup. The proposed opacity needs visual acceptance
at global, regional and street scales on both map and imagery.

The lower-risk public-API alternative is restoring finite lighting fade distances.
That improves near-camera readability, but the strength of night shading would vary
with zoom and can nearly disappear locally. Uniformly raising imagery brightness/gamma
would affect day colors and quantitative imagery too. Neither alternative is my first
choice for a world clock that should stay visually meaningful at every scale.

### Automatic location should not dominate first arrival

Confirmed path: `session.js:22` requests location for a visitor without a saved/shared
view; `main.js:231` calls `locate()` automatically. The failure path at `main.js:72`
shows the same prominent notification as an explicit click on the location icon.
The root's QA browser could not obtain geolocation and therefore received that toast.
The actual default globe remains usable underneath it.

Proposed change: distinguish an automatic attempt from a visitor's explicit action.
Keep saved/shared camera ownership and the default usable globe. Reuse already-granted
location where available; avoid retrying a known denied permission automatically. For
routine automatic denial/unavailability, settle the location control/status quietly
and keep search ready. An explicit location-icon action should still receive useful
success/failure feedback and a clear retry path. The browser permission interaction
and source dates remain real; a location failure is not a global app failure.

### Time transport keyboard and disclosure semantics

`timeline.js:237–244` nests Play, Rate and Live inside the native `summary`. HTML allows
phrasing content there, so this is not being reported as invalid markup. However, that
summary is a native disclosure activation surface, with its accessible name derived
from its subtree unless explicitly labelled. The nested controls enlarge that name
and require real keyboard/assistive-technology review.
[HTML summary semantics](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-summary-element)
and [HTML accessibility mapping](https://w3c.github.io/html-aam/#el-summary) support this
distinction; no specific screen-reader failure has been reproduced here.

Play and Live stop click propagation. Rate only stops the `change` event; its click,
keyboard popup and arrow-key behavior still need observation. The expected contract
is: Enter/Space on the disclosure expands only the calendar; Enter/Space on Play or
Live changes only time state; rate arrows change only rate; all three stay reachable
while collapsed; opening/closing detail must preserve time and visible focus.

Preferred durable shape is one separately named disclosure button with `aria-expanded`
and `aria-controls`, a sibling transport group, and a separate UTC readout. That avoids
putting multiple actions inside one disclosure activation/name surface. A native
details/summary can still own the calendar if the always-visible transport is its
sibling in a dock wrapper. The [WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
defines the desired expansion keyboard behavior. Do not merely suppress every key
event; that would interfere with the native select and accessibility.

### Genuine night lights: source contract, not an immediate decorative layer

NASA's [VNP46A2 collection 2 product](https://ladsweb.modaps.eosdis.nasa.gov/missions-and-measurements/products/VNP46A2)
is daily, approximately 500m corrected nighttime radiance, with quality, cloud,
snow/ice and latest-high-quality-retrieval fields. Its gap-filled field differs from
a new observation. The documented archive begins in 2012; current availability and
publication lag still need actual catalog checks. Raw files are approximately 40MB,
so server/laptop preprocessing should clip needed cells and retain quality/provenance
before producing bounded tiles. Keep retrieval/production dates and actual radiance
units; a dim pixel alone does not establish an outage.

NASA's [GIBS Earth-at-Night metadata](https://github.com/nasa-gibs/worldview-options-eosdis/blob/master/common/config/metadata/viirs/EarthAtNight.md)
explicitly describes the attractive city-light composites as 2012/2016 snapshots.
Fading such a composite with the solar mask is a useful static context appearance,
but it cannot stand in for changing or historical city-light observations. A science
night-light timeline should use the actual dated product and quality flags, not just
change the URL date on a static composite. [GIBS access documentation](https://nasa-gibs.github.io/gibs-api-docs/access-basics/)
provides temporal-domain queries; verify the chosen layer's actual dates rather than
assuming its entire advertised interval is available. No NASA adapter, account or
download was created during this review.

## Implementation following that review

The root accepted the bounded cartographic appearance and separate disclosure actions.
`astronomy.js` now installs public `Cesium.Material`/Fabric type
`EarthObserverCartographicNight`. Its uniforms are maximum `nightOpacity=0.35`,
`twilightWidth=sin(6 degrees)`, tint `#080f16`, and the actual globe ellipsoid's inverse
squared radii. The shader reconstructs world position from `positionToEyeEC` and
`czm_inverseView3D`, derives geodetic direction and uses native `czm_sunDirectionWC`.
Native globe lighting stays disabled, avoiding another darkening pass. Toggling the
appearance changes opacity to zero or its bound; Sun/Moon and scene time stay active.
Destroy restores owned previous globe material, native lighting, ground-atmosphere,
atmosphere-from-sun and scene light, then destroys the allocated material.

The new dock wrapper hosts the UTC readout and transport beside the native calendar
details. Its summary now has only one action, a stable accessible label and matching
expanded state/controlled-body ID. Play, Rate and Live are independent siblings and
remain visible while the calendar is closed. No blanket keyboard suppression was
added; the native disclosure and select retain their own behavior.

Historical USGS markers retain actual source identity, magnitude when present, and
source event time as compatible properties for the verified event dossier bridge.
Other sources do not acquire USGS identities, and playback time never replaces event
time. The focused clock/timeline suite passes 19 checks including transport separation,
native-lighting exclusion, appearance toggling/resource restoration, and source pin
dates. Actual WebGL compilation, visual legibility and keyboard/mobile acceptance
still require the root agent's integrated browser review.

## Actual integrated browser checks reported by root

12 October 2026, local foundation preview. Root verified the material's real WebGL
compilation with zero console errors, and readable coastlines/place labels at
18,000km altitude on night-facing Europe/Africa. Desktop 1280×720 and mobile 390×844
screenshots are retained locally as `qa-artifacts/foundation-desktop.jpg` and
`qa-artifacts/foundation-mobile.jpg` (ignored QA artifacts, not a published demo).

The mobile bottom sheet remained usable. Enter on the standalone calendar disclosure
opened it; the sibling rate control changed to one day per second without opening the
calendar. Those observations resolve the earlier compilation/disclosure checks for
this environment. They do not establish all browsers, screen readers or frame budgets.

The local preview did not expose hosted history and returned the expected 404. Full
historical playback with hosted evidence therefore remains unverified in the browser;
the focused contract checks must not be described as that end-to-end result. Neither
these screenshots nor this review establish publication of the foundation release.
