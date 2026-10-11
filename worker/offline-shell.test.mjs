import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { collectOfflineShell, prepareOfflineShell, preloadStartupModules, publicShellAsset, PUBLIC_SHELL_MAX_BYTES, OFFLINE_MANIFEST } from '../scripts/offline-shell.mjs';
import { renderServiceWorker } from '../scripts/service-worker-runtime.mjs';
const manifest = () => ({
  'index.html': { file: 'assets/bootstrap-one.js', imports: ['_shared.js', '_preview.js'], dynamicImports: ['src/main.js', 'src/optional.js'], css: ['assets/app-one.css'] },
  'src/main.js': { file: 'assets/main-one.js', name: 'main', isDynamicEntry: true, imports: ['_shared.js', '_navigation.js'], assets: ['assets/static-icon.png'], dynamicImports: ['src/optional.js'] },
  '_shared.js': { file: 'assets/shared-one.js', imports: ['_cycle.js'] },
  '_cycle.js': { file: 'assets/cycle-one.js', imports: ['_shared.js'] },
  '_preview.js': { file: 'assets/preview-one.js' },
  '_navigation.js': { file: 'assets/navigation-one.js' },
  'src/optional.js': { file: 'assets/optional-heavy.js', imports: ['_geoid.js'], assets: ['assets/optional-data.bin'] },
  '_geoid.js': { file: 'assets/huge-geoid.js' },
});
const html = (scope) => `<script type="module" src="${scope}assets/bootstrap-one.js"></script><link rel="preload" as="script" href='${scope}cesium/1.138.0/Cesium.js' data-globe-engine><link rel="stylesheet" href="${scope}cesium/1.138.0/Widgets/widgets.css"><a href="${scope}api/evidence/moderation">Not an asset</a><link rel="preconnect" href="https://gibs.earthdata.nasa.gov">`;
test('the shell includes both startup static closures, shared cycles once, CSS and static assets, while optional dynamic data stays excluded', () => {
  const critical = collectOfflineShell({ manifest: manifest(), html: html('/earth/'), scope: '/earth/' });
  for (const file of ['bootstrap-one.js', 'main-one.js', 'shared-one.js', 'cycle-one.js', 'preview-one.js', 'navigation-one.js', 'app-one.css', 'static-icon.png']) assert.equal(critical.includes('/earth/assets/' + file), true);
  assert.equal(critical.filter((item) => item.endsWith('shared-one.js')).length, 1);
  assert.equal(critical.some((item) => /optional|geoid|api\//.test(item)), false);
  assert.equal(critical.every((item) => item.startsWith('/earth/')), true);
  assert.equal(critical.includes('/earth/cesium/1.138.0/Assets/Textures/NaturalEarthII/0/1/0.jpg'), true);
});
test('missing dependencies, unsafe paths, mismatched vendor mounts and an excessive graph fail the build', () => {
  const input = { manifest: manifest(), html: html('/'), scope: '/' };
  const missing = manifest(); delete missing['_navigation.js']; assert.throws(() => collectOfflineShell({ ...input, manifest: missing }), /Missing or unsafe/);
  const unsafe = manifest(); unsafe['_shared.js'].file = '../api/evidence/session'; assert.throws(() => collectOfflineShell({ ...input, manifest: unsafe }), /unsafe/);
  assert.throws(() => collectOfflineShell({ ...input, maxAssets: 5 }), /budget/);
  assert.throws(() => collectOfflineShell({ ...input, scope: '/earth/' }), /vendor script/);
  assert.throws(() => collectOfflineShell({ ...input, scope: '/earth/../' }), /EARTH_BASE_PATH/);
});
test('the actual Vite generated-key shape resolves main from the document, not a source filename assumption', () => {
  const input = manifest();
  const main = input['src/main.js']; delete input['src/main.js'];
  input['_main-BnXJiO1T.js'] = { ...main, file: 'assets/main-BnXJiO1T.js', imports: ['index.html'] };
  input['index.html'].dynamicImports = ['_main-BnXJiO1T.js', 'src/optional.js'];
  const critical = collectOfflineShell({ manifest: input, html: html('/earth/'), scope: '/earth/' });
  assert.equal(critical.includes('/earth/assets/main-BnXJiO1T.js'), true);
  assert.equal(critical.includes('/earth/assets/shared-one.js'), true);
  assert.equal(critical.some((item) => /optional|geoid/.test(item)), false);
  input['_main-second.js'] = { ...main, file: 'assets/main-second.js' }; input['index.html'].dynamicImports.push('_main-second.js');
  assert.throws(() => collectOfflineShell({ manifest: input, html: html('/earth/'), scope: '/earth/' }), /exactly one/);
  input['index.html'].dynamicImports = ['src/optional.js'];
  assert.throws(() => collectOfflineShell({ manifest: input, html: html('/earth/'), scope: '/earth/' }), /exactly one/);
});

test('modulepreload follows only the real main static closure, respects mounted paths and existing scripts, and never executes main', () => {
  const input = manifest();
  input['_main-BnXJiO1T.js'] = { ...input['src/main.js'], file: 'assets/main-BnXJiO1T.js', imports: ['index.html', '_navigation.js'] };
  delete input['src/main.js']; input['index.html'].dynamicImports = ['_main-BnXJiO1T.js'];
  const original = '<html><head>' + html('/earth/') + '<link rel="modulepreload" href="/earth/assets/shared-one.js"></head></html>';
  const result = preloadStartupModules({ manifest: input, html: original, scope: '/earth/' });
  for (const file of ['main-BnXJiO1T.js', 'navigation-one.js', 'preview-one.js', 'cycle-one.js']) assert.equal(result.includes(`rel="modulepreload" crossorigin href="/earth/assets/${file}"`), true);
  assert.equal(result.match(/shared-one\.js/g).length, 1); assert.equal(result.match(/bootstrap-one\.js/g).length, 1);
  assert.equal(result.includes('optional-heavy'), false); assert.equal(result.includes('huge-geoid'), false);
  assert.equal(result.includes('<script type="module" src="/earth/assets/main-'), false);
  assert.equal(preloadStartupModules({ manifest: input, html: result, scope: '/earth/' }).match(/main-BnXJiO1T\.js/g).length, 1);
  const unsafe = manifest(); unsafe['_shared.js'].file = '../api/evidence/private.js';
  assert.throws(() => preloadStartupModules({ manifest: unsafe, html: original }), /unsafe/);
  assert.throws(() => preloadStartupModules({ manifest: input, html: original, maxAssets: 2 }), /budget/);
});
test('a temporary mounted build resolves plugin vendor folders, checks missing files/byte budget and versions static dependency content', async () => {
  const parent = path.resolve(tmpdir()), folder = await mkdtemp(path.join(parent, 'earth-offline-'));
  assert.equal(path.resolve(folder).startsWith(parent + path.sep), true); assert.match(path.basename(folder), /^earth-offline-/);
  try {
    const scope = '/earth/', critical = collectOfflineShell({ manifest: manifest(), html: html(scope), scope });
    for (const route of critical) {
      const relative = route === scope ? 'index.html' : route.includes('/cesium/') ? route.slice(1) : route.slice(scope.length);
      const filename = path.join(folder, relative); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, route === scope ? html(scope) : 'fixture');
    }
    await writeFile(path.join(folder, OFFLINE_MANIFEST), JSON.stringify(manifest()));
    const first = await prepareOfflineShell({ outDir: folder, scope }); assert.deepEqual(first.critical, critical);
    assert.equal(first.shell.descriptor.url, scope + first.shell.filename);
    assert.deepEqual(JSON.parse(first.shell.body), { schema: 1, release: first.version, scope, html: html(scope) });
    const markerBytes = Buffer.byteLength(JSON.stringify({ schema: 1, release: first.version, critical, htmlDigest: first.shell.descriptor.htmlDigest }));
    assert.equal(first.bytes, Buffer.byteLength(first.shell.body) + (critical.length - 1) * Buffer.byteLength('fixture') + markerBytes);
    await assert.rejects(prepareOfflineShell({ outDir: folder, scope, maxAssets: critical.length }), /budget/); // One reserved completion-marker entry.
    await writeFile(path.join(folder, 'assets/shared-one.js'), 'changed shared module');
    const second = await prepareOfflineShell({ outDir: folder, scope }); assert.notEqual(second.version, first.version);
    assert.notEqual(second.shell.filename, first.shell.filename); // Different dependencies cannot share an immutable shell descriptor.
    await assert.rejects(prepareOfflineShell({ outDir: folder, scope, maxBytes: 2 }), /budget/);
    await rm(path.join(folder, 'assets/navigation-one.js'));
    await assert.rejects(prepareOfflineShell({ outDir: folder, scope }), /Missing essential/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the public shell is content-addressed across HTML, asset release and mount, and has a fixed decoded byte budget', () => {
  const input = { html: '<!doctype html><html>Public build</html>', version: 'fixture', scope: '/earth/' };
  const asset = publicShellAsset(input), hash = createHash('sha256').update(asset.body).digest('hex');
  assert.equal(asset.descriptor.url, `/earth/assets/public-shell-${hash}.json`);
  assert.equal(asset.descriptor.htmlDigest, createHash('sha256').update(input.html).digest('hex'));
  for (const change of [{ html: input.html + 'updated' }, { version: 'next' }, { scope: '/' }]) assert.notEqual(publicShellAsset({ ...input, ...change }).filename, asset.filename);
  assert.throws(() => publicShellAsset({ ...input, html: 'x'.repeat(PUBLIC_SHELL_MAX_BYTES) }), /byte budget/);
  assert.throws(() => publicShellAsset({ ...input, scope: '/earth/../' }), /Invalid/);
  assert.throws(() => publicShellAsset({ ...input, version: 'private/unsafe' }), /Invalid/);
});

test('the actual generator emits scoped universal JSON after startup preloads without acquiring optional files', async () => {
  const parent = path.resolve(tmpdir()), folder = await mkdtemp(path.join(parent, 'earth-shell-generator-'));
  assert.equal(path.resolve(folder).startsWith(parent + path.sep), true); assert.match(path.basename(folder), /^earth-shell-generator-/);
  try {
    const scope = '/earth/', original = '<!doctype html><html><head>' + html(scope) + '</head><body>Universal public document</body></html>';
    const critical = collectOfflineShell({ manifest: manifest(), html: original, scope });
    for (const route of critical) {
      const relative = route === scope ? 'index.html' : route.includes('/cesium/') ? route.slice(1) : route.slice(scope.length);
      const filename = path.join(folder, 'dist', relative); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, route === scope ? original : 'fixture');
    }
    await writeFile(path.join(folder, 'dist', OFFLINE_MANIFEST), JSON.stringify(manifest()));
    const script = fileURLToPath(new URL('../scripts/service-worker.mjs', import.meta.url));
    await promisify(execFile)(process.execPath, [script], { cwd: folder, env: { ...process.env, EARTH_BASE_PATH: scope } });
    const builtHtml = await readFile(path.join(folder, 'dist/index.html'), 'utf8'), sw = await readFile(path.join(folder, 'dist/sw.js'), 'utf8');
    assert.match(builtHtml, /modulepreload[^>]+main-one\.js/);
    const descriptor = JSON.parse(/const SHELL = (\{[^;]+\}), SHELL_RELEASE/.exec(sw)[1]);
    const body = await readFile(path.join(folder, 'dist', descriptor.url.slice(scope.length)), 'utf8');
    assert.equal(createHash('sha256').update(body).digest('hex'), descriptor.digest); assert.equal(JSON.parse(body).html, builtHtml);
    assert.match(sw, /earth-observer-shell-v3-/); assert.equal(sw.includes('optional-heavy.js'), false); assert.equal(sw.includes('optional-data.bin'), false);
    assert.match(sw, /x-earth-shell-release/); assert.match(sw, /frame-ancestors 'none'/);
    await assert.rejects(readFile(path.join(folder, 'dist', OFFLINE_MANIFEST)), { code: 'ENOENT' });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('generated service-worker code excludes mounted APIs and authorization requests before navigation or asset caching', () => {
  const generated = renderServiceWorker({ version: 'fixture', critical: ['/earth/'], scope: '/earth/' });
  const listeners = new Map(), context = { self: { addEventListener: (name, fn) => listeners.set(name, fn) }, URL, location: { origin: 'https://example.com' }, Response, caches: { match() { throw new Error('Private cache access'); } }, fetch() { throw new Error('Private fetch interception'); } };
  vm.runInNewContext(generated, context);
  for (const route of ['/api/evidence/session', '/earth/api/evidence/moderation', '/earth/api/evidence/reference/photo']) {
    const event = { request: { method: 'GET', mode: 'navigate', url: 'https://example.com' + route, headers: new Headers() }, respondWith() { assert.fail('API request must not be intercepted'); } };
    listeners.get('fetch')(event);
  }
  listeners.get('fetch')({ request: { method: 'GET', mode: 'navigate', url: 'https://example.com/earth/', headers: new Headers({ authorization: 'Bearer private' }) }, respondWith() { assert.fail('Authorization request must not be intercepted'); } });
});
