import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSpatialDemand,extractCameraDemand,SPATIAL_DISPLAY_GRIDS,SPATIAL_DEMAND_LIMITS } from './spatial-demand.js';
import { buildPreparedUsgsScene,selectPreparedUsgsCells } from '../../worker/prepared-usgs-scene.js';
import { USGS_LIVE_DAY,usgsLiveDayOverview } from './usgs-live-day.js';
import { pluginFactsDigest } from './plugin-evidence.js';

const input=(bounds,extra={})=>({bounds,center:{lon:4,lat:50},width:1280,height:720,...extra});
const world={west:-180,south:-90,east:180,north:90};
function assertPointCovered(demand,lon,lat){
  const grid=SPATIAL_DISPLAY_GRIDS[demand.level],x=Math.floor((((lon+180)%360+360)%360)/360*grid.columns),
    y=Math.min(grid.rows-1,Math.max(0,Math.floor((90-lat)/180*grid.rows)));
  assert.ok(demand.cells.some(cell=>cell[0]===x&&cell[1]===y),`source point ${lon},${lat} is included at level ${demand.level}`);
}

test('a whole world stays complete at32 cells and immutable; ambiguous opposite dateline endpoints are conservative',()=>{
  const before=input(world),demand=selectSpatialDemand(before);
  assert.equal(demand.tier,'world');assert.equal(demand.level,0);assert.equal(demand.mode,'clusters');assert.equal(demand.cells.length,32);
  for(const lon of [-180,-135,0,179.999,180])for(const lat of [-90,-45,0,45,90])assertPointCovered(demand,lon,lat);
  assert.deepEqual(before,input(world));assert.equal(Object.isFrozen(demand.cells[0]),true);
  assert.throws(()=>{demand.cells[0][0]=3;},TypeError);
  const opposite=selectSpatialDemand(input({...world,west:180,east:-180}));
  assert.equal(opposite.key,demand.key);assert.equal(opposite.bounds.west,180);assert.equal(opposite.bounds.east,-180);
  const tiny=selectSpatialDemand(input(world,{width:80,height:80}));
  assert.equal(tiny.cells.length,32);assert.equal(tiny.displayBudget.minimumGridExceedsPixelCapacity,true,'never silently drop visible cells to satisfy a screen target');
});

test('small local footprints request detailed features only with usable screen space',()=>{
  const bounds={west:4.2,south:50.7,east:4.5,north:50.9},center={lon:4.35,lat:50.85};
  const demand=selectSpatialDemand(input(bounds,{center,width:390,height:844}));
  assert.equal(demand.tier,'local');assert.equal(demand.level,2);assert.equal(demand.mode,'features');assert.ok(demand.cells.length<=4);
  assert.deepEqual(demand.bounds,bounds);assert.deepEqual(demand.center,center);assertPointCovered(demand,4.35,50.85);
  assert.equal(selectSpatialDemand(input(bounds,{center,width:200,height:180})).mode,'clusters');
});

test('crossing the dateline and clipping at poles includes exact boundary source positions',()=>{
  const demand=selectSpatialDemand(input({west:170,south:45,east:-170,north:55},{center:{lon:180,lat:50}}));
  assert.equal(demand.footprint.longitudeSpan,20);assert.equal(demand.center.lon,180);
  for(const lon of [170,175,180,-180,-175,-170])for(const lat of [45,50,55])assertPointCovered(demand,lon,lat);
  for(const bounds of [{west:-5,south:88,east:5,north:90},{west:-5,south:-90,east:5,north:-88}]){
    const polar=selectSpatialDemand(input(bounds,{center:{lon:0,lat:bounds.north>0?89:-89}}));
    for(const lon of [-5,0,5])for(const lat of [bounds.south,bounds.north])assertPointCovered(polar,lon,lat);
    for(const lon of [-180,-100,60,180])assertPointCovered(polar,lon,bounds.north>0?90:-90);
    assert.equal(polar.coverage.poleLongitudeExpanded,true,'all longitudes meet at a physically visible pole');
  }
  const edge=selectSpatialDemand(input({west:170,south:0,east:180,north:10},{center:{lon:175,lat:5}}));
  assertPointCovered(edge,180,0);assertPointCovered(edge,170,10);
});

test('oversubscribed fine angular cells coarsen as a whole instead of truncating the view',()=>{
  const bounds={west:10,south:65,east:65,north:89},demand=selectSpatialDemand(input(bounds,{center:{lon:37.5,lat:77}}));
  assert.equal(demand.tier,'country');assert.equal(demand.level,1);assert.equal(demand.displayBudget.coarsened,true);
  assert.ok(demand.displayBudget.reasons.includes('cell-budget'));assert.ok(demand.cells.length<=SPATIAL_DEMAND_LIMITS.cells);
  for(let lon=10;lon<=65;lon+=5)for(let lat=65;lat<=89;lat+=2)assertPointCovered(demand,lon,lat);
  assertPointCovered(demand,65,89);
});

test('resize changes delivery detail when necessary but stable demands keep canonical keys',()=>{
  const bounds={west:0,south:44,east:12,north:52},desktop=selectSpatialDemand(input(bounds)),
    smaller=selectSpatialDemand(input(bounds,{width:240,height:180}));
  assert.ok(smaller.level<desktop.level);assert.ok(smaller.displayBudget.reasons.includes('screen-capacity'));
  assert.equal(selectSpatialDemand(input(bounds,{width:1400,height:900})).key,desktop.key);
  assert.equal(selectSpatialDemand(input(bounds)).key,desktop.key);
  assert.notEqual(smaller.key,desktop.key);
  const cells=desktop.cells;for(let i=1;i<cells.length;i++)assert.ok(cells[i][1]>cells[i-1][1]||cells[i][1]===cells[i-1][1]&&cells[i][0]>cells[i-1][0]);
  for(const lon of [0,6,12])for(const lat of [44,48,52])assertPointCovered(smaller,lon,lat);
});

