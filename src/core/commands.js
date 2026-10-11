const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Deterministic local discovery; results contain explicit internal actions, never executable query text. */
export function commandCatalog({ layers = [], places = [], state = {} } = {}) {
  const catalog = [
    { id: 'show-layers', label: 'Find a place / layers', group: 'Workspace', icon: 'search', keywords: 'search coordinates controls', action: { type: 'show-layers' } },
    { id: 'home', label: 'Show the full globe', group: 'Navigation', icon: 'globe', keywords: 'home earth world', action: { type: 'home' } },
    { id: 'news', label: 'Open news and intelligence', group: 'Workspace', icon: 'news', keywords: 'reports sources current events', action: { type: 'news' } },
    { id: 'notebook', label: 'Open local notebook', group: 'Workspace', icon: 'notebook', keywords: 'notes photos evidence export', action: { type: 'notebook' } },
    { id: 'share', label: 'Copy a link to this view', group: 'Workspace', icon: 'share', keywords: 'share clipboard camera layers', action: { type: 'share' } },
    { id: 'save-place', label: 'Save this view', group: 'Saved places', icon: 'bookmark', keywords: 'favorite favourite bookmark location', action: { type: 'save-place' } },
    { id: 'clear-layers', label: 'Turn off every layer', group: 'Layers', icon: 'layers', keywords: 'clear disable all', action: { type: 'clear-layers' } },
  ];
  for (const layer of layers) {
    if (typeof layer.id !== 'string' || !layer.id || typeof layer.name !== 'string' || !layer.name) continue;
    catalog.push({ id: `layer:${layer.id}`, label: `${state[layer.id]?.enabled ? 'Disable' : 'Enable'} ${layer.name}`, group: layer.category || 'Layers', icon: 'layers', keywords: `${layer.id} ${layer.category || ''} ${layer.source || ''}`, action: { type: 'toggle-layer', id: layer.id } });
  }
  for (const place of places) {
    if (typeof place.id !== 'string' || !place.id || typeof place.name !== 'string' || !place.name) continue;
    catalog.push({ id: `place:${place.id}`, label: `Go to ${place.name}`, group: 'Saved places', icon: 'bookmark', keywords: `${place.name} favorite favourite location`, action: { type: 'place', id: place.id } });
  }
  return catalog;
}
export function searchCommands(catalog, query, limit = 12) {
  const raw = normalize(query), words = raw.split(/\s+/).filter(Boolean);
  return catalog.map((command, index) => {
    const label = normalize(command.label), text = `${label} ${normalize(command.group)} ${normalize(command.keywords)}`;
    if (!words.every((word) => text.includes(word))) return null;
    const score = !raw ? 0 : label === raw ? 0 : label.startsWith(raw) ? 1 : label.includes(raw) ? 2 : 3;
    return { command, score, index };
  }).filter(Boolean).sort((a, b) => a.score - b.score || a.index - b.index).slice(0, Math.max(0, Math.min(50, limit))).map((item) => item.command);
}
export function paletteShortcut(event, { editable = false, open = false } = {}) {
  return !event.defaultPrevented && !event.altKey && Boolean(event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k' && (open || !editable);
}
export function editableTarget(target) {
  return Boolean(target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}
