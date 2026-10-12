import test from 'node:test';
import assert from 'node:assert/strict';
import { claimDocumentInvestigation as claim,retainDocumentRaw as retain,completeDocumentInvestigation as complete,
  failDocumentInvestigation as fail,readDocumentStatus as status,readDocumentAnalysis as read,DOCUMENT_POLICY } from './document-investigations.js';
import { documentFixture,syntheticPdf,syntheticAnalysis } from './document-investigation-fixture.mjs';

let claimSerial=0;
const nextClaim=()=>({workerId:'test-document-producer',claimId:(++claimSerial).toString(16).padStart(32,'0')});
const lease=job=>({jobId:job.jobId,fence:job.fence,leaseToken:job.leaseToken});
const count=(f,table)=>Number(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
async function start(f){return (await claim(f.env,nextClaim(),{now:f.now})).job;}
async function raw(f,job,label='A'){const bytes=syntheticPdf(label),result=await retain(f.env,{...lease(job),acquiredAt:f.stamp(),rawBytes:bytes},{now:f.now});return {result,bytes};}
async function finish(f,job,pdf){return complete(f.env,{...lease(job),rawReceiptId:pdf.result.receipt.id,...await syntheticAnalysis(pdf.bytes)},{now:f.now});}

test('exact retained source-item basis, independent raw receipt and complete DB publication use distinct clocks',async t=>{
  const f=await documentFixture(t);assert.equal((await f.source()).status,'stored');f.advance(1000);
  const input=nextClaim(),claimed=await claim(f.env,input,{now:f.now}),job=claimed.job;
  assert.equal(job.subject.kind,'publication-item');assert.equal('eventId' in job,false);assert.equal('snapshotId' in job,false);
  assert.ok(job.basis.item.evidence.id.startsWith('receipt:'));const metadataKnown=job.basis.item.evidence.recordedAt;
  f.advance(1000);const pdf=await raw(f,job);assert.equal(pdf.result.status,'retained');const rawKnown=pdf.result.receipt.recordedAt;
  assert.ok(rawKnown>metadataKnown);assert.equal((await read(f.env,{}, {now:f.now})).available,false);
  f.advance(1000);const published=await finish(f,job,pdf);assert.equal(published.status,'published');assert.equal(published.stored,true);
  const current=await read(f.env,{}, {now:f.now});assert.equal(current.available,true);
  assert.deepEqual(current.knowledge,{metadataRecordedAt:metadataKnown,documentRecordedAt:rawKnown,analysisPublishedAt:published.receipt.recordedAt});
  assert.equal(current.currentInputMatches,true);assert.equal(current.latestBodyMatches,true);assert.equal(current.content.statements.length,4);
  assert.equal((await read(f.env,{knownAt:rawKnown},{now:f.now})).available,false);
  const before=f.activity.providers.length;await status(f.env,{jobId:job.jobId,fence:job.fence});await read(f.env,{}, {now:f.now});
  assert.equal(f.activity.providers.length,before,'read paths never acquire');
});

test('not-due check and unrelated feed changes do not admit a new body or rewrite the exact basis',async t=>{
  const f=await documentFixture(t);await f.source();const job=await start(f),pdf=await raw(f,job);await finish(f,job,pdf);
  f.advance(1000);await f.source('A',{other:true,force:true});f.reset();
  const idle=await claim(f.env,nextClaim(),{now:f.now});assert.equal(idle.status,'not-due');assert.equal(idle.job,null);
  assert.equal(f.activity.objects.length,0);assert.equal(f.activity.providers.length,0);assert.equal(f.activity.sql.filter(row=>row.write).length,0);
  assert.equal(JSON.parse(f.sqlite.prepare('SELECT basis_json FROM earth_document_work').get().basis_json).item.evidence.id,job.basis.item.evidence.id);
});

test('six-hour unchanged body check finishes operationally without another analysis receipt or extraction',async t=>{
  const f=await documentFixture(t);await f.source();const first=await start(f),a=await raw(f,first);const published=await finish(f,first,a);
  f.advance(DOCUMENT_POLICY.checkMs+1);const again=await start(f),same=await raw(f,again);
  assert.equal(same.result.status,'checked');assert.equal(same.result.changed,false);assert.equal(same.result.publication.id,published.receipt.id);
  assert.equal(same.result.receipt.id,a.result.receipt.id);assert.equal(same.result.receipt.recordedAt,a.result.receipt.recordedAt);
  assert.equal(count(f,'earth_document_raw_receipts'),1);assert.equal(count(f,'earth_document_publications'),1);
  const lookup=await status(f.env,{jobId:again.jobId,fence:again.fence});assert.equal(lookup.attempt.state,'succeeded');assert.equal(lookup.publication.id,published.receipt.id);
});

test('A/B/A raw revisions preserve first retention while each changed current edition gets actual new knowledge time',async t=>{
  const f=await documentFixture(t);await f.source();const ja=await start(f),a=await raw(f,ja);const pa=await finish(f,ja,a);
  f.advance(DOCUMENT_POLICY.checkMs+1);const jb=await start(f),b=await raw(f,jb,'B');const pb=await finish(f,jb,b);
  f.advance(DOCUMENT_POLICY.checkMs+1);const jr=await start(f),reverted=await raw(f,jr,'A');const pr=await finish(f,jr,reverted);
  assert.equal(reverted.result.receipt.id,a.result.receipt.id);assert.equal(reverted.result.receipt.recordedAt,a.result.receipt.recordedAt);
  assert.notEqual(pr.receipt.id,pa.receipt.id);assert.ok(pr.receipt.recordedAt>pb.receipt.recordedAt);
  assert.equal(count(f,'earth_document_raw_receipts'),2);assert.equal(count(f,'earth_document_publications'),3);
  assert.equal((await read(f.env,{knownAt:pb.receipt.recordedAt},{now:f.now})).receipt.id,pb.receipt.id);
  assert.equal((await read(f.env,{}, {now:f.now})).receipt.id,pr.receipt.id);
});

test('metadata corrections reuse the same first raw retention while analysis binds the corrected source-item receipt',async t=>{
  const f=await documentFixture(t);await f.source();const original=await start(f),a=await raw(f,original);await finish(f,original,a);
  f.advance(1000);await f.source('B',{force:true});const corrected=await start(f),same=await raw(f,corrected,'A');
  assert.equal(same.result.status,'retained','corrected metadata still needs its own bound analysis');
  assert.equal(same.result.receipt.id,a.result.receipt.id);assert.equal(same.result.receipt.recordedAt,a.result.receipt.recordedAt);
  assert.equal(same.result.receipt.basisReceiptId,original.basis.item.evidence.id);
  f.advance(1000);await finish(f,corrected,same);const result=await read(f.env,{}, {now:f.now});
  assert.equal(result.content.basis.item.revision,corrected.inputRevision);
  assert.equal(result.content.basis.item.evidence.id,corrected.basis.item.evidence.id);
  assert.equal(result.knowledge.metadataRecordedAt,corrected.basis.item.evidence.recordedAt);
  assert.equal(result.knowledge.documentRecordedAt,a.result.receipt.recordedAt);
  assert.ok(result.knowledge.metadataRecordedAt>result.knowledge.documentRecordedAt);
  assert.equal(count(f,'earth_document_raw_receipts'),1);assert.equal(count(f,'earth_document_publications'),2);
});

test('retained newer raw with failed analysis preserves prior complete publication and explicitly reports incompatibility',async t=>{
  const f=await documentFixture(t);await f.source();const ja=await start(f),a=await raw(f,ja);const pa=await finish(f,ja,a);
  f.advance(DOCUMENT_POLICY.checkMs+1);const jb=await start(f),b=await raw(f,jb,'B');
  const invalid={...lease(jb),rawReceiptId:b.result.receipt.id,...await syntheticAnalysis(b.bytes)};invalid.citations[0].end++;
  await assert.rejects(complete(f.env,invalid,{now:f.now}),{code:'document_evidence_invalid'});
  await fail(f.env,{...lease(jb),errorCode:'extractor_failed'});
  const current=await read(f.env,{}, {now:f.now});assert.equal(current.receipt.id,pa.receipt.id);assert.equal(current.latestBodyMatches,false);
  assert.equal(current.bodyCheck.state,'retry');assert.equal(count(f,'earth_document_raw_receipts'),2);assert.equal(count(f,'earth_document_publications'),1);
  const historical=await read(f.env,{knownAt:pa.receipt.recordedAt},{now:f.now});assert.equal(historical.receipt.id,pa.receipt.id);assert.equal(historical.bodyCheck,null);
  f.advance(60001);const next=await start(f);assert.ok(next.fence>jb.fence);
  const retry=await read(f.env,{}, {now:f.now});assert.equal(retry.latestBodyMatches,false,'unobserved retry cannot erase the latest actual body B');
  assert.equal(retry.bodyCheck.lastBodyObservedAt,b.result.receipt.acquiredAt);
});

test('claims recover exactly once and expiry/supersession fence stale writers',async t=>{
  const f=await documentFixture(t);await f.source();const input=nextClaim(),a=await claim(f.env,input,{now:f.now});
  const recovered=await claim(f.env,input,{now:f.now});assert.equal(recovered.job.leaseToken,a.job.leaseToken);assert.equal(recovered.job.fence,a.job.fence);
  assert.equal((await claim(f.env,nextClaim(),{now:f.now})).status,'busy');
  assert.equal((await status(f.env,{claimId:input.claimId})).job.leaseToken,a.job.leaseToken);
  f.advance(DOCUMENT_POLICY.leaseMs+1);const b=await start(f);assert.ok(b.fence>a.job.fence);
  assert.equal((await raw(f,a.job)).result.status,'superseded');
  assert.equal((await status(f.env,{jobId:a.job.jobId,fence:a.job.fence})).attempt.state,'lease-expired');
  assert.equal((await status(f.env,{claimId:'f'.repeat(32)})).attemptFound,false);
});

test('metadata correction during R2 preparation cannot publish the obsolete input',async t=>{
  const f=await documentFixture(t);await f.source();const job=await start(f),pdf=await raw(f,job);let changed=false;
  f.objectHook(async ({operation,key})=>{if(!changed&&operation==='put'&&key.includes('/analysis/')){changed=true;await f.source('B',{force:true});}});
  const result=await finish(f,job,pdf);assert.equal(result.status,'superseded');assert.equal(result.stored,false);assert.equal(count(f,'earth_document_publications'),0);
  f.objectHook(null);const next=await start(f);assert.notEqual(next.inputRevision,job.inputRevision);assert.notEqual(next.basis.item.evidence.id,job.basis.item.evidence.id);
  assert.equal((await status(f.env,{jobId:job.jobId,fence:job.fence})).attempt.state,'superseded');
});

test('transaction admission protects completeness when the lease expires between its statements',async t=>{
  const f=await documentFixture(t);await f.source();const job=await start(f),pdf=await raw(f,job);let expire=false;
  f.sqlHook(({phase,sql})=>{if(!expire&&phase==='after'&&sql.startsWith('INSERT INTO earth_document_publications')){expire=true;f.advance(DOCUMENT_POLICY.leaseMs+1);}});
  const result=await finish(f,job,pdf);assert.equal(result.stored,true);
  const state=await status(f.env,{jobId:job.jobId,fence:job.fence});assert.equal(state.attempt.state,'succeeded');assert.equal(state.job.state,'succeeded');
  assert.equal(state.publication.id,result.receipt.id);
});

test('expired raw request cannot reuse an old admission marker and future acquisition cannot create a receipt',async t=>{
  const f=await documentFixture(t);await f.source();const job=await start(f),pdf=await raw(f,job);f.advance(DOCUMENT_POLICY.leaseMs+1);
  const expired=await retain(f.env,{...lease(job),acquiredAt:pdf.result.receipt.acquiredAt,rawBytes:pdf.bytes},{now:f.now});assert.equal(expired.stored,false);
  const next=await start(f);await assert.rejects(retain(f.env,{...lease(next),acquiredAt:new Date(f.now()+300001).toISOString(),rawBytes:syntheticPdf('B')},{now:f.now}),TypeError);
  assert.equal(count(f,'earth_document_raw_receipts'),1);
});

test('corrupt original readback and missing schema fail closed without claiming retained/public success',async t=>{
  const f=await documentFixture(t);await f.source();const job=await start(f);let corrupt=true;
  f.objectHook(({operation,key,body})=>{if(corrupt&&operation==='put'&&key.includes('/raw/')&&key.startsWith('documents/')){corrupt=false;body[10]^=1;}});
  await assert.rejects(raw(f,job),{code:'evidence_digest_mismatch'});assert.equal(count(f,'earth_document_raw_receipts'),0);
  const missing=await documentFixture(t,{documents:false});assert.equal((await claim(missing.env,nextClaim(),{now:missing.now})).configured,false);
  assert.equal((await read(missing.env,{}, {now:missing.now})).configured,false);
});

test('stored read retries one edition change rather than mixing old content and a newer pointer',async t=>{
  const f=await documentFixture(t);await f.source();const a=await start(f),ra=await raw(f,a);await finish(f,a,ra);
  f.advance(DOCUMENT_POLICY.checkMs+1);const b=await start(f),rb=await raw(f,b,'B');let changed=false,latest;
  f.objectHook(async({operation,key})=>{if(!changed&&operation==='get'&&key.includes('/analysis/')){changed=true;f.objectHook(null);latest=await finish(f,b,rb);}});
  const result=await read(f.env,{}, {now:f.now});assert.equal(result.available,true);assert.equal(result.receipt.id,latest.receipt.id);assert.equal(result.latestBodyMatches,true);
});

test('lost claim readback proves only the selected claim absence and identifies un-reclaimed lease expiry',async t=>{
  const f=await documentFixture(t);await f.source();const input=nextClaim(),job=(await claim(f.env,input,{now:f.now})).job;
  const absent=await status(f.env,{claimId:'e'.repeat(32)});assert.equal(absent.status,'absent');assert.equal(absent.available,false);assert.equal(absent.job,null);
  f.advance(DOCUMENT_POLICY.leaseMs+1);const expired=await status(f.env,{claimId:input.claimId});
  assert.equal(expired.attempt.state,'lease-expired');assert.equal(expired.attempt.retainedState,'running');assert.equal('leaseToken' in expired.job,false);
  assert.equal(expired.attempt.fence,job.fence);
});

test('warm idle and completed-history delivery use bounded indexed work rather than scanning the journal',async t=>{
  const f=await documentFixture(t);await f.source();const job=await start(f),pdf=await raw(f,job);await finish(f,job,pdf);f.reset();
  await claim(f.env,nextClaim(),{now:f.now});assert.ok(f.activity.sql.length<=3);assert.equal(f.activity.sql.filter(row=>row.write).length,0);
  f.reset();await read(f.env,{knownAt:f.stamp()},{now:f.now});assert.ok(f.activity.sql.length<=2);assert.equal(f.activity.objects.length,1);
  const plans=f.activity.sql.filter(row=>row.sql.includes('FROM earth_document_publications p')).flatMap(row=>f.sqlite.prepare('EXPLAIN QUERY PLAN '+row.sql).all(...row.values));
  assert.ok(plans.some(row=>row.detail.includes('earth_document_publications_known')));
  assert.equal(plans.some(row=>/SCAN p\b/.test(row.detail)),false);
});