test('invalid geography or screen sizes fail instead of producing a false demand',()=>{
  for(const value of [input({...world,north:91}),input({...world,south:10,north:-10}),input({...world,west:NaN}),
    input(world,{center:{lon:181,lat:0}}),input(world,{width:0}),input(world,{height:Infinity}),{}])assert.throws(()=>selectSpatialDemand(value),TypeError);
});

const toRadians=degrees=>degrees*Math.PI/180;
function cameraFixture(rectangle,{hit=true}={}){
  const calls=[],ellipsoid={id:'ellipsoid'};
  const Cesium={Math:{toDegrees:value=>value*180/Math.PI},Cartesian2:class{constructor(x,y){this.x=x;this.y=y;}},
    Cartographic:{fromCartesian(point,target){assert.equal(target,ellipsoid);return point;}}};
  const viewer={canvas:{clientWidth:390,clientHeight:844},scene:{globe:{ellipsoid}},camera:{
    positionCartographic:{longitude:toRadians(4),latitude:toRadians(50)},
    computeViewRectangle(target){calls.push('rectangle');assert.equal(target,ellipsoid);return rectangle;},
    pickEllipsoid(point,target){calls.push('center');assert.deepEqual({...point},{x:195,y:422});assert.equal(target,ellipsoid);
      return hit?{longitude:toRadians(4.35),latitude:toRadians(50.85)}:undefined;},
  }};return {viewer,Cesium,calls};
}
test('camera extraction reads CSS viewport, native rectangle and center ray without changing the camera',()=>{
  const f=cameraFixture({west:toRadians(4.2),south:toRadians(50.7),east:toRadians(4.5),north:toRadians(50.9)});
  const demand=extractCameraDemand(f.viewer,f.Cesium);
  assert.equal(demand.mode,'features');assert.equal(demand.extraction.method,'view-rectangle-and-ellipsoid-ray');
  assert.equal(demand.displayBudget.cssWidth,390);assert.ok(Math.abs(demand.center.lon-4.35)<1e-12);assert.deepEqual(f.calls,['rectangle','center']);
  assert.equal(f.viewer.camera.positionCartographic.longitude,toRadians(4));
});
test('missing/horizon camera geometry uses a bounded world fallback with an explicit reason',()=>{
  for(const rectangle of [undefined,{west:NaN,south:0,east:1,north:1}]){
    const f=cameraFixture(rectangle),demand=extractCameraDemand(f.viewer,f.Cesium);
    assert.equal(demand.level,0);assert.equal(demand.cells.length,32);assert.equal(demand.extraction.reason,'view-rectangle-unavailable');
  }
  const f=cameraFixture({west:0,south:0,east:1,north:1},{hit:false}),demand=extractCameraDemand(f.viewer,f.Cesium);
  assert.equal(demand.extraction.reason,'center-ray-misses-globe');assert.equal(demand.tier,'world');assert.equal(demand.cells.length,32);
  assert.equal(extractCameraDemand(null,null).cells.length,32);
});

test('display demand cells are compatible with actual prepared USGS selection, including ±180 reports',async()=>{
  const at='2026-10-12T08:00:00.000Z',records=[170,180,-180,-170].map((lon,index)=>({stableId:`edge${index}`,usgsId:`edge${index}`,
    lon,lat:50,depthKm:12,mag:3,place:null,time:Date.parse(at),sourceUrl:null,updatedAt:Date.parse(at),eventType:'earthquake',reviewStatus:'reviewed',sourceTitle:null}));
  const facts={schemaVersion:1,kind:'usgs-rolling-seismic-observations',scopeId:USGS_LIVE_DAY.scopeId,sourceId:'usgs',minimumMagnitude:2.5,windowHours:24,records};
  const overview=usgsLiveDayOverview({canonicalFacts:facts,sourceGeneratedAt:at,sourceFeatureCount:records.length,countsBySourceType:[{type:'earthquake',count:records.length}]}),
    receipt={id:`receipt:${'a'.repeat(64)}`,fence:1,factsDigest:await pluginFactsDigest(facts),rawSha256:'b'.repeat(64),
      artifactSha256:await pluginFactsDigest(overview),capturedAt:at,recordedAt:at,sourceUpdatedAt:at};
  const prepared=await buildPreparedUsgsScene({schemaVersion:1,configured:true,available:true,knownAt:null,version:receipt.id,
    plugin:{id:USGS_LIVE_DAY.pluginId,scopeId:USGS_LIVE_DAY.scopeId},scope:{id:USGS_LIVE_DAY.scopeId,sourceId:'usgs',minimumMagnitude:2.5,windowHours:24},
    receipt,overview,records,coverage:{complete:true,recordCount:records.length}});
  const demand=selectSpatialDemand(input({west:170,south:45,east:-170,north:55},{center:{lon:180,lat:50}}));
  const view=await selectPreparedUsgsCells(prepared,demand);assert.equal(view.counts.selectedReports,4);
  assert.equal(view.clusters.reduce((n,cell)=>n+cell.count,0),4);
  const detailed=await selectPreparedUsgsCells(prepared,{...demand,mode:'features'});
  assert.deepEqual(detailed.features.map(feature=>feature.record.lon),[170,180,-180,-170]);
});
