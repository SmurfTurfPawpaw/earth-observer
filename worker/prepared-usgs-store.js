import { USGS_LIVE_DAY } from '../src/core/usgs-live-day.js';
import { pluginJson } from '../src/core/plugin-evidence.js';
import { buildPreparedUsgsScene,validatePreparedUsgsScene,rebindPreparedUsgsScene,preparedUsgsSource,
  PREPARED_USGS_POLICY,PREPARED_USGS_LIMITS } from './prepared-usgs-scene.js';

export const PREPARED_USGS_STORE_LIMITS=Object.freeze({deadlineMs:10000,operationMs:2000,objects:2,
  objectBytes:PREPARED_USGS_LIMITS.preparedBytes,totalBytes:2*PREPARED_USGS_LIMITS.preparedBytes,chunks:4096});
export const PREPARED_USGS_KEYS=Object.freeze({current:`prepared/${PREPARED_USGS_POLICY}/current.json`,
  prior:`prepared/${PREPARED_USGS_POLICY}/prior.json`});
const UTF8=new TextEncoder(),DECODER=new TextDecoder('utf-8',{fatal:true}),cache=new WeakMap();
const utc=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const fail=code=>Object.assign(new Error(code),{code});
const configured=env=>Boolean(env?.EARTH_DB?.prepare&&env?.EARTH_STORE?.get&&env?.EARTH_STORE?.put);
// Base D1 statements use primary. Reusing a first-primary session would only
// force its first statement and could make the later authority recheck stale.
const primary=env=>env.EARTH_DB;
const same=(a,b)=>a&&b&&pluginJson(a)===pluginJson(b);
const stateFor=bucket=>{let state=cache.get(bucket);if(!state){state={current:null,prior:null,inflight:new Map()};cache.set(bucket,state);}return state;};
function boundedSignal(signal){return signal?AbortSignal.any([signal,AbortSignal.timeout(PREPARED_USGS_STORE_LIMITS.deadlineMs)]):AbortSignal.timeout(PREPARED_USGS_STORE_LIMITS.deadlineMs);}
async function io(operation,signal){
  const stopped=signal?AbortSignal.any([signal,AbortSignal.timeout(PREPARED_USGS_STORE_LIMITS.operationMs)]):AbortSignal.timeout(PREPARED_USGS_STORE_LIMITS.operationMs);
  stopped.throwIfAborted();let abort;
  try{return await Promise.race([Promise.resolve().then(()=>{stopped.throwIfAborted();return operation();}),new Promise((_,reject)=>{
    abort=()=>reject(fail('prepared_storage_unavailable'));stopped.addEventListener('abort',abort,{once:true});if(stopped.aborted)abort();})]);}
  finally{stopped.removeEventListener('abort',abort);}
}
async function rows(db,sql,values,signal){const result=await io(()=>db.prepare(sql).bind(...values).all(),signal);
  if(result?.success===false||!Array.isArray(result?.results))throw fail('prepared_storage_unavailable');return result.results;}
function receipt(row){return {id:row.receipt_id,fence:Number(row.fence),factsDigest:row.facts_digest,rawSha256:row.raw_sha256,
  artifactSha256:row.artifact_sha256,capturedAt:row.captured_at,recordedAt:row.recorded_at,sourceUpdatedAt:row.source_updated_at};}
