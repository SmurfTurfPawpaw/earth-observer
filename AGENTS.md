# Earth Observer: design-led work

- Announce the proposed package before implementation: intended visible result, scope, important tradeoffs, and verification. Give meaningful updates during work and report changes to the plan before proceeding with changed scope.
- For the design reset and major renderer decisions, use `docs/DESIGN_RESET.md`. The existing design contract and release59 are functional references, not an accepted visual target.
- Present representative visual references/storyboards and an interactive prototype for the user's review before committing to a new visual direction or renderer migration. Record actual user decisions; never invent approval or treat tests, a screenshot, or deployment as user acceptance.
- Demonstrate each reviewed package against the agreed visual target. Report observed behavior, unresolved failures and any aesthetic/performance compromise. Re-examine later phases when evidence changes assumptions.
- Use direct user instructions to resolve authorization; do not repeatedly request permission for routine implementation inside an authorized package. Keep architectural/visual deviations visible.
- The implementation goal is currently paused for feedback. Do not resume it merely because an investigation or planning question arrives. Carry this file and the design record to replacement Earth Observer branches/checkouts and delegated agents.
- Preserve unrelated working changes. Never blanket-stage or revert existing backend retention/audit WIP. No engine choice, hardware capacity, rendering quality, source coverage or cost has been validated by this planning record.
