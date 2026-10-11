# Returning visits and the public app shell

Production builds emit a content-addressed `assets/public-shell-[sha256].json`
containing the exact final public HTML, its release and mount. This is generated
after Vite startup module preloads. It contains no visitor, authentication,
notebook or API data. The service worker fetches this fixed JSON instead of
prefetching the root HTML, validates its SHA-256, exact schema, release, mount and
HTML digest, and synthesizes the document with the application's fixed
`DOCUMENT_HEADERS` security policies. Decoded JSON and HTML are bounded to
64 KiB. Redirects, a wrong origin, private/no-store responses and unsafe content
types cannot install the shell. Browser Fetch hides `Set-Cookie`; byte provenance,
not that header check alone, establishes which document can be stored.

The active worker serves this installed document immediately for an exact GET
navigation to its scope root, such as `/earth/`. Hash camera state is compatible;
query-dependent documents, non-root navigation, authentication, API routes and
write requests remain outside this shell fallback. Before returning a stored
document the worker checks its release marker, security headers, byte bound and
HTML digest. Older network-HTML caches cannot supply this document. Missing or
invalid copies use the normal network response without storing it; a first
offline visit cannot manufacture an app shell.

Cloudflare currently adds request-specific JavaScript Detections markup to live
HTML. The synthesized warm shell deliberately contains only our universal build,
so it does not replay that optional injected script or per-request parameters.
This does not change server, Cloudflare, API or authentication protections.
Community sign-in still uses the normal sign-in route and the separate,
uncached session API; private notebook content remains on the device.

Online cached-root navigation schedules one credential-free same-root
availability check in `waitUntil`, with concurrent checks coalesced and a
30-second cooldown. Response headers have a 3.5-second deadline; the document
body is canceled without reading, copying or persisting it. Failed checks and
offline restores produce saved-app notices. A check never changes the installed
document, acquires other assets or forces a reload.

The existing post-startup service-worker registration checks for updates. A new
worker activates only after its complete fixed startup asset set is saved, and
the next navigation uses that worker's own matching document. A failed update
leaves the previous worker in use. A visitor can remain on an older release while
an update is unavailable; there is no promise of an immediate update or complete
offline provider coverage. No forced reload discards an open workspace.

A local completion marker is written only after every required cache write
succeeds. Its entry and bytes count against the existing startup budget; it adds
no fetched route. Failed new installs wait for their in-flight writes and remove
their partial cache, while a failed reinstall preserves a known complete cache.
Activation retains the current release and one complete prior v3 release, pruning
older, legacy and partial buckets. Selection inspects at most six older metadata
records, each bounded to 16 KiB, and never inspects a newer in-progress release.
An exact app/vendor asset may fall back to that prior complete release after the
current and optional caches miss. This allows an older open tab to finish using
its own immutable script after an update. Prior HTML, private/API routes,
query-dependent requests and non-root navigation never use this fallback.

Large engine and application assets remain HTTP-cache-first online, with
CacheStorage as their offline safety net. Existing limits are unchanged: at most
96 startup entries including completion metadata/12 MiB, 180 optional app assets, 120 approved NASA base tiles,
and 64 entries/16 MiB for actually visited OpenFreeMap files. No optional layer
graph, neighboring map tiles or private submissions are prefetched.

Runtime tests use fake caches and transport to check hung-server warm navigation,
coalescing, immutable document/version transitions, interrupted installation,
digest/schema/size failures, security-header preservation, protected-route
exclusions and offline status. A temporary build fixture executes the actual
generator and checks its scoped JSON/preload artifact. These tests establish
contracts, not measured production startup speed; browser timing remains a
separate release acceptance check.