async function head(db,signal){
  const row=(await rows(db,`SELECT c.*,s.checked_at,s.next_check_at,s.last_successful_at,s.status,
    s.source_updated_at AS operational_source_generated_at FROM earth_plugin_state s JOIN earth_plugin_captures c
    ON c.receipt_id=s.current_receipt AND c.plugin_id=s.plugin_id AND c.scope_id=s.scope_id
    WHERE s.plugin_id=? AND s.scope_id=?`,[USGS_LIVE_DAY.pluginId,USGS_LIVE_DAY.scopeId],signal))[0];
  if(!row)return null;
  const value=receipt(row),source=preparedUsgsSource(value);
  const check=[row.checked_at,row.next_check_at,row.last_successful_at,row.operational_source_generated_at].every(utc)&&
    typeof row.status==='string'?{checkedAt:row.checked_at,nextCheckAt:row.next_check_at,lastSuccessfulAt:row.last_successful_at,
      status:row.status,sourceGeneratedAt:row.operational_source_generated_at}:null;
  return {receipt:value,source,check};
}
async function admittedPrior(db,prepared,signal){
  if(!prepared)return null;
  const row=(await rows(db,`SELECT * FROM earth_plugin_captures WHERE receipt_id=? AND plugin_id=? AND scope_id=?`,
    [prepared.source.receiptId,USGS_LIVE_DAY.pluginId,USGS_LIVE_DAY.scopeId],signal))[0];
  return row&&same(prepared.source,preparedUsgsSource(receipt(row)))?prepared:null;
}
async function bytes(object,signal){
  if(!Number.isSafeInteger(object?.size)||object.size<1||object.size>PREPARED_USGS_STORE_LIMITS.objectBytes)throw fail('prepared_object_limit');
  if(!object.body?.getReader){const out=new Uint8Array(await io(()=>object.arrayBuffer(),signal));
    if(out.byteLength!==object.size||out.byteLength>PREPARED_USGS_STORE_LIMITS.objectBytes)throw fail('prepared_object_limit');return out;}
  const reader=object.body.getReader(),chunks=[];let size=0,count=0;
  try{for(;;){const result=await io(()=>reader.read(),signal);if(result.done)break;
    if(!(result.value instanceof Uint8Array)||!result.value.byteLength||++count>PREPARED_USGS_STORE_LIMITS.chunks)throw fail('prepared_object_limit');
    size+=result.value.byteLength;if(size>object.size||size>PREPARED_USGS_STORE_LIMITS.objectBytes)throw fail('prepared_object_limit');chunks.push(result.value);}
    if(size!==object.size)throw fail('prepared_object_limit');const out=new Uint8Array(size);let at=0;for(const chunk of chunks){out.set(chunk,at);at+=chunk.byteLength;}return out;
  }catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
async function slot(env,name,signal,{refresh=false,allowInvalid=false}={}){
  const state=stateFor(env.EARTH_STORE);
  if(!refresh&&state[name])return state[name];
  // Owner invalid descriptors must never coalesce into public admission.
  const requestKey=`${name}:${allowInvalid?'owner':'reader'}`;
  if(state.inflight.has(requestKey))return io(()=>state.inflight.get(requestKey),signal);
  const task=(async()=>{
    const object=await io(()=>env.EARTH_STORE.get(PREPARED_USGS_KEYS[name]),signal);
    if(!object){state[name]=null;return {prepared:null,etag:null};}
    if(typeof object.etag!=='string'||!object.etag)throw fail('prepared_atomic_storage_required');
    const old=state[name];if(old?.etag===object.etag){void object.body?.cancel?.().catch(()=>{});return old;}
    const invalid=()=>{state[name]=null;void object.body?.cancel?.().catch(()=>{});return {prepared:null,etag:object.etag,invalid:true};};
    let raw;
    try{raw=await bytes(object,signal);}catch(error){
      if(allowInvalid&&error?.code==='prepared_object_limit'){signal?.throwIfAborted();return invalid();}throw error;}
    let prepared;
    try{prepared=await validatePreparedUsgsScene(JSON.parse(DECODER.decode(raw)),{signal});}
    catch(error){if(allowInvalid&&(error instanceof TypeError||error instanceof SyntaxError)){signal?.throwIfAborted();return invalid();}throw error;}
    const result={prepared,etag:object.etag};state[name]=result;return result;
  })();state.inflight.set(requestKey,task);
  try{return await task;}finally{if(state.inflight.get(requestKey)===task)state.inflight.delete(requestKey);}
}
async function writeSlot(env,name,prepared,expected,signal){
  const body=UTF8.encode(pluginJson(prepared));if(body.byteLength>PREPARED_USGS_STORE_LIMITS.objectBytes)throw fail('prepared_object_limit');
  let saved;
  try{saved=await io(()=>env.EARTH_STORE.put(PREPARED_USGS_KEYS[name],body,{onlyIf:expected===null?
    new Headers({'if-none-match':'*'}):{etagMatches:expected},httpMetadata:{contentType:'application/json'}}),signal);}
  catch{const actual=await slot(env,name,signal,{refresh:true,allowInvalid:true});return {committed:actual.prepared?.version===prepared.version,uncertain:true,actual};}
  if(saved===null)return {committed:false,uncertain:false,actual:await slot(env,name,signal,{refresh:true,allowInvalid:true})};
  if(!saved||typeof saved.etag!=='string'||!saved.etag){const actual=await slot(env,name,signal,{refresh:true,allowInvalid:true});
    return {committed:actual.prepared?.version===prepared.version,uncertain:true,actual};}
  // Conditional success is authoritative R2 evidence; cold readers verify encoded content.
  const actual={prepared,etag:saved.etag};stateFor(env.EARTH_STORE)[name]=actual;return {committed:true,uncertain:false,actual};
}
function cannotReplace(existing,candidate){return existing&& (existing.source.fence>candidate.source.fence||
  existing.source.fence===candidate.source.fence&&!same(existing.source,candidate.source));}
function clocks(current,now){const age=current.check?Math.max(0,now()-Date.parse(current.check.sourceGeneratedAt)):null;
  return {check:current.check,sourceGenerationAgeMs:age,stale:current.check?current.check.status!=='ready'||age>USGS_LIVE_DAY_PLUGIN_CADENCE*2:null};}
const USGS_LIVE_DAY_PLUGIN_CADENCE=60000;

/** Owner-wake only: bounded reconstructable derivative, never an authoritative
 * evidence writer. R2 slots and D1 are not atomic; delivery requires an exact head. */
export async function ensurePreparedUsgsScene(env,{now=Date.now,signal:external,readObservations}={}){
  if(!configured(env))return {configured:false,status:'unavailable'};
  const signal=boundedSignal(external),db=primary(env);let candidate=null,target=null,uncertain=false;
  try{
    for(let attempt=0;attempt<2;attempt++){
      signal.throwIfAborted();const current=await head(db,signal);if(!current)return {configured:true,status:'unavailable'};
      if(target&&!same(current.source,target.source))return {configured:true,status:'superseded'};target=current;
      const retained=await slot(env,'current',signal,{refresh:true,allowInvalid:true});
      if(same(retained.prepared?.source,current.source))return {configured:true,status:'ready',version:retained.prepared.version};
      if(cannotReplace(retained.prepared,{source:current.source}))return {configured:true,status:'conflict'};
      if(!candidate){
        const prior=await slot(env,'prior',signal,{refresh:true,allowInvalid:true}),reuse=[retained.prepared,prior.prepared].find(value=>value?.source.factsDigest===current.source.factsDigest);
        if(reuse)candidate=await rebindPreparedUsgsScene(reuse,current.receipt,{signal});
        else{
          if(typeof readObservations!=='function')return {configured:true,status:'pending'};
          const snapshot=await readObservations(env,{now,signal});
          if(!snapshot.available||!same(preparedUsgsSource(snapshot.receipt),current.source))return {configured:true,status:'superseded'};
          candidate=await buildPreparedUsgsScene(snapshot,{signal});
        }
      }
      // Head advance during preparation invalidates this writer before either slot changes.
      if(!same((await head(db,signal))?.source,current.source))return {configured:true,status:'superseded'};
      if(retained.prepared){
        const prior=await slot(env,'prior',signal,{refresh:true,allowInvalid:true});
        if(!prior.prepared||prior.prepared.source.fence<retained.prepared.source.fence){
          const old=await writeSlot(env,'prior',retained.prepared,prior.etag,signal);uncertain||=old.uncertain;
          if(!old.committed&&old.actual.prepared?.source.fence<retained.prepared.source.fence)return {configured:true,status:'pending',uncertain};
        }else if(prior.prepared.source.fence===retained.prepared.source.fence&&!same(prior.prepared.source,retained.prepared.source))
          return {configured:true,status:'conflict'};
      }
      const saved=await writeSlot(env,'current',candidate,retained.etag,signal);uncertain||=saved.uncertain;
      if(saved.committed){const actual=await head(db,signal);
        return same(actual?.source,candidate.source)?{configured:true,status:'prepared',version:candidate.version,uncertain}:
          {configured:true,status:'pending',uncertain};}
      // At most one conflict restart. Never write over a newer or incomparable cache basis.
      if(cannotReplace(saved.actual.prepared,candidate))return {configured:true,status:'superseded',uncertain};
    }
    return {configured:true,status:'pending',uncertain};
  }catch(error){return {configured:true,status:'unavailable',errorCode:error?.code||'prepared_derivative_unavailable'};}
}

/** Stored-only delivery. No provider acquisition, derivative repair or writes. */
export async function readPreparedUsgsScene(env,{now=Date.now,signal:external,includePrior=false}={}){
  const base={schemaVersion:1,configured:configured(env),available:false,pending:false,policyId:PREPARED_USGS_POLICY,
    source:null,check:null,stale:null,sourceGenerationAgeMs:null,prepared:null,prior:null};
  if(!base.configured)return {...base,errorCode:'prepared_storage_unavailable',explanation:'Stored prepared scenes are unavailable'};
  const signal=boundedSignal(external),db=primary(env);
  try{
    for(let attempt=0;attempt<2;attempt++){
      const current=await head(db,signal);if(!current)return {...base,explanation:'No completed retained source receipt is available'};
      let retained=await slot(env,'current',signal);
      if(!same(retained.prepared?.source,current.source))retained=await slot(env,'current',signal,{refresh:true});
      let prior=null;if(includePrior){try{const old=await slot(env,'prior',signal,{refresh:true});
        if(old.prepared&&(old.prepared.source.fence<current.source.fence||same(old.prepared.source,current.source)))
          prior=await admittedPrior(db,old.prepared,signal);
      }catch{signal.throwIfAborted();/* Lost/corrupt prior requires a full snapshot, not failure of valid current facts. */}}
      const latest=await head(db,signal);if(!same(current.source,latest?.source)){if(attempt===0)continue;
        return {...base,pending:true,errorCode:'prepared_head_changed',explanation:'Source edition changed during stored delivery'};}
      const details={source:current.source,...clocks(current,now)};
      if(!same(retained.prepared?.source,current.source))return {...base,...details,pending:true,
        errorCode:'prepared_pending',explanation:'The completed source receipt is awaiting its prepared scene; retain the previous complete view'};
      return {...base,...details,available:true,prepared:retained.prepared,prior};
    }
  }catch(error){return {...base,errorCode:error?.code||'prepared_derivative_unavailable',explanation:'Stored prepared scenes are unavailable'};}
}
