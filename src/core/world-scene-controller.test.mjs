import test from 'node:test';
import assert from 'node:assert/strict';
import { worldHash } from './world-model.js';
import { createWorldSceneController, normalizeWorldScene, sceneCoverageAt, WORLD_SCENE_SCOPE, WORLD_SCENE_REFRESH_MS, WORLD_SCENE_LIMITS } from './world-scene-controller.js';

const DAY = 86400000, start = '2025-06-01T12:00:00.000Z', today = '2026-10-12T02:00:00.000Z';
const after = (at, distance) => new Date(Date.parse(at) + distance).toISOString();
const range = { from: '2024-10-12T00:00:00.000Z', to: today };
const coverage = { availableRange: range, requestedRange: range, segments: [range], gaps: [], complete: true, truncated: false, status: 'complete' };
async function point(name, originAt = start) {
  const key = await worldHash(['usgs', `usgs:${name}`]);
  return { id: `event:usgs:${key}`, itemId: `item:${key}`, sourceId: 'usgs', sourceRecordId: `usgs:${name}`,
    revision: 'a'.repeat(64), snapshotId: 'b'.repeat(64), lat: 50, lon: 4, magnitude: 5.2, originAt, title: name,
    url: `https://earthquake.usgs.gov/earthquakes/eventpage/${name}` };
}
function payload(at = null, points = [], extra = {}) {
  const requestedRange=at?{from:after(at,-7*DAY+1),to:after(at,7*DAY)}:range;
  const scopedCoverage={...coverage,requestedRange,segments:[requestedRange]};
  return { schemaVersion: 1, configured: true, available: true, mode: 'reconstruction', knownMode: 'none', knownAt: null,
    scope: { id: WORLD_SCENE_SCOPE, sourceId: 'usgs' }, at, window: '7d', version: 'archive:1', currentVersion: 'archive:1', events: [],
    counts: { returned: points.length, eligible: at ? points.length : null, omitted: at ? 0 : null },
    complete: true, membershipComplete: true, truncated: false, cursor: null, coverage: scopedCoverage,
    validFrom: at, validTo: at ? after(at, 7 * DAY) : null, nextSceneChangeAt: at ? after(at, 7 * DAY) : null,
    ...(at ? { points, bufferFrom: at, bufferTo: after(at, 7 * DAY), bufferWindowFrom: after(at, -7 * DAY) } : {}), ...extra };
}
function documentFixture() {
  const listeners = new Map();
  return { hidden: false, addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
    visibility() { listeners.get('visibilitychange')?.(); }, listeners };
}
function scheduler() {
  let time = 0, id = 0; const timers = new Map();
  return { timers, now: () => time, setTimeoutImpl(fn, delay) { timers.set(++id, { fn, at: time + delay }); return id; },
    clearTimeoutImpl(id) { timers.delete(id); }, advance(ms) { time += ms; for (const [id, item] of [...timers]) if (item.at <= time && timers.delete(id)) item.fn(); } };
}
const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };

test('a stored seven-day buffer gives exact local origin/expiry scenes, without a request per changing event', async () => {
  const old = await point('old', after(start, -6 * DAY)), next = await point('new', after(start, 3600000)); let requests = 0;
  const controller = createWorldSceneController({ documentRef: documentFixture(), fetchImpl: async (url) => {
    requests++; const query = new URL(url, 'https://example.test').searchParams;
    return Response.json(query.has('metadata') ? payload() : payload(query.get('at'), [old, next]));
  } });
  assert.equal(requests, 0); await controller.open(); await controller.select(start);
  assert.deepEqual(controller.getState().selection.points.map((item) => item.title), ['old']);
  assert.equal(controller.advance(after(start, 3599999)), true); assert.deepEqual(controller.getState().selection.points.map((item) => item.title), ['old']);
  assert.equal(controller.advance(after(start, 3600000)), true); assert.deepEqual(controller.getState().selection.points.map((item) => item.title), ['old', 'new']);
  assert.equal(controller.advance(after(start, DAY)), true); assert.deepEqual(controller.getState().selection.points.map((item) => item.title), ['new']);
  assert.equal(controller.peek(after(start, 7 * DAY)), null, 'The exact exclusive buffer seam needs the next buffer');
  assert.equal(requests, 2); controller.destroy();
});

