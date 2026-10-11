import { historySnapshotIdentity } from './history.js';
import { collectionCaptureSources } from './collection-check.js';

const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const deadlineMs = 2500;
const SQL = `SELECT e.value AS expected,
  h.snapshot_id AS history_id,h.record_count AS history_count,
  c.snapshot_id AS receipt_id,c.recorded_at AS receipt_at,
  s.snapshot_id AS current_id,s.captured_at AS current_at,s.recorded_at AS current_recorded_at,
  w.snapshot_id AS current_receipt_id,w.recorded_at AS current_receipt_at,
  n.collected_at AS notified_at,n.input_digest AS notified_digest,n.record_count AS notified_count,n.revision AS notified_revision
  FROM json_each(?) e
  LEFT JOIN earth_observations h ON h.source=json_extract(e.value,'$.source') AND h.at=json_extract(e.value,'$.at')
  LEFT JOIN earth_world_captures c ON c.source_id=json_extract(e.value,'$.source') AND c.captured_at=json_extract(e.value,'$.at')
  LEFT JOIN earth_world_sources s ON s.source_id=json_extract(e.value,'$.source')
  LEFT JOIN earth_world_captures w ON w.source_id=s.source_id AND w.captured_at=s.captured_at
  LEFT JOIN earth_collection_revision n ON n.id=1`;

/** One bounded primary read proves the exact prepared capture, not just table availability.
 * No immutable body reads or writes; receipt identities reuse the source snapshot schema.
 */
export async function readCollectionCompletion(env, prepared, inputDigest, { now = Date.now } = {}) {
  if (!env.EARTH_DB?.prepare || !env.EARTH_DB?.batch) return { configured: false, available: false, complete: false };
  const sources = collectionCaptureSources(prepared.payload);
  if (!sources?.length || sources.length > 4 || !iso(prepared.collectedAt)) return { configured: true, available: false, complete: false };
  const captures = await Promise.all(sources.map(async source => {
    const records = prepared.payload.indexRecords.filter(record => record.sourceId === source);
    const coordinates = source === 'usgs' ? records.filter(record => Number.isFinite(record.lat) && Number.isFinite(record.lon))
      .map(record => ({ id: record.id, lat: record.lat, lon: record.lon })) : [];
    return { source, at: prepared.collectedAt, ...await historySnapshotIdentity(source, records, coordinates) };
  }));
  let timer;
  try {
    const db = env.EARTH_DB.withSession?.('first-primary') || env.EARTH_DB;
    const result = await Promise.race([db.prepare(SQL).bind(JSON.stringify(captures)).all(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Completion read unavailable')), deadlineMs); })]);
    if (result?.success === false || !Array.isArray(result?.results) || result.results.length !== captures.length)
      return { configured: true, available: false, complete: false };
    let receiptsComplete = true, notificationComplete = true;
    const seen = new Set();
    for (const row of result.results) {
      const expected = typeof row.expected === 'string' ? JSON.parse(row.expected) : null;
      const capture = captures.find(entry => entry.source === expected?.source);
      if (!capture || seen.has(capture.source) || JSON.stringify(expected) !== JSON.stringify(capture)) throw Error('Invalid completion identity');
      seen.add(capture.source);
      for (const [value, expectedId] of [[row.history_id, capture.id], [row.receipt_id, capture.id]])
        if (value != null && value !== expectedId) throw Error('Conflicting retained receipt');
      if (row.history_id != null && row.history_count !== capture.recordCount) throw Error('Conflicting retained count');
      if (row.receipt_id != null && (!iso(row.receipt_at) || Date.parse(capture.at) > Date.parse(row.receipt_at) + 305000 ||
          Date.parse(row.receipt_at) > now() + 300000)) throw Error('Invalid receipt publication clock');
      if (row.current_at != null && (!iso(row.current_at) || row.current_at === capture.at && row.current_id !== capture.id))
        throw Error('Conflicting source watermark');
      receiptsComplete &&= Boolean(row.history_id === capture.id && row.history_count === capture.recordCount &&
        row.receipt_id === capture.id && row.current_at >= capture.at && row.current_id === row.current_receipt_id &&
        iso(row.current_recorded_at) && row.current_recorded_at === row.current_receipt_at);
      if (row.notified_at != null && (!iso(row.notified_at) || row.notified_at > prepared.collectedAt ||
          row.notified_at === prepared.collectedAt && (row.notified_digest !== inputDigest ||
            row.notified_count !== prepared.payload.indexRecords.length || row.notified_revision !== `${prepared.collectedAt}:${inputDigest}`)))
        throw Error('Conflicting collection notification');
      notificationComplete &&= Boolean(row.notified_at === prepared.collectedAt && row.notified_digest === inputDigest &&
        row.notified_count === prepared.payload.indexRecords.length && row.notified_revision === `${prepared.collectedAt}:${inputDigest}`);
    }
    return { configured: true, available: true, complete: receiptsComplete && notificationComplete,
      receiptsComplete, notificationComplete, captures };
  } catch { return { configured: true, available: false, complete: false }; }
  finally { clearTimeout(timer); }
}
