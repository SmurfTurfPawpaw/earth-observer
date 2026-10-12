# Design reset and review record

Status: planning, 12 October2026. Latest user steering explicitly abandons the ambitious 3D direction and proposes https://threatmap.checkpoint.com/ as a simpler reference. The previous Unreal / browser game-engine comparison is superseded. The long-running engineering goal remains paused; this reference establishes a proposed direction, not acceptance of an implemented replacement.

Prototype authorization: the user subsequently said "let's try it, we'll start with design until it's perfect and then implement the data, let's make it quick". A separate prototype in `public/design/` on branch `codex/design-atlas-20261012` is authorized. It uses clearly identified fictional fixtures, bundled Natural Earth geometry and browser-local interactions. It is served separately at `/earth/design/`, preserving the existing Earth application. This authorizes building/reviewing the prototype, not acceptance of its design or resumption of the backend goal.

## What is already established

The user values a serious public intelligence tool, uncluttered controls, geographic precision, continuous world time, historical exploration, meaningful iconography, fluid motion and premium visual execution. The user rejected the current interface's visual quality. Passing engineering checks and publishing release59 do not establish visual acceptance. Earlier palette/radius/effect restrictions must be reconsidered against a visual reference rather than inherited as the final aesthetic.

Current working interpretation, still requiring visual confirmation: a calm 2D intelligence atlas. The reference was inspected in a real browser: dark dotted continents, a faint grid, small location rings, highlighted animated paths and a top summary counter. Our platform would combine that visual economy with meaningful category icons, semantic zoom, one evidence dossier and a continuous expandable historical timeline. Local events use location markers/affected footprints; connection arcs require a sourced relationship or origin/destination. Arrival animation never invents an event, causal link or source observation. Counters describe the actually retained dataset, not comprehensive world coverage.

## How the user stays involved

1. Before a package, state its intended visible result, scope and tradeoffs in chat. For design, show the intended composition/motion before broad implementation.
2. Keep one decision record containing references, explicit user feedback, chosen direction, rejected directions and unresolved choices. User approval must cite their actual message or decision; silence and successful tests are not approval.
3. Build a small representative interactive scene before the wider frontend/backend rebuild. Identify prototype/sample data explicitly. An attractive still image establishes an artistic target, not engine feasibility or interaction quality.
4. At the review checkpoint, show actual captures and a runnable prototype, explain what works and what remains incomplete, and wait for the user to select/correct the direction. Existing broad engineering authorization does not establish acceptance of a proposed new aesthetic.
5. Inside a reviewed package, carry out routine authorized work without repeated questions. If measurements or source constraints change the plan materially, disclose the change and revisit dependent phases.
6. Report completion against both visual/interaction acceptance and measured engineering behavior. Never substitute test counts for design quality.

## 2D renderer and delivery, proposed

Budget update from the user: maximum EUR5/month. Treat this as a strict ceiling for proposed recurring project services, including provider taxes/fees, while clarifying whether existing domain/website/subscription costs are included. No purchase or paid upgrade is authorized. Prefer browser-side rendering and quota-bounded free static hosting/data services for a pilot; do not propose a US$5 minimum metered plan as a guaranteed EUR5 cap. Rented always-on GPU streaming, unrestricted AI analysis and unbounded global history are not a validated fit. The current collector/Sites workloads have not been audited against this ceiling. The new 2D direction removes remote GPU rendering from the proposed critical path; it does not remove acquisition/storage costs.

Start with a self-contained SVG or Canvas2D global overview using permitted bundled geographic data. World shape, navigation, marker icons and bounded animations can render without a globe engine. Geographic projection, dateline wrapping, region bounds, picking and counts remain explicit contracts. Stored backend observations, priority lanes and historical evidence should remain independent of the display renderer; reuse them only after relevant review.

Regional zoom can progressively reveal country/local detail. MapLibre is an optional detailed-map candidate; its WebGL rendering and tile/provider requirements must be evaluated separately, preserving the lightweight global overview. No new library, tile provider, renderer implementation or deployment has been selected by this planning update.

Proposed first prototype: global overview, a country-level event inspection and multi-day history playback with clearly identified sample evidence. Judge composition, marker/category readability, clutter, selection, timeline and continuity. Measure first useful view, input-to-visible response, frame pacing, transferred bytes/memory, narrow-screen behavior and reconnect. The new appearance must not be presented as a fix for pending source preparation. Set budgets with actual device/hosting context rather than claiming universal instant loading or free capacity.

Sources checked:

- Visual reference, inspected in browser: https://threatmap.checkpoint.com/
- Natural Earth geographic data terms: https://www.naturalearthdata.com/about/terms-of-use/
- Optional regional map renderer: https://maplibre.org/maplibre-gl-js/docs/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Project instructions discovery: https://learn.chatgpt.com/docs/agent-configuration/agents-md

## Decisions still needed

- Which parts of the threat-map reference the user wants to carry into the final composition, motion and navigation.
- Accepted interactive visual direction.
- Representative devices, traffic/retention scope, and how the EUR5/month ceiling accounts for existing domain/hosting/subscription costs.
- Renderer selection supported by prototype observations.
- Which existing backend contracts survive review against the accepted experience.

Do not mark these decisions made until evidence or explicit user direction resolves them.

## Research and rabbit-hole preview, 12 October 2026

The user explicitly authorised changing the existing design preview to explore a research experience with five depths: Brief, Context, Investigate, Systems and Synthesis. They then identified rabbit-hole exploration as the primary design goal: a social research hub where a finding leads to another question, with community contributions that can support, challenge or add context to evidence. Users may begin with a goal or project when they do not know the right question yet; the preview should suggest useful next questions.

This package changes only the separate `/earth/design/` experience. It supplies authored fictional investigations for Taiwan/semiconductors, an illustrative Athena space project and European energy; an urgent sample world intake; a branching research trail; depth controls; geographic connections; evidence and local draft community notes; and sample historical playback. Deep sample analysis is prepared, then progressively revealed. It does not perform unrestricted research, collect fresh news, create real community activity, activate subscriptions or run X/Reddit collection.

The design may convey urgency through hierarchy and colour while maintaining explicit sample status. Aircraft observations remain distinct from a person's whereabouts, geographic associations from confirmed incident positions, and inferred relationships from established causality. No real person's private location is supplied. Community examples and local drafts do not establish verified claims or real-user participation.

Review the actual inquiry → finding → next question → trail → evidence/community → return flow. User feedback is still required before treating this new visual direction or interaction model as accepted. Existing backend work remains outside this package.
