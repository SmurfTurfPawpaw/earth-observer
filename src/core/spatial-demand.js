export const SPATIAL_DEMAND_POLICY='angular-display-demand-v1';
export const SPATIAL_DISPLAY_GRIDS=Object.freeze([
  {level:0,columns:8,rows:4},{level:1,columns:32,rows:16},{level:2,columns:128,rows:64},
].map(Object.freeze));
export const SPATIAL_DEMAND_LIMITS=Object.freeze({cells:128,pixelsPerCell:72*72});
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const radians=degrees=>degrees*Math.PI/180;
const wrap=lon=>((lon+180)%360+360)%360-180;
function longitudeSpan(west,east){return Math.abs(east-west)===360?360:east>=west?east-west:360+east-west;}
function admit({bounds,center,width,height}={}){
  if(!bounds||![bounds.west,bounds.south,bounds.east,bounds.north].every(finite)||
    bounds.west< -180||bounds.west>180||bounds.east< -180||bounds.east>180||bounds.south< -90||bounds.north>90||bounds.south>bounds.north||
    !center||![center.lon,center.lat].every(finite)||center.lon< -180||center.lon>180||center.lat< -90||center.lat>90||
    !finite(width)||!finite(height)||width<=0||height<=0)throw new TypeError('Use finite geographic bounds, center and positive CSS viewport dimensions');
  return {bounds:{west:bounds.west,south:bounds.south,east:bounds.east,north:bounds.north},center:{lon:center.lon,lat:center.lat},width,height};
}
function gridCoverage(bounds,grid){
  const span=longitudeSpan(bounds.west,bounds.east),xs=[];
  if(span===360){for(let x=0;x<grid.columns;x++)xs.push(x);}
  else{
    const startDegrees=wrap(bounds.west)+180,start=Math.floor(startDegrees/360*grid.columns);
    const end=Math.floor((startDegrees+span)/360*grid.columns),seen=new Set();
    // Inclusive end keeps source points lying exactly on the viewport boundary.
    for(let i=start;i<=end;i++)seen.add(i%grid.columns);
    xs.push(...seen);xs.sort((a,b)=>a-b);
  }
  const row=lat=>Math.min(grid.rows-1,Math.max(0,Math.floor((90-lat)/180*grid.rows)));
  const firstRow=row(bounds.north),lastRow=row(bounds.south);
  // Every longitude meets at a pole. Cover its whole angular row even when the
  // supplied rectangle names only a narrow longitude wedge.
  const poleRows=new Set();if(bounds.north===90)poleRows.add(0);if(bounds.south===-90)poleRows.add(grid.rows-1);
  return {xs,firstRow,lastRow,poleRows,columns:grid.columns,
    count:xs.length*(lastRow-firstRow+1)+poleRows.size*(grid.columns-xs.length)};
}
function displayTier(spanLon,spanLat,fraction,center){
  // These are display scales, not country borders or evidence significance.
  const projectedWidth=spanLon*Math.max(0.1,Math.cos(radians(center.lat)));
  if(spanLon>=180||spanLat>=100||fraction>=0.25)return 'world';
  if(projectedWidth>=60||spanLat>=40||fraction>=0.035)return 'continent';
  if(projectedWidth>=18||spanLat>=14||fraction>=0.004)return 'country';
  if(projectedWidth>=3||spanLat>=3||fraction>=0.0001)return 'region';
  return 'local';
}

/** Camera footprint is a delivery/display preference. It never restricts
 * global acquisition, declares source coverage, or moves reported positions. */
