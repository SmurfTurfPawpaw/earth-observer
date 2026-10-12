import { claimDocumentInvestigation, retainDocumentRaw, completeDocumentInvestigation,
  failDocumentInvestigation, readDocumentStatus, readDocumentAnalysis, readDocumentOriginal, DOCUMENT_LIMITS } from './document-investigations.js';
import { pluginBytesDigest } from '../src/core/plugin-evidence.js';

export const DOCUMENT_PRODUCER_PATH = '/api/document-investigations/producer';
export const DOCUMENT_PUBLIC_PATH = '/api/documents/ec-statement-26-2127';
export const DOCUMENT_ORIGINAL_PATH = `${DOCUMENT_PUBLIC_PATH}/original`;
export const DOCUMENT_API_LIMITS = Object.freeze({ bodyBytes: 768 * 1024, responseBytes: 256 * 1024,
  deadlineMs: 15000, skewMs: 30000, requests: 60, nonceEntries: 64 });
const UTF8 = new TextEncoder(), HEX = /^[a-f0-9]{64}$/, KEY = /^[A-Za-z0-9_-]{43,128}$/;
const json = (data,status=200,extra={}) => Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
export const documentProducerMessage = (timestamp,nonce,bodyDigest) =>
  `earth-document-producer-v1\nPOST\n${DOCUMENT_PRODUCER_PATH}\n${timestamp}\n${nonce}\n${bodyDigest}`;
function abortable(operation,signal) {
  if(signal.aborted) { void Promise.resolve(operation).catch(()=>{});return Promise.reject(signal.reason); }
  let stop;
  return Promise.race([Promise.resolve(operation),new Promise((_,reject)=>{
    stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});
  })]).finally(()=>signal.removeEventListener('abort',stop));
}
async function body(request,signal) {
  const length=request.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>DOCUMENT_API_LIMITS.bodyBytes))
    throw Object.assign(new TypeError('Body budget'),{status:413});
  if(!request.body) throw new TypeError('Missing document action');
  const reader=request.body.getReader(),chunks=[];let size=0;
  try {
    for(;;){const {done,value}=await abortable(reader.read(),signal);if(done)break;
      size+=value.byteLength;if(size>DOCUMENT_API_LIMITS.bodyBytes)throw Object.assign(new TypeError('Body budget'),{status:413});chunks.push(value);}
    const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
    return {bytes,text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)};
  } catch(error){void reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
function action(value) {
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||value.schemaVersion!==1||
    !['claim','raw','complete','fail','status'].includes(value.operation))throw new TypeError('Use a fixed document action');
  const fields={claim:['workerId','claimId'],raw:['jobId','fence','leaseToken','acquiredAt','rawPdfBase64'],
    complete:['jobId','fence','leaseToken','rawReceiptId','extraction','citations','execution'],fail:['jobId','fence','leaseToken','errorCode'],
    status:['claimId','jobId','fence']};
  const allowed=['schemaVersion','operation',...fields[value.operation]];
  if(Object.keys(value).some(key=>!allowed.includes(key))||value.operation!=='status'&&fields[value.operation].some(key=>!Object.hasOwn(value,key)))
    throw new TypeError('Use the closed document action');
  const {schemaVersion,operation,...input}=value;
  if(operation==='raw') {
    if(typeof input.rawPdfBase64!=='string'||input.rawPdfBase64.length>699052||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.rawPdfBase64))throw new TypeError('Use bounded PDF base64');
    const {rawPdfBase64,...rest}=input,binary=atob(rawPdfBase64);
    return {operation,input:{...rest,rawBytes:Uint8Array.from(binary,char=>char.charCodeAt(0))}};
  }
  return {operation,input};
}

/** The mounted capability is scoped to this fixed document. It cannot collect
 * other providers, register URLs, or alter incident publications. */
