import { DEMO_NOW, DEMO_START } from './demo-data.js';
import { RESEARCH_LEVELS, demoInvestigations, researchWorldSignals } from './research-data.js';

const HOUR = 3_600_000;
const normal = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
const stamp = value => new Date(value).toISOString();

export function initResearchWorkspace({map,onScene=()=>{},documentRef=document}={}) {
  const win=documentRef.defaultView||globalThis, cleanup=[],saved=new Map(),drafts=new Map();
  const n=id=>documentRef.getElementById(id);
  let trail=[],depth=1,tab='findings',time=DEMO_NOW,selectedNodeId=null,signal=null,savedView=false;
  let playing=false,frame=null,stopped=false,playFrom=0,playStarted=0,lastPaint=0;
  const listen=(target,event,fn)=>{target?.addEventListener(event,fn);cleanup.push(()=>target?.removeEventListener(event,fn));};
  const el=(tag,classes,text)=>{const node=documentRef.createElement(tag);if(classes)node.className=classes;if(text!==undefined)node.textContent=text;return node;};
  const text=(id,value)=>{if(n(id))n(id).textContent=value;};
  const show=(id,visible)=>{if(n(id))n(id).hidden=!visible;};
  const announce=value=>text('announcement',value);
  const current=()=>demoInvestigations.find(item=>item.id===trail.at(-1)?.id)||null;
  const evidenceFor=item=>(item?.evidence||[]).filter(record=>record.at<=time);
  const admitted=(item,evidence)=>!item.evidenceIds?.length||item.evidenceIds.every(id=>evidence.some(record=>record.id===id));

  function threadView(item){const base=item?.levels?.[depth];if(!base||trail.length<2)return base;
    const entry=trail.at(-1),ignore=new Set(['which','where','would','could','should','about','actually','matter','taiwan','semiconductor','semiconductors','space','project','energy','europe','sample','evidence','dependencies','supply','chain','trace','investigate']);
    const words=normal(entry.query.split(':').at(-1)).split(' ').filter(word=>word.length>3&&!ignore.has(word));
    const nodeIds=new Set((item.edges||[]).filter(edge=>[edge.from,edge.to].includes(entry.nodeId)).flatMap(edge=>edge.evidenceIds||[]));
    const matching=item.evidence.filter(record=>nodeIds.has(record.id)||words.some(word=>normal(`${record.label} ${record.detail}`).includes(word)));
    const candidateIds=new Set(matching.map(record=>record.id)),seen=new Set();
    const findings=[...base.findings,...Object.values(item.levels).flatMap(level=>level.findings)].filter(finding=>{
      if(seen.has(finding.title)||!(finding.evidenceIds?.some(id=>candidateIds.has(id))||words.some(word=>normal(`${finding.title} ${finding.body}`).includes(word))))return false;seen.add(finding.title);return true;
    }).slice(0,3);
    if(!findings.length)findings.push({title:'A useful gap to investigate',body:'The prepared scenario has no source fixture that answers this branch. The next investigation would seek original records, compare alternative explanations and establish what remains unknown.',evidenceIds:[]});
    const focusRecords=matching.sort((a,b)=>words.filter(word=>normal(`${b.label} ${b.detail}`).includes(word)).length-words.filter(word=>normal(`${a.label} ${a.detail}`).includes(word)).length).slice(0,2);
    return {heading:entry.label,summary:`Following a branch of ${item.title.toLowerCase()}. These sample findings focus on the connection you selected.`,findings,focusRecords,questions:(item.questions||[]).filter(question=>question.query!==entry.query)};
  }

  function match(query){const term=normal(query),words=term.split(' ');return demoInvestigations.map(item=>{
    const aliases=[item.query,item.id,...(item.aliases||[])].map(normal);
    const score=aliases.reduce((best,alias)=>Math.max(best,term===alias?100:alias.length>3&&term.includes(alias)?30:0),0)
      + ['taiwan','semiconductor','chips','athena','space','satellite','orbit','energy','gas','electricity'].filter(word=>words.includes(word)&&aliases.some(alias=>alias.split(' ').includes(word))).length*5;
    return {item,score};}).sort((a,b)=>b.score-a.score).find(value=>value.score>0)?.item||null;}
  function branch(question){const button=el('button','branch-button');button.type='button';button.append(el('span','branch-label',question.label),el('span','branch-reason',question.why||'Follow this connection'));
    button.addEventListener('click',()=>runQuery(question.query||question.label,{branch:true}));return button;}
  function refs(ids,evidence){const host=el('div','research-meta');for(const id of ids||[]){const record=evidence.find(value=>value.id===id);if(!record)continue;const button=el('button','evidence-reference',record.label);button.type='button';
    button.addEventListener('click',()=>{tab='evidence';render();n('research-body')?.querySelector(`[data-evidence="${CSS.escape(id)}"]`)?.scrollIntoView({block:'nearest',behavior:'smooth'});});host.append(button);}return host;}
  function renderTrail(){const host=n('research-trail');if(host){host.replaceChildren();const start=el('button','trail-crumb','Explore');start.type='button';start.addEventListener('click',home);host.append(start);
    trail.forEach((entry,index)=>{host.append(el('span','trail-separator','/'));const button=el('button','trail-crumb',entry.label);button.type='button';button.title=entry.query;if(index===trail.length-1)button.setAttribute('aria-current','step');button.addEventListener('click',()=>restore(index));host.append(button);});}
    if(n('trail-back'))n('trail-back').disabled=trail.length<2;show('trail-reset',Boolean(trail.length||signal));}
  function renderGuidance(item){const host=n('guidance-list');if(!host)return;host.replaceChildren();let questions=[...(item?.levels?.[depth]?.questions||[]),...(item?.questions||[])];
    if(!item)questions=[{label:'I’m building something',why:'Find questions and constraints you have not considered.',query:'I am building a space project'},
      {label:'Why does this matter?',why:'Trace companies, policies and dependencies.',query:'Taiwan and semiconductors'},
      {label:'What affects my everyday life?',why:'Explore energy, prices and their connections.',query:'European energy'}];
    const seen=new Set();for(const question of questions){if(seen.has(question.query))continue;seen.add(question.query);host.append(branch(question));if(seen.size>=3)break;}}
  function renderCommunity(item,evidence){show('community-section',Boolean(item&&tab==='evidence'&&!savedView));const host=n('community-notes');if(!host)return;host.replaceChildren();
    for(const note of [...(item?.communityNotes||[]).filter(value=>admitted(value,evidence)),...(drafts.get(item?.id)||[])]){
      const card=el('article','community-card');card.dataset.stance=note.stance;card.append(el('span','research-meta',`${note.local?'Your local draft':'Sample note'} · ${note.stance}`),el('p','',note.body),refs(note.evidenceIds,evidence));host.append(card);}
    if(!host.children.length)host.append(el('p','research-note','No sample notes at this point in the timeline.'));}
  function results(item){const host=n('research-body');if(!host)return;host.replaceChildren();const evidence=evidenceFor(item),level=threadView(item);
    if(signal){const card=el('article','research-card');card.append(el('span','research-meta','Fictional intake scenario'),el('h3','',signal.headline),el('p','',signal.summary),el('p','research-note','Illustrative location. No live report or verified incident is implied.'));host.append(card);
      const linked=demoInvestigations.find(value=>value.id===signal.investigationId);if(linked)host.append(branch({label:'Explore the wider context',why:linked.title,query:linked.query}));return;}
    if(!item)return;
    if(tab==='findings'){const questions=[...(level?.questions||[]),...(item.questions||[])].filter((question,index,array)=>question.query!==trail.at(-1)?.query&&array.findIndex(value=>value.query===question.query)===index).slice(0,5);
      if(questions.length){const next=el('div','next-questions thread-next');next.append(el('span','eyebrow','YOUR NEXT THREAD'),branch(questions[0]));host.append(next);}
      for(const record of level?.focusRecords||[]){if(!evidence.some(value=>value.id===record.id))continue;const card=el('article','research-card branch-focus');card.append(el('span','research-meta','EVIDENCE FOR THIS BRANCH · FIXTURE'),el('h3','',record.label),el('p','',record.detail),refs([record.id],evidence));host.append(card);}
      const findings=(level?.findings||[]).filter(value=>admitted(value,evidence));for(const finding of findings){const card=el('article','research-card');card.append(el('h3','',finding.title),el('p','',finding.body),refs(finding.evidenceIds,evidence));host.append(card);}
      if(!findings.length)host.append(el('p','research-note','No prepared findings at this point in the sample history. Move the timeline forward.'));
      const next=el('div','next-questions');next.append(el('span','eyebrow','OTHER DIRECTIONS'));for(const question of questions.slice(1))next.append(branch(question));host.append(next);
    }else if(tab==='connections'){for(const edge of (item.edges||[]).filter(value=>admitted(value,evidence))){const from=item.nodes.find(value=>value.id===edge.from),to=item.nodes.find(value=>value.id===edge.to);if(!from||!to)continue;
      const card=el('article','connection-card');card.dataset.kind=edge.kind;card.append(el('span','research-meta',edge.kind==='hypothesis'?'Sample hypothesis':'Relationship in sample evidence'),el('h3','',`${from.label} → ${to.label}`),el('p','',edge.label),refs(edge.evidenceIds,evidence));
      const button=el('button','connection-explore','Follow this connection ↗');button.type='button';button.addEventListener('click',()=>runQuery(`${item.query}: ${edge.label}`,{branch:true,label:to.label,nodeId:to.id}));card.append(button);host.append(card);}
      host.append(el('p','research-note','Fictional evidence relationships. A connection alone does not establish causality.'));
    }else{for(const record of evidence){const card=el('article','evidence-card');card.dataset.evidence=record.id;card.append(el('span','research-meta',`${record.kind} · Fixture`),el('h3','',record.label),el('p','',record.detail),el('time','research-meta',stamp(record.at).slice(0,16).replace('T',' ')+' UTC'));host.append(card);}
      if(!evidence.length)host.append(el('p','research-note','No source fixtures at this sample time.'));}
    renderCommunity(item,evidence);}
  function worldFeed(){const host=n('world-feed-list');if(!host)return;host.replaceChildren();for(const entry of researchWorldSignals.filter(value=>value.at<=time).slice(0,4)){
    const button=el('button','world-feed-item');button.type='button';button.dataset.category=entry.category;button.append(el('span','feed-icon',entry.category==='natural'?'◈':entry.category==='economy'?'↗':'⌁'));
    const copy=el('span','feed-copy');copy.append(el('span','feed-title',entry.headline),el('span','feed-meta',`${entry.region||entry.place||'World'} · ${Math.max(0,Math.round((time-entry.at)/60_000))}m · Sample`));button.append(copy);button.addEventListener('click',()=>selectSignal(entry.id));host.append(button);}
    if(!host.children.length)host.append(el('p','research-note','No fictional arrivals in this time window.'));}
  function savedResults(){const host=n('research-body');if(!host)return;host.replaceChildren();if(!saved.size){host.append(el('article','research-card','Your saved trails will appear here. Open an inquiry and save a thread to try it.'));return;}
    for(const entry of saved.values()){const card=el('article','research-card');card.append(el('span','research-meta',`Local session · depth ${entry.depth}`),el('h3','',entry.query));const button=el('button','connection-explore','Reopen this trail ↗');button.type='button';button.addEventListener('click',()=>{trail=entry.trail.map(value=>({...value}));depth=entry.depth;selectedNodeId=trail.at(-1)?.nodeId||null;savedView=false;signal=null;render();focus();});card.append(button);host.append(card);}}
  function timeline(){text('timeline-date',new Date(time).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}));text('timeline-readout',stamp(time).slice(11,16)+' UTC · Sample');
    if(n('timeline-input'))n('timeline-input').value=String(Math.round((time-DEMO_START)/(DEMO_NOW-DEMO_START)*1000));
    n('timeline-now')?.setAttribute('aria-pressed',String(time===DEMO_NOW));n('timeline-play')?.setAttribute('aria-pressed',String(playing));n('timeline-play')?.setAttribute('aria-label',playing?'Pause sample history':'Play sample history');
    if(n('timeline-play'))n('timeline-play').innerHTML=playing?'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4v12M14 4v12"/></svg>':'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6V4Z"/></svg>';
    const host=n('timeline-detail');if(host){host.replaceChildren();for(const record of (current()?.developments||[]).filter(value=>value.at<=time).slice(-4)){const row=el('article','timeline-entry');row.append(el('time','research-meta',stamp(record.at).slice(5,16).replace('T',' ')+' UTC'),el('h4','',record.title),el('p','',record.body));host.append(row);}}}
  function render(){if(stopped)return;if(signal?.at>time)signal=null;const item=current(),entry=trail.at(-1),evidence=evidenceFor(item),open=Boolean(item||signal||savedView);
    n('atlas')?.classList.toggle('is-researching',open);show('research-empty',!open);show('research-workspace',open);show('world-feed',!item&&!savedView);show('research-guidance',!item&&!savedView);
    text('depth-description',RESEARCH_LEVELS.find(value=>value.id===depth)?.description||RESEARCH_LEVELS.find(value=>value.id===depth)?.subtitle||'');
    for(const button of n('depth-controls')?.querySelectorAll('[data-depth]')||[]){const active=Number(button.dataset.depth)===depth;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));}
    for(const button of n('research-tabs')?.querySelectorAll('[data-tab]')||[]){const active=button.dataset.tab===tab;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));}
    text('research-title',savedView?'Your research trails':signal?.headline||entry?.query||item?.title||'');
    text('research-kicker',savedView?'SAVED / THIS SESSION':signal?'WORLD / SAMPLE INTAKE':`${depth} / ${RESEARCH_LEVELS.find(value=>value.id===depth)?.label||'Research'} · Prepared sample`);
    text('research-summary',savedView?'Return to a thread and continue exploring.':signal?.summary||threadView(item)?.summary||item?.summary||'');
    text('research-status',item?`${evidence.length} source fixtures · ${trail.length} ${trail.length===1?'step':'steps'} · Sample synthesis available`:'Interactive preview · three prepared inquiries');
    show('research-follow',Boolean(item&&!savedView));text('research-follow',saved.has(entry?.query)?'Saved for this session':'Save this trail');n('research-follow')?.setAttribute('aria-pressed',String(saved.has(entry?.query)));text('followed-count',String(saved.size));
    show('research-tabs',!savedView&&!signal);show('community-section',Boolean(item&&tab==='evidence'&&!savedView));
    renderTrail();renderGuidance(item);worldFeed();timeline();if(savedView)savedResults();else results(item);
    onScene({mode:item&&!savedView?'research':'world',nodes:item?.nodes||[],edges:(item?.edges||[]).filter(value=>admitted(value,evidence)),worldSignals:researchWorldSignals.filter(value=>value.at<=time),depth,time,selectedNodeId:selectedNodeId||signal?.id||null});
    const nav=savedView?'saved':item?'research':'world';for(const button of documentRef.querySelectorAll('[data-nav]')){button.classList.toggle('is-active',button.dataset.nav===nav);button.setAttribute('aria-pressed',String(button.dataset.nav===nav));}}
  function focus(){const item=current();if(!item)return;const node=item.nodes.find(value=>value.id===selectedNodeId);if(node)map?.focus(node.lon,node.lat,2);else map?.focus(10,15,1);}
  function pause(){playing=false;if(frame!==null)win.cancelAnimationFrame(frame);frame=null;}
  function runQuery(query,{branch:asBranch=false,label,nodeId}={}){const clean=String(query||'').trim().slice(0,600);if(clean.length<2){n('research-query')?.focus();return;}pause();const item=match(clean);signal=null;savedView=false;if(n('research-query'))n('research-query').value=clean;
    if(!item){trail=[];selectedNodeId=null;render();text('map-title','A world worth understanding.');text('research-status','No prepared sample matches this inquiry. Try a starter or describe a space project.');text('map-subtitle','This preview does not run live searches.');announce('No prepared sample for this inquiry. Live research is not connected.');return;}
    const entry={id:item.id,query:clean,label:label||clean.split(':').at(-1).trim().slice(0,38),nodeId:nodeId||null,depth};trail=asBranch&&trail.length?[...trail,entry].slice(-12):[entry];selectedNodeId=entry.nodeId;tab='findings';
    text('map-title',item.title);text('map-subtitle','Follow a node. Explore a connection. Keep your trail.');render();focus();announce(`Opened a prepared fictional inquiry at depth ${depth}: ${clean}`);}
  function restore(index){if(!trail[index])return;pause();trail=trail.slice(0,index+1);depth=trail.at(-1).depth||depth;selectedNodeId=trail.at(-1).nodeId||null;tab='findings';savedView=false;signal=null;render();focus();}
  function home(){pause();trail=[];selectedNodeId=null;signal=null;savedView=false;tab='findings';text('map-title','A world worth understanding.');text('map-subtitle','Explore the sample world, or follow a question.');render();map?.home();}
  function selectSignal(id){const entry=researchWorldSignals.find(value=>value.id===id&&value.at<=time);if(!entry)return;pause();trail=[];selectedNodeId=null;signal=entry;savedView=false;render();map?.focus(entry.lon,entry.lat,2);announce(`Inspecting fictional sample: ${entry.headline}`);}
  function selectMapItem(selection){if(selection.kind==='signal'){selectSignal(selection.id);return;}const item=current(),node=item?.nodes.find(value=>value.id===selection.id);if(node)runQuery(`${item.query}: ${node.label}`,{branch:true,label:node.label,nodeId:node.id});}
  function tick(timestamp){if(!playing||stopped)return;time=Math.min(DEMO_NOW,playFrom+(timestamp-playStarted)*12*HOUR/1000);if(timestamp-lastPaint>120||time===DEMO_NOW){lastPaint=timestamp;render();}if(time===DEMO_NOW){pause();timeline();return;}frame=win.requestAnimationFrame(tick);}
  function initTimeline(){const input=n('timeline-input');if(input){input.min='0';input.max='1000';input.step='1';}const ticks=n('timeline-ticks');if(ticks){ticks.replaceChildren();for(let step=0;step<8;step++)ticks.append(el('span','',new Date(DEMO_START+step*24*HOUR).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'})));}
    const chart=n('activity-chart');if(chart){chart.replaceChildren();const dates=[...researchWorldSignals.map(value=>value.at),...demoInvestigations.flatMap(value=>value.developments.map(record=>record.at))];for(let i=0;i<42;i++){const start=DEMO_START+i*(DEMO_NOW-DEMO_START)/42,count=dates.filter(value=>value>=start&&value<start+(DEMO_NOW-DEMO_START)/42).length;const bar=el('span','');bar.style.height=`${Math.min(100,8+count*18)}%`;chart.append(bar);}}}
  listen(n('research-form'),'submit',event=>{event.preventDefault();runQuery(n('research-query')?.value);});
  listen(n('research-query'),'keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();runQuery(n('research-query').value);}});
  listen(n('starter-queries'),'click',event=>{const button=event.target.closest('[data-query]');if(button)runQuery(button.dataset.query);});
  listen(n('depth-controls'),'click',event=>{const button=event.target.closest('[data-depth]');if(!button)return;depth=Math.max(1,Math.min(5,Number(button.dataset.depth)||1));if(trail.length)trail.at(-1).depth=depth;render();announce(`Research depth ${depth}: ${RESEARCH_LEVELS.find(value=>value.id===depth)?.label}`);});
  listen(n('research-tabs'),'click',event=>{const button=event.target.closest('[data-tab]');if(button){tab=button.dataset.tab;render();}});
  listen(n('research-follow'),'click',()=>{const entry=trail.at(-1);if(!entry)return;saved.set(entry.query,{query:entry.query,depth,trail:trail.map(value=>({...value}))});render();announce('Trail saved for this browser session.');});
  listen(n('research-close'),'click',home);listen(n('trail-reset'),'click',home);listen(n('trail-back'),'click',()=>restore(trail.length-2));
  listen(n('community-note-form'),'submit',event=>{event.preventDefault();const item=current(),body=String(n('community-note')?.value||'').trim().slice(0,500);if(!item||!body)return;const list=drafts.get(item.id)||[];if(list.length>=12){announce('The preview allows twelve local notes per inquiry.');return;}
    const stance=['support','challenge','context'].includes(n('community-note-kind')?.value)?n('community-note-kind').value:'context';list.push({body,stance,local:true,evidenceIds:[]});drafts.set(item.id,list);n('community-note').value='';render();announce('Local draft added. It has not been published or verified.');});
  listen(n('timeline-input'),'input',()=>{pause();time=DEMO_START+(Number(n('timeline-input').value)/1000)*(DEMO_NOW-DEMO_START);if(signal&&signal.at>time)signal=null;render();});
  listen(n('timeline-now'),'click',()=>{pause();time=DEMO_NOW;render();});
  listen(n('timeline-play'),'click',()=>{if(playing){pause();timeline();return;}if(time===DEMO_NOW)time=DEMO_START;playing=true;playFrom=time;playStarted=win.performance.now();lastPaint=0;render();frame=win.requestAnimationFrame(tick);});
  listen(n('timeline-expand'),'click',()=>{const expanded=n('timeline-expand').getAttribute('aria-expanded')==='true';n('timeline-expand').setAttribute('aria-expanded',String(!expanded));show('timeline-detail',!expanded);});
  listen(n('map-home'),'click',home);listen(n('map-zoom-in'),'click',()=>map?.zoomBy(1.5));listen(n('map-zoom-out'),'click',()=>map?.zoomBy(1/1.5));
  for(const button of documentRef.querySelectorAll('[data-nav]'))listen(button,'click',()=>{if(button.dataset.nav==='world')home();else if(button.dataset.nav==='saved'){savedView=true;signal=null;render();}else if(button.dataset.nav==='community'){if(!current())runQuery('Taiwan and semiconductors');tab='evidence';render();n('community-section')?.scrollIntoView({block:'nearest',behavior:'smooth'});}else{if(!current())runQuery('Taiwan and semiconductors');n('research-query')?.focus();}});
  listen(documentRef,'visibilitychange',()=>{if(documentRef.hidden){pause();timeline();}});
  listen(documentRef,'keydown',event=>{if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(event.target?.tagName)){event.preventDefault();n('research-query')?.focus();}if(event.key==='Escape'&&!['INPUT','TEXTAREA'].includes(event.target?.tagName))home();});
  initTimeline();render();return {runQuery,selectMapItem,getState:()=>({depth,tab,time,trail:trail.map(value=>({...value})),saved:saved.size,playing}),destroy(){stopped=true;pause();cleanup.forEach(fn=>fn());}};
}
