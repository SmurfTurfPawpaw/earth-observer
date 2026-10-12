import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import * as stagedSchema from '../db/archive-maintenance-schema.ts';

// Execute SQL generated IN MEMORY from the actual staged Drizzle schema. No
// generated migration file, database binding, network or production source work.
let stagedSql;
async function schemaSql() {
  stagedSql ??= (async () => generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(stagedSchema)))();
  return stagedSql;
}
export async function archiveMaintenanceFixture(t, { actualMigration = false } = {}) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  let clock = Date.parse('2026-10-12T04:00:00.000Z'), serial = Promise.resolve();
  sqlite.function('strftime', { varargs: true }, (format, value, modifier) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(value, 'now');
    if (modifier !== undefined) assert.match(modifier, /^[+-]\d+ seconds$/);
    return new Date(clock + (modifier ? Number(modifier.split(' ')[0]) * 1000 : 0)).toISOString();
  });
  for (const name of ['0000_glossy_overlord.sql', '0001_collection_revision.sql', '0002_aircraft_observations.sql', '0003_world_evidence.sql', '0004_world_archive_investigations.sql'])
    sqlite.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  if (actualMigration) sqlite.exec(await readFile(new URL('../drizzle/0009_archive_maintenance.sql', import.meta.url), 'utf8'));
  else for (const sql of await schemaSql()) sqlite.exec(sql);
  const activity = [];
  const db = { beforeBatch: null, afterStatement: null, withSession(mode) { assert.equal(mode, 'first-primary'); return this; }, prepare(sql) {
    const bind = (...values) => ({ sql, values, async all() {
      const results = sqlite.prepare(sql).all(...values), changes = sqlite.prepare('SELECT changes() AS n').get().n;
      activity.push({ sql, values, rows: results.length }); db.afterStatement?.({ sql, values, results }); return { success: true, results, meta: { changes } };
    } }); return { ...bind(), bind };
  }, batch(statements) {
    const task = serial.then(async () => { await db.beforeBatch?.(statements); sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }); serial = task.catch(() => {}); return task;
  } };
  const objects = new Map(), store = { async get(key) { const body = objects.get(key); return body === undefined ? null : {
    size: new TextEncoder().encode(body).length, text: async () => body, json: async () => JSON.parse(body) }; },
  async put(key, body) { if (!objects.has(key)) objects.set(key, String(body)); return null; } };
  const env = { EARTH_DB: db, EARTH_STORE: store };
  return { env, sqlite, activity, objects, now: () => clock, stamp: () => new Date(clock).toISOString(), setClock(value) { clock = Date.parse(value); },
    advance(ms) { clock += ms; }, state() { return sqlite.prepare('SELECT * FROM earth_archive_maintenance').get(); } };
}
