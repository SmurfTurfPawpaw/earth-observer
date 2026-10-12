import { createResearchMap } from './research-map.js';
import { initResearchWorkspace } from './research-ui.js';

const svg = document.getElementById('world-map');
let ui, stopped = false;
const map = createResearchMap({svg,
  onSelect(selection){ui?.selectMapItem(selection);},
  onViewChange(view){
    document.getElementById('view-coordinates').textContent=`${Math.abs(view.lat).toFixed(1)}° ${view.lat<0?'S':'N'} / ${Math.abs(view.lon).toFixed(1)}° ${view.lon<0?'W':'E'}`;
    document.getElementById('view-scale').textContent=view.zoom<2?'WORLD':view.zoom<4?'REGION':'DETAIL';
  },
});
function clock(){document.getElementById('utc-clock').textContent=new Date().toISOString().slice(11,19)+' UTC';}
clock();const clockId=setInterval(clock,1000);
map.ready.then(()=>{
  if(stopped)return;
  svg.querySelector('.map-geography')?.setAttribute('aria-hidden','true');
  ui=initResearchWorkspace({map:map.map,onScene:scene=>map.setScene(scene)});
  document.getElementById('map-loading').hidden=true;
}).catch(()=>{document.getElementById('map-loading').textContent='The sample map could not load. Reload to try again.';});
addEventListener('pagehide',()=>{stopped=true;clearInterval(clockId);ui?.destroy();map.destroy();},{once:true});