test('all bounded pages are consumed before a marker buffer can be reused, and unfinished membership stays explicit', async () => {
  const points = await Promise.all(['a', 'b', 'c'].map((name) => point(name))); let requests = 0;
  const controller = createWorldSceneController({ documentRef: documentFixture(), fetchImpl: async (url) => {
    requests++; const query = new URL(url, 'https://example.test').searchParams;
    if (query.has('metadata')) return Response.json(payload());
    const second = query.has('cursor');
    return Response.json(payload(start, second ? points.slice(2) : points.slice(0, 2), {
      counts: { returned: second ? 1 : 2, eligible: 3, omitted: second ? 2 : 1 }, complete: false, truncated: true, cursor: second ? null : 'YQ' }));
  } });
  await controller.open(); await controller.select(start);
  assert.equal(controller.getState().selection.points.length, 3); assert.equal(controller.getState().selection.counts.omitted, 0);
  assert.equal(controller.getState().selection.complete, true); assert.equal(controller.advance(after(start, 1)), true); assert.equal(requests, 3);
  controller.destroy();
  const limited = createWorldSceneController({ documentRef: documentFixture(), fetchImpl: async (url) => Response.json(new URL(url, 'https://example.test').searchParams.has('metadata') ? payload() :
    payload(start, [points[0]], { membershipComplete: false, counts: { returned: 1, eligible: null, omitted: null }, truncated: true })) });
  await limited.open(); await limited.select(start); assert.equal(limited.getState().selection.truncated, true); assert.equal(limited.peek(after(start, 1)), null); limited.destroy();
});

test('Known then preserves advertised origin dates but cannot admit or prefetch evidence published later', async () => {
  let calls = 0;
  const controller = createWorldSceneController({ documentRef: documentFixture(), fetchImpl: async (url) => {
    calls++; const query = new URL(url, 'https://example.test').searchParams;
    if (query.has('metadata')) return Response.json(payload());
    assert.equal(query.get('knownMode'), 'scene'); assert.equal(query.has('points'), false);
    const at = query.get('at');
    return Response.json(payload(at, [], { mode: 'as-known', knownMode: 'scene', knownAt: at, version: 'archive:0', points: undefined,
      coverage: { ...coverage, segments: [], gaps: [{ from: after(at, -7 * DAY + 1), to: at, status: 'unavailable-at-cutoff' }], complete: false, status: 'unavailable-at-cutoff' }, complete: false }));
  } });
  await controller.open(); await controller.select(start, 'known-then');
  assert.deepEqual(controller.getState().metadata.coverage.availableRange, range); assert.equal(controller.getState().selection.coverage.status, 'unavailable-at-cutoff');
  assert.equal(await controller.prefetch(), false); assert.equal(calls, 2); controller.destroy();
  const p = await point('future'), key = p.id.slice('event:usgs:'.length);
  const event = { schemaVersion: 1, id: p.id, kind: 'earthquake', source: { id: 'usgs', url: p.url }, place: { lat: p.lat, lon: p.lon }, eventTime: { at: start },
    reportedFacts: { magnitude: p.magnitude }, evidence: { sourceId: 'usgs', sourceRecordId: p.sourceRecordId, itemId: `item:${key}`, revision: p.revision, snapshotId: p.snapshotId },
    knowledge: { firstRecordedAt: today }, archive: { scopeId: WORLD_SCENE_SCOPE, chunkId: 'c'.repeat(64), publishedAt: today } };
  await assert.rejects(normalizeWorldScene(payload(start, [], { mode: 'as-known', knownMode: 'scene', knownAt: start, events: [event], points: undefined, counts: { returned: 1, eligible: 1, omitted: 0 } }), { at: start, lens: 'known-then' }), /disagrees/);
});

