import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCatalog, searchCommands, paletteShortcut } from './commands.js';
import { createCommandPalette } from './commands-ui.js';

test('local commands expose actual layer state and saved ids without provider calls or executable query text', () => {
  const commands = commandCatalog({ layers: [{ id: 'flights', name: 'Aircraft', category: 'Movement', source: 'adsb.lol' }], state: { flights: { enabled: true } }, places: [{ id: 'cafe', name: 'Café view' }] });
  assert.deepEqual(commands.find((command) => command.id === 'layer:flights').action, { type: 'toggle-layer', id: 'flights' });
  assert.equal(commands.find((command) => command.id === 'layer:flights').label, 'Disable Aircraft');
  assert.deepEqual(searchCommands(commands, 'cafe')[0].action, { type: 'place', id: 'cafe' });
  assert.equal(searchCommands(commands, 'Movement aircraft')[0].id, 'layer:flights');
  assert.deepEqual(searchCommands(commands, '<script>'), []);
});

test('command search ranks labels before metadata and keeps deterministic order and bounded results', () => {
  const commands = [{ id: 'keyword', label: 'Something else', keywords: 'radar' }, { id: 'prefix', label: 'Radar display' }, { id: 'exact', label: 'Radar' }];
  assert.deepEqual(searchCommands(commands, 'radar').map((item) => item.id), ['exact', 'prefix', 'keyword']);
  assert.deepEqual(searchCommands(commands, '').map((item) => item.id), ['keyword', 'prefix', 'exact']);
  assert.equal(searchCommands(commands, 'radar', 1).length, 1);
});

test('the shortcut yields to editors and earlier keyboard owners, while the open palette can close itself', () => {
  const key = { key: 'k', ctrlKey: true };
  assert.equal(paletteShortcut(key), true);
  assert.equal(paletteShortcut({ key: 'K', metaKey: true }), true);
  assert.equal(paletteShortcut(key, { editable: true }), false);
  assert.equal(paletteShortcut(key, { editable: true, open: true }), true);
  assert.equal(paletteShortcut({ ...key, defaultPrevented: true }), false);
  assert.equal(paletteShortcut({ ...key, altKey: true }), false);
  assert.equal(paletteShortcut({ key: 'k' }), false);
});

class Node extends EventTarget {
  constructor(doc) { super(); this.ownerDocument = doc; this.children = []; this.attributes = {}; this.isConnected = true; this.open = false; this.value = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  closest() { return null; }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollIntoView() {}
}
const keyEvent = (key, extra = {}) => Object.assign(new Event('keydown', { cancelable: true }), { key, ...extra });

test('palette keyboard selection executes the supplied action, restores focus, and cleans up its shortcut', async () => {
  const doc = new Node(); doc.ownerDocument = doc; doc.createElement = () => new Node(doc); doc.createElementNS = () => new Node(doc);
  const previous = new Node(doc); doc.activeElement = previous;
  const dialog = new Node(doc), input = new Node(doc), list = new Node(doc), count = new Node(doc), closeButton = new Node(doc);
  let catalogReads = 0; const executed = [];
  const palette = createCommandPalette({ dialog, input, list, count, closeButton, documentRef: doc,
    getCatalog: () => { catalogReads++; return commandCatalog(); }, execute: (action) => executed.push(action) });
  assert.equal(catalogReads, 0);
  const shortcut = keyEvent('k', { ctrlKey: true }); doc.dispatchEvent(shortcut);
  assert.equal(shortcut.defaultPrevented, true); assert.equal(dialog.open, true); assert.equal(doc.activeElement, input);
  input.dispatchEvent(keyEvent('ArrowDown'));
  assert.equal(input.attributes['aria-activedescendant'], 'command-result-1');
  input.dispatchEvent(keyEvent('Enter'));
  await Promise.resolve();
  assert.deepEqual(executed, [{ type: 'home' }]); assert.equal(dialog.open, false); assert.equal(doc.activeElement, previous);
  palette.open(); input.dispatchEvent(keyEvent('Escape'));
  assert.equal(dialog.open, false); assert.equal(doc.activeElement, previous);
  palette.destroy(); doc.dispatchEvent(keyEvent('k', { ctrlKey: true })); assert.equal(dialog.open, false);
});
