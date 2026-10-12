import { ARCHIVE_SCOPE, archivePrimary, archiveRows, archiveIO } from './world-archive.js';
import { worldTime, isWorldDigest } from '../src/core/world-model.js';
import { usgsCatalogRange } from '../server/hosted/usgs-catalog-interval.js';

export const ARCHIVE_DAY_LIMITS = Object.freeze({ days: 736, pieces: 512, dayBytes: 65536, deliveryBytes: 256 * 1024 });
export const ARCHIVE_RECEIPT_CLOCK = '$receipt';
export class ArchiveDayCoverageConflict extends Error {
  constructor() { super('Archive day coverage changed before atomic admission'); this.name = 'ArchiveDayCoverageConflict'; this.code = 'coverage-generation-conflict'; }
}
const DAY = 86400000, encoder = new TextEncoder(), iso = (value) => new Date(value).toISOString();
const readyBindings = new WeakSet(), missingBindings = new WeakMap();
const clock = (value, pending = false) => value === ARCHIVE_RECEIPT_CLOCK && pending ? value : worldTime(value);
const milliseconds = (value) => value === ARCHIVE_RECEIPT_CLOCK ? Infinity : Date.parse(value);
const dayOf = (value) => iso(Math.floor(Date.parse(value) / DAY) * DAY).slice(0, 10);
function dayBounds(day) {
  if (!/^\d{4}-\d\d-\d\d$/.test(day || '') || worldTime(`${day}T00:00:00.000Z`).slice(0, 10) !== day) throw new TypeError('Invalid UTC coverage day');
  const from = Date.parse(`${day}T00:00:00.000Z`); return { from, to: from + DAY - 1 };
}
function piecesValue(value, day, pending = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value), bounds = dayBounds(day);
  if (encoder.encode(text).byteLength > ARCHIVE_DAY_LIMITS.dayBytes) throw new RangeError('Daily coverage proof exceeds its byte budget');
  const pieces = JSON.parse(text);
  if (!Array.isArray(pieces) || !pieces.length || pieces.length > ARCHIVE_DAY_LIMITS.pieces) throw new RangeError('Daily coverage proof exceeds its piece budget');
  let previous = bounds.from - 1;
  for (const piece of pieces) {
    if (!piece || Object.keys(piece).sort().join(',') !== 'chunkId,from,knownAt,to' || !isWorldDigest(piece.chunkId)) throw new TypeError('Invalid daily coverage proof');
    const from = worldTime(piece.from), to = worldTime(piece.to), knownAt = clock(piece.knownAt, pending);
    if (from !== piece.from || to !== piece.to || knownAt !== piece.knownAt || from > to || Date.parse(from) <= previous ||
        Date.parse(from) < bounds.from || Date.parse(to) > bounds.to) throw new TypeError('Daily proof intervals overlap or leave their UTC day');
    previous = Date.parse(to);
  }
  return pieces;
}
function materialize(existing, proof, day) {
  const bounds = dayBounds(day), candidate = { from: Math.max(bounds.from, Date.parse(proof.range.from)), to: Math.min(bounds.to, Date.parse(proof.range.to)),
    knownAt: proof.publishedAt ?? ARCHIVE_RECEIPT_CLOCK, chunkId: proof.chunkId };
  const original = existing ? piecesValue(existing.first_proof_json, day) : [];
  const values = original.map((piece) => ({ ...piece, from: Date.parse(piece.from), to: Date.parse(piece.to) }));
  values.push(candidate);
  const edges = [...new Set(values.flatMap((piece) => [piece.from, piece.to + 1]))].sort((a, b) => a - b), result = [];
  for (let index = 0; index < edges.length - 1; index++) {
    const from = edges[index], to = edges[index + 1] - 1;
    const winner = values.filter((piece) => piece.from <= from && piece.to >= to).sort((a, b) => milliseconds(a.knownAt) - milliseconds(b.knownAt))[0];
    if (!winner) continue;
    const last = result.at(-1);
    if (last && Date.parse(last.to) + 1 === from && last.knownAt === winner.knownAt && last.chunkId === winner.chunkId) last.to = iso(to);
    else result.push({ from: iso(from), to: iso(to), knownAt: winner.knownAt, chunkId: winner.chunkId });
  }
  piecesValue(result, day, true);
  const firstProofAt = result.map((piece) => piece.knownAt).sort((a, b) => milliseconds(a) - milliseconds(b))[0];
  const complete = Date.parse(result[0].from) === bounds.from && Date.parse(result.at(-1).to) === bounds.to &&
    result.every((piece, index) => !index || Date.parse(result[index - 1].to) + 1 === Date.parse(piece.from));
  const completeKnownAt = complete ? result.map((piece) => piece.knownAt).sort((a, b) => milliseconds(b) - milliseconds(a))[0] : null;
  const firstProofJson = JSON.stringify(result), expectedGeneration = existing?.generation ?? 0;
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new TypeError('Invalid coverage generation');
  return { day, expectedGeneration, generation: expectedGeneration + 1, firstProofAt, completeKnownAt, firstProofJson,
    rangeFrom: result[0].from, rangeTo: result.at(-1).to, changed: firstProofJson !== existing?.first_proof_json };
}
/** Preserve the CLOSED millisecond source/publisher interval, including a lone
 * midnight endpoint in the next day. First-proof times come only from receipts.
 * Null publishedAt is a transaction plan; SQL resolves $receipt from that receipt. */
