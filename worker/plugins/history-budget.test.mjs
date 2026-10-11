import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { readPluginPublications } from './store.js';
import { pluginBytesDigest } from '../../src/core/plugin-evidence.js';

const PLUGIN = 'ecb-press-v1', SCOPE = 'ecb-institutional-press-en-v1', BUDGET = 4096;
const START = Date.parse('2026-10-12T04:00:00.000Z'), NOW = Date.parse('2026-10-12T09:00:00.000Z');
const recorded = (n) => new Date(START + n * 1000).toISOString(), knownAt = new Date(NOW).toISOString();
const itemId = `publication:ecb:${'a'.repeat(64)}`, revision = (n) => n.toString(16).padStart(64, '0');
const originalUrl = 'https://www.ecb.europa.eu//press/pr/date/2026/html/ecb.pr261007~0000000001.en.html';

/** Synthetic historical journal, actual generated schema and actual read path.
 * No source or host requests; timings measure native SQLite/JS work only. */
async function fixture(t, captures) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  for (const migration of ['0007_source_plugins.sql', '0008_plugin_heads.sql']) sqlite.exec(await readFile(new URL(`../../drizzle/${migration}`, import.meta.url), 'utf8'));
  const artifact = { schemaVersion: 1, kind: 'publication-feed-overview', pluginId: PLUGIN, scopeId: SCOPE,
    title: 'TEST ONLY historical budget fixture', items: [], coverage: { mode: 'rolling-provider-feed', completeArchive: false, absenceMeaning: 'not-withdrawal' } };
  const artifactBytes = new TextEncoder().encode(JSON.stringify(artifact)), artifactHash = await pluginBytesDigest(artifactBytes);
  const captureInsert = sqlite.prepare('INSERT INTO earth_plugin_captures VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const revisionInsert = sqlite.prepare('INSERT INTO earth_plugin_revisions VALUES (?,?,?,?,?,?,?)');
  const membershipInsert = sqlite.prepare('INSERT INTO earth_plugin_membership VALUES (?,?,?)');
  const insertCapture = (n) => {
    const receiptId = `receipt:test-budget-${n}`, at = recorded(n), projection = { itemId, revision: revision(n), kind: 'original-publication',
      title: `TEST ONLY revision ${n}`, url: originalUrl, sourceRecordId: originalUrl, publishedAt: '2026-10-07T08:00:00.000Z', publishedPrecision: 'second' };
    captureInsert.run(receiptId, PLUGIN, SCOPE, n, at, at, 'b'.repeat(64), 'c'.repeat(64), artifactHash, 100, 100, artifactBytes.length, null, 'RSS 2.0', 1);
    revisionInsert.run(PLUGIN, itemId, revision(n), JSON.stringify(projection), projection.publishedAt, at, at);
    membershipInsert.run(receiptId, itemId, revision(n));
  };
  sqlite.exec('BEGIN'); for (let n = 1; n <= captures; n++) insertCapture(n);
  sqlite.prepare('INSERT INTO earth_plugin_heads VALUES (?,?,?,?,?,?)').run(PLUGIN, itemId, revision(captures), `receipt:test-budget-${captures}`, recorded(captures), '2026-10-07T08:00:00.000Z');
  sqlite.prepare(`INSERT INTO earth_plugin_state (plugin_id,scope_id,checked_at,next_check_at,last_successful_at,status,failure_count,current_receipt,facts_digest,fence)
    VALUES (?,?,?,?,?,'ready',0,?,?,?)`).run(PLUGIN, SCOPE, recorded(captures), knownAt, recorded(captures), `receipt:test-budget-${captures}`, 'b'.repeat(64), captures);
  sqlite.exec('COMMIT'); sqlite.exec('ANALYZE');
  const sqlActivity = [], objects = []; let afterRead;
  const db = { withSession(mode) { assert.equal(mode, 'first-primary'); return this; },
    prepare(sql) { return { bind(...values) { return { async all() {
      assert.ok(!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)/i.test(sql), 'Public reads cannot mutate the journal');
      const started = performance.now(), results = sqlite.prepare(sql).all(...values);
      sqlActivity.push({ sql, values, results, milliseconds: performance.now() - started });
      afterRead?.({ sql, values, results });
      return { success: true, results, meta: {} };
    } }; } }; },
    async batch(statements) { const results = []; sqlite.exec('BEGIN'); try { for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  const env = { EARTH_DB: db, EARTH_STORE: { async get(key) {
    objects.push(key); assert.equal(key, `plugins/${PLUGIN}/artifacts/${artifactHash}`);
    return { size: artifactBytes.length, arrayBuffer: async () => artifactBytes.buffer.slice(0) };
  }, async put() { assert.fail('Public history cannot write object storage'); } } };
  return { env, sqlite, sqlActivity, objects, now: () => NOW,
    afterRead(fn) { afterRead = fn; },
    append(until) { sqlite.exec('BEGIN'); for (let n = captures + 1; n <= until; n++) insertCapture(n);
      captures = until;
      sqlite.prepare('UPDATE earth_plugin_heads SET revision=?,receipt_id=?,recorded_at=? WHERE plugin_id=? AND item_id=?')
        .run(revision(until), `receipt:test-budget-${until}`, recorded(until), PLUGIN, itemId);
      sqlite.prepare('UPDATE earth_plugin_state SET current_receipt=?,fence=? WHERE plugin_id=?')
        .run(`receipt:test-budget-${until}`, until, PLUGIN);
      sqlite.exec('COMMIT'); },
    reset() { sqlActivity.length = 0; objects.length = 0; } };
}

test('1,200 retained memberships remain a complete known-at read under the pilot history budget', async (t) => {
  const f = await fixture(t, 1200), start = performance.now();
  const result = await readPluginPublications(f.env, PLUGIN, { knownAt, limit: 20, now: f.now });
  const elapsed = performance.now() - start;
  assert.equal(result.available, true); assert.equal(result.items.length, 1); assert.equal(result.items[0].revision, revision(1200));
  assert.equal(result.items[0].lastRecordedAt, recorded(1200)); assert.equal(result.counts.more, false);
  const rank = f.sqlActivity.find((row) => /ROW_NUMBER/i.test(row.sql)); assert.ok(rank, 'The admitted journal reconstructs its latest retained item revision');
  t.diagnostic(`1,200 memberships: ${elapsed.toFixed(2)} ms total native SQLite/JS read; ${rank.milliseconds.toFixed(2)} ms bounded ranking; ${f.sqlActivity.length} SQL reads, ${f.objects.length} artifact reads. Not browser/GPU timing.`);
});

test('history beyond 4,096 memberships fails closed before ranking and its budget probe does not count the entire growing journal', async (t) => {
  const f = await fixture(t, 5000), start = performance.now();
  const result = await readPluginPublications(f.env, PLUGIN, { knownAt, limit: 20, now: f.now });
  const elapsed = performance.now() - start;
  assert.equal(result.available, false); assert.deepEqual(result.items, []); assert.equal(result.counts.returned, 0);
  assert.equal(result.errorCode, 'historical-delivery-budget'); assert.equal(result.receipt, null); assert.equal(result.artifact, null);
  assert.match(result.explanation || '', /histor|budget|bound|limit/i);
  assert.equal(f.sqlActivity.some((row) => /ROW_NUMBER/i.test(row.sql)), false, 'Oversized public history must not execute the window query');
  const probe = f.sqlActivity.find((row) => /earth_plugin_membership/i.test(row.sql)); assert.ok(probe, 'The guard measures actual stored membership, not the small displayed list');
  assert.match(probe.sql, /LIMIT/i, 'A growing journal cannot require a full COUNT for each visitor');
  assert.ok(probe.values.includes(BUDGET + 1) || new RegExp(`LIMIT\\s+${BUDGET + 1}\\b`, 'i').test(probe.sql), 'The candidate probe stops at budget plus one');
  const observed = probe.results.flatMap((row) => Object.values(row)).find((value) => value === BUDGET + 1);
  assert.equal(observed, BUDGET + 1, 'The guard returns a capped count, not all 5,000 memberships');
  t.diagnostic(`5,000 memberships: ${elapsed.toFixed(2)} ms fail-closed native SQLite/JS read; ${probe.milliseconds.toFixed(2)} ms capped probe; ranking skipped. Not browser/GPU timing.`);
  f.reset();
  const current = await readPluginPublications(f.env, PLUGIN, { limit: 20, now: f.now });
  assert.equal(current.available, true); assert.equal(current.items[0].revision, revision(5000));
  assert.equal(f.sqlActivity.some((row) => /ROW_NUMBER|earth_plugin_membership/i.test(row.sql)), false, 'Current delivery stays on indexed heads instead of the historical journal');
});

test('a capture arriving after the budget probe cannot widen its admitted cohort, and one edition retry rechecks the new larger journal', async (t) => {
  const f = await fixture(t, 1200);
  f.afterRead(({ sql }) => { if (/COUNT\(\*\)/i.test(sql) && /earth_plugin_membership/i.test(sql)) { f.afterRead(null); f.append(5000); } });
  const result = await readPluginPublications(f.env, PLUGIN, { knownAt, limit: 20, now: f.now });
  const ranks = f.sqlActivity.filter((row) => /ROW_NUMBER/i.test(row.sql)), probes = f.sqlActivity.filter((row) => /COUNT\(\*\)/i.test(row.sql) && /earth_plugin_membership/i.test(row.sql));
  assert.equal(ranks.length, 1); assert.equal(JSON.parse(ranks[0].results[0].projection_json).revision, revision(1200), 'The first query remains bound to the receipt admitted by its 1,200-row probe');
  assert.equal(probes.length, 2); assert.equal(probes[0].results[0].count, 1200); assert.equal(probes[1].results[0].count, BUDGET + 1);
  assert.equal(result.available, false); assert.equal(result.errorCode, 'historical-delivery-budget'); assert.deepEqual(result.items, []);
  assert.equal(result.receipt, null); assert.equal(result.artifact, null);
});
