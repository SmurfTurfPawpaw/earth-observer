import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const OFFLINE_MANIFEST = '.offline-manifest.json';
const validScope = (scope) => /^\/(?:[a-z0-9-]+\/)*$/.test(scope);
const safeFile = (file) => typeof file === 'string' && /^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$/.test(file) && !file.split('/').some((part) => part === '.' || part === '..');

function mainEntry(manifest) {
  const startup = [...new Set(manifest['index.html']?.dynamicImports || [])].filter((key) => {
    const entry = manifest[key];
    return entry?.name === 'main' && entry.isDynamicEntry === true && /^assets\/main-[A-Za-z0-9_-]+\.js$/.test(entry.file);
  });
  if (startup.length !== 1) throw new Error('The document must reference exactly one dynamic main startup chunk');
  return startup[0];
}

/** Fetch/compile startup modules alongside Cesium without executing them or optional layers. */
export function preloadStartupModules({ manifest, html, scope = '/', maxAssets = 96 }) {
  if (!validScope(scope)) throw new Error('Invalid EARTH_BASE_PATH');
  const visited = new Set(), files = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (!entry || !safeFile(entry.file) || !entry.file.endsWith('.js')) throw new Error(`Missing or unsafe static startup module: ${key}`);
    visited.add(key); files.add(scope + entry.file);
    if (files.size > maxAssets) throw new Error('Startup module count exceeded its budget');
    for (const dependency of entry.imports || []) visit(dependency);
  };
  visit(mainEntry(manifest));
  for (const tag of String(html).matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attributes = new Map([...tag[0].matchAll(/\b([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]));
    if (attributes.get('type') !== 'module' && attributes.get('rel') !== 'modulepreload') continue;
    const value = attributes.get('src') || attributes.get('href');
    if (value) {
      const url = new URL(value, `https://earth.invalid${scope}`);
      if (url.origin === 'https://earth.invalid' && !url.search && !url.hash) files.delete(url.pathname);
    }
  }
  if (!/<\/head\s*>/i.test(html)) throw new Error('Startup document head is missing');
  const tags = [...files].map((file) => `<link rel="modulepreload" crossorigin href="${file}">`).join('\n');
  return html.replace(/<\/head\s*>/i, `${tags}\n</head>`);
}

/** Follow Vite's static imports only. main.js is the single explicit dynamic startup entry. */
export function collectOfflineShell({ manifest, html, scope = '/', maxAssets = 96 }) {
  if (!validScope(scope)) throw new Error('Invalid EARTH_BASE_PATH');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('The Vite offline manifest is invalid');
  const routes = new Set([scope]), visited = new Set();
  const add = (route) => { routes.add(route); if (routes.size > maxAssets) throw new Error('Offline shell asset count exceeded its budget'); };
  const visit = (key) => {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (!entry || !safeFile(entry.file)) throw new Error(`Missing or unsafe static shell chunk: ${key}`);
    visited.add(key); add(scope + entry.file);
    for (const file of [...entry.css || [], ...entry.assets || []]) {
      if (!safeFile(file)) throw new Error('Unsafe static shell asset');
      add(scope + file);
    }
    for (const dependency of entry.imports || []) visit(dependency);
    // Deliberately do not follow dynamicImports: optional layers/decoders/data stay on demand.
  };
  visit('index.html');
  visit(mainEntry(manifest));
  // Cesium's plugin emits vendor tags outside Vite's module graph. Read only those local tags.
  let engine;
  for (const tag of String(html).matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attributes = new Map([...tag[0].matchAll(/\b([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]));
    const value = attributes.get('src') || attributes.get('href');
    if (!value) continue;
    const url = new URL(value, `https://earth.invalid${scope}`);
    if (url.origin !== 'https://earth.invalid' || url.search || url.hash || !url.pathname.startsWith(scope + 'cesium/')) continue;
    const relative = url.pathname.slice(scope.length);
    if (!/^cesium\/[A-Za-z0-9_.-]+\/(?:Cesium\.js|Widgets\/widgets\.css)$/.test(relative)) continue;
    add(url.pathname); if (relative.endsWith('/Cesium.js')) engine = url.pathname;
  }
  if (!engine) throw new Error('Essential Cesium vendor script is missing');
  const base = engine.replace(/Cesium\.js$/, 'Assets/Textures/NaturalEarthII/');
  for (const file of ['tilemapresource.xml', '0/0/0.jpg', '0/1/0.jpg']) add(base + file);
  return [...routes].sort();
}

async function builtAsset(outDir, route, scope) {
  const root = path.resolve(outDir);
  const relatives = route === scope ? ['index.html'] : [route.slice(scope.length), route.slice(1)];
  for (const relative of [...new Set(relatives)]) {
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep)) throw new Error('Offline asset escaped the public output directory');
    try { return await readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Missing essential offline asset: ${route}`);
}
export async function prepareOfflineShell({ outDir = 'dist', scope = '/', maxAssets = 96, maxBytes = 12 * 1024 * 1024 } = {}) {
  const [html, data] = await Promise.all([readFile(path.join(outDir, 'index.html'), 'utf8'), readFile(path.join(outDir, OFFLINE_MANIFEST), 'utf8')]);
  const critical = collectOfflineShell({ manifest: JSON.parse(data), html, scope, maxAssets });
  const hash = createHash('sha256'); let bytes = 0;
  for (const route of critical) {
    const body = await builtAsset(outDir, route, scope); bytes += body.length;
    if (bytes > maxBytes) throw new Error('Offline shell bytes exceeded their budget');
    hash.update(route).update(body);
  }
  return { critical, version: hash.digest('hex').slice(0, 16), bytes };
}