export function projectArchiveCoverageDays(existingDays, receipt) {
  const range = usgsCatalogRange(receipt?.range);
  if (receipt?.scopeId !== ARCHIVE_SCOPE.id || receipt.kind !== 'interval' || !isWorldDigest(receipt.chunkId) ||
      !Number.isInteger(receipt.expectedCount) || receipt.expectedCount < 0 || receipt.expectedCount > 500 ||
      receipt.recordCount !== receipt.expectedCount || receipt.publishedAt != null && clock(receipt.publishedAt) !== receipt.publishedAt)
    throw new TypeError('Only exact count-matched interval receipts establish daily coverage');
  if (!Array.isArray(existingDays) || existingDays.length > 33 || new Set(existingDays.map((row) => row.day)).size !== existingDays.length)
    throw new TypeError('Use the bounded affected daily coverage rows');
  const existing = new Map(existingDays.map((row) => [row.day, row])), result = [];
  for (let cursor = Math.floor(Date.parse(range.from) / DAY) * DAY; cursor <= Date.parse(range.to); cursor += DAY) {
    const day = iso(cursor).slice(0, 10);
    if (existing.get(day)?.scope_id && existing.get(day).scope_id !== ARCHIVE_SCOPE.id) throw new TypeError('Foreign daily coverage scope');
    result.push(materialize(existing.get(day), { ...receipt, range }, day));
  }
  return result.filter((row) => row.changed);
}
export async function prepareArchiveDayCoverage(env, receipt) {
  const range = usgsCatalogRange(receipt?.range); env = archivePrimary(env);
  const existing = await archiveRows(env.EARTH_DB, `SELECT * FROM earth_archive_coverage_days WHERE scope_id=? AND day>=? AND day<=? ORDER BY day LIMIT 34`,
    [ARCHIVE_SCOPE.id, dayOf(range.from), dayOf(range.to)]);
  return projectArchiveCoverageDays(existing, receipt);
}
/** Include this predicate in the one initial atomic publisher admission. Later
 * day writes depend on that admitted receipt and never re-check wall-clock expiry. */
