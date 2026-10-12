# Shared camera and inspection ownership

Tilt, north and button zoom orbit the current screen-center surface target. The target comes from loaded ground or an ellipsoid intersection; a missing intersection falls back to the camera's own geographic nadir. Source coordinates remain unchanged. URLs and saved sessions still contain the actual camera position and orientation, not the picked target. Precise ENU basis extraction avoids Cesium's coarse near-vertical Euler getter threshold during pose restoration.

Global tilt fits a sphere with a 3% display margin inside the actual native viewport planes. Local tilt keeps the requested angle. Native wheel and pinch remain Cesium controls. The shared 250-metre close-navigation floor is temporary; detailed terrain, imagery and near-ground marker acceptance remain separate unfinished dependencies.

Display delivery and explicit inspection have independent cancellation lifetimes. Background source updates and display-priority minutes may repaint markers without closing an opened list or replacing an inspected report's exact evidence. Actual camera movement, source disable, hidden/History mode, explicit close and a newer human inspection invalidate the corresponding pending selection. One pinned list per source and bounded auxiliary reads prevent unbounded accumulation.

An opened area's immutable source, view version, category partition and display-priority timestamp bind its member reads. A small refresh icon offers explicit acquisition of a newer area edition; rows remain on their original edition until that action succeeds. Cancelled inspection restores its earlier status. Expired editions have an explicit retry path; a ready area with individual markers or no currently displayed reports is distinguished from unavailable preparation.

Area reports, the calendar and shell panels share workspace ownership. Switching surfaces hides the previous panel while preserving selected evidence and notebook drafts. Background notifications do not open or close workspaces.

This UI package does not claim six-hour server availability. Existing servers retain current/prior prepared editions and may reject older exact inspections. The client accepts a future fixed retention contract only when valid metadata is supplied; absent metadata and browser-cached proof make no server-retention promise. Collector-owned immutable retention and post-publication scene preparation are the next independent backend package.