test('rapid seeks, Live and hidden tabs cancel both the owned body and future prefetch', async () => {
  const first = await point('first'), documentRef = documentFixture(), body = Promise.withResolvers(), began = Promise.withResolvers(); let signal;
  const controller = createWorldSceneController({ documentRef, fetchImpl: async (url, init) => {
    const query = new URL(url, 'https://example.test').searchParams;
    if (query.has('metadata')) return Response.json(payload());
    signal = init.signal; began.resolve(); return body.promise;
  } });
  await controller.open(); const pending = controller.select(start); await began.promise;
  controller.live(); assert.equal(signal.aborted, true); body.resolve(Response.json(payload(start, [first])));
  assert.equal(await pending, false); assert.equal(controller.getState().selection, null); controller.destroy(); assert.equal(documentRef.listeners.size, 0);
  const prefetchBody = Promise.withResolvers(), prefetchBegan = Promise.withResolvers(); let calls = 0, prefetchedSignal;
  const prefetch = createWorldSceneController({ documentRef, fetchImpl: async (url, init) => {
    calls++; const query = new URL(url, 'https://example.test').searchParams;
    if (query.has('metadata')) return Response.json(payload());
    if (query.get('at') === start) return Response.json(payload(start, [first]));
    prefetchedSignal = init.signal; prefetchBegan.resolve(); return prefetchBody.promise;
  } });
  await prefetch.open(); await prefetch.select(start); const upcoming = prefetch.prefetch(); await prefetchBegan.promise;
  assert.equal(calls, 3); documentRef.hidden = true; documentRef.visibility(); assert.equal(prefetchedSignal.aborted, true);
  prefetchBody.resolve(Response.json(payload(after(start, 7 * DAY), []))); assert.equal(await upcoming, false); prefetch.destroy();
});

test('coverage revision checks preserve the selected UTC and renew unchanged buffers without more scene transfers', async () => {
  const timing = scheduler(), first = await point('stable'); let scenes = 0, metadataCalls = 0;
  const controller = createWorldSceneController({ ...timing, documentRef: documentFixture(), fetchImpl: async (url) => {
    const query = new URL(url, 'https://example.test').searchParams;
    if (query.has('metadata')) { metadataCalls++; return Response.json(payload()); }
    scenes++; return Response.json(payload(query.get('at'), [first]));
  } });
  await controller.open(); await controller.select(start); controller.advance(after(start, 1000));
  timing.advance(WORLD_SCENE_REFRESH_MS); await settle();
  assert.equal(metadataCalls, 2); assert.equal(scenes, 1); assert.equal(controller.getState().selectedAt, after(start, 1000));
  assert.equal(controller.advance(after(start, DAY)), true); controller.destroy(); assert.equal(timing.timers.size, 0);
});

test('an invalid date, another scope, or a forged point identity never becomes historical geography', async () => {
  const p = await point('identity');
  await assert.rejects(normalizeWorldScene(payload(start, [{ ...p, id: `event:usgs:${'d'.repeat(64)}` }]), { at: start, buffered: true }), /identity/);
  await assert.rejects(normalizeWorldScene(payload(start, [p], { scope: { id: 'today', sourceId: 'usgs' } }), { at: start, buffered: true }), /does not match/);
  const controller = createWorldSceneController({ documentRef: documentFixture(), fetchImpl: async () => Response.json(payload()) });
  await controller.open(); assert.equal(await controller.select('2025-02-30T12:00:00.000Z'), false); controller.destroy();
});