export function archiveDayGenerationGate(updates) {
  const expected = updates.map(({ day, expectedGeneration }) => ({ day, generation: expectedGeneration }));
  if (expected.length > 33) throw new RangeError('Too many affected coverage days');
  return { sql: `NOT EXISTS(SELECT 1 FROM json_each(?) wanted LEFT JOIN earth_archive_coverage_days d
    ON d.scope_id=? AND d.day=json_extract(wanted.value,'$.day')
    WHERE COALESCE(d.generation,0)<>json_extract(wanted.value,'$.generation'))`, values: [JSON.stringify(expected), ARCHIVE_SCOPE.id] };
}
export function archiveDayCompletionStatements(db, updates, { chunkId, admittedSql, admittedValues = [] } = {}) {
  if (!isWorldDigest(chunkId) || typeof admittedSql !== 'string' || !admittedSql) throw new TypeError('Require an internal atomic admission predicate');
  if (!updates.length) return [];
  const payload = JSON.stringify(updates);
  if (encoder.encode(payload).length > 256 * 1024) throw new RangeError('Daily coverage SQL exceeds its byte budget');
  return [db.prepare(`INSERT INTO earth_archive_coverage_days
    (scope_id,day,generation,first_proof_at,complete_known_at,first_proof_json,range_from,range_to)
    SELECT c.scope_id,json_extract(u.value,'$.day'),json_extract(u.value,'$.generation'),
      CASE WHEN json_extract(u.value,'$.firstProofAt')='$receipt' THEN c.published_at ELSE json_extract(u.value,'$.firstProofAt') END,
      CASE WHEN json_extract(u.value,'$.completeKnownAt')='$receipt' THEN c.published_at ELSE json_extract(u.value,'$.completeKnownAt') END,
      replace(json_extract(u.value,'$.firstProofJson'),json_quote('$receipt'),json_quote(c.published_at)),
      json_extract(u.value,'$.rangeFrom'),json_extract(u.value,'$.rangeTo')
    FROM json_each(?) u JOIN earth_archive_chunks c ON c.scope_id=? AND c.chunk_id=? WHERE ${admittedSql}
    ON CONFLICT(scope_id,day) DO UPDATE SET generation=excluded.generation,first_proof_at=excluded.first_proof_at,
      complete_known_at=excluded.complete_known_at,first_proof_json=excluded.first_proof_json,range_from=excluded.range_from,range_to=excluded.range_to
    WHERE earth_archive_coverage_days.generation=excluded.generation-1`).bind(payload, ARCHIVE_SCOPE.id, chunkId, ...admittedValues)];
}

export async function ensureArchiveDaySchema(env, { force = false } = {}) {
  try {
    if (!env?.EARTH_DB?.prepare || !env.EARTH_DB.batch) return false;
    const db = env.EARTH_DB;
    if (readyBindings.has(db)) return true;
    if (!force && performance.now() - (missingBindings.get(db) ?? -Infinity) < 5000) return false;
    const value = await archiveIO(() => db.batch([db.prepare(`SELECT d.scope_id,d.day,d.generation,d.first_proof_at,d.complete_known_at,
      d.first_proof_json,d.range_from,d.range_to,s.materialized_order,s.status,s.checked_at,s.fence,s.lease_token,s.lease_until,s.admission_token,s.admitted_chunk_id
      FROM earth_archive_coverage_days d LEFT JOIN earth_archive_day_state s ON 0 LIMIT 0`)]));
    if (Array.isArray(value) && value.length === 1 && value[0]?.success !== false && Array.isArray(value[0]?.results)) { readyBindings.add(db); return true; }
    missingBindings.set(db, performance.now()); return false;
  } catch { if (env?.EARTH_DB) missingBindings.set(env.EARTH_DB, performance.now()); return false; }
}
export async function archiveDayReadiness(env, currentOrder) {
  if (!await ensureArchiveDaySchema(env)) return { ready: false, status: 'migration-required' };
  const state = (await archiveRows(env.EARTH_DB, 'SELECT materialized_order,status FROM earth_archive_day_state WHERE scope_id=?', [ARCHIVE_SCOPE.id]))[0];
  return { ready: state?.status === 'ready' && state.materialized_order === currentOrder,
    status: !state ? 'bootstrap-required' : state.status === 'ready' && state.materialized_order === currentOrder ? 'ready' : 'bootstrap-pending',
    materializedOrder: state?.materialized_order ?? 0 };
}
/** New atomic publications may advance an already-complete day edition only from
 * their exact scope predecessor. They cannot leap over unfinished bootstrap. */
