import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { endianness } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windProxy } from '../server/providers/wind.js';
import { createWindSource } from '../src/layers/wind/source.js';
import { readWindBody } from '../src/sources/windBody.js';

export const WIND_MODELS = Object.freeze(['gfs', 'ifs']);
export const WIND_OVERLAYS = Object.freeze(['none', 'temperature', 'pressure']);
export const MAX_GRID_BYTES = 3 * 1024 * 1024;
const HOUR = 3600_000;

/** Keep a generation's repeated index/GRIB range requests under a shared budget. */
export function memoizeWindFetch(fetchImpl = fetch, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const cached = new Map();
  const pending = new Map();
  let retainedBytes = 0;
  const responseFor = ({ bytes, status, headers }) => new Response(bytes, { status, headers });
  return async (url, options = {}) => {
    options.signal?.throwIfAborted();
    const key = `${url}\n${new Headers(options.headers).get('range') || ''}`;
    if (cached.has(key)) return responseFor(cached.get(key));
    let operation = pending.get(key);
    if (!operation) {
      operation = (async () => {
        const response = await fetchImpl(url, options);
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Wind upstream HTTP ${response.status}`);
        }
        const bytes = await readWindBody(response, 8 * 1024 * 1024, options.signal);
        const headers = new Headers(response.headers);
        headers.delete('content-encoding');
        headers.set('content-length', String(bytes.byteLength));
        const value = { bytes, status: response.status, headers };
        if (retainedBytes + bytes.byteLength <= maxBytes) {
          cached.set(key, value);
          retainedBytes += bytes.byteLength;
        }
        return value;
      })();
      pending.set(key, operation);
    }
    try {
      const value = await operation;
      options.signal?.throwIfAborted();
      return responseFor(value);
    } finally {
      if (pending.get(key) === operation) pending.delete(key);
    }
  };
}

function checkSnapshot(snapshot, bytes, { model, overlay, generationTime }) {
  const { cycle, grid } = snapshot || {};
  const run = Date.parse(cycle?.runIso);
  const valid = Date.parse(cycle?.validIso);
  const date = cycle?.runIso?.slice(0, 10).replaceAll('-', '');
  if (
    snapshot?.unavailable || snapshot?.stale || snapshot?.schemaVersion !== 1 ||
    snapshot?.model !== model || (snapshot?.overlay ?? 'none') !== overlay ||
    snapshot?.units !== 'm/s' || snapshot?.level !== '10 m above ground' ||
    !Number.isFinite(run) || !Number.isFinite(valid) ||
    !Number.isInteger(cycle?.forecastHour) || cycle.forecastHour < 0 ||
    ![0, 6, 12, 18].includes(cycle?.hour) || cycle.date !== date ||
    new Date(run).getUTCHours() !== cycle.hour ||
    valid !== run + cycle.forecastHour * HOUR ||
    run > generationTime || generationTime - run > 24 * HOUR ||
    Math.abs(valid - generationTime) > 3 * HOUR ||
    !grid || grid.nx !== 360 || grid.ny !== 181 || grid.dx !== 1 || grid.dy !== 1 ||
    grid.lo1 !== 0 || grid.la1 !== 90 ||
    (overlay !== 'none' && (!snapshot.scalar || snapshot.scalarError)) ||
    !bytes || bytes.byteLength > MAX_GRID_BYTES ||
    bytes.byteLength !== grid.nx * grid.ny * (overlay === 'none' ? 8 : 12)
  ) throw new Error(`Invalid or incomplete ${model}/${overlay} forecast snapshot`);
}

/** Generate all assets before writing any; publication belongs to the workflow. */
export async function generateWindAssets({
  outputDir = '.cache/wind-snapshots',
  now = () => Date.now(),
  fetchImpl = fetch,
  proxyOptions = {},
  onProgress = () => {},
} = {}) {
  if (endianness() !== 'LE') throw new Error('Wind generation requires little-endian Float32 storage');
  const generationTime = now();
  if (!Number.isFinite(generationTime)) throw new Error('Invalid generation time');
  const generationFetch = memoizeWindFetch(fetchImpl);
  const plugin = windProxy({
    ...proxyOptions,
    fetchImpl: generationFetch,
    // A run crossing the next cycle still uses one consistent forecast reference.
    now: () => generationTime,
    targetDx: 1,
    timeoutMs: 90_000,
  });
  let handler;
  plugin.configureServer({ middlewares: { use(prefix, mounted) {
    if (prefix !== '/api/wind' || handler) throw new Error('Unexpected wind middleware');
    handler = mounted;
  } } });
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/api/wind/')) {
      res.writeHead(404).end();
      return;
    }
    req.url = req.url.slice('/api/wind'.length);
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const assets = [];
  try {
    for (const model of WIND_MODELS) {
      for (const overlay of WIND_OVERLAYS) {
        onProgress({ model, overlay });
        let gridBytes;
        const source = createWindSource({
          timeoutMs: 100_000,
          fetchImpl: async (input, options) => {
            const url = new URL(input, origin);
            if (url.origin !== origin) throw new Error('Unexpected wind grid origin');
            const response = await fetch(url, options);
            if (!response.ok || !url.pathname.startsWith('/api/wind/grid/')) return response;
            gridBytes = Buffer.from(await readWindBody(response, MAX_GRID_BYTES, options.signal));
            return new Response(gridBytes, { status: response.status, headers: response.headers });
          },
        });
        const snapshot = await source.getSnapshot({ model, overlay });
        checkSnapshot(snapshot, gridBytes, { model, overlay, generationTime });
        const { u, v, scalar, ...manifest } = snapshot;
        if (scalar) manifest.scalar = { kind: scalar.kind, units: scalar.units, level: scalar.level };
        manifest.fetchedAt = now();
        manifest.gridSha256 = createHash('sha256').update(gridBytes).digest('hex');
        manifest.source = model === 'gfs'
          ? { name: 'NOAA GFS', url: 'https://registry.opendata.aws/noaa-gfs-bdp-pds/', license: 'U.S. government-produced public data' }
          : { name: 'ECMWF Open Data', url: 'https://www.ecmwf.int/en/forecasts/datasets/open-data', license: 'CC BY 4.0',
              licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
              attribution: 'This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF).',
              modification: 'Resampled to a 1-degree grid; temperature converted to degrees Celsius and pressure to hPa.',
              disclaimer: 'ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use.' };
        manifest.dataType = 'model-forecast';
        assets.push({ stem: `${model}-${overlay}`, manifest, gridBytes });
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const publishedAt = new Date(now()).toISOString();
  await mkdir(outputDir, { recursive: true });
  const files = [];
  for (const { stem, manifest, gridBytes } of assets) {
    manifest.publishedAt = publishedAt;
    const manifestPath = path.join(outputDir, `${stem}.manifest.json`);
    const gridPath = path.join(outputDir, `${stem}.grid.bin`);
    const json = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(json) > 16_384) throw new Error('Wind manifest exceeds byte budget');
    await writeFile(gridPath, gridBytes);
    await writeFile(manifestPath, json);
    files.push({ manifestPath, gridPath, gridBytes: gridBytes.byteLength, gridSha256: manifest.gridSha256 });
  }
  return { publishedAt, generatedAt: new Date(generationTime).toISOString(), files };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/wind-snapshot.mjs [output-directory]');
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!((major === 24 && minor >= 14) || major === 26))
      throw new Error(`Use Node 24.14+ (24.x) or 26.x for ecCodes; current runtime is ${process.version}`);
    const result = await generateWindAssets({
      outputDir: process.argv[2] || '.cache/wind-snapshots',
      onProgress: ({ model, overlay }) => process.stdout.write(`Generating ${model}/${overlay}\n`),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`Wind snapshot generation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