test('one thousand retained points use four capable pages or ten legacy pages with the same frame-local membership', async (t) => {
  const points = await Promise.all(Array.from({ length: 1000 }, (_, index) => point(`stress${index}`, after(start, -7 * DAY + (index + 1) * 14 * DAY / 1000))));
  for(const capacity of [100,250]) {
    let requests=0;
    const controller=createWorldSceneController({documentRef:documentFixture(),fetchImpl:async(url)=>{
      requests++;const query=new URL(url,'https://example.test').searchParams;
      if(query.has('metadata'))return Response.json(payload(null,[],capacity===250?{delivery:{pointsPageLimit:250}}:{}));
      const limit=Number(query.get('limit'));assert.equal(limit,capacity);
      const offset=query.has('cursor')?Number(atob(query.get('cursor'))):0,slice=points.slice(offset,offset+limit),next=offset+slice.length;
      return Response.json(payload(start,slice,{counts:{returned:slice.length,eligible:points.length,omitted:points.length-slice.length},
        complete:false,truncated:true,cursor:next===points.length?null:btoa(String(next)).replace(/=+$/,'')}));
    }});
    await controller.open();await controller.select(start);assert.equal(controller.getState().selection.truncated,false);assert.equal(requests,capacity===250?5:11);
    const began=performance.now();
    for(let frame=0;frame<600;frame++) {
      const at=after(start,frame/600*6*DAY),scene=controller.frame(at);
      assert.ok(scene);assert.ok(scene.points.every(item=>item.originAt<=at&&Date.parse(item.originAt)>Date.parse(at)-7*DAY));
    }
    t.diagnostic(`600 local membership frames including assertions, page capacity ${capacity}: ${(performance.now()-began).toFixed(1)} ms; not browser/GPU timing.`);
    assert.equal(requests,capacity===250?5:11);controller.destroy();
  }
});

const conflictResponse = (requestedVersion = 'archive:1', currentVersion = 'archive:2') => Response.json({ schemaVersion: 1, configured: true, available: false,
  scope: { id: WORLD_SCENE_SCOPE }, errorCode: 'scene-version-changed', requestedVersion, currentVersion }, { status: 409 });

test('one edition conflict restarts from page one without mixing revisions, and the accepted fresh buffer remains usable', async (t) => {
  const old = await point('old'), fresh = await point('fresh'), final = await point('final'); let pages = 0, calls = 0;
  const controller = createWorldSceneController({ documentRef: documentFixture(), fetchImpl: async (url) => {
    calls++; const query = new URL(url, 'https://example.test').searchParams;if(query.has('metadata'))return Response.json(payload());
    pages++;
    if(pages===1){assert.equal(query.has('cursor'),false);return Response.json(payload(start,[old],{counts:{returned:1,eligible:2,omitted:1},cursor:'YQ'}));}
    if(pages===2){assert.equal(query.get('cursor'),'YQ');return conflictResponse();}
    if(pages===3){assert.equal(query.has('cursor'),false);return Response.json(payload(start,[fresh],{version:'archive:2',currentVersion:'archive:2',counts:{returned:1,eligible:2,omitted:1},cursor:'Yg'}));}
    assert.equal(query.get('cursor'),'Yg');return Response.json(payload(start,[final],{version:'archive:2',currentVersion:'archive:2',counts:{returned:1,eligible:2,omitted:1}}));
  } });
  t.after(()=>controller.destroy());
  await controller.open();assert.equal(await controller.select(start),true);
  assert.deepEqual(controller.getState().selection.points.map((p)=>p.title).sort(),['final','fresh']);assert.equal(controller.getState().selection.version,'archive:2');
  assert.equal(controller.getState().metadata.currentVersion,'archive:2');assert.equal(controller.advance(after(start,1)),true);assert.equal(calls,5);controller.destroy();
});

