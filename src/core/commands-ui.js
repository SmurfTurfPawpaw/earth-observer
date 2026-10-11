import { createIcon } from './icons.js';
import { searchCommands, paletteShortcut, editableTarget } from './commands.js';

/** A native modal owns focus; commands call supplied action methods instead of clicking page controls. */
export function createCommandPalette({ dialog, input, list, count, closeButton, getCatalog, execute, onError = () => {}, documentRef = dialog.ownerDocument }) {
  let results = [], active = 0, previousFocus, destroyed = false;
  const cleanup = [];
  const bind = (node, name, handler) => { node.addEventListener(name, handler); cleanup.push(() => node.removeEventListener(name, handler)); };
  const refreshActive = () => {
    const items = [...list.children];
    for (const [index, item] of items.entries()) item.setAttribute('aria-selected', String(index === active));
    if (items[active]) { input.setAttribute('aria-activedescendant', items[active].id); items[active].scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    const selectedId = results[active]?.id;
    results = searchCommands(getCatalog(), input.value);
    const selectedIndex = results.findIndex((command) => command.id === selectedId);
    active = selectedIndex >= 0 ? selectedIndex : 0;
    const items = results.map((command, index) => {
      const item = documentRef.createElement('li'); item.id = `command-result-${index}`; item.setAttribute('role', 'option'); item.className = 'command-result';
      const text = documentRef.createElement('span'), label = documentRef.createElement('span'), group = documentRef.createElement('small');
      label.textContent = command.label; group.textContent = command.group; text.append(label, group); item.append(createIcon(command.icon, documentRef), text);
      item.addEventListener('pointermove', () => { if (active !== index) { active = index; refreshActive(); } });
      item.addEventListener('click', () => run(command));
      return item;
    });
    list.replaceChildren(...items);
    count.textContent = results.length ? `${results.length} commands · ↑ ↓ to choose · Enter to run` : 'No matching commands';
    refreshActive();
  };
  const close = () => {
    if (!dialog.open) return;
    dialog.close(); input.setAttribute('aria-expanded', 'false');
    if (previousFocus?.isConnected && !previousFocus.closest?.('[hidden]')) previousFocus.focus();
  };
  const run = async (command) => {
    if (!command || destroyed) return;
    close();
    try { await execute(command.action); } catch (error) { onError(error.message || 'This command could not run.'); }
  };
  const open = () => {
    if (destroyed || dialog.open) return;
    previousFocus = documentRef.activeElement; input.value = ''; render(); dialog.showModal(); input.setAttribute('aria-expanded', 'true'); input.focus();
  };
  const shortcut = (event) => {
    if (!paletteShortcut(event, { editable: editableTarget(event.target), open: dialog.open })) return;
    event.preventDefault(); dialog.open ? close() : open();
  };
  bind(documentRef, 'keydown', shortcut);
  bind(input, 'input', render);
  bind(input, 'keydown', (event) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); if (results.length) active = (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; refreshActive(); }
    else if (event.key === 'Enter') { event.preventDefault(); void run(results[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  bind(dialog, 'cancel', (event) => { event.preventDefault(); close(); });
  bind(closeButton, 'click', close);
  bind(dialog, 'click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } });
  return { open, close, refresh: () => { if (dialog.open) render(); }, destroy() { destroyed = true; close(); cleanup.splice(0).reverse().forEach((dispose) => dispose()); list.replaceChildren(); } };
}
