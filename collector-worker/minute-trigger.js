import { collectionAcknowledgment } from '../src/core/collection-ack.js';

export const MINUTE_TRIGGER_URL = 'https://giovannicallebaut.com/earth/api/collector/trigger';
export const MINUTE_TRIGGER_CRON = '* * * * *';
export const MINUTE_TRIGGER_LIMITS = Object.freeze({ responseBytes: 4096, deadlineMs: 55_000 });
const BODY = '{"action":"collect"}', PATH = '/api/collector/trigger', encoder = new TextEncoder();
const keyPattern = /^[A-Za-z0-9_-]{43,128}$/;
const statuses = new Set(['stored','failed','busy','denied','unavailable','invalid_request','replayed','uncertain','deadline']);
const count = (value,max) => Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
const randomNonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map((value)=>value.toString(16).padStart(2,'0')).join('');

function configuration(env) {
  if(env?.EARTH_MINUTE_TIMER_ENABLED==='0')return 'paused';
  if(env?.EARTH_MINUTE_TIMER_ENABLED!=='1'||typeof env.EARTH_TRIGGER_HMAC_KEY!=='string'||!keyPattern.test(env.EARTH_TRIGGER_HMAC_KEY))return 'unconfigured';
  // An optional old origin binding is a sanity check, never a URL override.
  if(env.EARTH_TARGET_ORIGIN!==undefined&&env.EARTH_TARGET_ORIGIN!=='https://giovannicallebaut.com')return 'invalid_configuration';
  return 'ready';
}
function abortable(operation,signal) {
  if(signal.aborted){void Promise.resolve(operation).catch(()=>{});return Promise.reject(signal.reason);}
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(operation).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
/** WebCrypto implements exactly the existing collect-only HMAC protocol. */
export async function signMinuteTrigger(key,{now=Date.now(),nonce=randomNonce()}={}) {
  if(typeof key!=='string'||!keyPattern.test(key)||!Number.isFinite(now)||!/^[a-f0-9]{32}$/.test(nonce))throw new TypeError('Invalid minute trigger configuration');
  const timestamp=String(Math.floor(now/1000));
  if(!/^\d{10}$/.test(timestamp))throw new TypeError('Invalid minute trigger clock');
  const message=`earth-collector-trigger-v1\nPOST\n${PATH}\n${timestamp}\n${nonce}\n${BODY}`;
  const cryptoKey=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=[...new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,encoder.encode(message)))].map((value)=>value.toString(16).padStart(2,'0')).join('');
  return {'content-type':'application/json',accept:'application/json','x-earth-trigger-timestamp':timestamp,
    'x-earth-trigger-nonce':nonce,'x-earth-trigger-signature':signature};
}
async function readSummary(response,signal) {
  const rejectBody=()=>{void response.body?.cancel().catch(()=>{});};
  if(response.redirected||response.url&&response.url!==MINUTE_TRIGGER_URL||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||!response.body){rejectBody();throw new Error('Invalid timer response');}
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MINUTE_TRIGGER_LIMITS.responseBytes)){rejectBody();throw new Error('Invalid timer response size');}
  const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try {
    for(;;){signal.throwIfAborted();const {value,done}=await abortable(reader.read(),signal);signal.throwIfAborted();if(done)break;
      bytes+=value.byteLength;if(bytes>MINUTE_TRIGGER_LIMITS.responseBytes)throw new Error('Invalid timer response size');text+=decoder.decode(value,{stream:true});}
    const payload=JSON.parse(text+decoder.decode());
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||!statuses.has(payload.status)||
        ![true,false,null].includes(payload.stored)||payload.status==='stored'&&payload.stored!==true||
        response.ok!==(payload.status==='stored')||payload.status!=='stored'&&payload.stored===true)throw new Error('Invalid timer response');
    return {status:payload.status,httpStatus:response.status,stored:payload.stored,...collectionAcknowledgment(payload),sourceCount:count(payload.sourceCount,4),
      snapshotCount:count(payload.snapshotCount,4),failureCount:count(payload.failureCount,20),recordCount:count(payload.recordCount,500),
      worldStored:payload.worldStored===true,updatesPublished:payload.updatesPublished===true,
      ...(payload.readStatusBeforeRetry===true?{readStatusBeforeRetry:true}:{})};
  }catch(error){cancel();throw error;}finally{signal.removeEventListener('abort',cancel);try{reader.releaseLock();}catch{/* Cancellation can settle asynchronously. */}}
}