test('same-time refresh retains its accepted scene during a restart, while another date never borrows that frame', async (t) => {
  const old=await point('accepted'), fresh=await point('corrected'), gate=Promise.withResolvers(), began=Promise.withResolvers(), otherGate=Promise.withResolvers();let metadataCalls=0,pages=0;
  const controller=createWorldSceneController({documentRef:documentFixture(),fetchImpl:async(url)=>{
    const query=new URL(url,'https://example.test').searchParams;
    if(query.has('metadata'))return Response.json(payload(null,[],++metadataCalls>1?{version:'archive:2',currentVersion:'archive:2'}:{}));
    if(++pages===1)return Response.json(payload(start,[old]));
    if(pages===2)return Response.json(payload(start,[fresh],{version:'archive:2',currentVersion:'archive:2',counts:{returned:1,eligible:2,omitted:1},cursor:'YQ'}));
    if(pages===3)return conflictResponse('archive:2','archive:3');
    if(pages===4){began.resolve();return gate.promise;}return otherGate.promise;
  }});
  t.after(()=>controller.destroy());
  await controller.open();await controller.select(start);const previous=controller.getState().selection;
  await controller.refresh();await began.promise;assert.equal(controller.getState().selection,previous);assert.equal(controller.getState().loading,true);assert.equal(controller.getState().selectedAt,start);
  const refreshing=controller.select(start);gate.resolve(Response.json(payload(start,[fresh],{version:'archive:3',currentVersion:'archive:3'})));assert.equal(await refreshing,true);
  assert.equal(controller.getState().selection.version,'archive:3');assert.deepEqual(controller.getState().selection.points.map((p)=>p.title),['corrected']);
  const nextAt=after(start,8*DAY),other=controller.select(nextAt);assert.equal(controller.getState().selection,null);assert.equal(controller.getState().selectedAt,nextAt);
  controller.live();otherGate.resolve(Response.json(payload(nextAt,[],{version:'archive:3',currentVersion:'archive:3'})));
  assert.equal(await other,false);assert.equal(controller.getState().selection,null);controller.destroy();
});

test('a second edition conflict stops after one restart, and arbitrary400/other409 responses never retry', async (t) => {
  const p=await point('candidate');
  for(const status of ['conflict',400,409]){
    let pages=0;const controller=createWorldSceneController({documentRef:documentFixture(),fetchImpl:async(url)=>{
      if(new URL(url,'https://example.test').searchParams.has('metadata'))return Response.json(payload());
      pages++;if(status==='conflict')return pages%2===1?Response.json(payload(start,[p],{counts:{returned:1,eligible:2,omitted:1},cursor:'YQ'})):conflictResponse();
      return Response.json({error:'Invalid bounded scene query',errorCode:'different-conflict'},{status});
    }});
    t.after(()=>controller.destroy());
    await controller.open();assert.equal(await controller.select(start),false);assert.equal(pages,status==='conflict'?4:1);assert.equal(controller.getState().selection,null);
    assert.match(controller.getState().error,status==='conflict'?/updating/:new RegExp(`HTTP ${status}`));controller.destroy();
  }
});


test('loaded coverage windows are retained and malformed or uncontained proofs cannot claim unchecked dates',async()=>{
  const window={from:'2026-10-01T00:00:00.000Z',to:'2026-10-10T00:00:00.000Z'};
  const result=await normalizeWorldScene(payload(null,[],{coverage:{...coverage,requestedRange:window,segments:[window]}}),{metadata:true});
  assert.deepEqual(result.coverage.availableRange,range);assert.deepEqual(result.coverage.requestedRange,window);
  for(const invalid of [
    {requestedRange:{...window,from:'2026-02-30T00:00:00.000Z'},segments:[]},
    {requestedRange:window,segments:[range]},
    {requestedRange:window,segments:[],gaps:[{from:range.from,to:window.to,status:'not-imported'}]},
    {requestedRange:null,segments:[window]}
  ]) await assert.rejects(normalizeWorldScene(payload(null,[],{coverage:{...coverage,requestedRange:window,segments:[window],...invalid}}),{metadata:true}),/coverage/);
});

