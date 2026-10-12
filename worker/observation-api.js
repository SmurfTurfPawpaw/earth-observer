import { readPluginObservations } from './plugins/store.js';

export const USGS_OBSERVATION_PATH='/api/layers/earthquakes';
export const USGS_OBSERVATION_API_LIMITS=Object.freeze({bytes:160*1024,deadlineMs:15000});
const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export function createObservationApiHandler({now=Date.now,read=readPluginObservations,deadlineMs=USGS_OBSERVATION_API_LIMITS.deadlineMs}={}) {
  if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>USGS_OBSERVATION_API_LIMITS.deadlineMs)throw new TypeError('Use bounded observation delivery');
  return async(request,env)=>{
    const url=new URL(request.url);if(url.pathname!==USGS_OBSERVATION_PATH)return null;
    if(request.method!=='GET')return json({available:false,error:'Method Not Allowed'},405);
    if(url.search.length>100||[...url.searchParams.keys()].some(key=>key!=='knownAt'||url.searchParams.getAll(key).length!==1))
      return json({available:false,error:'Use one canonical knowledge cutoff'},400);
    const controller=new AbortController(),stop=()=>controller.abort(new Error('Stored observation delivery cancelled'));
    if(request.signal.aborted)stop();else request.signal.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(stop,deadlineMs);let abort;
    try{
      controller.signal.throwIfAborted();
      const value=await Promise.race([read(env,{knownAt:url.searchParams.get('knownAt'),now,signal:controller.signal}),new Promise((_,reject)=>{
        abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();})]);
      if(new TextEncoder().encode(JSON.stringify(value)).byteLength>USGS_OBSERVATION_API_LIMITS.bytes)throw Error('Stored observation response limit');
      return json(value,!value.configured?503:!value.available&&!value.knownAt?503:200);
    }catch(error){return json({available:false,error:error instanceof TypeError?'Invalid knowledge cutoff':'Stored observations unavailable'},error instanceof TypeError?400:503);}
    finally{clearTimeout(timer);request.signal.removeEventListener('abort',stop);if(abort)controller.signal.removeEventListener('abort',abort);}
  };
}
