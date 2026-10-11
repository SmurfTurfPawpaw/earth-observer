import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateWindAssets, memoizeWindFetch } from '../../scripts/wind-snapshot.mjs';
import { weatherScalarMetadata } from '../providers/wind/grid.js';

const NOW = Date.parse('2026-10-11T12:17:00Z');
const COUNT = 360 * 181;
const cycle = {
  date: '20261011', hour: 6, forecastHour: 6,
  runIso: '2026-10-11T06:00:00.000Z', validIso: '2026-10-11T12:00:00.000Z',
};
function models({ badOverlay, badTime = false } = {}) {
  const calls = [];
  const provider = async ({ overlay, targetDx, now }) => {
    calls.push({ overlay, targetDx, now: now() });
    const scalar = weatherScalarMetadata(overlay);
    return {
      cycle: badTime ? { ...cycle, validIso: '2026-10-10T12:00:00.000Z' } : cycle,
      level: '10 m above ground', units: 'm/s',
      ...(scalar && overlay !== badOverlay ? { scalar } : {}),
      ...(overlay === badOverlay ? { scalarError: 'Temperature field unavailable' } : {}),
      grid: {
        nx: 360, ny: 181, lo1: 0, la1: 90, dx: targetDx, dy: targetDx,
        u: new Float32Array(COUNT).fill(1.5), v: new Float32Array(COUNT).fill(-2.5),
        ...(scalar && overlay !== badOverlay ? { scalar: new Float32Array(COUNT).fill(overlay === 'temperature' ? 12.25 : 1013.25) } : {}),
      },
    };
  };
  return { calls, providers: { gfs: provider, ifs: provider } };
}

test('snapshot generation produces six compatible bounded grids with exact SHA-256 and real time fields', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'earth-wind-'));
  const { calls, providers } = models();
  try {
    const result = await generateWindAssets({ outputDir: folder, now: () => NOW, proxyOptions: { models: providers } });
    assert.equal(result.files.length, 6);
    assert.equal((await readdir(folder)).length, 12);
    assert.deepEqual(calls.map((call) => call.overlay), ['none', 'temperature', 'pressure', 'none', 'temperature', 'pressure']);
    assert.ok(calls.every((call) => call.targetDx === 1 && call.now === NOW));
    for (const file of result.files) {
      const manifest = JSON.parse(await readFile(file.manifestPath, 'utf8'));
      const bytes = await readFile(file.gridPath);
      const overlay = manifest.overlay || 'none';
      assert.equal(bytes.byteLength, COUNT * (overlay === 'none' ? 8 : 12));
      assert.equal(bytes.readFloatLE(0), 1.5);
      assert.equal(bytes.readFloatLE(COUNT * 4), -2.5);
      if (overlay !== 'none') assert.equal(bytes.readFloatLE(COUNT * 8), overlay === 'temperature' ? 12.25 : 1013.25);
      assert.equal(manifest.gridSha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(manifest.publishedAt, new Date(NOW).toISOString());
      assert.equal(manifest.fetchedAt, NOW);
      assert.deepEqual(manifest.cycle, cycle);
      assert.equal(manifest.dataType, 'model-forecast');
      assert.equal(manifest.schemaVersion, 1);
      assert.match(manifest.gridUrl, new RegExp(`^/api/wind/grid/${manifest.model}-20261011-6-f6-1`));
      assert.ok(!Object.hasOwn(manifest, 'u') && !Object.hasOwn(manifest, 'v'));
      assert.ok(!manifest.scalar || !Object.hasOwn(manifest.scalar, 'values'));
      if (manifest.model === 'ifs') {
        assert.equal(manifest.source.license, 'CC BY 4.0');
        assert.match(manifest.source.modification, /Resampled/);
        assert.match(manifest.source.attribution, /European Centre/);
        assert.match(manifest.source.disclaimer, /liability/);
      }
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a missing scalar or inconsistent forecast time leaves all output files untouched', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'earth-wind-fail-'));
  try {
    for (const options of [{ badOverlay: 'temperature' }, { badTime: true }]) {
      await assert.rejects(generateWindAssets({ outputDir: folder, now: () => NOW, proxyOptions: { models: models(options).providers } }), /Invalid or incomplete/);
      assert.deepEqual(await readdir(folder), []);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a generation coalesces duplicate range reads while preserving independent response bodies', async () => {
  let calls = 0;
  const fetchImpl = memoizeWindFetch(async () => {
    calls += 1;
    return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
  });
  const url = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com/fixture';
  const options = { headers: { Range: 'bytes=0-2' } };
  const responses = await Promise.all([fetchImpl(url, options), fetchImpl(url, options)]);
  assert.deepEqual(await Promise.all(responses.map(async (response) => [...new Uint8Array(await response.arrayBuffer())])), [[1, 2, 3], [1, 2, 3]]);
  assert.equal(calls, 1);
  assert.deepEqual([...new Uint8Array(await (await fetchImpl(url, options)).arrayBuffer())], [1, 2, 3]);
  assert.equal(calls, 1);
  await fetchImpl(url, { headers: { Range: 'bytes=3-5' } });
  assert.equal(calls, 2);
});

test('memoization respects its byte budget, rejects oversized bodies and retries failed responses', async () => {
  let calls = 0;
  const capped = memoizeWindFetch(async () => { calls += 1; return new Response(new Uint8Array([1, 2, 3])); }, { maxBytes: 2 });
  await capped('https://example.test/no-retain');
  await capped('https://example.test/no-retain');
  assert.equal(calls, 2);
  const oversized = memoizeWindFetch(async () => new Response('x', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }));
  await assert.rejects(oversized('https://example.test/large'), /byte budget/);
  let failures = 0;
  const retry = memoizeWindFetch(async () => { failures += 1; return new Response('down', { status: 503 }); });
  await assert.rejects(retry('https://example.test/down'), /503/);
  await assert.rejects(retry('https://example.test/down'), /503/);
  assert.equal(failures, 2);
});
