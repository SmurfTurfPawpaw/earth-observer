import * as Cesium from 'cesium';
import { applyModelAtmosphereWorkaround } from '../app/atmosphereCompat.js';

const NASA_TILES = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';

/** A keyless globe with explicit, attributable imagery and demand-driven rendering. */
export function createGlobeViewer({ container, creditContainer, onNotice = () => {} }) {
  // This build uses the Apache-licensed renderer without ion services. Set only
  // its optional default logo credit; imagery/data credits remain independent.
  Cesium.CreditDisplay.cesiumCredit = new Cesium.Credit('');
  const viewer = new Cesium.Viewer(container, {
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    baseLayer: false,
    skyBox: false,
    scene3DOnly: true,
    useDefaultRenderLoop: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    selectionIndicator: true,
    infoBox: false,
    creditContainer,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    msaaSamples: 2,
    shadows: false,
    contextOptions: { webgl: { alpha: false, antialias: true } },
  });
  try {
    viewer.targetFrameRate = 60;
    viewer.resolutionScale = Math.min(1, 1.5 / (globalThis.devicePixelRatio || 1));
    viewer.scene.globe.maximumScreenSpaceError = 3;
    viewer.scene.globe.tileCacheSize = 100;
    viewer.scene.globe.preloadAncestors = true;
    viewer.scene.globe.preloadSiblings = true;
    viewer.scene.globe.loadingDescendantLimit = 8;
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#213a49');
    viewer.scene.screenSpaceCameraController.minimumZoomDistance = 250;
    viewer.scene.screenSpaceCameraController.maximumZoomDistance = 50000000;
    // Cesium's surface mode keeps mapped markers legible while occluding the far side.
    viewer.scene.globe.depthTestAgainstTerrain = false;
    viewer.clock.shouldAnimate = true;
    applyModelAtmosphereWorkaround(viewer.scene);

    const nasa = new Cesium.UrlTemplateImageryProvider({
      url: NASA_TILES,
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      maximumLevel: 8,
      credit: new Cesium.Credit('<a href="https://earthdata.nasa.gov/">NASA GIBS / Blue Marble</a>', true),
    });
    const imagery = viewer.imageryLayers.addImageryProvider(nasa);
    imagery.show = false;
    let mode = 'map', mapStatus = 'loading', mapProvider, mapLayer, mapFlight, mapFailures = 0, mapRetryAt = 0, nasaAvailable = true;
    const mapLifetime = new AbortController();
    function applyBasemap() {
      imagery.show = nasaAvailable && (mode === 'imagery' || mapStatus === 'unavailable');
      if (mapLayer) mapLayer.show = mode === 'map' && mapStatus === 'ready';
      mapProvider?.setEnabled(Boolean(mapLayer?.show));
      viewer.scene.requestRender();
    }
    function mapUnavailable(message) {
      if (viewer.isDestroyed()) return;
      mapStatus = 'unavailable'; mapRetryAt = Date.now() + 30000;
      mapProvider?.destroy(); mapProvider = undefined;
      if (mapLayer) viewer.imageryLayers.remove(mapLayer, true);
      mapLayer = undefined; applyBasemap();
      if (mode === 'map') onNotice(message);
    }
    function ensureMap() {
      if (mapFlight) return mapFlight;
      if (mapStatus === 'ready') return Promise.resolve(true);
      if (Date.now() < mapRetryAt) return Promise.resolve(false);
      mapStatus = 'loading';
      mapFlight = import('../maps/openFreeMapImagery.js').then(async ({ createOpenFreeMapImageryProvider }) => {
        if (viewer.isDestroyed() || mode !== 'map') { mapStatus = 'idle'; return false; }
        const provider = await createOpenFreeMapImageryProvider({ signal: mapLifetime.signal, onTile: () => { mapFailures = 0; } });
        if (viewer.isDestroyed()) { provider.destroy(); return false; }
        mapProvider = provider; mapFailures = 0;
        mapLayer = viewer.imageryLayers.addImageryProvider(provider); mapStatus = 'ready';
        provider.errorEvent.addEventListener(() => {
          if (mode !== 'map' || mapStatus !== 'ready' || viewer.isDestroyed()) return;
          if (++mapFailures >= 8) mapUnavailable('Street map tiles are unavailable. Showing coarse imagery; reconnect or choose the map again to retry.');
        });
        applyBasemap(); return true;
      }).catch(() => { mapUnavailable('Street map tiles are unavailable. Showing coarse imagery; reconnect or choose the map again to retry.'); return false; })
        .finally(() => { mapFlight = undefined; });
      return mapFlight;
    }
    const basemap = {
      setMode(value) {
        if (!['map', 'imagery'].includes(value)) throw new TypeError('Choose map or imagery');
        mode = value;
        applyBasemap();
        if (mode === 'map') basemap.ready = ensureMap();
        return mode;
      },
      getState: () => ({ mode, status: mapStatus,
        active: mode === 'map' && mapStatus === 'ready' ? 'map' : nasaAvailable && (mode === 'imagery' || mapStatus === 'unavailable') ? 'imagery' : 'bundled',
        nativeMaximumLevel: 14, maximumLevel: 18 }),
      ready: undefined,
    };
    viewer.earthBasemap = basemap;
    basemap.ready = ensureMap();
    const destroyViewer = viewer.destroy.bind(viewer);
    viewer.destroy = () => { mapLifetime.abort(); mapProvider?.destroy(); return destroyViewer(); };
    // Paint inexpensive bundled imagery first; NASA detail fills in without a blank globe.
    const baseReady = Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
      { maximumLevel: 1, credit: new Cesium.Credit('<a href="https://www.naturalearthdata.com/">Natural Earth</a>, public domain', true) },
    ).then((provider) => {
      if (viewer.isDestroyed()) return false;
      viewer.imageryLayers.addImageryProvider(provider, 0);
      viewer.scene.requestRender();
      return true;
    }).catch(() => false);
    let tileFailures = 0, fallbackStarted = false;
    nasa.errorEvent.addEventListener((error) => {
      if (fallbackStarted || viewer.isDestroyed()) return;
      tileFailures += 1;
      if (error.timesRetried < 2 && tileFailures < 12) {
        error.retry = true;
        return;
      }
      fallbackStarted = true;
      baseReady.then((available) => {
        if (viewer.isDestroyed()) return;
        if (!available) { onNotice('Imagery is unavailable. The globe remains interactive; reconnect for map detail.'); return; }
        viewer.imageryLayers.remove(imagery, true);
        nasaAvailable = false;
        viewer.scene.requestRender();
        if (mode === 'imagery' || mapStatus === 'unavailable') onNotice('NASA imagery is unavailable. Showing bundled Natural Earth imagery.');
      });
    });

    // Trackpad pinch arrives as Ctrl+wheel; Cesium otherwise treats it as browser zoom.
    const controller = viewer.scene.screenSpaceCameraController;
    controller.zoomEventTypes = [
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH,
      { eventType: Cesium.CameraEventType.WHEEL, modifier: Cesium.KeyboardEventModifier.CTRL },
    ];
    return viewer;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}
