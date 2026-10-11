import { createIcon } from './icons.js';

export function createSavedPlacesUi({ store, getView, onRecall, onChange = () => {}, documentRef = globalThis.document }) {
  const panel = documentRef.getElementById('saved-places'), input = documentRef.getElementById('saved-place-name');
  const form = documentRef.getElementById('save-place-form'), list = documentRef.getElementById('saved-place-list');
  const status = documentRef.getElementById('saved-place-status'), count = documentRef.getElementById('saved-place-count');
  const save = documentRef.getElementById('save-place'), cancel = documentRef.getElementById('cancel-save-place');
  let editingId = null;
  const node = (tag, className, text) => { const element = documentRef.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const finishEditing = () => { editingId = null; input.value = ''; cancel.hidden = true; save.title = 'Save the current camera view'; save.setAttribute('aria-label', save.title); };
  const button = (icon, label) => { const element = node('button', 'icon-button'); element.type = 'button'; element.title = label; element.setAttribute('aria-label', label); element.append(createIcon(icon, documentRef)); return element; };
  const render = () => {
    const places = store.list(); count.textContent = places.length;
    if (!places.length) { list.replaceChildren(node('li', 'saved-place-empty', 'Save a named camera view to return here later. Stored only in this browser.')); return; }
    list.replaceChildren(...places.map((place) => {
      const item = node('li');
      const go = node('button', 'saved-place-go'); go.type = 'button'; go.title = `Return to ${place.name}`;
      go.append(node('span', '', place.name), node('small', '', `${place.view.lat.toFixed(3)}, ${place.view.lon.toFixed(3)} · ${(place.view.alt / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`));
      go.addEventListener('click', () => { try { onRecall(place.id); } catch (error) { status.textContent = error.message; } });
      const rename = button('edit', `Rename ${place.name}`);
      rename.addEventListener('click', () => { editingId = place.id; input.value = place.name; cancel.hidden = false; save.title = 'Save the new name'; save.setAttribute('aria-label', save.title); input.focus(); input.select(); status.textContent = 'Rename this saved view.'; });
      const remove = button('close', `Remove ${place.name}`);
      remove.addEventListener('click', () => { try { store.remove(place.id); if (editingId === place.id) finishEditing(); status.textContent = `Removed ${place.name}.`; render(); onChange(); save.focus(); } catch (error) { status.textContent = error.message; } });
      item.append(go, rename, remove); return item;
    }));
  };
  const submit = (event) => {
    event.preventDefault();
    try {
      const place = editingId ? store.rename(editingId, input.value) : store.save(input.value, getView());
      finishEditing(); status.textContent = `Saved ${place.name} on this device.`; render(); onChange();
    } catch (error) { status.textContent = error.message || 'The view could not be saved.'; }
  };
  const cancelRename = () => { finishEditing(); status.textContent = ''; input.focus(); };
  form.addEventListener('submit', submit); cancel.addEventListener('click', cancelRename); render();
  status.textContent = store.getError() || '';
  return {
    open({ draft = false } = {}) {
      panel.open = true;
      if (draft) { finishEditing(); const view = getView(); input.value = `${view.lat.toFixed(3)}, ${view.lon.toFixed(3)}`; input.focus(); input.select(); }
    },
    refresh: render,
    destroy() { form.removeEventListener('submit', submit); cancel.removeEventListener('click', cancelRename); list.replaceChildren(); },
  };
}