export function archiveDayAdvanceStatement(db, { chunkId, admittedSql = '1', admittedValues = [] } = {}) {
  return db.prepare(`UPDATE earth_archive_day_state SET materialized_order=(SELECT id FROM earth_archive_chunks WHERE scope_id=? AND chunk_id=?),
    checked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE scope_id=? AND status='ready' AND ${admittedSql}
    AND materialized_order=COALESCE((SELECT MAX(id) FROM earth_archive_chunks WHERE scope_id=? AND id<(SELECT id FROM earth_archive_chunks WHERE scope_id=? AND chunk_id=?)),0)`)
    .bind(ARCHIVE_SCOPE.id, chunkId, ARCHIVE_SCOPE.id, ...admittedValues, ARCHIVE_SCOPE.id, ARCHIVE_SCOPE.id, chunkId);
}

/** A manual owner writer needs the same one-time generation gate even if another
 * writer has already published its identical receipt. The marker is transaction
 * local in effect: set, consume for every write, then clear in the SAME batch. */
export function prepareManualArchiveDayAdmission(db, updates, chunkId) {
  const gate = archiveDayGenerationGate(updates), token = crypto.randomUUID();
  const admissionStatement = db.prepare(`INSERT INTO earth_archive_day_state(scope_id,materialized_order,status,fence,admission_token,admitted_chunk_id)
    SELECT ?,0,'pending',0,?,? WHERE ${gate.sql} ON CONFLICT(scope_id) DO UPDATE SET
      admission_token=excluded.admission_token,admitted_chunk_id=excluded.admitted_chunk_id WHERE ${gate.sql}`)
    .bind(ARCHIVE_SCOPE.id, token, chunkId, ...gate.values, ...gate.values);
  const admittedSql = `EXISTS(SELECT 1 FROM earth_archive_day_state s WHERE s.scope_id=? AND s.admission_token=? AND s.admitted_chunk_id=?)`;
  const admittedValues = [ARCHIVE_SCOPE.id, token, chunkId];
  const completionStatement = db.prepare(`UPDATE earth_archive_day_state SET admission_token=NULL,admitted_chunk_id=NULL
    WHERE scope_id=? AND ${admittedSql}`).bind(ARCHIVE_SCOPE.id, ...admittedValues);
  return { admissionStatement, admittedSql, admittedValues, completionStatement };
}
function union(values) {
  const result = [];
  for (const piece of [...values].sort((a, b) => a.from.localeCompare(b.from))) {
    const last = result.at(-1);
    if (last && Date.parse(piece.from) <= Date.parse(last.to) + 1) { if (piece.to > last.to) last.to = piece.to; }
    else result.push({ from: piece.from, to: piece.to });
  }
  return result;
}
function complement(range, selected, available) {
  if (!range) return [];
  const edges = new Set([Date.parse(range.from), Date.parse(range.to) + 1]);
  for (const piece of [...selected, ...available]) for (const point of [Date.parse(piece.from), Date.parse(piece.to) + 1])
    if (point > Date.parse(range.from) && point <= Date.parse(range.to)) edges.add(point);
  const sorted = [...edges].sort((a, b) => a - b), gaps = [];
  for (let index = 0; index < sorted.length - 1; index++) {
    const from = sorted[index], to = sorted[index + 1] - 1;
    if (selected.some((piece) => Date.parse(piece.from) <= from && Date.parse(piece.to) >= to)) continue;
    const status = available.some((piece) => Date.parse(piece.from) <= from && Date.parse(piece.to) >= to) ? 'unavailable-at-cutoff' : 'not-imported';
    const last = gaps.at(-1);
    if (last?.status === status && Date.parse(last.to) + 1 === from) last.to = iso(to);
    else gaps.push({ from: iso(from), to: iso(to), status });
  }
  return gaps;
}
/** Stored-only delivery: compact complete days, first-proof JSON only for partial
 * days or a cutoff before completion. Guard bytes BEFORE loading those arrays. */
