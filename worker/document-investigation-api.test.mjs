import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createHmac } from 'node:crypto';
import { createDocumentInvestigationApiHandler,DOCUMENT_PRODUCER_PATH,DOCUMENT_PUBLIC_PATH,DOCUMENT_ORIGINAL_PATH,documentProducerMessage } from './document-investigation-api.js';
import { createDocumentInvestigationProducer,DOCUMENT_PRODUCER_URL } from '../scripts/document-investigation-producer.mjs';
import { documentFixture,syntheticPdf,syntheticAnalysis } from './document-investigation-fixture.mjs';
import { EC_DOCUMENT_POLICY as P } from '../src/core/document-evidence.js';

const KEY='test-document-key-'.padEnd(64,'z');let serial=0;
function signed(value,now,{nonce=(++serial).toString(16).padStart(32,'0'),key=KEY,timestamp=String(Math.floor(now()/1000)),text=JSON.stringify(value),digest=createHash('sha256').update(text).digest('hex'),url=DOCUMENT_PRODUCER_PATH,method='POST'}={}) {
  const signature=createHmac('sha256',key).update(documentProducerMessage(timestamp,nonce,digest)).digest('hex');
  return new Request('https://document.test'+url,{method,body:method==='POST'?text:undefined,headers:{'content-type':'application/json',
    'x-earth-document-timestamp':timestamp,'x-earth-document-nonce':nonce,'x-earth-document-digest':digest,'x-earth-document-signature':signature}});
}
const json=async response=>({status:response.status,value:await response.json()});
const claimBody=()=>({schemaVersion:1,operation:'claim',workerId:'api-test',claimId:(++serial).toString(16).padStart(32,'0')});

test('missing/secrets reused from other capabilities and invalid method/path/body/time signatures fail closed',async()=>{
  let calls=0;const now=()=>Date.parse('2026-10-12T03:00:00.000Z'),handler=createDocumentInvestigationApiHandler({now,claim:async()=>{calls++;return {schemaVersion:1,configured:true,status:'absent'};}});
  const body=claimBody();assert.equal((await handler(signed(body,now),{})).status,503);
  assert.equal((await handler(signed(body,now),{EARTH_DOCUMENT_PRODUCER_KEY:KEY,EARTH_COLLECTOR_TOKEN:KEY})).status,503);
  const env={EARTH_DOCUMENT_PRODUCER_KEY:KEY};
  assert.equal((await handler(signed(body,now,{key:'wrong-key'.padEnd(64,'q')}),env)).status,401);
  assert.equal((await handler(signed(body,now,{timestamp:String(Math.floor(now()/1000)-31)}),env)).status,401);
  assert.equal((await handler(signed({...body,sourceUrl:'https://evil.test'},now),env)).status,400);
  assert.equal((await handler(signed(body,now,{digest:'a'.repeat(64)}),env)).status,401);
  const wrongPath=signed(body,now,{url:DOCUMENT_PRODUCER_PATH+'?source=evil'});assert.equal((await handler(wrongPath,env)).status,401);
  assert.equal(calls,0);
  assert.equal(await handler(new Request('https://document.test/not-this-api'),env),null);
});

test('same nonce is rejected and raw/source scope stays fixed through actual backend storage',async t=>{
  const f=await documentFixture(t);await f.source();const env={...f.env,EARTH_DOCUMENT_PRODUCER_KEY:KEY},handler=createDocumentInvestigationApiHandler({now:f.now});
  const body=claimBody(),nonce='a'.repeat(32),claimed=await json(await handler(signed(body,f.now,{nonce}),env));
  assert.equal(claimed.status,200);assert.equal(claimed.value.status,'leased');
  assert.equal((await handler(signed(body,f.now,{nonce}),env)).status,409);
  const job=claimed.value.job,raw={schemaVersion:1,operation:'raw',jobId:job.jobId,fence:job.fence,leaseToken:job.leaseToken,
    acquiredAt:f.stamp(),rawPdfBase64:Buffer.from(syntheticPdf('A')).toString('base64')};
  const accepted=await json(await handler(signed(raw,f.now),env));assert.equal(accepted.value.status,'retained');
  const status=await json(await handler(signed({schemaVersion:1,operation:'status',jobId:job.jobId,fence:job.fence},f.now),env));
  assert.equal(status.value.rawReceipt.id,accepted.value.receipt.id);assert.equal('leaseToken' in status.value.job,false);
  const complete={schemaVersion:1,operation:'complete',jobId:job.jobId,fence:job.fence,leaseToken:job.leaseToken,
    rawReceiptId:accepted.value.receipt.id,...await syntheticAnalysis(syntheticPdf('A'))};
  const published=await json(await handler(signed(complete,f.now),env));assert.equal(published.value.status,'published');
  const replay=await json(await handler(signed(complete,f.now),env));assert.equal(replay.value.receipt.id,published.value.receipt.id);
  const altered={...complete,citations:complete.citations.slice(0,3)};assert.equal((await handler(signed(altered,f.now),env)).status,409);
});