test('a changed scene edition invalidates calendar shading rather than relabelling its window with scene segments',async()=>{
  const documentRef=documentFixture(), timing=scheduler(), p=await point('new-edition');let edition=1;
  const window={from:'2026-10-01T00:00:00.000Z',to:today};
  const controller=createWorldSceneController({...timing,documentRef,fetchImpl:async(url)=>{
    const q=new URL(url,'https://example.test').searchParams;
    if(q.has('metadata'))return Response.json(payload(null,[],{version:`archive:${edition}`,currentVersion:`archive:${edition}`,coverage:{...coverage,requestedRange:window,segments:[window]}}));
    edition=2;return Response.json(payload(q.get('at'),[p],{version:'archive:2',currentVersion:'archive:2'}));
  }});
  try {
    await controller.open();await controller.select(start);
    const state=controller.getState();assert.equal(state.selectedAt,start);assert.equal(state.selection.points.length,1);
    assert.deepEqual(state.metadata.coverage.availableRange,range);assert.equal(state.metadata.coverage.requestedRange,null);
    assert.deepEqual(state.metadata.coverage.segments,[]);assert.equal(state.metadata.coverage.stale,true);
    assert.equal(controller.advance(after(start,1)),true,'The bounded accepted scene remains locally usable during calendar invalidation');
    await controller.refresh();assert.deepEqual(controller.getState().metadata.coverage.requestedRange,window);
    assert.deepEqual(controller.getState().metadata.coverage.segments,[window]);assert.equal(controller.getState().selectedAt,after(start,1));
  }finally{controller.destroy();}
});


test('locally advanced knowledge scenes qualify dates outside the loaded proof window as unchecked, not unimported',()=>{
  const target={from:after(start,-7*DAY+1),to:start};
  const moved=sceneCoverageAt({...coverage,requestedRange:target,segments:[target]},after(start,1000),'scene');
  assert.deepEqual(moved.requestedRange,{from:after(start,-7*DAY+1001),to:after(start,1000)});
  assert.deepEqual(moved.gaps,[{from:after(start,1),to:after(start,1000),status:'not-evaluated'}]);
  assert.equal(moved.complete,false);assert.equal(moved.status,'partial');
});


test('a wholly loaded unimported period remains unimported while truncated or unchecked windows stay partial',()=>{
  const target={from:after(start,-7*DAY+1),to:start};
  const missing={...coverage,requestedRange:target,segments:[],gaps:[{...target,status:'not-imported'}],complete:false,status:'not-imported'};
  const actual=sceneCoverageAt(missing,start);
  assert.equal(actual.status,'not-imported');assert.equal(actual.complete,false);assert.deepEqual(actual.gaps,missing.gaps);
  assert.equal(sceneCoverageAt({...missing,truncated:true},start).status,'partial');
  const unchecked=sceneCoverageAt(missing,after(start,1000));
  assert.equal(unchecked.status,'partial');assert.equal(unchecked.gaps.at(-1).status,'not-evaluated');
});

test('optional delivery capability is admitted strictly and never expands full-event pages or unadvertised requests',async()=>{
  assert.equal((await normalizeWorldScene(payload(null,[],{delivery:{pointsPageLimit:250}}),{metadata:true})).delivery.pointsPageLimit,250);
  assert.equal((await normalizeWorldScene(payload(),{metadata:true})).delivery,null);
  for(const value of [0,1,101,249,251,'250',null])
    await assert.rejects(normalizeWorldScene(payload(null,[],{delivery:{pointsPageLimit:value}}),{metadata:true}),/delivery capability/);
  const points=await Promise.all(Array.from({length:101},(_,index)=>point(`cap${index}`)));
  await assert.rejects(normalizeWorldScene(payload(start,points),{at:start,buffered:true}),/membership/);
  assert.equal((await normalizeWorldScene(payload(start,points),{at:start,buffered:true,pageLimit:250})).points.length,101);
  await assert.rejects(normalizeWorldScene(payload(start,[]),{at:start,pageLimit:250}),/page limit/);
  let calls=0;const controller=createWorldSceneController({documentRef:documentFixture(),fetchImpl:async(url)=>{
    const query=new URL(url,'https://example.test').searchParams;calls++;
    if(query.has('metadata'))return Response.json(payload(null,[],{delivery:{pointsPageLimit:250}}));
    assert.equal(query.get('limit'),'100');assert.equal(query.get('knownMode'),'scene');
    return Response.json(payload(start,[],{points:undefined,mode:'as-known',knownMode:'scene',knownAt:start}));
  }});
  try{await controller.open();assert.equal(await controller.select(start,'known-then'),true);assert.equal(calls,2);}finally{controller.destroy();}
});