export async function readArchiveDayCoverage(env, { range, knownAt = null } = {}) {
  if (knownAt !== null && worldTime(knownAt) !== knownAt) throw new TypeError('Use a canonical coverage knowledge cutoff');
  if (range) { range = { from: worldTime(range.from), to: worldTime(range.to) }; if (range.from > range.to) throw new TypeError('Invalid delivery range'); }
  env = archivePrimary(env); const db = env?.EARTH_DB;
  if (!db?.prepare) return { configured: false, available: false, complete: false, segments: [], gaps: [], errorCode: 'coverage-store-unavailable' };
  const bounds = (await archiveRows(db, `SELECT MIN(range_from) AS range_from,MAX(range_to) AS range_to FROM earth_archive_coverage_days WHERE scope_id=?`, [ARCHIVE_SCOPE.id]))[0];
  const availableRange = bounds?.range_from ? { from: bounds.range_from, to: bounds.range_to } : null, target = range || availableRange;
  if (!target) return { configured: true, available: true, availableRange: null, requestedRange: null, complete: false, segments: [], gaps: [], status: 'not-imported', deliveryBytes: 0 };
  const summaries = await archiveRows(db, `SELECT day,generation,first_proof_at,complete_known_at,range_from,range_to,
    CASE WHEN complete_known_at IS NOT NULL AND (? IS NULL OR complete_known_at<=? OR first_proof_at>?) THEN 0 ELSE length(CAST(first_proof_json AS BLOB)) END AS proof_bytes
    FROM earth_archive_coverage_days WHERE scope_id=? AND day>=? AND day<=? ORDER BY day LIMIT ?`,
  [knownAt, knownAt, knownAt, ARCHIVE_SCOPE.id, dayOf(target.from), dayOf(target.to), ARCHIVE_DAY_LIMITS.days + 1]);
  const budgetFailure = (errorCode) => ({ configured: true, available: false, availableRange, requestedRange: target, complete: false,
    segments: [], gaps: [{ ...target, status: 'not-evaluated' }], status: 'delivery-budget', truncated: true, errorCode,
    explanation: 'Daily coverage exceeds its bounded delivery budget; no complete coverage is asserted.' });
  if (summaries.length > ARCHIVE_DAY_LIMITS.days) return budgetFailure('coverage-day-budget');
  const summaryBytes = encoder.encode(JSON.stringify(summaries)).length, proofBytes = summaries.reduce((total, row) => total + row.proof_bytes, 0);
  if (summaryBytes + proofBytes > ARCHIVE_DAY_LIMITS.deliveryBytes) return budgetFailure('coverage-byte-budget');
  const wanted = summaries.filter((row) => row.proof_bytes).map((row) => ({ day: row.day, generation: row.generation, bytes: row.proof_bytes }));
  const loaded = wanted.length ? await archiveRows(db, `SELECT d.day,d.first_proof_json FROM json_each(?) w JOIN earth_archive_coverage_days d
    ON d.scope_id=? AND d.day=json_extract(w.value,'$.day') AND d.generation=json_extract(w.value,'$.generation')
    WHERE length(CAST(d.first_proof_json AS BLOB))=json_extract(w.value,'$.bytes')`, [JSON.stringify(wanted), ARCHIVE_SCOPE.id]) : [];
  if (loaded.length !== wanted.length) return budgetFailure('coverage-generation-changed');
  const arrays = new Map(loaded.map((row) => [row.day, piecesValue(row.first_proof_json, row.day)])), all = [], selected = [];
  for (const row of summaries) {
    if (row.complete_known_at) {
      const bounds = dayBounds(row.day); all.push({ from: iso(bounds.from), to: iso(bounds.to) });
      if (!knownAt || row.complete_known_at <= knownAt) selected.push({ from: iso(bounds.from), to: iso(bounds.to) });
      else if (row.first_proof_at <= knownAt) selected.push(...(arrays.get(row.day) || []).filter((piece) => piece.knownAt <= knownAt));
    } else {
      const pieces = arrays.get(row.day) || []; all.push(...pieces);
      selected.push(...pieces.filter((piece) => !knownAt || piece.knownAt <= knownAt));
    }
  }
  const allSegments = union(all), segments = union(selected), gaps = complement(target, segments, allSegments);
  return { configured: true, available: true, availableRange, requestedRange: target, segments, gaps, complete: !gaps.length,
    status: !gaps.length ? 'complete' : gaps.every((gap) => gap.status === 'unavailable-at-cutoff') ? 'unavailable-at-cutoff' : 'partial',
    truncated: false, deliveryBytes: summaryBytes + proofBytes, dayRows: summaries.length,
    meaning: 'Count-matched catalog response coverage at acquisition, not final coverage of every physical earthquake.' };
}
