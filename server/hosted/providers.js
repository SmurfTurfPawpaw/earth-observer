import { aircraftProxy } from './aircraft.js';
import { celestrakProxy, rocketLaunchesProxy } from '../providers/space.js';
import { terrainHeightsProxy } from '../providers/terrain.js';
import { overpassProxy } from '../providers/overpass.js';
import { militaryInstallationsProxy } from '../providers/military-installations.js';
import { cctvProxy } from '../providers/cctv.js';
import { gbfsProxy } from '../providers/gbfs.js';
import { transitProxy } from '../providers/transit.js';
import { firmsProxy } from '../providers/firms.js';
import { windProxy } from '../providers/wind.js';
import { weatherProxy } from '../providers/weather.js';
import { cycloneProxy } from '../providers/cyclones.js';
import { firePerimetersProxy } from '../providers/firePerimeters.js';
import { intelligenceProxy } from './intelligence.js';
import { economicsProxy } from './economics.js';

/** Only providers documented in DATA_POLICY are mounted in the hosted app. */
export function hostedProviders() {
  return [aircraftProxy(), celestrakProxy(), rocketLaunchesProxy(), terrainHeightsProxy(),
    overpassProxy(), militaryInstallationsProxy(), cctvProxy(), gbfsProxy(), transitProxy(),
    firmsProxy(), windProxy(), weatherProxy(), cycloneProxy(), firePerimetersProxy(), intelligenceProxy(), economicsProxy()];
}
