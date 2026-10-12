import * as Cesium from 'cesium';
import { ISS_OVERLAY_SOURCE_ID } from './policy.js';
import { isSatelliteElementSupported } from './source.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { clearFocusTarget } = services.focus;
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const documentRef = services.documentRef || globalThis.document;
  let holding = false, destroyed = false, removeVisibility, candidate, basis;

  function supportedDisplay(value, now) {
    if (!value || !isSatelliteElementSupported(layerState._catalog.get(value.id), now)) return false;
    if (value.kind === 'tracked') return layerState._trackedNorad === value.id &&
      layerState._trackedEntity === value.object && value.object.show !== false;
    if (value.kind === 'point') return layerState._params.showPoints && layerState._pointCollection?.show !== false &&
      layerState._points.get(value.id) === value.object && value.object.show !== false && Boolean(value.object.position);
    return layerState._params.showOrbits && layerState._orbitPaths.get(value.id)?.primitive === value.object && value.object.show !== false;
  }

  /** Ordinary frames check one cached physical display; rescan only on changes or its expiry. */
  function _syncRenderHold() {
    const active = !destroyed && layerState._enabled && layerState._viewer && !layerState._viewer.isDestroyed?.() && !documentRef?.hidden;
    let animated = false;
    if (active) {
      const now = services.now?.() ?? Date.now();
      const unchanged = basis && basis.catalog === layerState._catalog && basis.points === layerState._points &&
        basis.paths === layerState._orbitPaths && basis.revision === layerState._catalogRevision &&
        basis.pointCount === layerState._points.size && basis.pathCount === layerState._orbitPaths.size &&
        basis.collection === layerState._pointCollection && basis.collectionShown === layerState._pointCollection?.show &&
        basis.showPoints === layerState._params.showPoints && basis.showOrbits === layerState._params.showOrbits &&
        basis.trackedId === layerState._trackedNorad && basis.trackedEntity === layerState._trackedEntity;
      const valid = supportedDisplay(candidate, now);
      if (!unchanged || candidate && !valid) {
        candidate = null;
        const tracked = { kind: 'tracked', id: layerState._trackedNorad, object: layerState._trackedEntity };
        if (tracked.object && supportedDisplay(tracked, now)) candidate = tracked;
        if (!candidate && layerState._params.showPoints && layerState._pointCollection?.show !== false)
          for (const [id, object] of layerState._points) {
            const value = { kind: 'point', id, object };
            if (supportedDisplay(value, now)) { candidate = value; break; }
          }
        if (!candidate && layerState._params.showOrbits)
          for (const [id, path] of layerState._orbitPaths) {
            const value = { kind: 'orbit', id, object: path.primitive };
            if (value.object && supportedDisplay(value, now)) { candidate = value; break; }
          }
        basis = { catalog: layerState._catalog, points: layerState._points, paths: layerState._orbitPaths,
          revision: layerState._catalogRevision, pointCount: layerState._points.size, pathCount: layerState._orbitPaths.size,
          collection: layerState._pointCollection, collectionShown: layerState._pointCollection?.show,
          showPoints: layerState._params.showPoints, showOrbits: layerState._params.showOrbits,
          trackedId: layerState._trackedNorad, trackedEntity: layerState._trackedEntity };
      }
      animated = Boolean(candidate);
    }
    if (animated !== holding) {
      holding = animated;
      if (animated) holdContinuousRender('satellites'); else releaseContinuousRender('satellites');
    }
    return animated;
  }
  const renderFrame = () => {
    if (!destroyed && !documentRef?.hidden) parts.rendering._preRenderTick();
    _syncRenderHold();
  };
  const visibilityChanged = () => { _syncRenderHold(); };

  const methods = {
    // Catalog data refresh; propagation remains preRender-owned.

    async init(viewer) {
      if (destroyed) throw new DOMException('Satellite layer closed', 'AbortError');
      parts.catalog._abortActiveUpdates();
      clearFocusTarget('satellites');
      layerState._viewer = viewer;
      layerState._catalog = new Map();
      layerState._points = new Map();
      layerState._detectionObjects = new Map();
      layerState._orbitPaths = new Map();
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._lastCheckedAt = null;
      layerState._satelliteSources = [];
      layerState._withheldElements = { expired: 0, missingEpoch: 0, futureEpoch: 0 };
      layerState._denseWithheldElements = { expired: 0, missingEpoch: 0, futureEpoch: 0 };
      layerState._trackedNorad = null;
      parts.tracking._cancelPendingTrackingRestore();
      layerState._trackedEntity = null;
      layerState._trackedFrameNumber = -1;
      layerState._trackedFrameGeo = null;
      layerState._trackedCalculatedAt = null;
      layerState._trackedFrameNowForTest = null;
      layerState._lastFocusUpdate = 0;
      layerState._activeFocusCount = 0;
      layerState._enabled = false;
      _syncRenderHold();
      layerState._overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
      layerState._overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
      // Dense extras rebuild via update() when _params.catalog === 'dense'
      // (the catalog-mode preference itself is sticky across init/destroy).
      layerState._denseIds = [];
      layerState._denseCursor = 0;
      layerState._denseLoadPromise = null;
      layerState._denseLoadToken++;
      layerState._denseStatus = 'idle';
      layerState._denseError = null;
      layerState._catalogRevision++;

      // Point primitives for satellite dots
      layerState._pointCollection = new Cesium.PointPrimitiveCollection();
      viewer.scene.primitives.add(layerState._pointCollection);

      parts.interaction._installClickHandler(viewer);

      // Pre-render listener for real-time position updates
      // (fleet propagation + tracked per-frame dot + orbit ring GMST rotation)
      layerState._preRenderListener = viewer.scene.preRender.addEventListener(
        renderFrame,
      );
      if (!removeVisibility && documentRef?.addEventListener) {
        documentRef.addEventListener('visibilitychange', visibilityChanged);
        removeVisibility = () => documentRef.removeEventListener('visibilitychange', visibilityChanged);
      }

      console.log('[Data:Satellites] Initialized');
    },

    enable(viewer) {
      if (destroyed) return false;
      layerState._enabled = true;
      for (const [noradId, point] of layerState._points) {
        if (!isSatelliteElementSupported(layerState._catalog.get(noradId), services.now?.() ?? Date.now())) point.show = false;
      }
      if (layerState._pointCollection)
        layerState._pointCollection.show =
          parts.controls.satelliteVisualsVisible(
            layerState._enabled,
            layerState._params.showPoints,
          );
      // Orbit ring primitives + persistent ISS host label — show them
      for (const [noradId, path] of layerState._orbitPaths)
        path.primitive.show = isSatelliteElementSupported(layerState._catalog.get(noradId), services.now?.() ?? Date.now()) && parts.controls.satelliteVisualsVisible(
          layerState._enabled,
          layerState._params.showOrbits,
        );
      parts.labels._syncIssOverlay();
      // Re-attach input handlers and preRender propagation
      parts.interaction._installClickHandler(viewer);
      // Pick-ownership (H2): satellite dot ids are numeric NORAD catalog numbers;
      // the registry hands predicates String()-coerced ids, so match via Number().
      registerPickOwner('satellites', (pickedId) => {
        const norad = Number(pickedId);
        return Number.isFinite(norad) && layerState._points.has(norad);
      });
      if (!layerState._preRenderListener && viewer) {
        layerState._preRenderListener = viewer.scene.preRender.addEventListener(
          renderFrame,
        );
      }
      parts.tracking._applyPendingTrackingRestore();
      _syncRenderHold();
    },

    disable(viewer) {
      parts.catalog._abortActiveUpdates();
      parts.tracking._cancelPendingTrackingRestore();
      layerState._enabled = false;
      _syncRenderHold();
      if (layerState._pointCollection) layerState._pointCollection.show = false;
      for (const path of layerState._orbitPaths.values())
        path.primitive.show = false;
      parts.tracking._clearTracking();
      parts.labels._syncIssOverlay();
      // Remove click handler + keydown listener + preRender propagation while disabled
      if (layerState._clickHandler) {
        layerState._clickHandler.destroy();
        layerState._clickHandler = null;
      }
      if (layerState._trackedEntityChangedRemove) {
        layerState._trackedEntityChangedRemove();
        layerState._trackedEntityChangedRemove = null;
      }
      documentRef?.removeEventListener?.('keydown', parts.interaction._onKeyDown);
      unregisterPickOwner('satellites');
      if (layerState._preRenderListener) {
        layerState._preRenderListener();
        layerState._preRenderListener = null;
      }
    },

    destroy(viewer) {
      if (destroyed) return;
      destroyed = true;
      parts.catalog._abortActiveUpdates();
      layerState._enabled = false;
      _syncRenderHold(); removeVisibility?.(); removeVisibility = null;
      candidate = null; basis = null;
      parts.tracking._clearTracking();
      parts.tracking._cancelPendingTrackingRestore();
      if (layerState._clickHandler) {
        layerState._clickHandler.destroy();
        layerState._clickHandler = null;
      }
      if (layerState._trackedEntityChangedRemove) {
        layerState._trackedEntityChangedRemove();
        layerState._trackedEntityChangedRemove = null;
      }
      documentRef?.removeEventListener?.('keydown', parts.interaction._onKeyDown);
      unregisterPickOwner('satellites');
      if (layerState._preRenderListener) {
        layerState._preRenderListener();
        layerState._preRenderListener = null;
      }
      layerState._overlayHost.clearSource(ISS_OVERLAY_SOURCE_ID);
      layerState._overlayHost.setVisible(ISS_OVERLAY_SOURCE_ID, false);
      if (layerState._pointCollection) {
        viewer.scene.primitives.remove(layerState._pointCollection);
        layerState._pointCollection = null;
      }
      // Orbit ring primitives are removed (and destroyed) here
      for (const path of layerState._orbitPaths.values()) {
        viewer.scene.primitives.remove(path.primitive);
      }
      layerState._points.clear();
      layerState._detectionObjects.clear();
      layerState._orbitPaths.clear();
      layerState._catalog.clear();
      layerState._denseIds = [];
      layerState._denseCursor = 0;
      layerState._denseLoadToken++;
      layerState._denseStatus = 'idle';
      layerState._denseError = null;
      layerState._catalogRevision++;
      layerState._rowControlsListener = null;
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._lastError = null;
      layerState._lastFocusUpdate = 0;
      layerState._activeFocusCount = 0;
      layerState._trackingRefreshEpoch += 1;
      layerState._lastTrackingRefreshOutcome = {
        epoch: layerState._trackingRefreshEpoch,
        status: 'destroyed',
        failedGroups: [],
      };
      layerState._viewer = null;
    },
  };

  return { methods, _syncRenderHold };
}
