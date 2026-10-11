import { ECB_PRESS_PLUGIN, collectEcbPress, ecbPressItems } from './ecb-press.js';
import { EUROSTAT_GAS_PLUGIN, collectEurostatGasOrigins, eurostatGasItems } from '../../server/hosted/eurostat-gas-origins.js';

// Admission is code-reviewed, fixed and versioned. Visitors cannot register a
// source, supply a URL, enlarge its scope or trigger acquisition.
export const SOURCE_PLUGINS = Object.freeze([
  Object.freeze({ ...ECB_PRESS_PLUGIN, collect: collectEcbPress, items: ecbPressItems }),
  Object.freeze({ ...EUROSTAT_GAS_PLUGIN, collect: collectEurostatGasOrigins, items: eurostatGasItems }),
]);

export const sourcePlugin = id => SOURCE_PLUGINS.find(plugin => plugin.pluginId === id) || null;
export const publicPlugin = plugin => ({ id: plugin.pluginId, scopeId: plugin.scopeId,
  kind: plugin.kind, name: plugin.name, sourceUrl: plugin.sourceUrl, rights: plugin.rights });
