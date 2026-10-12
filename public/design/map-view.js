import { createWorldMap } from './world-map.js';
import { demoEvents, demoRelationships } from './demo-data.js';
import { initInteractions } from './interactions.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('world-map');
const colors = { natural:'#e8b873', politics:'#b8a9d9', economy:'#8ddac9', mobility:'#91b7e1' };
const symbols = {
  earthquake:'M-7 0h3l2-5 3 10 2-5h4',
  flood:'M-7-2q2-3 4 0t4 0t4 0M-7 2q2-3 4 0t4 0t4 0',
  wildfire:'M0-7c1 4 6 5 4 10-1 4-7 5-8 0-1-3 2-4 3-6 0 2 2 3 2 3',
  storm:'M-5 1c-5-1-3-6 0-6 2-5 8-3 8 1 5 0 5 5 1 5H0M-1 2l-2 4h4l-2 4',
  politics:'M-7-3 0-7 7-3M-6-2H6M-5-1v6M0-1v6M5-1v6M-7 7H7',
  energy:'M2-8-5 1H0l-2 7 7-10H0l2-6Z',
  economy:'M-7 5-2 0 2 3 7-5M2-5h5v5',
  transport:'M-7-4h9v9h-9v-9Zm9 3h3l3 3v3H2M-4 5v2M5 5v2',
  maritime:'M-6-2 0-5 6-2v5M0-8v3M-8 3l3 4h10l3-4H-8Z',
  layers:'M-7-2 0-6 7-2 0 2-7-2ZM-7 2 0 6l7-4',
};
function element(name, attributes = {}, parent) {
  const node = document.createElementNS(NS,name);
  for (const [key,value] of Object.entries(attributes)) node.setAttribute(key,String(value));
  parent?.append(node); return node;
}
let map, ui, visible = [], selectedId, signalLayer, connectionLayer;
let destroyed = false, cleanupClock;
const nameFor = event => `${event.place} · ${event.headline}`;

