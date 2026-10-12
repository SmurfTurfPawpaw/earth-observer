import { USGS_LIVE_DAY,decodeUsgsLiveDay,usgsLiveDayItems,usgsLiveDayOverview } from '../../src/core/usgs-live-day.js';
import { pluginBytesDigest,pluginFactsDigest,pluginJson } from '../../src/core/plugin-evidence.js';
import { readResponseBytesCapped } from '../../src/sources/httpBody.js';

export { usgsLiveDayItems };
export const USGS_LIVE_DAY_PLUGIN=Object.freeze({...USGS_LIVE_DAY,name:'USGS M2.5+ day seismic reports',
  cadenceMs:60000,deadlineMs:15000,maxItems:1,maxResponseBytes:USGS_LIVE_DAY.rawBytes,maxArtifactBytes:USGS_LIVE_DAY.artifactBytes,
  enabledEnv:'EARTH_USGS_LIVE_DAY_ENABLED',rights:{status:'reviewed-public-display',attribution:'U.S. Geological Survey',
    scope:'Scientific summary observations; retain source-reported event types, dates and revisions.',
    evidence:['https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php']}});
const UTF8=new TextEncoder(),etag=value=>value==null?null:typeof value==='string'&&/^(?:W\/)?"[\x21\x23-\x7e]{1,240}"$/.test(value)?value:undefined;
const modified=value=>value==null?null:typeof value==='string'&&value.length<=128&&!/[\r\n]/.test(value)&&Number.isFinite(Date.parse(value))?value:undefined;
async function bounded(task,signal) {
  signal.throwIfAborted();let stop;
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return task();}),new Promise((_,reject)=>{
    stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();})]);}
  finally{signal.removeEventListener('abort',stop);}
}
const close=response=>{if(response.body)void response.body.cancel().catch(()=>{});};
export async function collectUsgsLiveDay({now=Date.now,signal:external,previous={},fetchImpl=fetch}={}) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new DOMException('USGS source deadline','TimeoutError')),USGS_LIVE_DAY_PLUGIN.deadlineMs);
  const signal=external?AbortSignal.any([external,controller.signal]):controller.signal;
  try{
    signal.throwIfAborted();if(!Number.isFinite(now()))throw new TypeError('Invalid source clock');
    const priorEtag=etag(previous.validators?.etag),priorModified=modified(previous.validators?.lastModified);
    if(priorEtag===undefined||priorModified===undefined)throw new TypeError('Invalid source validators');
    const prior=/^[a-f0-9]{64}$/.test(previous.factsDigest||''),headers={Accept:'application/json','User-Agent':'earth-observer-source-plugin/1.0'};
    if(prior&&priorEtag)headers['If-None-Match']=priorEtag;else if(prior&&priorModified)headers['If-Modified-Since']=priorModified;
    const response=await bounded(()=>fetchImpl(USGS_LIVE_DAY.sourceUrl,{signal,redirect:'error',credentials:'omit',headers}),signal);
    if(response.redirected||response.url&&response.url!==USGS_LIVE_DAY.sourceUrl){close(response);throw Error('USGS source changed');}
    const nextEtag=etag(response.headers.get('etag')),nextModified=modified(response.headers.get('last-modified'));
    if(nextEtag===undefined||nextModified===undefined){close(response);throw Error('Invalid source validators');}
    const validators={etag:response.status===304?nextEtag??priorEtag:nextEtag,lastModified:response.status===304?nextModified??priorModified:nextModified};
    const base={schemaVersion:1,pluginId:USGS_LIVE_DAY.pluginId,scopeId:USGS_LIVE_DAY.scopeId,kind:'observation-feed',
      checkedAt:new Date(now()).toISOString(),sourceUrl:USGS_LIVE_DAY.sourceUrl,validators};
    if(response.status===304){close(response);if(!prior||!headers['If-None-Match']&&!headers['If-Modified-Since'])throw Error('Unsolicited source304');
      return {...base,outcome:'not-modified',factsDigest:previous.factsDigest,sourceUpdatedAt:null,sourceVersion:null,raw:null,canonicalFacts:null,artifact:null};}
    if(!response.ok){const raw=response.headers.get('retry-after'),delay=/^\d{1,9}$/.test(raw||'')?Number(raw)*1000:Date.parse(raw||'')-now();close(response);
      throw Object.assign(Error('USGS source unavailable'),{retryAfterMs:Number.isFinite(delay)?Math.max(0,Math.min(86400000,delay)):0});}
    if(!/^application\/(?:json|geo\+json)(?:\s*;[^\r\n]*)?$/i.test(response.headers.get('content-type')||'')){close(response);throw Error('USGS source is not JSON');}
    const bytes=await bounded(()=>readResponseBytesCapped(response,USGS_LIVE_DAY.rawBytes,signal),signal);
    const decoded=decodeUsgsLiveDay(bytes,{now,guard:()=>signal.throwIfAborted()});
    if(previous.sourceUpdatedAt&&decoded.sourceGeneratedAt<previous.sourceUpdatedAt)throw Error('USGS response predates the retained generation');
    const factsDigest=await pluginFactsDigest(decoded.canonicalFacts),rawSha=await pluginBytesDigest(bytes);
    const artifact=usgsLiveDayOverview(decoded);
    if(UTF8.encode(pluginJson(artifact)).byteLength>USGS_LIVE_DAY.artifactBytes)throw Error('USGS artifact budget');
    signal.throwIfAborted();return {...base,checkedAt:new Date(now()).toISOString(),outcome:'validated',sourceUpdatedAt:decoded.sourceGeneratedAt,
      sourceVersion:null,raw:{bytes,mediaType:'application/json',sha256:rawSha},canonicalFacts:decoded.canonicalFacts,factsDigest,artifact};
  }finally{clearTimeout(timer);}
}
