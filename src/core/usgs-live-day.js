import { normalizeEarthquakeSnapshot } from '../layers/earthquakes/records.js';
import { pluginJson, pluginFactsDigest } from './plugin-evidence.js';

export const USGS_LIVE_DAY = Object.freeze({ pluginId: 'usgs-live-day-m2-5-v1', scopeId: 'usgs-live-day-m2-5-v1',
  sourceId: 'usgs', sourceUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  itemId: 'observation-feed:usgs-live-day-m2-5-v1', kind: 'observation-feed', itemKind: 'rolling-observation-feed',
  minimumMagnitude: 2.5, windowHours: 24, rawBytes: 512 * 1024, factsBytes: 128 * 1024,
  features: 2000, records: 500, artifactBytes: 8 * 1024, futureMs: 300000 });
const UTF8 = new TextEncoder(), ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const rowKeys = ['stableId','usgsId','lon','lat','depthKm','mag','place','time','sourceUrl','updatedAt','eventType','reviewStatus','sourceTitle'];
const invalid = () => { throw Object.assign(new TypeError('Invalid bounded USGS live-day observations'), { code: 'invalid_plugin_evidence' }); };
function closed(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) invalid();
}
const sourceText = (value, maximum) => value == null ? null : typeof value === 'string' && value.length > 0 && UTF8.encode(value).byteLength <= maximum ? value : invalid();
const epoch = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
function sourceUrl(value, id) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 2048) invalid();
  let url; try { url = new URL(value); } catch { invalid(); }
  if (url.origin !== 'https://earthquake.usgs.gov' || url.username || url.password || url.search || url.hash ||
    ![`${'/earthquakes/eventpage/'}${id}`, `${'/earthquakes/eventpage/'}${id}/`].includes(url.pathname)) invalid();
  return value;
}
function row(value) {
  closed(value,rowKeys);
  if (!ID.test(value.stableId) || value.usgsId !== value.stableId || !Number.isFinite(value.lon) || Math.abs(value.lon)>180 ||
    !Number.isFinite(value.lat) || Math.abs(value.lat)>90 || value.depthKm !== null && !Number.isFinite(value.depthKm) ||
    !Number.isFinite(value.mag) || value.mag<USGS_LIVE_DAY.minimumMagnitude || value.mag>10 || !epoch(value.time) ||
    value.updatedAt !== null && !epoch(value.updatedAt)) invalid();
  sourceText(value.place,512); sourceText(value.eventType,80); sourceText(value.reviewStatus,80); sourceText(value.sourceTitle,512);
  sourceUrl(value.sourceUrl,value.usgsId); return { ...value };
}
export function validateUsgsLiveDayFacts(value) {
  closed(value,['schemaVersion','kind','scopeId','sourceId','minimumMagnitude','windowHours','records']);
  if (value.schemaVersion!==1 || value.kind!=='usgs-rolling-seismic-observations' || value.scopeId!==USGS_LIVE_DAY.scopeId ||
    value.sourceId!==USGS_LIVE_DAY.sourceId || value.minimumMagnitude!==2.5 || value.windowHours!==24 ||
    !Array.isArray(value.records) || value.records.length>USGS_LIVE_DAY.records || UTF8.encode(pluginJson(value)).byteLength>USGS_LIVE_DAY.factsBytes) invalid();
  const records=value.records.map(row);
  if(new Set(records.map(value=>value.stableId)).size!==records.length || records.some((value,index)=>index&&records[index-1].stableId.localeCompare(value.stableId)>=0)) invalid();
  return { ...value,records };
}
/** Exact source bytes stay separate from the qualifying factual projection.
 * Source generation/count changes alone do not revise observation facts. */