function clustersFor(events, zoom) {
  const groups = [];
  for (const event of events) {
    const position = map.project([event.lon,event.lat]);
    const group = event.id !== selectedId && groups.find(item => !item.selected && Math.hypot((item.x-position[0])*zoom,(item.y-position[1])*zoom) < 24);
    if (group) { group.events.push(event); group.x = group.events.reduce((sum,value)=>sum+map.project([value.lon,value.lat])[0],0)/group.events.length;
      group.y = group.events.reduce((sum,value)=>sum+map.project([value.lon,value.lat])[1],0)/group.events.length; }
    else groups.push({events:[event],x:position[0],y:position[1],selected:event.id===selectedId});
  }
  return groups;
}
function renderConnections() {
  connectionLayer.replaceChildren();
  const byId = new Map(visible.map(event=>[event.id,event]));
  for (const relation of demoRelationships.slice(0,4)) {
    const from = byId.get(relation.from), to = byId.get(relation.to);
    if (!from || !to || selectedId && ![from.id,to.id].includes(selectedId)) continue;
    const [x1,y1] = map.project([from.lon,from.lat]), [x2,y2] = map.project([to.lon,to.lat]);
    const distance = Math.hypot(x2-x1,y2-y1), controlY=(y1+y2)/2-Math.min(90,distance*.23);
    const d=`M${x1} ${y1}Q${(x1+x2)/2} ${controlY} ${x2} ${y2}`;
    const group=element('g',{},connectionLayer), title=element('title',{},group); title.textContent=`Sample relationship: ${relation.label}`;
    element('path',{d,class:'connection-line'},group);
    element('path',{d,class:'connection-moving',style:`animation-delay:-${distance/100}s`},group);
  }
}
function renderSignals({ arrival = false } = {}) {
  if (!signalLayer || !map) return;
  signalLayer.replaceChildren(); const {zoom}=map.getView();
  for (const group of clustersFor(visible,zoom).sort((left,right)=>Number(left.selected)-Number(right.selected))) {
    const event=group.events[0], isCluster=group.events.length>1, selected=group.events.some(item=>item.id===selectedId);
    const marker=element('g',{class:`event-marker${selected?' selected':''}${arrival?' arriving':''}`,
      transform:`translate(${group.x} ${group.y}) scale(${1/zoom})`,tabindex:'0',role:'button',
      'aria-label':isCluster?`Explore grouped sample signals near ${event.place}`:nameFor(event),
      style:`--node:${isCluster?'#8ddac9':colors[event.category]||colors.economy}`},signalLayer);
    const title=element('title',{},marker); title.textContent=isCluster?'Grouped sample signals · zoom to explore':nameFor(event);
    if (selected) {
      element('circle',{r:37,class:'selection-area'},marker);
      element('path',{d:'M-23-14v-9h9M14-23h9v9M23 14v9h-9M-14 23h-9v-9',class:'selection-cross'},marker);
    }
    element('circle',{r:17,class:'node-halo'},marker);
    element('circle',{r:18,class:'arrival-ring'},marker);
    if (isCluster) element('circle',{cx:4,cy:4,r:10,class:'cluster-tail'},marker);
    element('circle',{r:10,class:'node-circle'},marker);
    element('path',{d:symbols[isCluster?'layers':event.symbol||event.kind]||symbols[event.category]||symbols.economy,class:'node-icon'},marker);
    if (selected) {
      const label=element('text',{x:15,y:3,class:'event-label'},marker); label.textContent=event.place.toUpperCase();
    }
    const choose=()=>{if(isCluster) map.focus(event.lon,event.lat,Math.min(8,Math.max(3.5,zoom*1.8)));else ui?.selectEvent(event.id);};
    marker.addEventListener('click',event=>{event.stopPropagation();choose();});
    marker.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();choose();}});
  }
  renderConnections();
}
function viewChanged(view) {
  document.getElementById('view-coordinates').textContent=`${Math.abs(view.lat).toFixed(2)}° ${view.lat<0?'S':'N'} / ${Math.abs(view.lon).toFixed(2)}° ${view.lon<0?'W':'E'}`;
  document.getElementById('view-scale').textContent=view.zoom<2?'GLOBAL':view.zoom<4?'REGIONAL':'LOCAL';
  renderSignals();
}
function clock() {
  const date=new Date(); document.getElementById('utc-clock').textContent=date.toISOString().slice(11,19)+' UTC';
}
async function start() {
  map=createWorldMap({svg,onViewChange:viewChanged});
  await map.ready; if(destroyed)return;
  const world=svg.querySelector('#map-world');
  if(!world)throw new Error('Map surface unavailable');
  svg.querySelector('.map-geography')?.setAttribute('aria-hidden','true');
  connectionLayer=element('g',{id:'connections','aria-hidden':'true'},world);
  signalLayer=element('g',{id:'signals'},world);
  ui=initInteractions({events:demoEvents,relationships:demoRelationships,map,
    onFilter(events){visible=events;renderSignals();},
    onTime(time,{isDemoNow}){document.getElementById('map-subtitle').textContent=isDemoNow?'Explore a signal. Follow the context.':'Moving through the sample history.';},
    onSelect(event){selectedId=event?.id;renderSignals();},
    onReplay(){renderSignals({arrival:true});document.getElementById('announcement').textContent='Replaying fictional sample signal arrivals.';}});
  document.getElementById('map-loading').hidden=true;
  renderSignals({arrival:true});clock();cleanupClock=setInterval(clock,1000);
}
start().catch(error=>{console.error(error); const loading=document.getElementById('map-loading'); loading.textContent='The design preview could not open. Reload to try again.';});
addEventListener('pagehide',()=>{destroyed=true;clearInterval(cleanupClock);ui?.destroy();map?.destroy();},{once:true});