test('stored GET has no acquisition/admission surface and honors historical knowledge bounds',async t=>{
  const f=await documentFixture(t);await f.source();const handler=createDocumentInvestigationApiHandler({now:f.now});f.reset();
  const response=await handler(new Request('https://document.test'+DOCUMENT_PUBLIC_PATH),f.env);
  assert.equal((await response.json()).available,false);assert.equal(f.activity.providers.length,0);
  assert.equal(f.activity.sql.filter(row=>row.write).length,0);assert.equal(f.activity.objects.filter(row=>row.operation==='put').length,0);
  assert.equal((await handler(new Request('https://document.test'+DOCUMENT_PUBLIC_PATH+'?collect=1'),f.env)).status,400);
  assert.equal((await handler(new Request('https://document.test'+DOCUMENT_PUBLIC_PATH+'?knownAt=bad'),f.env)).status,400);
  assert.equal((await handler(new Request('https://document.test'+DOCUMENT_PUBLIC_PATH,{method:'POST'}),f.env)).status,405);
});

test('HTTP timeout after mutation admission is uncertain and leaves actual completion available to readback',async()=>{
  let settle;const pending=new Promise(resolve=>{settle=resolve;}),background=[];
  const now=()=>Date.parse('2026-10-12T03:00:00.000Z'),handler=createDocumentInvestigationApiHandler({now,deadlineMs:10,
    retain:async()=>pending});
  const request=signed({schemaVersion:1,operation:'raw',jobId:`document:${'a'.repeat(64)}`,fence:1,leaseToken:'b'.repeat(32),
    acquiredAt:new Date(now()).toISOString(),rawPdfBase64:Buffer.from(syntheticPdf('A')).toString('base64')},now);
  const result=await json(await handler(request,{EARTH_DOCUMENT_PRODUCER_KEY:KEY},{waitUntil:promise=>background.push(promise)}));
  assert.equal(result.status,504);assert.equal(result.value.status,'uncertain');assert.equal(result.value.stored,null);assert.equal(result.value.readStatusBeforeRetry,true);
  settle({schemaVersion:1,configured:true,status:'retained',stored:true});await Promise.all(background);
});

test('producer and real scoped handler agree on admission/readback/unchanged body without real providers',async t=>{
  const f=await documentFixture(t);await f.source();const env={...f.env,EARTH_DOCUMENT_PRODUCER_KEY:KEY},handler=createDocumentInvestigationApiHandler({now:f.now});
  let journal=null,sourceCalls=0,extractions=0,lose='complete';const operations=[];
  const producer=createDocumentInvestigationProducer({key:KEY,now:f.now,stateStore:{load:async()=>structuredClone(journal),save:async value=>{journal=structuredClone(value);}},
    fetchImpl:async(url,options)=>{
      if(url===P.downloadUrl){sourceCalls++;return new Response(syntheticPdf('A'),{headers:{'content-type':'application/pdf'}});}
      assert.equal(url,DOCUMENT_PRODUCER_URL);const body=JSON.parse(options.body);operations.push(body.operation);
      const request=new Request('https://document.test'+DOCUMENT_PRODUCER_PATH,{...options}),response=await handler(request,env);
      if(body.operation===lose){lose=null;throw Error('TEST ONLY lost response after actual complete commit');}return response;
    },extractorImpl:async bytes=>{extractions++;const analysis=await syntheticAnalysis(bytes);return {execution:analysis.execution,result:{extraction:analysis.extraction}};}});
  const lost=await producer.oneCycle();assert.equal(lost.needsReadback,true);assert.equal(sourceCalls,1);assert.equal(extractions,1);assert.ok(journal.pending);
  const recovered=await producer.oneCycle();assert.equal(recovered.status,'published');assert.equal(sourceCalls,1);assert.equal(extractions,1);assert.equal(journal,null);
  f.advance(6*3600000+1);const unchanged=await producer.oneCycle();assert.equal(unchanged.status,'checked');assert.equal(sourceCalls,2);assert.equal(extractions,1);
  assert.ok(operations.includes('status'));assert.equal(Number(f.sqlite.prepare('SELECT COUNT(*) AS n FROM earth_document_publications').get().n),1);
});

