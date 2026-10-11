export const UI_STORAGE_KEY = 'earth-observer:ui:v1';
export function readUiState(storage, { mobile = false } = {}) {
  let saved;
  try { saved = JSON.parse(storage?.getItem(UI_STORAGE_KEY) || 'null'); } catch { /* Unavailable storage uses usable defaults. */ }
  if (saved?.version !== 1) saved = {};
  return {
    version: 1,
    sidebarOpen: mobile ? false : typeof saved.sidebarOpen === 'boolean' ? saved.sidebarOpen : true,
    navbarOpen: typeof saved.navbarOpen === 'boolean' ? saved.navbarOpen : false,
    openCategories: Array.isArray(saved.openCategories) ? [...new Set(saved.openCategories.filter((value) => typeof value === 'string'))] : null,
  };
}
export function writeUiState(storage, state) {
  try { storage?.setItem(UI_STORAGE_KEY, JSON.stringify({ ...state, version: 1 })); return Boolean(storage); } catch { return false; }
}

/** Explanatory placeholders are source-card text, not legal notices. Provider adapters own their real credits. */
export function layerCreditNotices(layer) {
  const attribution = String(layer.attribution || '').trim(), notices = [];
  if (attribution && !/^Attribution is shown for (?:the selected agency|each approved operator|the selected source)$/.test(attribution)) {
    if (attribution === 'Open Infrastructure Map · © OpenStreetMap contributors · ODbL') notices.push({ html: '© OpenStreetMap contributors · ODbL', onScreen: true }, { html: 'Open Infrastructure Map', onScreen: true });
    else notices.push({ html: attribution, onScreen: true });
  }
  if (layer.detailedAttribution) notices.push({ html: layer.detailedAttribution, onScreen: false });
  return notices;
}

/** Shared legal credits stay visible until their last displaying layer releases them. */
export function createCreditLedger(display, makeCredit) {
  const records = new Map();
  const keys = new Map();
  return {
    retain(html, onScreen = true) {
      const key = `${Boolean(onScreen)}:${html}`;
      let entry = records.get(key);
      if (!entry) { entry = { credit: makeCredit(html, onScreen), owners: 0 }; records.set(key, entry); keys.set(entry.credit, key); display.addStaticCredit(entry.credit); }
      entry.owners += 1; return entry.credit;
    },
    release(credit) {
      const key = keys.get(credit), entry = records.get(key);
      if (!entry) return;
      if (--entry.owners > 0) return;
      display.removeStaticCredit(credit); records.delete(key); keys.delete(credit);
    },
    clear() { for (const { credit } of records.values()) display.removeStaticCredit(credit); records.clear(); keys.clear(); },
  };
}

/** Cache retrieval time is separate from the observation time supplied by a provider. */
export function cacheStatus(entry = {}, formatTime = (value) => new Date(value).toLocaleString()) {
  const state = entry.browserCache;
  if (!['HIT', 'STALE', 'OFFLINE'].includes(state)) return { label: '', detail: '' };
  const label = state === 'OFFLINE' ? 'Offline · cached' : state === 'STALE' ? 'Older cache' : 'Cached';
  const retrievedAt = Number(entry.browserCachedAt);
  return { label, detail: Number.isFinite(retrievedAt) && retrievedAt > 0 ? `Browser copy retrieved ${formatTime(retrievedAt)}` : 'Browser copy; retrieval time unavailable' };
}
