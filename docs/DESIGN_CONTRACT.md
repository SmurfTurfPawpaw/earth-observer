# Living atlas design contract

The primary experience is a high-resolution globe with one coherent investigation
workspace. People should immediately understand where they are, which time they
are viewing, and what they can investigate. Live is a state of the whole scene.

## Layout and interaction

- Keep most of the screen for geography. Start without an expanded inventory sidebar.
- Floating global search is the primary entry: places, events, assets, datasets and
  questions grouped by their actual supported search path. Do not advertise an
  unanswered AI field as working. Keyboard shortcut and clear dismissal.
- Compact left rail selects Explore, Data, Investigate or Saved. Only one workspace
  expands. Secondary settings and source coverage live in contextual menus.
- One right dossier combines selected event/asset, original source, chronology,
  evidence and supported context. Close other competing detail panels. Navigation
  into a dossier preserves scene time, viewport and a back path.
- Persistent bottom time dock: play/pause, selected date, rate and Live. Expansion
  provides a calendar ruler and supported coverage; no list of irregular captures.
- Zoom and north remain immediately reachable; tilt and secondary actions can be
  grouped. All map inputs interrupt an active flight instead of fighting it.
- Mobile uses a compact top search and resizable bottom detail sheet. Safe-area
  padding prevents conflicts with the time dock and source credit affordance.

## Visual system

Palette tokens: canvas #080F16, surface #121D29, raised #1B2938,
border #2C3D50, primary text #EDF2F5, secondary #A8B8C8,
focus/accent #7DDCCB, secondary accent #8DBCE8.
Amber #E7BA74 and red #EC8C87 indicate actual caution/severity, never decoration.
Use calm surfaces with restrained translucency, consistent 12–16px radii and
subtle borders. Preserve legible night terrain; no vignette or simulated thermal.

Reading text approximately 15px, secondary metadata 12px, clear headings 18–22px.
Dates/numbers use tabular figures. Typography scaling remains available without
scaling the globe or breaking control layout. Icon controls have accessible names,
tooltips and approximately 44px touch targets. Use one consistent icon vocabulary.
Information never depends on color alone; keyboard focus and reduced motion work.

Motion communicates actual state: selection, arrival, loading settlement and
time progression. Use short interruptible 140–220ms transitions, preserve stable
layout and avoid whole-panel rebuilding for each update. No decorative pulse storm.

## Perceived and actual responsiveness

Show an immediate interactive shell and compatible remembered scene; progressively
replace cached material with current source-backed detail. Reserve panel geometry
while content loads. Keep current content visible during refresh, cancel obsolete
requests and prefetch only neighboring cells/time chunks within explicit limits.
Saved previews do not become fresh evidence merely by being shown smoothly.

Measure shell readiness, first useful globe, input latency, first contextual data,
frame work, tile settlement and peak memory separately. No universal zero-latency
claim. Prefer useful coarse resolution immediately, then sharper supported detail.

## Acceptance and evolution

Evaluate first visit, place search, event/source inspection, historical playback,
return to Live, reload, keyboard-only and narrow-screen journeys. Agents must report
observed actions and friction with environment/revision, not imaginary user metrics.
New UI is accepted only if it simplifies these workflows and retains navigation,
readable evidence, historical context and source attribution. Revisit design after
behavioral contracts change; do not hide fragmented behavior under visual polish.
