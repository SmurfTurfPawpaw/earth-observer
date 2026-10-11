import { mkdir, writeFile, rename, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gdeltQueryUrl } from '../server/hosted/gdelt-query.js';
import { validateGdeltSnapshot } from '../server/hosted/gdelt-snapshot.js';
import { normalizeGdelt } from '../server/hosted/intelligence-sources.js';
import { readResponseJsonCapped } from '../server/providers/common/http.js';

export const GDELT_SNAPSHOT_CATEGORIES = Object.freeze(['geopolitics', 'economy', 'disasters']);
export const GDELT_SNAPSHOT_ASSET = 'gdelt.snapshot.json';
export const MAX_GDELT_SNAPSHOT_BYTES = 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One bounded metadata batch; any failure preserves the previously published data. */
export async function generateGdeltSnapshot({ fetchImpl = fetch, now = Date.now, sleepImpl = wait,
  timeoutMs = 15000, minGapMs = 6100 } = {}) {
  const categories = {};
  let previousStart = null;
  for (const category of GDELT_SNAPSHOT_CATEGORIES) {
    if (previousStart !== null) {
      const delay = Math.max(0, Math.max(6000, minGapMs) - (now() - previousStart));
      if (delay) await sleepImpl(delay);
    }
    previousStart = now();
    const queryUrl = gdeltQueryUrl({ category, country: '', countryName: '', q: '' });
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(queryUrl, { signal, redirect: 'error', headers: {
        Accept: 'application/json', 'User-Agent': 'earth-observer-snapshots/1.0 (+https://github.com/SmurfTurfPawpaw/earth-observer)',
      } });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: 'skipped', category, reason: response.status === 429 ? 'GDELT rate limit (HTTP 429); previous snapshot preserved' : `GDELT HTTP ${response.status}; previous snapshot preserved` };
      }
      const metadata = await readResponseJsonCapped(response, 2 * 1024 * 1024, signal);
      signal.throwIfAborted();
      if (!Array.isArray(metadata?.articles) || metadata.articles.length > 80) throw new Error('Unexpected GDELT article count');
      const retrievedAt = new Date(now()).toISOString();
      const unique = new Map();
      for (const report of normalizeGdelt(metadata, retrievedAt, category)) if (!unique.has(report.url)) unique.set(report.url, report);
      categories[category] = { queryUrl, retrievedAt, reports: [...unique.values()] };
    } catch (error) {
      return { status: 'skipped', category, reason: error.name === 'TimeoutError' ? 'GDELT timeout; previous snapshot preserved' : 'GDELT metadata unavailable or invalid; previous snapshot preserved' };
    }
  }
  const proposed = { schemaVersion: 1, generatedAt: new Date(now()).toISOString(),
    source: { id: 'gdelt', name: 'The GDELT Project', url: 'https://www.gdeltproject.org/' },
    coverage: { timespan: '24h', maxRecordsPerCategory: 80, categories: [...GDELT_SNAPSHOT_CATEGORIES],
      note: 'Bounded discovery sample; GDELT indexing time is not publication time.' }, categories };
  let snapshot;
  try { snapshot = validateGdeltSnapshot(proposed, now()); }
  catch { return { status: 'skipped', reason: 'GDELT snapshot metadata failed consumer validation; previous snapshot preserved' }; }
  const bytes = new TextEncoder().encode(`${JSON.stringify(snapshot)}\n`);
  if (bytes.byteLength > MAX_GDELT_SNAPSHOT_BYTES) return { status: 'skipped', reason: 'GDELT snapshot exceeded 1 MiB; previous snapshot preserved' };
  return { status: 'generated', snapshot, bytes };
}

/** Never overwrite a local or release asset with a skipped/partial batch. */
export async function writeGdeltSnapshot(outputDir, result) {
  if (result.status !== 'generated') return false;
  const directory = path.resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, GDELT_SNAPSHOT_ASSET);
  const temporary = path.join(directory, `${GDELT_SNAPSHOT_ASSET}.${process.pid}.tmp`);
  await writeFile(temporary, result.bytes);
  await rename(temporary, destination);
  return destination;
}

async function main() {
  const result = await generateGdeltSnapshot();
  const destination = await writeGdeltSnapshot(process.argv[2] || '.cache/intelligence-snapshots', result);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  console.log(JSON.stringify({ status: result.status, ...(result.reason ? { reason: result.reason, category: result.category } : {}),
    ...(destination ? { destination, bytes: result.bytes.byteLength, generatedAt: result.snapshot.generatedAt,
      counts: Object.fromEntries(GDELT_SNAPSHOT_CATEGORIES.map((category) => [category, result.snapshot.categories[category].reports.length])) } : {}) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