/** Stateless timer: one fixed scoped POST, no KV/database and no immediate retry. */
export function createMinuteTimer({fetchImpl=(...args)=>fetch(...args),now=Date.now,nonce=randomNonce,
  timeoutMs=MINUTE_TRIGGER_LIMITS.deadlineMs,logger=(summary)=>console.info(JSON.stringify(summary))}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>MINUTE_TRIGGER_LIMITS.deadlineMs)throw new TypeError('Use a bounded minute timer deadline');
  async function run(env={}, {signal:externalSignal}={}) {
    const configured=configuration(env);
    if(configured!=='ready')return {ok:false,summary:{status:configured,stored:false}};
    if(externalSignal?.aborted)return {ok:false,summary:{status:'cancelled',stored:false}};
    const deadline=new AbortController(),signal=externalSignal?AbortSignal.any([deadline.signal,externalSignal]):deadline.signal;
    const timer=setTimeout(()=>deadline.abort(new Error('Minute timer deadline')),timeoutMs);let dispatched=false;
    try {
      const headers=await abortable(signMinuteTrigger(env.EARTH_TRIGGER_HMAC_KEY,{now:now(),nonce:nonce()}),signal);
      const operation=Promise.resolve().then(()=>{signal.throwIfAborted();dispatched=true;
        return fetchImpl(MINUTE_TRIGGER_URL,{method:'POST',headers,body:BODY,signal,redirect:'error',credentials:'omit',cache:'no-store'});});
      const response=await abortable(operation,signal),summary=await readSummary(response,signal);
      return {ok:response.ok&&summary.status==='stored'&&summary.stored===true,summary};
    }catch{
      return {ok:false,summary:{status:signal.aborted?(externalSignal?.aborted?'cancelled':'uncertain'):'request_failed',
        stored:dispatched?null:false,...(dispatched?{readStatusBeforeRetry:true}:{})}};
    }finally{clearTimeout(timer);}
  }
  async function scheduled(controller,env) {
    // The next minute is the retry opportunity; uncertain writes must not fan out.
    if(typeof controller?.noRetry==='function')controller.noRetry();
    const eventValid=controller?.cron===MINUTE_TRIGGER_CRON&&Number.isSafeInteger(controller.scheduledTime)&&controller.scheduledTime>=0&&controller.scheduledTime<=8.64e15&&
      (controller.type===undefined||controller.type==='scheduled');
    const result=eventValid?await run(env):{ok:false,summary:{status:'invalid_schedule',stored:false}};
    logger({timer:'earth-minute',scheduledAt:eventValid?new Date(controller.scheduledTime).toISOString():null,...result.summary});
    if(!result.ok&&!['paused','busy'].includes(result.summary.status))throw new Error(`Earth minute timer: ${result.summary.status}`);
    return result;
  }
  function health(request,env) {
    const url=new URL(request.url);
    if(!['/','/healthz','/status'].includes(url.pathname))return new Response('Not found',{status:404});
    if(request.method!=='GET')return new Response('Read-only timer health',{status:405,headers:{allow:'GET'}});
    if(url.search)return Response.json({error:'Timer health does not accept parameters'},{status:400});
    const state=configuration(env);
    return Response.json({schemaVersion:1,status:state,cron:MINUTE_TRIGGER_CRON,stateStorage:'none',
      note:'Configuration health does not prove scheduled execution. Verify Cloudflare events and dated hosted source receipts.'},
    {status:state==='unconfigured'||state==='invalid_configuration'?503:200,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  }
  return {run,scheduled,fetch:health};
}
const minuteTimer=createMinuteTimer();
export default {scheduled:(controller,env)=>minuteTimer.scheduled(controller,env),fetch:(request,env)=>minuteTimer.fetch(request,env)};
