import { workspaceTime } from './navigation-state.js';

/** One latest-owner restore. Clock/suspension precede requested-layer admission;
 * scene and layer completion never reapply an older camera or time. */
export function createWorkspaceRestore({ manager, applyTemporal, applyCamera, applyArea, getTimeline,
  onSettled = () => {}, now = Date.now } = {}) {
  let owner = 0, restoring = false, destroyed = false;
  const current = revision => !destroyed && revision === owner;
  return {
    isRestoring: () => restoring,
    async restore(state) {
      if (destroyed) return false;
      const temporal = workspaceTime(state.temporal || { mode: 'live' }, { now: now() });
      const revision = ++owner; restoring = true;
      try {
        applyTemporal(temporal);
        const modeWork = manager.setTimelineMode(temporal.mode);
        applyArea(state.area); applyCamera(state.view);
        await modeWork;
        if (!current(revision)) return false;
        for (const [id, params] of Object.entries(state.layerParams || {})) manager.setLayerParams?.(id, params);
        const sceneWork = getTimeline()?.restore(temporal, { prepared: true });
        const layerWork = manager.restore(state.layers ?? (state.requestLocation ? ['earthquakes'] : undefined));
        await Promise.all([sceneWork, layerWork]);
        if (!current(revision)) return false;
        restoring = false; onSettled(); return true;
      } catch (error) { if (!current(revision)) return false; throw error; }
      finally { if (current(revision)) restoring = false; }
    },
    cancel({ cancelScene = true } = {}) { ++owner; restoring = false; if (cancelScene) getTimeline()?.cancelRestore?.(); },
    destroy() { if (destroyed) return; destroyed = true; ++owner; restoring = false; getTimeline()?.cancelRestore?.(); },
  };
}