export function decodeUsgsLiveDay(bytes,{now=Date.now,guard=()=>{}}={}) {
  guard(); const receivedAt=now();
  if(!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>USGS_LIVE_DAY.rawBytes||!epoch(receivedAt)) invalid();
  let source; try { source=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)); } catch { invalid(); }
  const metadata=source?.metadata;
  if(source?.type!=='FeatureCollection'||!Array.isArray(source.features)||source.features.length>USGS_LIVE_DAY.features||
    !metadata||metadata.status!==200||metadata.url!==USGS_LIVE_DAY.sourceUrl||!epoch(metadata.generated)||metadata.generated>receivedAt+USGS_LIVE_DAY.futureMs||
    !Number.isSafeInteger(metadata.count)||metadata.count!==source.features.length) invalid();
  const seen=new Set();
  for(const feature of source.features) {
    guard(); if(feature?.type!=='Feature'||!ID.test(feature.id||'')||seen.has(feature.id)) invalid(); seen.add(feature.id);
    if(feature.properties?.mag>=USGS_LIVE_DAY.minimumMagnitude && (feature.geometry?.type!=='Point'||
      !Array.isArray(feature.geometry.coordinates)||feature.geometry.coordinates.length!==3||feature.geometry.coordinates.some(value=>!Number.isFinite(value)))) invalid();
  }
  const normalized=normalizeEarthquakeSnapshot(source); if(!normalized||normalized.length>USGS_LIVE_DAY.records) invalid();
  const original=new Map(source.features.map(feature=>[feature.id,feature]));
  const records=normalized.map(value=>{
    guard();const properties=original.get(value.usgsId).properties;
    if(!epoch(value.time)||value.time>metadata.generated+USGS_LIVE_DAY.futureMs||value.time>receivedAt+USGS_LIVE_DAY.futureMs||
      value.time<metadata.generated-24*3600000-USGS_LIVE_DAY.futureMs||properties.updated!=null&&(!epoch(properties.updated)||
        properties.updated>metadata.generated+USGS_LIVE_DAY.futureMs||properties.updated>receivedAt+USGS_LIVE_DAY.futureMs)) invalid();
    return row({...value,sourceUrl:sourceUrl(properties.url,value.usgsId),updatedAt:properties.updated??null,
      eventType:sourceText(properties.type,80),reviewStatus:sourceText(properties.status,80),sourceTitle:sourceText(properties.title,512)});
  }).sort((a,b)=>a.stableId.localeCompare(b.stableId));
  const canonicalFacts=validateUsgsLiveDayFacts({schemaVersion:1,kind:'usgs-rolling-seismic-observations',scopeId:USGS_LIVE_DAY.scopeId,
    sourceId:'usgs',minimumMagnitude:2.5,windowHours:24,records});
  const counts=new Map(); for(const record of records)counts.set(record.eventType,(counts.get(record.eventType)||0)+1);
  return {canonicalFacts,sourceGeneratedAt:new Date(metadata.generated).toISOString(),sourceFeatureCount:source.features.length,
    countsBySourceType:[...counts].map(([type,count])=>({type,count})).sort((a,b)=>String(a.type).localeCompare(String(b.type)))};
}
export async function usgsLiveDayItems(facts) {
  const valid=validateUsgsLiveDayFacts(facts);
  return [{itemId:USGS_LIVE_DAY.itemId,sourceRevision:await pluginFactsDigest(valid),kind:USGS_LIVE_DAY.itemKind,
    title:'USGS M2.5+ seismic reports · past day',sourceRecordId:USGS_LIVE_DAY.sourceUrl,url:USGS_LIVE_DAY.sourceUrl,
    publishedAt:null,publishedPrecision:'unknown'}];
}
export function usgsLiveDayOverview(decoded) {
  const facts=validateUsgsLiveDayFacts(decoded.canonicalFacts);
  return {schemaVersion:1,kind:'observation-feed-overview',pluginId:USGS_LIVE_DAY.pluginId,scopeId:USGS_LIVE_DAY.scopeId,
    sourceId:'usgs',minimumMagnitude:2.5,windowHours:24,sourceGeneratedAt:decoded.sourceGeneratedAt,sourceFeatureCount:decoded.sourceFeatureCount,
    qualifyingRecordCount:facts.records.length,countsBySourceType:decoded.countsBySourceType,
    meaning:'Rolling scientific summary at source capture. Missing later membership is not withdrawal. Non-earthquake source types remain seismic records.'};
}