test('exact original GET serves unchanged PDF only after complete admission with attachment and sandbox headers',async t=>{
  const f=await documentFixture(t);await f.source();const handler=createDocumentInvestigationApiHandler({now:f.now});
  const env={...f.env,EARTH_DOCUMENT_PRODUCER_KEY:KEY};
  const claimed=await json(await handler(signed(claimBody(),f.now),env)),job=claimed.value.job,pdf=syntheticPdf('A');
  const retained=await json(await handler(signed({schemaVersion:1,operation:'raw',jobId:job.jobId,fence:job.fence,
    leaseToken:job.leaseToken,acquiredAt:f.stamp(),rawPdfBase64:Buffer.from(pdf).toString('base64')},f.now),env));
  const url='https://document.test'+DOCUMENT_ORIGINAL_PATH+'?receipt='+encodeURIComponent(retained.value.receipt.id);
  f.reset();assert.equal((await handler(new Request(url),f.env)).status,404);assert.equal(f.activity.objects.length,0);
  await handler(signed({schemaVersion:1,operation:'complete',jobId:job.jobId,fence:job.fence,leaseToken:job.leaseToken,
    rawReceiptId:retained.value.receipt.id,...await syntheticAnalysis(pdf)},f.now),env);
  f.reset();const response=await handler(new Request(url),f.env);
  assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),pdf);
  assert.equal(response.headers.get('content-type'),'application/pdf');assert.equal(response.headers.get('content-length'),String(pdf.byteLength));
  assert.equal(response.headers.get('content-disposition'),'attachment; filename="STATEMENT_26_2127_EN.pdf"');
  assert.match(response.headers.get('content-security-policy'),/default-src 'none'; sandbox;/);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(f.activity.providers.length,0);assert.equal(f.activity.sql.filter(row=>row.write).length,0);
  assert.equal(f.activity.objects.filter(row=>row.operation==='put').length,0);
  const key=[...f.objects.keys()].find(key=>key.includes('/raw/')&&key.startsWith('documents/'));
  f.objects.set(key,syntheticPdf('CORRUPTED'));assert.equal((await handler(new Request(url),f.env)).status,503);
  assert.equal(f.activity.providers.length,0);
});

test('original download has a closed receipt query, bounded delivery and cancellation before stored I/O',async()=>{
  let reads=0;const receipt=`document-raw:${'a'.repeat(64)}`,base='https://document.test'+DOCUMENT_ORIGINAL_PATH;
  const handler=createDocumentInvestigationApiHandler({original:async()=>{reads++;return {configured:true,available:true,bytes:new Uint8Array(512*1024+1)};}});
  for(const query of ['', '?receipt=bad', '?receipt='+receipt+'&receipt='+receipt, '?receipt='+receipt+'&knownAt=2026-10-12T00:00:00.000Z',
    '?source=https://evil.test/pdf', '?receipt='+receipt.toUpperCase()])
    assert.equal((await handler(new Request(base+query),{})).status,400);
  assert.equal((await handler(new Request(base+'?receipt='+receipt,{method:'POST'}),{})).status,405);assert.equal(reads,0);
  assert.equal((await handler(new Request(base+'?receipt='+receipt),{})).status,503,'oversized original cannot leave the handler');
  const cancelled=new AbortController();cancelled.abort();const before=reads;
  assert.equal((await handler(new Request(base+'?receipt='+receipt,{signal:cancelled.signal}),{})).status,503);assert.equal(reads,before);
  let receivedSignal;
  const timed=createDocumentInvestigationApiHandler({deadlineMs:10,original:async(env,input,{signal})=>{
    receivedSignal=signal;return new Promise(()=>{});
  }});
  assert.equal((await timed(new Request(base+'?receipt='+receipt),{})).status,503);assert.equal(receivedSignal.aborted,true);
});
