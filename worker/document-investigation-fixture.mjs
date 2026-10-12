// Test-only real SQLite + actual Drizzle table definitions. No hosted receipts.
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as documentTables from '../db/document-investigation-schema.ts';
import * as pluginTables from '../db/plugin-schema.ts';
import { runSourcePlugin } from './plugins/store.js';
import { EC_PRESS_PLUGIN, collectEcPress, ecPressItems } from './plugins/ec-press.js';
import { EC_DOCUMENT_POLICY as P } from '../src/core/document-evidence.js';
import { pluginBytesDigest } from '../src/core/plugin-evidence.js';

const UTF8=new TextEncoder();
export const CLOCK=Date.parse('2026-10-12T02:30:00.000Z');
export const SENTENCES=Object.freeze({
  'eu-icc-position':'The European Union has been a constant supporter of the International Criminal Court (ICC).',
  'eu-icc-commitment':'The EU will work closely with the ICC to ensure it continues to operate effectively.',
  'reported-us-sanctions-intent':'It is deeply regrettable that the United States has announced intentions to impose sanctions.',
  'reported-relative-delay':'As there is a six-month delay before the measures are applicable, there is room for dialogue.',
});
export async function syntheticAnalysis(raw) {
  const text=`TEST ONLY 😀\nEuropean Commission - Statement\n${P.title}\nBrussels, 9 October 2026\n${Object.values(SENTENCES).join('\n')}\nSTATEMENT/26/2127`;
  const citations=Object.entries(SENTENCES).map(([selector,exact])=>{const at=text.indexOf(exact),start=[...text.slice(0,at)].length;
    return {selector,page:1,start,end:start+[...exact].length,exact};});
  return {extraction:{schemaVersion:1,policyId:P.id,sourceUrl:P.downloadUrl,inputMode:'stdin',acquiredAt:null,
    rawPdfSha256:await pluginBytesDigest(raw),rawPdfBytes:raw.byteLength,
    extractor:{name:'pypdf',version:'6.10.0',mode:'default-extract-text',normalization:'none',offsetUnit:'unicode-code-points'},
    pages:[{page:1,text,textSha256:await pluginBytesDigest(UTF8.encode(text)),characters:[...text].length}],pdfCreationDateRaw:null,
    runtime:{mode:'local-supervised',wallTimeSeconds:20,peakMemoryEnforced:false}},citations,
    execution:{mode:'windows-job-object',memoryMeaning:'committed-virtual-memory',processMemoryLimitBytes:64*1024*1024,
      jobMemoryLimitBytes:96*1024*1024,processesLimit:2,wallSeconds:20,inputBytesLimit:512*1024,stdoutBytesLimit:1024*1024,
      stderrBytesLimit:64*1024,nativeReportedPeakProcessBytes:20*1024*1024,nativeReportedPeakJobBytes:32*1024*1024,
      activeProcessesAfterCleanup:0,jobListAppliedBeforeExecution:true,hostAlreadyInJob:true,exitCode:0,environment:'minimal-without-producer-credentials'}};
}
export const syntheticPdf=label=>UTF8.encode(`%PDF-1.4\nTEST ONLY ${label} integrity fixture, not an authentic source document`);