export function selectSpatialDemand(input){
  const {bounds,center,width,height}=admit(input),spanLon=longitudeSpan(bounds.west,bounds.east),spanLat=bounds.north-bounds.south;
  const areaFraction=spanLon/360*(Math.sin(radians(bounds.north))-Math.sin(radians(bounds.south)))/2;
  const tier=displayTier(spanLon,spanLat,areaFraction,center),initialLevel=tier==='world'?0:tier==='continent'?1:2;
  const pixelCapacity=Math.max(1,Math.min(SPATIAL_DEMAND_LIMITS.cells,Math.floor(width*height/SPATIAL_DEMAND_LIMITS.pixelsPerCell)));
  let level=initialLevel,coverage=gridCoverage(bounds,SPATIAL_DISPLAY_GRIDS[level]);const reasons=[];
  while(level>0&&(coverage.count>SPATIAL_DEMAND_LIMITS.cells||coverage.count>pixelCapacity)){
    reasons.push(coverage.count>SPATIAL_DEMAND_LIMITS.cells?'cell-budget':'screen-capacity');
    coverage=gridCoverage(bounds,SPATIAL_DISPLAY_GRIDS[--level]);
  }
  const cells=[];for(let y=coverage.firstRow;y<=coverage.lastRow;y++){
    if(coverage.poleRows.has(y)){for(let x=0;x<coverage.columns;x++)cells.push([x,y]);}
    else for(const x of coverage.xs)cells.push([x,y]);
  }
  const mode=tier==='local'&&level===2&&spanLon<=3&&spanLat<=3&&width>=240&&height>=240&&cells.length<=4?'features':'clusters';
  const grid=SPATIAL_DISPLAY_GRIDS[level],focusCell=[Math.floor((wrap(center.lon)+180)/360*grid.columns),
    Math.min(grid.rows-1,Math.max(0,Math.floor((90-center.lat)/180*grid.rows)))];
  const key=`${SPATIAL_DEMAND_POLICY}|${tier}|${level}|${mode}|${cells.map(cell=>cell.join(':')).join(',')}`;
  return freeze({schemaVersion:1,policyId:SPATIAL_DEMAND_POLICY,tier,level,cells,mode,key,bounds,center,focusCell,
    footprint:{longitudeSpan:spanLon,latitudeSpan:spanLat,areaFraction},
    displayBudget:{cssWidth:width,cssHeight:height,pixelCapacity,coarsened:level!==initialLevel,reasons:[...new Set(reasons)],
      minimumGridExceedsPixelCapacity:cells.length>pixelCapacity},
    coverage:{allVisibleCells:true,poleLongitudeExpanded:coverage.poleRows.size>0&&coverage.xs.length<coverage.columns,
      meaning:'All cells intersecting the supplied view bounds, with conservative pole-row expansion; this is not factual/source completeness'}});
}

function degrees(value,Cesium){return typeof Cesium?.Math?.toDegrees==='function'?Cesium.Math.toDegrees(value):value*180/Math.PI;}
function boundedDegree(value,max){return finite(value)&&value>=-max-1e-8&&value<=max+1e-8?Math.min(max,Math.max(-max,value)):null;}
function cartographicCenter(value,Cesium){
  if(!value)return null;const lon=boundedDegree(degrees(value.longitude,Cesium),180),lat=boundedDegree(degrees(value.latitude,Cesium),90);
  return lon===null||lat===null?null:{lon,lat};
}

/** Read native camera geometry only. Sky/horizon/unsupported geometry takes a
 * bounded whole-world delivery fallback; this neither moves nor renders camera. */
export function extractCameraDemand(viewer,Cesium){
  const scene=viewer?.scene,camera=viewer?.camera||scene?.camera,canvas=viewer?.canvas||scene?.canvas;
  const dimension=(value,fallback)=>finite(value)&&value>0?value:finite(fallback)&&fallback>0?fallback:1;
  const width=dimension(canvas?.clientWidth,viewer?.container?.clientWidth),height=dimension(canvas?.clientHeight,viewer?.container?.clientHeight);
  const ellipsoid=scene?.globe?.ellipsoid||Cesium?.Ellipsoid?.WGS84;
  const world={west:-180,south:-90,east:180,north:90};let bounds=null,center=null,reason=null;
  try{
    const rectangle=camera?.computeViewRectangle?.(ellipsoid);
    if(rectangle){
      const west=boundedDegree(degrees(rectangle.west,Cesium),180),east=boundedDegree(degrees(rectangle.east,Cesium),180),
        south=boundedDegree(degrees(rectangle.south,Cesium),90),north=boundedDegree(degrees(rectangle.north,Cesium),90);
      if([west,east,south,north].every(value=>value!==null)&&south<=north)bounds={west,south,east,north};
    }
    if(!bounds)reason='view-rectangle-unavailable';
    if(bounds&&typeof camera?.pickEllipsoid==='function'&&typeof Cesium?.Cartographic?.fromCartesian==='function'){
      const point=typeof Cesium?.Cartesian2==='function'?new Cesium.Cartesian2(width/2,height/2):{x:width/2,y:height/2};
      const hit=camera.pickEllipsoid(point,ellipsoid);
      if(hit)center=cartographicCenter(Cesium.Cartographic.fromCartesian(hit,ellipsoid),Cesium);
      if(!center)reason='center-ray-misses-globe';
    }else if(bounds)reason='center-ray-unavailable';
  }catch{reason='camera-geometry-unavailable';}
  if(reason)bounds=world;
  if(!center){try{center=cartographicCenter(camera?.positionCartographic,Cesium);}catch{}}
  if(!center)center={lon:0,lat:0};
  const demand=selectSpatialDemand({bounds:bounds||world,center,width,height});
  return freeze({...demand,extraction:{method:reason?'conservative-world':'view-rectangle-and-ellipsoid-ray',reason}});
}
