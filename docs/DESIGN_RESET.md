# Design reset and review record

Status: planning, 12 October2026. The user has asked for design-first work, visible planning before implementation, and a convincing Watch Dogs / Iron Man visual experience. The long-running engineering goal is paused. The replacement engine and visual direction remain undecided.

## What is already established

The user values a serious public intelligence tool, uncluttered controls, geographic precision, continuous world time, historical exploration, meaningful iconography, fluid motion and premium visual execution. The user rejected the current interface's visual quality. Passing engineering checks and publishing release59 do not establish visual acceptance. Earlier palette/radius/effect restrictions must be reconsidered against a visual reference rather than inherited as the final aesthetic.

My working interpretation, still requiring visual confirmation, is a spatial instrument: genuinely three-dimensional location anchors and selection geometry, purposeful light/materials, layered information that assembles around the selected geography, and coordinated transitions. A flat dashboard with teal icons does not demonstrate that interpretation. Decorative animation must not invent observed events or replace source evidence.

## How the user stays involved

1. Before a package, state its intended visible result, scope and tradeoffs in chat. For design, show the intended composition/motion before broad implementation.
2. Keep one decision record containing references, explicit user feedback, chosen direction, rejected directions and unresolved choices. User approval must cite their actual message or decision; silence and successful tests are not approval.
3. Build a small representative interactive scene before the wider frontend/backend rebuild. Identify prototype/sample data explicitly. An attractive still image establishes an artistic target, not engine feasibility or interaction quality.
4. At the review checkpoint, show actual captures and a runnable prototype, explain what works and what remains incomplete, and wait for the user to select/correct the direction. Existing broad engineering authorization does not establish acceptance of a proposed new aesthetic.
5. Inside a reviewed package, carry out routine authorized work without repeated questions. If measurements or source constraints change the plan materially, disclose the change and revisit dependent phases.
6. Report completion against both visual/interaction acceptance and measured engineering behavior. Never substitute test counts for design quality.

## Renderer evaluation, proposed

Budget update from the user: maximum EUR5/month. Treat this as a strict ceiling for proposed recurring project services, including provider taxes/fees, while clarifying whether existing domain/website/subscription costs are included. No purchase or paid upgrade is authorized. Prefer browser-side rendering and quota-bounded free static hosting/data services for a pilot; do not propose a US$5 minimum metered plan as a guaranteed EUR5 cap. Rented always-on GPU streaming, unrestricted AI analysis and unbounded global history are not a validated fit. Local Unreal may still be a visual research tool if existing hardware supports it, without assuming electricity/availability is free. The current collector/Sites workloads have not been audited against this ceiling.

Unreal plus Cesium for Unreal is a serious candidate. Epic Pixel Streaming renders on a remote GPU and streams frames plus interactive input over WebRTC. It is a different delivery architecture from a browser-native renderer; independent visitor navigation, session capacity, latency, reconnect behavior and hosting cost require measurement. A shared video mirror is suitable for a shared view, not automatically for independent cameras.

A browser-native game renderer is a second candidate. Babylon.js exposes WebGL/WebGPU rendering and game-oriented materials/effects. Accurate Earth coordinates, terrain/imagery level-of-detail, globe-scale precision, history and evidence must be proven in the integration. The existing globe renderer is also a baseline to measure, not a predetermined winner. No engine has been installed or selected for the reset.

Proposed comparison uses the same geography, camera framing and sample evidence: a global overview, a tilted local investigation, and a short historical transition. Judge marker silhouette/material/lighting, selection depth, information hierarchy, motion continuity and readability. Measure first usable frame, input-to-visible response, frame pacing, transferred bytes/memory, narrow-screen behavior and reconnect. For streamed rendering, also measure independent concurrent views and actual GPU/bandwidth costs. Set budgets with the user/device/hosting context rather than claiming universal instant loading or free capacity.

Sources checked:

- Epic Pixel Streaming overview: https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-pixel-streaming-in-unreal-engine
- Epic hosting/networking: https://dev.epicgames.com/documentation/en-us/unreal-engine/hosting-and-networking-guide-for-pixel-streaming-in-unreal-engine
- Cesium for Unreal: https://cesium.com/learn/unreal/
- Babylon.js specifications: https://www.babylonjs.com/specifications/
- Project instructions discovery: https://learn.chatgpt.com/docs/agent-configuration/agents-md

## Decisions still needed

- Exact reference scenes and what the user likes about their geometry, depth, motion and composition.
- Accepted interactive visual direction.
- Representative devices, traffic/retention scope, and how the EUR5/month ceiling accounts for existing domain/hosting/subscription costs.
- Renderer selection supported by prototype observations.
- Which existing backend contracts survive review against the accepted experience.

Do not mark these decisions made until evidence or explicit user direction resolves them.