export async function documentFixture(t,{documents=true}={}) {
  let clock=CLOCK,sqlHook=null,objectHook=null,serial=0;
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.function('strftime',{varargs:true},(format,value,...modifiers)=>{
    if(format!=='%Y-%m-%dT%H:%M:%fZ'||value!=='now')throw Error('Unexpected fixture clock');
    let out=clock;for(const modifier of modifiers){const match=/^([+-]?\d+(?:\.\d+)?) (second|minute|hour)s?$/.exec(modifier);
      if(!match)throw Error('Fixture clock modifier');out+=Number(match[1])*({second:1000,minute:60000,hour:3600000})[match[2]];}
    return new Date(out).toISOString();
  });
  for(const table of [...Object.values(pluginTables),...(documents?Object.values(documentTables):[])]){
    const config=getTableConfig(table),columns=config.columns.map(column=>`"${column.name}" ${column.getSQLType()}${column.notNull?' NOT NULL':''}${column.primary?' PRIMARY KEY':''}`);
    for(const pk of config.primaryKeys)columns.push(`PRIMARY KEY (${pk.columns.map(column=>`"${column.name}"`).join(',')})`);
    sqlite.exec(`CREATE TABLE "${config.name}" (${columns.join(',')})`);
    for(const index of config.indexes)sqlite.exec(`CREATE ${index.config.unique?'UNIQUE ':''}INDEX "${index.config.name}" ON "${config.name}" (${index.config.columns.map(column=>`"${column.name}"`).join(',')})`);
  }
  const activity={sql:[],objects:[],providers:[]},objects=new Map();
  const store={
    async get(key){activity.objects.push({operation:'get',key});await objectHook?.({operation:'get',key});const value=objects.get(key);
      return value?{size:value.byteLength,arrayBuffer:async()=>new Uint8Array(value).buffer}:null;},
    async put(key,body,options={}){activity.objects.push({operation:'put',key});await objectHook?.({operation:'put',key,body});
      if(options.onlyIf?.get?.('if-none-match')==='*'&&objects.has(key))return null;
      objects.set(key,body instanceof Uint8Array?new Uint8Array(body):UTF8.encode(body));return {etag:`"test-${++serial}"`};},
  };
  const db={
    withSession(mode){if(mode!=='first-primary')throw Error('Primary session required');return this;},
    prepare(sql){const bind=(...values)=>{
      if(values.length>100)throw Error('D1 parameter budget');
      const execute=async()=>{const write=!/^\s*(SELECT|EXPLAIN)/i.test(sql);activity.sql.push({sql,values,write});
        await sqlHook?.({phase:'before',sql,values,write});const statement=sqlite.prepare(sql),results=statement.all(...values);
        const changes=write?Number(sqlite.prepare('SELECT changes() AS n').get().n):0;
        await sqlHook?.({phase:'after',sql,values,write});return {success:true,results,meta:{changes}};};
      return {sql,values,all:execute,run:execute,first:async()=>(await execute()).results[0]||null};
    };return {...bind(),bind};},
    async batch(statements){if(statements.length>16)throw Error('Publication statement budget');sqlite.exec('BEGIN');
      try{const out=[];for(const statement of statements)out.push(await statement.all());sqlite.exec('COMMIT');return out;}
      catch(error){sqlite.exec('ROLLBACK');throw error;}}
  };
  const env={EARTH_DB:db,EARTH_STORE:store},now=()=>clock;
  async function source(label='A',{other=false,force=false}={}) {
    if(force)sqlite.prepare("UPDATE earth_plugin_state SET next_check_at=? WHERE plugin_id='ec-press-v1'").run(new Date(clock).toISOString());
    const extra=other?'<item><title>TEST ONLY unrelated publication</title><link>https://ec.europa.eu/commission/presscorner/detail/en/speech_26_999999</link><guid>https://ec.europa.eu/commission/presscorner/detail/en/speech_26_999999</guid><pubDate>Fri, 09 Oct 2026 12:15:20 GMT</pubDate></item>':'';
    const xml=`<rss version="2.0"><channel><title>Press releases - RSS</title><link>https://ec.europa.eu/commission/presscorner/api/rss?</link><description>TEST ONLY fixture</description><language>EN</language><item><title>${P.title}</title><link>${P.pageUrl}</link><guid>${P.pageUrl}</guid><pubDate>Fri, 09 Oct 2026 12:14:20 GMT</pubDate><category>POLICY_AREA=TEST${label}</category></item>${extra}</channel></rss>`;
    return runSourcePlugin(env,{...EC_PRESS_PLUGIN,collect:collectEcPress,items:ecPressItems},{now,fetchImpl:async(url)=>{
      activity.providers.push(url);return new Response(xml,{headers:{'content-type':'application/rss+xml'}});}});
  }
  return {env,sqlite,now,activity,objects,source,stamp:()=>new Date(clock).toISOString(),advance:ms=>{clock+=ms;},setClock:ms=>{clock=ms;},
    sqlHook:hook=>{sqlHook=hook;},objectHook:hook=>{objectHook=hook;},reset:()=>{activity.sql=[];activity.objects=[];activity.providers=[];}};
}
