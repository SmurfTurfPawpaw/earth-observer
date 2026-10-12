import { ECB_PRESS_PLUGIN, collectEcbPress, ecbPressItems } from './ecb-press.js';
import { EC_PRESS_PLUGIN, collectEcPress, ecPressItems } from './ec-press.js';
import { USGS_LIVE_DAY_PLUGIN, collectUsgsLiveDay, usgsLiveDayItems } from './usgs-live-day.js';
import { EUROSTAT_GAS_PLUGIN, collectEurostatGasOrigins, eurostatGasItems } from '../../server/hosted/eurostat-gas-origins.js';

// Admission is code-reviewed, fixed and versioned. Visitors cannot register a
// source, supply a URL, enlarge its scope or trigger acquisition.
export const SOURCE_PLUGINS = Object.freeze([
  Object.freeze({ ...USGS_LIVE_DAY_PLUGIN, collect: collectUsgsLiveDay, items: usgsLiveDayItems }),
  Object.freeze({ ...ECB_PRESS_PLUGIN, collect: collectEcbPress, items: ecbPressItems }),
  Object.freeze({ ...EUROSTAT_GAS_PLUGIN, collect: collectEurostatGasOrigins, items: eurostatGasItems }),
  Object.freeze({ ...EC_PRESS_PLUGIN, collect: collectEcPress, items: ecPressItems }),
]);

export const PUBLICATION_PLUGIN_IDS = Object.freeze(SOURCE_PLUGINS.filter(plugin => plugin.kind === 'publication-feed').map(plugin => plugin.pluginId));

export const sourcePlugin = id => SOURCE_PLUGINS.find(plugin => plugin.pluginId === id) || null;
export const publicPlugin = plugin => ({ id: plugin.pluginId, scopeId: plugin.scopeId,
  kind: plugin.kind, name: plugin.name, sourceUrl: plugin.sourceUrl, rights: plugin.rights });