export function createDocumentInvestigationApiHandler({now=Date.now,claim=claimDocumentInvestigation,retain=retainDocumentRaw,
  complete=completeDocumentInvestigation,fail=failDocumentInvestigation,status=readDocumentStatus,read=readDocumentAnalysis,
  original=readDocumentOriginal,
  deadlineMs=DOCUMENT_API_LIMITS.deadlineMs}={}) {
  if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>DOCUMENT_API_LIMITS.deadlineMs)throw new TypeError('Use a bounded document API deadline');
  const states=new WeakMap();let windowAt=-Infinity,requests=0;
  return async (request,env={},ctx={})=>{
    const url=new URL(request.url);
    if(url.pathname===DOCUMENT_ORIGINAL_PATH) {
      if(request.method!=='GET')return json({available:false,error:'Method Not Allowed'},405,{allow:'GET'});
      const receipt=url.searchParams.get('receipt');
      if(url.search.length>160||url.searchParams.size!==1||url.searchParams.getAll('receipt').length!==1||
          !/^document-raw:[a-f0-9]{64}$/.test(receipt||''))
        return json({available:false,error:'Use one retained original receipt'},400);
      const controller=new AbortController(),cancel=()=>controller.abort();
      if(request.signal.aborted)cancel();else request.signal.addEventListener('abort',cancel,{once:true});
      const timer=setTimeout(cancel,deadlineMs);
      try {
        controller.signal.throwIfAborted();
        const result=await abortable(original(env,{receipt},{signal:controller.signal}),controller.signal);
        if(result.configured===false)return json({available:false,error:'Stored document original unavailable'},503);
        if(!result.available)return json({available:false,error:'Completed document original not found'},404);
        if(!(result.bytes instanceof Uint8Array)||result.bytes.byteLength<8||result.bytes.byteLength>DOCUMENT_LIMITS.rawBytes)
          throw Error('Original response budget');
        return new Response(result.bytes,{headers:{'content-type':'application/pdf','content-length':String(result.bytes.byteLength),
          'cache-control':'no-store','x-content-type-options':'nosniff',
          'content-security-policy':"default-src 'none'; sandbox; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'content-disposition':'attachment; filename="STATEMENT_26_2127_EN.pdf"'}});
      }catch(error){return json({available:false,error:error instanceof TypeError?'Invalid original receipt':'Stored document original unavailable'},error instanceof TypeError?400:503);}
      finally{clearTimeout(timer);request.signal.removeEventListener('abort',cancel);}
    }
    if(url.pathname===DOCUMENT_PUBLIC_PATH) {
      if(request.method!=='GET')return json({available:false,error:'Method Not Allowed'},405,{allow:'GET'});
      if(url.search.length>100||[...url.searchParams.keys()].some(key=>key!=='knownAt'||url.searchParams.getAll(key).length!==1))
        return json({available:false,error:'Use one canonical knowledge cutoff'},400);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),deadlineMs);
      try{const result=await abortable(read(env,{knownAt:url.searchParams.get('knownAt')},{now,signal:controller.signal}),controller.signal);
        if(UTF8.encode(JSON.stringify(result)).byteLength>DOCUMENT_API_LIMITS.responseBytes)throw Error('Response budget');
        return json(result,result.configured===false?503:200);
      }catch(error){return json({available:false,error:error instanceof TypeError?'Invalid knowledge cutoff':'Stored document analysis unavailable'},error instanceof TypeError?400:503);}
      finally{clearTimeout(timer);}
    }
    if(url.pathname!==DOCUMENT_PRODUCER_PATH)return null;
    if(request.method!=='POST')return json({status:'method-not-allowed',stored:false},405,{allow:'POST'});
    if(url.search||request.headers.has('origin'))return json({status:'denied',stored:false},401);
    if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||'')||
      request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')return json({status:'invalid-request',stored:false},400);
    const secret=env.EARTH_DOCUMENT_PRODUCER_KEY;
    if(typeof secret!=='string'||!KEY.test(secret)||['EARTH_COLLECTOR_TOKEN','EARTH_TRIGGER_HMAC_KEY','EARTH_ARCHIVE_IMPORT_KEY'].some(name=>secret===env[name]))
      return json({schemaVersion:1,configured:false,status:'unavailable',stored:false},503);
    const start=now();
    if(start<windowAt||start-windowAt>=60000){windowAt=start;requests=0;}
    if(++requests>DOCUMENT_API_LIMITS.requests)return json({status:'busy',stored:false},429,{'retry-after':'60'});
    const timestamp=request.headers.get('x-earth-document-timestamp')||'',nonce=request.headers.get('x-earth-document-nonce')||'',
      digest=request.headers.get('x-earth-document-digest')||'',signature=request.headers.get('x-earth-document-signature')||'';
    if(!/^\d{10}$/.test(timestamp)||Math.abs(start-Number(timestamp)*1000)>DOCUMENT_API_LIMITS.skewMs||
      !/^[a-f0-9]{32}$/.test(nonce)||!HEX.test(digest)||!HEX.test(signature))return json({status:'denied',stored:false},401);
    const key=await crypto.subtle.importKey('raw',UTF8.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    if(!await crypto.subtle.verify('HMAC',key,Uint8Array.from(signature.match(/../g),pair=>parseInt(pair,16)),
      UTF8.encode(documentProducerMessage(timestamp,nonce,digest))))return json({status:'denied',stored:false},401);
    const owner=env.EARTH_STORE||env;let state=states.get(owner);
    if(!state){state={pending:false,nonces:new Map()};states.set(owner,state);}
    for(const [id,until] of state.nonces)if(start>until)state.nonces.delete(id);
    if(state.nonces.has(nonce))return json({status:'replayed',stored:false},409);
    if(state.nonces.size>=DOCUMENT_API_LIMITS.nonceEntries)return json({status:'busy',stored:false},429);
    state.nonces.set(nonce,Number(timestamp)*1000+DOCUMENT_API_LIMITS.skewMs);
    const controller=new AbortController(),cancel=()=>controller.abort();
    if(request.signal.aborted)cancel();else request.signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(cancel,deadlineMs);let operation=null,parsed=null,mutationStarted=false;
    try{
      const raw=await body(request,controller.signal);
      if(await pluginBytesDigest(raw.bytes)!==digest||Math.abs(now()-Number(timestamp)*1000)>DOCUMENT_API_LIMITS.skewMs)
        return json({status:'denied',stored:false},401);
      parsed=action(JSON.parse(raw.text));controller.signal.throwIfAborted();
      if(parsed.operation!=='status'&&state.pending)return json({status:'busy',stored:false},429);
      if(parsed.operation!=='status'){state.pending=true;mutationStarted=true;}
      const handler={claim,raw:retain,complete,fail,status}[parsed.operation];
      // Once a mutation is admitted, HTTP cancellation cannot pretend to cancel
      // an in-flight D1 transaction. Readback determines its actual completion.
      operation=Promise.resolve().then(()=>handler(env,parsed.input,{now}));
      const settlement=operation.then(()=>{if(mutationStarted)state.pending=false;},()=>{if(mutationStarted)state.pending=false;});
      if(ctx.waitUntil)ctx.waitUntil(settlement);
      const result=await abortable(operation,controller.signal);
      if(UTF8.encode(JSON.stringify(result)).byteLength>DOCUMENT_API_LIMITS.responseBytes)throw Error('Response budget');
      return json(result,result.configured===false?503:result.status==='conflict'||result.status==='superseded'?409:200);
    }catch(error){
      const invalid=error instanceof TypeError||error instanceof SyntaxError;
      const uncertain=mutationStarted&&!invalid;
      return json({schemaVersion:1,status:invalid?'invalid-request':uncertain?'uncertain':'unavailable',stored:uncertain?null:false,
        readStatusBeforeRetry:uncertain,...(parsed?.input.jobId?{jobId:parsed.input.jobId,fence:parsed.input.fence}:{}),
        ...(parsed?.input.claimId?{claimId:parsed.input.claimId}:{})},error.status|| (invalid?400:controller.signal.aborted?504:503));
    }finally{clearTimeout(timer);request.signal.removeEventListener('abort',cancel);if(!operation&&mutationStarted)state.pending=false;}
  };
}