test('capable delivery still stops at1000 records and does not cache incomplete membership',async()=>{
  const points=await Promise.all(Array.from({length:1250},(_,index)=>point(`bounded${index}`)));let calls=0;
  const controller=createWorldSceneController({documentRef:documentFixture(),fetchImpl:async(url)=>{
    const q=new URL(url,'https://example.test').searchParams;if(q.has('metadata'))return Response.json(payload(null,[],{delivery:{pointsPageLimit:250}}));
    calls++;const offset=q.has('cursor')?Number(atob(q.get('cursor'))):0,limit=Number(q.get('limit'));assert.equal(limit,250);
    const slice=points.slice(offset,offset+limit);
    return Response.json(payload(start,slice,{counts:{returned:slice.length,eligible:1250,omitted:1250-slice.length},truncated:true,complete:false,cursor:btoa(String(offset+slice.length)).replace(/=+$/,'')}));
  }});
  try{await controller.open();assert.equal(await controller.select(start),true);assert.equal(calls,4);assert.equal(controller.getState().selection.points.length,1000);
    assert.equal(controller.getState().selection.truncated,true);assert.equal(controller.peek(after(start,1)),null);
  }finally{controller.destroy();}
});

test('large compact pages and an edition restart share one byte budget rather than resetting it',async()=>{
  const p=await point('byte-budget');let pages=0;
  const body=payload(start,[p],{counts:{returned:1,eligible:2,omitted:1},cursor:'YQ',extensionPadding:'x'.repeat(600000)});
  assert.ok(new TextEncoder().encode(JSON.stringify(body)).length<WORLD_SCENE_LIMITS.bytes);
  const controller=createWorldSceneController({documentRef:documentFixture(),fetchImpl:async(url)=>{
    const q=new URL(url,'https://example.test').searchParams;if(q.has('metadata'))return Response.json(payload(null,[],{delivery:{pointsPageLimit:250}}));
    pages++;assert.equal(q.get('limit'),'250');return pages===2?conflictResponse():Response.json(body);
  }});
  try{await controller.open();assert.equal(await controller.select(start),false);assert.equal(pages,3);assert.match(controller.getState().error,/browser budget/);
    assert.equal(controller.getState().selection,null);assert.equal(controller.peek(start),null);
  }finally{controller.destroy();}
});

test('byte-shortened capable pages cannot bypass the shared ten-request cap',async()=>{
  const points=await Promise.all(Array.from({length:20},(_,index)=>point(`tiny${index}`)));let pages=0;
  const controller=createWorldSceneController({documentRef:documentFixture(),fetchImpl:async(url)=>{
    const q=new URL(url,'https://example.test').searchParams;if(q.has('metadata'))return Response.json(payload(null,[],{delivery:{pointsPageLimit:250}}));
    const offset=q.has('cursor')?Number(atob(q.get('cursor'))):0;pages++;
    return Response.json(payload(start,[points[offset]],{counts:{returned:1,eligible:20,omitted:19},truncated:true,complete:false,cursor:btoa(String(offset+1)).replace(/=+$/,'')}));
  }});
  try{await controller.open();assert.equal(await controller.select(start),true);assert.equal(pages,10);
    assert.equal(controller.getState().selection.truncated,true);assert.equal(controller.getState().selection.points.length,10);assert.equal(controller.peek(after(start,1)),null);
  }finally{controller.destroy();}
});
