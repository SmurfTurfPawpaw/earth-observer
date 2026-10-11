export function normalizeEvidence(values, { now = Date.now(), id } = {}) {
  // Keep optional-call lowering out of a default-parameter scope in production builds.
  const identity = id || (typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : String(now));
  const title = String(values.title || '').trim().slice(0, 160), note = String(values.note || '').trim().slice(0, 8000);
  if (!title || (!note && !values.photo)) throw new Error('Add a title and a note or photograph.');
  let sourceUrl = '';
  if (values.sourceUrl) {
    const url = new URL(String(values.sourceUrl));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) throw new Error('Use a public HTTP or HTTPS source link.');
    sourceUrl = url.href;
  }
  const location = Number.isFinite(values.location?.lat) && Number.isFinite(values.location?.lon) && Math.abs(values.location.lat) <= 90 && Math.abs(values.location.lon) <= 180
    ? { lat: Number(values.location.lat.toFixed(3)), lon: Number(values.location.lon.toFixed(3)), meaning: 'Selected map location; not independently verified' } : null;
  return { id: identity, title, note, sourceUrl, location, createdAt: new Date(now).toISOString(), verification: 'User note; unverified', photo: values.photo || null };
}

/** Re-encode selected photographs, stripping embedded GPS/EXIF before local storage/export. */
export async function prepareEvidencePhoto(file) {
  if (!file) return null;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Choose a JPEG, PNG or WebP photograph smaller than 10 MB.');
  const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The image could not be prepared.')), 'image/jpeg', .82));
  } finally { image.close(); }
}

export function createEvidenceNotebook({ container, store, getLocation = () => null, notify = () => {} }) {
  const doc = container.ownerDocument, urls = new Set();
  let destroyed = false, saving = false, generation = 0;
  const el = (tag, text) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const intro = el('p', 'Private notes on this device. Add source links and photos, then export an evidence pack. Nothing is published automatically.'); intro.className = 'notebook-note';
  const form = el('form'); form.className = 'notebook-form';
  const field = (title, node) => { const label = el('label', title); label.append(node); form.append(label); return node; };
  const title = field('Title', el('input')); title.required = true; title.maxLength = 160;
  const note = field('Observation / question', el('textarea')); note.rows = 4; note.maxLength = 8000;
  const source = field('Source link', el('input')); source.type = 'url'; source.placeholder = 'https://…';
  const file = field('Photograph', el('input')); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp';
  const locateLabel = el('label'); locateLabel.className = 'notebook-location'; const locate = el('input'); locate.type = 'checkbox'; locateLabel.append(locate, 'Attach the selected map location'); form.append(locateLabel);
  const save = el('button', 'Save note'); save.type = 'submit'; form.append(save);
  const status = el('p'); status.className = 'notebook-status'; status.setAttribute('role', 'status');
  const actions = el('div'); actions.className = 'notebook-actions'; const exportButton = el('button', 'Export evidence pack'); exportButton.type = 'button'; actions.append(exportButton);
  const list = el('div'); list.className = 'notebook-list'; container.replaceChildren(intro, form, status, actions, list);
  async function records() { return (await store.all()).filter((record) => record.key.startsWith('evidence:')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async function render() {
    const owner = ++generation, items = await records(); if (destroyed || generation !== owner) return;
    for (const url of urls) URL.revokeObjectURL(url); urls.clear();
    list.replaceChildren(); exportButton.disabled = !items.length;
    if (!items.length) list.append(el('p', 'No saved notes yet.'));
    for (const record of items) {
      const card = el('article'); card.className = 'notebook-card'; card.append(el('h3', record.title), el('p', record.note), el('small', `${record.verification} · ${record.createdAt.replace('T', ' ').replace('.000Z', ' UTC')}`));
      if (record.sourceUrl) { const link = el('a', 'Original source'); link.href = record.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link); }
      if (record.location) card.append(el('small', `${record.location.lat}, ${record.location.lon} · selected map location`));
      if (record.photo) { const image = el('img'); image.alt = `User-provided photograph: ${record.title}`; const url = URL.createObjectURL(record.photo); urls.add(url); image.src = url; image.loading = 'lazy'; card.append(image); }
      const remove = el('button', 'Delete note'); remove.type = 'button'; remove.addEventListener('click', async () => { await store.delete(record.key); await render(); }); card.append(remove); list.append(card);
    }
  }
  const submit = async (event) => {
    event.preventDefault(); if (saving || destroyed) return; saving = true; save.disabled = true; status.textContent = 'Preparing local evidence…';
    try {
      const current = await records(); if (current.length >= 50) throw new Error('The notebook holds 50 notes. Export or delete some notes first.');
      const photo = await prepareEvidencePhoto(file.files[0]);
      if (current.reduce((sum, record) => sum + (record.photo?.size || 0), 0) + (photo?.size || 0) > 20 * 1024 * 1024) throw new Error('Photo storage is full. Export or delete some notes first.');
      const record = normalizeEvidence({ title: title.value, note: note.value, sourceUrl: source.value, photo, location: locate.checked ? getLocation() : null });
      const result = await store.put(`evidence:${record.id}`, record); form.reset();
      status.textContent = result?.persistent ? 'Saved on this device. Photo metadata removed; nothing uploaded.' : 'Saved for this open tab only: browser storage is unavailable. Export before closing or reloading.';
      await render();
    } catch (error) { status.textContent = error.message || 'The note could not be saved.'; }
    finally { saving = false; save.disabled = false; }
  };
  const exportPack = async () => {
    try {
      const items = await records();
      const notes = await Promise.all(items.map(async ({ key, photo, ...record }) => ({ ...record, photo: photo ? await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(photo); }) : null })));
      const blob = new Blob([JSON.stringify({ schema: 'earth-observer-evidence/v1', exportedAt: new Date().toISOString(), review: 'User-supplied material; requires independent verification. No publishing or consent rights are implied.', notes }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), download = el('a'); download.href = url; download.download = `earth-observer-evidence-${new Date().toISOString().slice(0, 10)}.json`; download.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      status.textContent = 'Evidence pack exported. Review personal information and photo rights before sharing.';
    } catch { notify('The evidence pack could not be exported.'); }
  };
  form.addEventListener('submit', submit); exportButton.addEventListener('click', exportPack);
  return { open: render, close() {}, destroy() { destroyed = true; generation++; form.removeEventListener('submit', submit); exportButton.removeEventListener('click', exportPack); for (const url of urls) URL.revokeObjectURL(url); container.replaceChildren(); } };
}
