# Shared scene work foundation

The user outcome is a globe that remains usable while source data changes. Data
acquisition and historical retention continue independently of the visitor's camera.
The browser prepares and displays admitted evidence; its work budget must not grow
by another independent scheduler every time a layer is added.

## Ownership and stages

One viewer owns the shared coordinator. Initial activation and recurring refresh
use the same bounded logical admission pool. Initial refresh reuses its activation
permit, rather than acquiring another permit and deadlocking the pool. Cancellation
invalidates publication immediately, but an ignored cancellation keeps its physical
admission until the underlying operation settles.

Each admitted update receives a work scope tied to the layer/controller/revision.
Preparation uses one round-robin pump with a four-millisecond total cooperative
budget per browser task. The budget is shared across consumers, not four milliseconds
per layer. Each synchronous record step is checked before another step runs.
Superseded refresh intent is coalesced into one bounded follow-up per layer.

Static fire, camera and infrastructure consumers prepare a replacement native
PointPrimitiveCollection off scene. Plain immutable records and primitive insertion
share the same preparation pump; these adapters no longer create an Entity,
PropertyBag or visualizer entry for every record. The previous complete dated cohort
stays visible until attachment and a final ownership check succeed. Publication is
synchronous: adopt source metadata and the new cohort together, remap selection and
tracking by stable identity, then release the old cohort. Observer failures cannot
discard an already accepted edition or interrupt terminal resource cleanup. One
viewer-owned picking bridge creates detailed Entities only for selection/tracking,
delegates other picks to Cesium and restores handlers after its last consumer.
Legacy Entity staging also uses the coordinator until its consumers are migrated.

Disable, History, hidden-tab transitions, replacement and destroy invalidate
queued/current work. A late source response or native attachment cannot publish
into a different owner. A failed refresh preserves the last complete same-scope
cohort and its original source dates. Changed geographic scopes must preserve their
existing explicit clearing policy rather than silently label old-area records new.

## Operational progress and limits

Progress describes actual queue/acquisition/preparation/application stages. A known
prepared-record count and total apply to the current preparation pass; they are not
a network byte percentage, an ETA, a source-freshness claim or a rendered-frame count.
Existing displayed readiness, records and dates remain separate while a refresh runs.
Progress notifications are throttled; they do not create a DOM update per record.

Metrics separate preparation CPU, queue wait, elapsed construction, native attachment
and synchronous publication. The coordinator's task maximum includes synchronous
observers, while its per-scope step CPU excludes them. Neither proves GPU upload,
visualizer cost or actual native presentation. A single constructor, JSON parse,
sort or GPU call cannot be preempted by this cooperative pump. Overruns remain visible
and require smaller payloads, another representation or suitable Worker preparation.

## Migration and re-examination

The first consumers are the existing static batching layers: fire detections,
cameras and infrastructure. They supply plain source/feature mapping and metadata; the
shared utility owns scheduling, staging, publication and disposal. Compatibility
assembly also uses the common pump. Synchronous legacy replacement remains explicit.

The next gates are large pure-data normalization, stateful aircraft/satellite
updates and camera-aware render plans. Animated engines keep exact source fixes,
existing supported motion and their separate display clocks; they cannot be replaced
with generic clones of incomplete public state. Geographic cells, zoom detail,
batched icons and genuine clusters should bound rendered candidates without deleting
retained evidence. Static engines do no work when relevant source/view state is clean.

Acceptance requires mixed concurrent consumers, outside-queue input work, cancellation
during preparation/native attachment, stable selection and old-edition retention.
Node scheduler results are synthetic ownership/scheduling evidence. Native browser
checks must additionally measure input delay, long tasks and frame work during
startup, refresh, camera movement and returning from a hidden tab. Repeat the supplied
16-layer workload before claiming improvement over its Lighthouse baseline.

The disappearing globe remains an independent graphics gate. A screenshot that
contains the globe does not establish that the user sees it in the native embedded
surface. Compare the original/current material and presentation pipeline in isolation;
do not claim the work coordinator resolves that defect.

When a gate fails or a better method appears, revise the shared contract and the
downstream phases. This foundation is part of the full historical/current/future
intelligence platform; it does not redefine that objective as a rendering demo.

## Central processing direction and measured checkpoint

The intended data path is sources -> independent collection/processing -> durable
evidence and prepared regional editions -> revision stream and bounded scene reads
-> thin browser rendering. Each verified source revision should prepare its reusable
map representation once, rather than repeat hashing, normalization and clustering
per visitor. Existing small SSE revision notices can announce an edition; transport
replacement alone does not remove browser work. Large scenes do not belong in the
existing four-KiB notification queue. WebSockets remain an option for two-way
subscriptions after shared cached regional outputs and subscriber limits are measured.

On 12 October 2026 the integrated changed-path suite passed 99 checks. A local
native Cesium 1.138 diagnostic accepted 7,000 synthetic static records in 666.8 ms
with Entity staging and 211.8 ms with primitive staging. Preparation CPU was
157.2 versus 45.6 ms; largest cooperative task was 11.1 versus 4.5 ms. The window
changed size during baseline observation, so this is a scoped directional result,
not a controlled whole-app benchmark. The lighter path still recorded an 80-ms
long task after camera input and a 93.2-ms request-to-postRender delay. Deferred
GPU work and complete product startup remain separate gates.

The diagnostic initially blocked the UMD build's embedded worker importScripts
blob URL with its own local CSP. Allowing that installed dependency in the fixture
produced loaded tiles and a visible globe; earlier fixture timings are invalid for
frame/GPU conclusions. No production security or graphics correction follows from
that fixture finding, and the user's native embedded black screen is not accepted.
