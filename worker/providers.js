import { aircraftProxy } from '../server/hosted/aircraft.js';
import { gbfsProxy } from '../server/providers/gbfs.js';
import { transitProxy } from '../server/providers/transit.js';
import { cctvProxy } from '../server/providers/cctv.js';
import { weatherProxy } from '../server/providers/weather.js';
import { cycloneProxy } from '../server/providers/cyclones.js';
import { firePerimetersProxy } from '../server/providers/firePerimeters.js';
import { intelligenceProxy } from '../server/hosted/intelligence.js';
import { economicsProxy } from '../server/hosted/economics.js';
import { createProviderStore } from './storage.js';

/** Pure Web API providers retain the same source admission and validation. */
export function workerProviders(options = {}) {
  return [aircraftProxy(options), gbfsProxy(options), transitProxy({ ...options, historyEnabled: false }), cctvProxy(options),
    weatherProxy(options), cycloneProxy(options), firePerimetersProxy(options),
    intelligenceProxy({ ...options, snapshotStore: createProviderStore(options.env) }),
    economicsProxy({ ...options, snapshotStore: createProviderStore(options.env) })];
}
