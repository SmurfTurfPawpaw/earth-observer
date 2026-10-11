import { worldTime, worldHash, isWorldDigest, createWorldSourceItem, provisionalWorldEvent } from '../src/core/world-model.js';
import { ARCHIVE_SCOPE, ARCHIVE_LIMITS, archivePrimary, ensureArchiveSchema, archiveRows, archiveJson,
  loadArchiveSnapshot, loadArchiveRaw } from './world-archive.js';

const WEEK = 7 * 86400000;
const json = (value,status=200) => Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const iso = (value) => new Date(value).toISOString();
const unavailable = () => ({schemaVersion:1,configured:false,available:false,events:[],reason:'The scoped archive or its migration is unavailable'});
function options(value, now) {
  if (value.scope !== undefined && value.scope !== ARCHIVE_SCOPE.id || value.window !== undefined && value.window !== '7d' ||
      value.knownMode !== undefined && !['none','fixed','scene'].includes(value.knownMode)) throw new TypeError('Invalid scene scope or lens');
  const metadata = value.metadata === true, at = value.at === undefined && metadata ? null : worldTime(value.at);
  const mode = value.knownMode || (value.knownAt === undefined ? 'none' : 'fixed');
  if (mode === 'scene' && !at || mode === 'none' && value.knownAt !== undefined || mode === 'fixed' && value.knownAt === undefined)
    throw new TypeError('Invalid scene knowledge mode');
  const knownAt = mode === 'scene' ? at : mode === 'fixed' ? worldTime(value.knownAt) : null;
  if (mode === 'scene' && value.knownAt !== undefined && worldTime(value.knownAt) !== at ||
      knownAt && Date.parse(knownAt)>now()+300000 || at && Date.parse(at)>now()+300000) throw new TypeError('Invalid future scene cutoff');
  const points=value.points===true;
  if(value.points!==undefined&&typeof value.points!=='boolean'||value.span!==undefined&&value.span!=='7d'||
      points&&(metadata||mode!=='none'||value.span!=='7d'||value.id!==undefined||Date.parse(at)>now())||!points&&value.span!==undefined||
      value.revision!==undefined&&(!value.id||!isWorldDigest(value.revision)))throw new TypeError('Invalid buffered reconstruction or detail revision');
  const limit = value.limit ?? 100;
  if (!Number.isInteger(limit) || limit<1 || limit>100 || value.id !== undefined && !/^event:usgs:[a-f0-9]{64}$/.test(value.id)) throw new TypeError('Invalid bounded scene selection');
  let bbox = null;
  if (value.bbox !== undefined) {
    if (typeof value.bbox !== 'string' || value.bbox.length>100) throw new TypeError('Invalid scene bounds');
    const numbers = value.bbox.split(',').map(Number);
    if (numbers.length!==4 || value.bbox.split(',').some((part)=>!part.trim()) || numbers.some((n)=>!Number.isFinite(n)) ||
        Math.abs(numbers[0])>180 || Math.abs(numbers[2])>180 || Math.abs(numbers[1])>90 || Math.abs(numbers[3])>90 || numbers[1]>numbers[3])
      throw new TypeError('Invalid scene bounds');
    bbox=numbers;
  }
  return {at,knownAt,knownMode:mode,mode:mode==='none'?'reconstruction':'as-known',scope:ARCHIVE_SCOPE.id,window:'7d',metadata,limit,bbox,
    id:value.id,cursor:value.cursor,points,span:points?'7d':null,nowMs:now(),revision:value.revision};
}
async function scopeState(db, query) {
  return (await archiveRows(db, `SELECT MAX(id) AS current_version,
    MAX(CASE WHEN ? IS NULL OR published_at<=? THEN id END) AS selected_version,
    MAX(CASE WHEN ? IS NULL OR published_at<=? THEN published_at END) AS previous_publication_at,
    MIN(CASE WHEN published_at>? THEN published_at END) AS next_publication_at,
    MIN(published_at) AS first_publication_at FROM earth_archive_chunks WHERE scope_id=?`,
  [query.knownAt,query.knownAt,query.knownAt,query.knownAt,query.knownAt,ARCHIVE_SCOPE.id]))[0];
}
function unionSegments(rows) {
  const result=[];
  for (const row of rows) {
    const from=worldTime(row.range_from),to=worldTime(row.range_to),last=result.at(-1);
    if (from>to) throw new Error('Invalid retained archive coverage');
    if (last && Date.parse(from)<=Date.parse(last.to)+1) { if (to>last.to) last.to=to; }
    else result.push({from,to});
  }
  return result;
}
async function coverage(db, query, state) {
  const bounds=(await archiveRows(db,`SELECT MIN(v.range_from) AS range_from,MAX(v.range_to) AS range_to
    FROM earth_archive_coverage v JOIN earth_archive_chunks c ON c.scope_id=v.scope_id AND c.chunk_id=v.chunk_id WHERE v.scope_id=?`,[ARCHIVE_SCOPE.id]))[0];
  const rows=await archiveRows(db,`SELECT v.range_from,v.range_to,c.published_at FROM earth_archive_coverage v
    JOIN earth_archive_chunks c ON c.scope_id=v.scope_id AND c.chunk_id=v.chunk_id
    WHERE v.scope_id=? ORDER BY v.range_from,v.range_to LIMIT ?`,
  [ARCHIVE_SCOPE.id,ARCHIVE_LIMITS.coverageSegments+1]);
  const truncated=rows.length>ARCHIVE_LIMITS.coverageSegments,bounded=rows.slice(0,ARCHIVE_LIMITS.coverageSegments);
  const allSegments=unionSegments(bounded),segments=unionSegments(bounded.filter((row)=>!query.knownAt||row.published_at<=query.knownAt));
  const availableRange=bounds.range_from===null?null:{from:worldTime(bounds.range_from),to:worldTime(bounds.range_to)};
  const bufferEnd=query.points?Math.min(Date.parse(query.at)+WEEK,query.nowMs,availableRange?Date.parse(availableRange.to):Date.parse(query.at),
    query.requestedBufferTo?Date.parse(query.requestedBufferTo):Infinity):null;
  query.bufferTo=query.points&&bufferEnd>Date.parse(query.at)?iso(bufferEnd):null;
  const target=query.at?{from:iso(Date.parse(query.at)-WEEK+1),to:query.bufferTo||query.at}:availableRange;
  const gaps=[];
  const addGap=(from,to)=>{
    if(truncated){gaps.push({from:iso(from),to:iso(to),status:'not-evaluated'});return;}
    let next=from;
    for(const retained of allSegments){
      const start=Math.max(next,Date.parse(retained.from)),end=Math.min(to,Date.parse(retained.to));
      if(end<next||start>to)continue;
      if(start>next)gaps.push({from:iso(next),to:iso(start-1),status:'not-imported'});
      gaps.push({from:iso(start),to:iso(end),status:query.knownAt?'unavailable-at-cutoff':'not-imported'});next=end+1;
    }
    if(next<=to)gaps.push({from:iso(next),to:iso(to),status:'not-imported'});
  };
  if(target) {
    let next=Date.parse(target.from),last=Date.parse(target.to);
    for (const segment of segments) {
      const from=Math.max(next,Date.parse(segment.from)),to=Math.min(last,Date.parse(segment.to));
      if(to<next || from>last) continue;
      if(from>next) addGap(next,from-1);
      next=Math.max(next,to+1);
    }
    if(next<=last) addGap(next,last);
  }
  const complete=Boolean(target)&&!gaps.length&&!truncated;
  const unavailableAtCutoff=gaps.length>0&&gaps.every((gap)=>gap.status==='unavailable-at-cutoff');
  return {availableRange,requestedRange:target,segments,gaps,complete,truncated,status:complete?'complete':unavailableAtCutoff?'unavailable-at-cutoff':
      truncated||segments.length||gaps.some((gap)=>gap.status==='unavailable-at-cutoff')?'partial':'not-imported',
    pending:[],failed:[],meaning:'Completed count-matched catalog origin intervals; not proof that every earthquake was detected. Import jobs are not yet tracked here.'};
}

