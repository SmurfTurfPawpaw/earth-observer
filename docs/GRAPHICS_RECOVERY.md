# Graphics context loss

`installContextRecovery(viewer, { onLost, onRestored })` observes the viewer's
canvas directly and returns `{ isLost(), destroy() }`. It does not create,
destroy or rebuild a Cesium viewer.

On `webglcontextlost` it cancels the event, permitting native browser restoration,
stops `viewer.useDefaultRenderLoop`, and calls `onLost(error)` once. The error has
code `EARTH_WEBGL_CONTEXT_LOST` and tells the visitor to reload to rebuild the globe.
On `webglcontextrestored` it keeps rendering stopped and calls `onRestored(error)`
once with code `EARTH_WEBGL_CONTEXT_RESTORED_RELOAD_REQUIRED`. A native restoration event
does not establish that the application's graphics resources have recovered.

`isLost()` deliberately remains true after restoration until the viewer is
replaced. The main visibility controller must respect that latch, and callbacks
should display explicit reload guidance through the existing error interface.
There is no automatic reload or claim of automatic recovery. Dispose the helper
before destroying the viewer; disposal is idempotent and does not restart
rendering or access the viewer.

Event-target tests cover loss cancellation and callback ordering, restoration,
duplicate events, a restoration without prior loss, disposal before and after
loss, and invalid callback/canvas contracts. They do not simulate GPU memory
pressure or establish recovery on a particular graphics device.

The [Khronos WebGL context-loss and restoration specification](https://registry.khronos.org/webgl/specs/1.0.3/#5.15.2)
requires applications to recreate resources that belonged to the lost context.
This is why merely receiving a restoration event does not resume this viewer.
For native-browser QA, use the optional
[WEBGL_lose_context extension](https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/)
on the existing canvas: trigger loss, wait for the loss event, then request
restoration. Check that explicit reload guidance appears, rendering stays
stopped through visibility changes, and a user reload rebuilds the globe with
the saved workspace. The extension may be unavailable; record that limitation.
This test simulates native context loss and does not reproduce every GPU fault.
