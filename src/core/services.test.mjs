import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreServices } from './services.js';

test('weather initializes its shared clock once without surfaces, overlays or render owners', async () => {
  const loads = [], clocks = [];
  const services = createCoreServices({}, { loaders: {
    weatherClock: async () => { loads.push('clock'); return { createWeatherClock() {
      const clock = { destroyed: false, destroy() { this.destroyed = true; } }; clocks.push(clock); return clock;
    } }; },
    surface: () => { throw new Error('Weather must not load terrain'); },
    overlayHost: () => { throw new Error('Weather must not create overlay canvases'); },
    render: () => { throw new Error('Weather must not install another scene owner'); },
  } });
  assert.deepEqual(loads, []);
  await Promise.all([services.ensure(['weatherClock']), services.ensure(['weatherClock'])]);
  assert.deepEqual(loads, ['clock']);
  assert.equal(clocks.length, 1);
  await services.destroy();
  assert.equal(clocks[0].destroyed, true);
});

test('surface requests cancel when hidden and do not restart while inactive', async () => {
  const documentRef = { hidden: false };
  const started = Promise.withResolvers();
  let requests = 0;
  const services = createCoreServices({}, { documentRef,
    fetchImpl: (_url, { signal }) => {
      requests++; started.resolve(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Hidden', 'AbortError')), { once: true }));
    },
    loaders: { surface: async () => [
      { createTerrainHeights: ({ source }) => ({ source }) },
      { createGroundFloor: () => ({ cachedGroundFloor: () => null, resolveGroundFloorCells: async () => {} }) },
    ] },
  });
  await services.ensure(['surface']);
  assert.equal(requests, 0);
  services.setActiveServices(['surface']);
  const request = services.surface.terrain.source.getHeights([{ lat: 1, lon: 2 }]);
  const signal = await started.promise;
  documentRef.hidden = true; services.setActiveServices(['surface']);
  assert.equal(signal.aborted, true);
  await assert.rejects(request, { name: 'AbortError' });
  await assert.rejects(services.surface.terrain.source.getHeights([{ lat: 1, lon: 2 }]), { name: 'AbortError' });
  assert.equal(requests, 1);
  await services.destroy();
});

test('destroying services during a code import prevents late scene initialization', async () => {
  const code = Promise.withResolvers(); let constructed = 0;
  const services = createCoreServices({}, { loaders: { weatherClock: () => code.promise } });
  const ensuring = services.ensure(['weatherClock']);
  const closing = services.destroy();
  code.resolve({ createWeatherClock() { constructed++; return { destroy() {} }; } });
  await assert.rejects(ensuring, { name: 'AbortError' });
  await closing;
  assert.equal(constructed, 0);
});

test('minimal surface preserves every ALPR and installation adapter dependency without fetching', async () => {
  const { createLayer } = await import('./layer-factories.js');
  let requests = 0;
  const fetchImpl = () => { requests++; throw new Error('Construction must not request terrain or data'); };
  const services = createCoreServices({}, { fetchImpl });
  await services.ensure(['surface']);
  const { groundFloor, anchors } = services.surface;
  for (const name of ['cachedGroundFloor', 'floorAltitudeM', 'resolveGroundFloorCells', 'resolveGroundFloorCellsBounded']) {
    assert.equal(typeof groundFloor[name], 'function', name);
  }
  assert.equal(typeof anchors.warmFireAnchorFloors, 'function');
  assert.equal(await anchors.warmFireAnchorFloors([]), false);
  for (const id of ['alpr-cameras', 'military-installations']) {
    const layer = await createLayer(id, { services, fetchImpl });
    assert.equal(typeof layer.init, 'function', id);
    assert.equal(typeof layer.update, 'function', id);
  }
  assert.equal(requests, 0);
  await services.destroy();
});