// Time-indexed candidates come first; provider revision selection happens BEFORE
// the final origin, magnitude and geography filters. An older pin cannot survive
// merely because a correction moved its selected facts outside the candidate area.
async function candidates(db,query,from,to,id) {
  const item=id?`item:${id.slice('event:usgs:'.length)}`:null;
  if(query.knownMode==='none') return archiveRows(db,`SELECT h.*,c.published_at,c.snapshot_id,c.raw_sha256,c.captured_at FROM earth_archive_heads h
    JOIN earth_archive_chunks c ON c.scope_id=h.scope_id AND c.chunk_id=h.chunk_id
    WHERE h.scope_id=? AND ${item?'h.item_id=?':'h.event_at>? AND h.event_at<=?'} ORDER BY h.item_id LIMIT ?`,
  item?[ARCHIVE_SCOPE.id,item,ARCHIVE_LIMITS.sceneCandidates+1]:[ARCHIVE_SCOPE.id,from,to,ARCHIVE_LIMITS.sceneCandidates+1]);
  return archiveRows(db,`WITH candidates AS (SELECT DISTINCT m.item_id FROM earth_archive_membership m
    JOIN earth_archive_chunks c ON c.scope_id=m.scope_id AND c.chunk_id=m.chunk_id
    WHERE m.scope_id=? AND ${item?'m.item_id=?':'m.event_at>? AND m.event_at<=?'} AND c.published_at<=?
    ORDER BY m.item_id LIMIT ?)
    SELECT m.*,c.published_at,c.id AS publication_order,c.snapshot_id,c.raw_sha256,c.captured_at
    FROM candidates k JOIN earth_archive_membership m ON m.scope_id=? AND m.item_id=k.item_id
    JOIN earth_archive_chunks c ON c.scope_id=m.scope_id AND c.chunk_id=m.chunk_id
    WHERE c.published_at<=? AND NOT EXISTS(SELECT 1 FROM earth_archive_membership b
      JOIN earth_archive_chunks bc ON bc.scope_id=b.scope_id AND bc.chunk_id=b.chunk_id
      WHERE b.scope_id=m.scope_id AND b.item_id=m.item_id AND bc.published_at<=? AND
      ((b.source_updated_at IS NOT NULL AND (m.source_updated_at IS NULL OR b.source_updated_at>m.source_updated_at)) OR
        (b.source_updated_at IS m.source_updated_at AND bc.id<c.id))) ORDER BY m.item_id`,
  [ARCHIVE_SCOPE.id,...(item?[item]:[from,to]),query.knownAt,ARCHIVE_LIMITS.sceneCandidates+1,ARCHIVE_SCOPE.id,query.knownAt,query.knownAt]);
}
const inBounds=(row,bbox)=>!bbox || row.lat>=bbox[1]&&row.lat<=bbox[3]&&(bbox[0]<=bbox[2]?row.lon>=bbox[0]&&row.lon<=bbox[2]:row.lon>=bbox[0]||row.lon<=bbox[2]);
function interval(rows,query,state,truncated) {
  if(truncated || !query.at) return {validFrom:null,validTo:null,nextSceneChangeAt:null};
  const at=Date.parse(query.at),horizon=ARCHIVE_LIMITS.horizonMs;
  let from=at-horizon,to=at+horizon;
  for(const row of rows) {
    if(row.magnitude<ARCHIVE_SCOPE.minimumMagnitude || !inBounds(row,query.bbox)) continue;
    const origin=Date.parse(worldTime(row.event_at));
    for(const boundary of [origin,origin+WEEK]) {
      if(boundary<=at) from=Math.max(from,boundary);
      else to=Math.min(to,boundary);
    }
  }
  if(query.knownMode==='scene') {
    if(state.previous_publication_at) from=Math.max(from,Date.parse(worldTime(state.previous_publication_at)));
    if(state.next_publication_at) to=Math.min(to,Date.parse(worldTime(state.next_publication_at)));
  }
  return {validFrom:iso(from),validTo:iso(to),nextSceneChangeAt:iso(to),intervalProof:'Selected retained revisions within a bounded one-day horizon; membership is (at-7d,at] and reuse is [validFrom,validTo).'};
}
function cursorEncode(value) { return btoa(JSON.stringify(value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function cursorDecode(text) {
  if(typeof text!=='string'||text.length>2048||!/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError('Invalid scene cursor');
  try { return JSON.parse(atob(text.replace(/-/g,'+').replace(/_/g,'/'))); } catch { throw new TypeError('Invalid scene cursor'); }
}
async function projectionEvents(env,rows,query,detail) {
  if(!rows.length) return [];
  const records=await archiveRows(env.EARTH_DB,`SELECT r.*,
    (SELECT COUNT(DISTINCT b.revision) FROM earth_archive_membership b JOIN earth_archive_chunks bc ON bc.scope_id=b.scope_id AND bc.chunk_id=b.chunk_id
      WHERE b.scope_id=? AND b.item_id=r.item_id AND b.source_updated_at IS json_extract(i.value,'$.sourceUpdatedAt')
        AND (? IS NULL OR bc.published_at<=?)) AS conflict_count
    FROM json_each(?) i JOIN earth_world_revisions r ON r.item_id=json_extract(i.value,'$.itemId') AND r.revision=json_extract(i.value,'$.revision')`,
  [ARCHIVE_SCOPE.id,query.knownAt,query.knownAt,archiveJson(rows.map((row)=>({itemId:row.item_id,revision:row.revision,sourceUpdatedAt:row.source_updated_at})))]);
  const retained=new Map(records.map((row)=>[`${row.item_id}/${row.revision}`,row])),events=[];
  for(const row of rows) {
    const record=retained.get(`${row.item_id}/${row.revision}`);
    let event; try { event=JSON.parse(record?.projection_json); } catch { throw new Error('Invalid retained archive projection'); }
    if(!record || record.source_id!=='usgs' || !isWorldDigest(record.snapshot_id) || !event || event.id!==row.event_id || event.id!==`event:usgs:${row.item_id.slice(5)}` ||
      event.evidence?.itemId!==row.item_id || event.evidence.revision!==row.revision || event.evidence.snapshotId!==record.snapshot_id ||
      event.evidence.sourceId!=='usgs' || event.evidence.sourceRecordId!==record.source_record_id || event.source?.id!=='usgs' ||
      !/^https:\/\/earthquake\.usgs\.gov\//.test(event.source.url) || event.place?.lat!==row.lat || event.place?.lon!==row.lon ||
      event.eventTime?.at!==row.event_at || event.reportedFacts?.magnitude!==row.magnitude || event.sourceTimes?.updatedAt!==row.source_updated_at ||
      event.knowledge?.firstCapturedAt!==record.first_captured_at || event.knowledge.firstRecordedAt!==record.first_recorded_at ||
      worldTime(record.first_recorded_at)>worldTime(row.published_at)) throw new Error('Archive projection disagrees with committed evidence');
    if(detail) {
      const scopeBody=await loadArchiveSnapshot(env,row.snapshot_id),originalBody=row.snapshot_id===record.snapshot_id?scopeBody:await loadArchiveSnapshot(env,record.snapshot_id);
      const sourceRecord=originalBody.records.find((value)=>value.id===record.source_record_id);
      const selectedRecord=scopeBody.records.find((value)=>value.id===record.source_record_id);
      if(!sourceRecord || !selectedRecord) throw new Error('Referenced archive evidence lacks the selected event');
      const original=await createWorldSourceItem(sourceRecord,{snapshotId:record.snapshot_id,capturedAt:record.first_captured_at,recordedAt:record.first_recorded_at});
      const selected=await createWorldSourceItem(selectedRecord,{snapshotId:row.snapshot_id,capturedAt:row.captured_at,recordedAt:row.published_at});
      if(original.revision!==row.revision || selected.revision!==row.revision || await worldHash(provisionalWorldEvent(original))!==await worldHash(event))
        throw new Error('Referenced archive evidence disagrees with its projection');
      await loadArchiveRaw(env,row.raw_sha256);
    }
    event.archive={scopeId:ARCHIVE_SCOPE.id,chunkId:row.chunk_id,publishedAt:row.published_at,capturedAt:row.captured_at,
      sourceUpdatedAt:row.source_updated_at,selectionPolicy:ARCHIVE_SCOPE.selectionPolicy,conflictCount:Math.max(0,record.conflict_count-1)};
    if(detail&&event.archive.conflictCount) {
      const conflicts=await archiveRows(env.EARTH_DB,`WITH first_publication AS (SELECT b.revision,MIN(bc.id) AS publication_order
        FROM earth_archive_membership b
        JOIN earth_archive_chunks bc ON bc.scope_id=b.scope_id AND bc.chunk_id=b.chunk_id
        WHERE b.scope_id=? AND b.item_id=? AND b.source_updated_at IS ? AND b.revision<>?
          AND (? IS NULL OR bc.published_at<=?) GROUP BY b.revision ORDER BY publication_order LIMIT 20)
        SELECT f.revision,f.publication_order,c.chunk_id,c.published_at,c.snapshot_id FROM first_publication f
          JOIN earth_archive_chunks c ON c.id=f.publication_order ORDER BY f.publication_order`,
      [ARCHIVE_SCOPE.id,row.item_id,row.source_updated_at,row.revision,query.knownAt,query.knownAt]);
      event.archive.conflicts=conflicts.map((conflict)=>({itemId:row.item_id,revision:conflict.revision,chunkId:conflict.chunk_id,
        publishedAt:conflict.published_at,snapshotId:conflict.snapshot_id,meaning:'A different retained factual revision with the same provider update time; not independent corroboration.'}));
      event.archive.conflictsOmitted=Math.max(0,event.archive.conflictCount-conflicts.length);
    }
    events.push(event);
  }
  return events;
}

async function scenePoints(env,rows) {
  if(!rows.length)return [];
  const records=await archiveRows(env.EARTH_DB,`SELECT r.item_id,r.revision,r.source_id,r.source_record_id,r.snapshot_id,r.event_id,r.event_at,
    json_extract(r.projection_json,'$.title') AS title,json_extract(r.projection_json,'$.source.url') AS url,
    json_extract(r.projection_json,'$.place.lat') AS lat,json_extract(r.projection_json,'$.place.lon') AS lon,
    json_extract(r.projection_json,'$.reportedFacts.magnitude') AS magnitude
    FROM json_each(?) i JOIN earth_world_revisions r ON r.item_id=json_extract(i.value,'$.itemId') AND r.revision=json_extract(i.value,'$.revision')`,
  [archiveJson(rows.map((row)=>({itemId:row.item_id,revision:row.revision})))]);
  const retained=new Map(records.map((row)=>[`${row.item_id}/${row.revision}`,row]));
  return rows.map((row)=>{
    const record=retained.get(`${row.item_id}/${row.revision}`);
    if(!record||record.source_id!=='usgs'||record.event_id!==row.event_id||record.event_at!==row.event_at||record.lat!==row.lat||record.lon!==row.lon||
      record.magnitude!==row.magnitude||!isWorldDigest(record.snapshot_id)||typeof record.title!=='string'||record.title.length>300||
      typeof record.url!=='string'||record.url.length>2048||!/^https:\/\/earthquake\.usgs\.gov\//.test(record.url))throw new Error('Buffered point disagrees with committed evidence');
    return {id:row.event_id,sourceId:'usgs',sourceRecordId:record.source_record_id,itemId:row.item_id,revision:row.revision,snapshotId:record.snapshot_id,
      lat:row.lat,lon:row.lon,magnitude:row.magnitude,originAt:row.event_at,title:record.title,url:record.url};
  });
}

export async function readWorldScene(env,value={}, {now=Date.now}={}) {
  const query=options(value,now); env=archivePrimary(env);
  if(query.points&&query.cursor!==undefined){const cursor=cursorDecode(query.cursor);
    if(cursor.bufferTo!==null)query.requestedBufferTo=worldTime(cursor.bufferTo);}
  if(!await ensureArchiveSchema(env)) return unavailable();
  const state=await scopeState(env.EARTH_DB,query),version=`archive:${state.selected_version||0}`;
  const availableCoverage=await coverage(env.EARTH_DB,query,state);
  const base={schemaVersion:1,configured:true,available:true,mode:query.mode,scope:ARCHIVE_SCOPE,at:query.at,window:query.window,
    knownAt:query.knownAt,knownMode:query.knownMode,version,currentVersion:`archive:${state.current_version||0}`,coverage:availableCoverage,
    note:'Stored scientific reconstruction and hosted-knowledge replay differ. Missing catalog records are not deletion; equal-date source conflicts remain traceable.'};
  if(query.metadata) return {...base,events:[],counts:{returned:0,eligible:null,omitted:null},complete:availableCoverage.complete,truncated:availableCoverage.truncated,cursor:null,
    validFrom:null,validTo:null,nextSceneChangeAt:null};
  const at=Date.parse(query.at),selectedTo=query.bufferTo||query.at;
  const rows=await candidates(env.EARTH_DB,query,iso(at-WEEK-(query.points?0:ARCHIVE_LIMITS.horizonMs)),
    query.points?selectedTo:iso(at+ARCHIVE_LIMITS.horizonMs),query.id);
  const truncated=rows.length>ARCHIVE_LIMITS.sceneCandidates,bounded=rows.slice(0,ARCHIVE_LIMITS.sceneCandidates);
  const selected=bounded.filter((row)=>row.event_at>iso(at-WEEK)&&row.event_at<=selectedTo&&row.magnitude>=ARCHIVE_SCOPE.minimumMagnitude&&inBounds(row,query.bbox))
    .sort((a,b)=>a.event_at.localeCompare(b.event_at)||a.item_id.localeCompare(b.item_id));
  const queryId=await worldHash({scope:query.scope,at:query.at,window:query.window,knownAt:query.knownAt,knownMode:query.knownMode,bbox:query.bbox,
    points:query.points,span:query.span,bufferTo:query.bufferTo,version});
  let after=null;
  if(query.cursor!==undefined) {
    after=cursorDecode(query.cursor);
    if(after.v!==1||after.query!==queryId||typeof after.itemId!=='string'||!/^item:[a-f0-9]{64}$/.test(after.itemId)||worldTime(after.eventAt)!==after.eventAt)
      throw new TypeError('Cursor does not match this immutable scene query');
  }
  const remaining=after?selected.filter((row)=>row.event_at>after.eventAt||row.event_at===after.eventAt&&row.item_id>after.itemId):selected;
  const page=remaining.slice(0,query.id?1:query.limit),last=page.at(-1);
  const events=query.points?[]:await projectionEvents(env,page,query,Boolean(query.id)),points=query.points?await scenePoints(env,page):null;
  if(query.id&&query.revision&&events[0]&&events[0].evidence.revision!==query.revision)
    return {...base,events:[],event:null,errorCode:'revision-changed',selectedRevision:events[0].evidence.revision};
  const returned=query.points?points.length:events.length;
  return {...base,events,...(query.points?{points,span:'7d',bufferFrom:query.at,bufferTo:query.bufferTo,bufferWindowFrom:iso(at-WEEK),
      pointMeaning:'Current retained source revisions of reported earthquake epicenters; use (utc-7d,utc] locally. Buffer is not a forecast.'}:{}),
    counts:{returned,eligible:truncated?null:selected.length,omitted:truncated?null:Math.max(0,selected.length-returned),
      candidateLimit:ARCHIVE_LIMITS.sceneCandidates,candidates:bounded.length},
    complete:!truncated&&availableCoverage.complete&&selected.length===returned,
    membershipComplete:!truncated,truncated:truncated||availableCoverage.truncated||selected.length>returned,
    cursor:!query.id&&remaining.length>page.length&&last?cursorEncode({v:1,query:queryId,eventAt:last.event_at,itemId:last.item_id,
      ...(query.points?{bufferTo:query.bufferTo}:{})}):null,
    ...(query.points?{validFrom:!truncated&&query.bufferTo?query.at:null,validTo:!truncated?query.bufferTo:null,
      nextSceneChangeAt:null,intervalProof:'All selected current source heads in the requested buffered origin interval; local time filtering reconstructs each instant.'}:
      interval(bounded,query,state,truncated)),...(query.id?{event:events[0]||null}:{} )};
}

/** Stored-only public routes. Neither request URLs nor queries choose providers. */
export function createWorldSceneHandler({env={},now=Date.now}={}) {
  return async(request)=>{
    const url=new URL(request.url),detail=/^\/api\/world\/scene\/events\/(event:usgs:[a-f0-9]{64})$/.exec(url.pathname);
    if(url.pathname!=='/api/world/scene'&&!detail) return null;
    if(request.method!=='GET') return json({error:'Method Not Allowed'},405);
    try {
      for(const key of url.searchParams.keys()) if(!['at','window','scope','knownAt','knownMode','limit','bbox','cursor','metadata','points','span','revision'].includes(key)||url.searchParams.getAll(key).length!==1)
        throw new TypeError('Unknown or repeated scene query');
      const params=Object.fromEntries(url.searchParams);
      if(params.limit!==undefined&&!/^[1-9]\d{0,2}$/.test(params.limit)||params.metadata!==undefined&&params.metadata!=='1'||params.points!==undefined&&params.points!=='1'||
        detail&&(params.metadata!==undefined||params.cursor!==undefined||params.limit!==undefined||params.points!==undefined||params.span!==undefined))
        throw new TypeError('Invalid bounded scene query');
      const value=await readWorldScene(env,{...params,...(params.limit===undefined?{}:{limit:Number(params.limit)}),metadata:params.metadata==='1',
        ...(params.points===undefined?{}:{points:true}),...(detail?{id:detail[1]}:{})},{now});
      if(!value.available) return json(value,503);
      if(value.errorCode==='revision-changed')return json({...value,error:'The selected event revision changed; reload the scene'},409);
      if(detail&&!value.event) return json({...value,error:'Event is not in the selected stored scene'},404);
      return json(value);
    } catch(error) { return error instanceof TypeError?json({error:'Invalid bounded scene query'},400):
      json({schemaVersion:1,configured:true,available:false,error:'Retained archive evidence is unavailable or failed integrity validation'},503); }
  };
}
