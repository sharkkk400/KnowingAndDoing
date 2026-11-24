import {readFile,writeFile,mkdir,rename,appendFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {getDaily} from './market-context.mjs';
import {instruments} from './dist/instruments.js';
import {mergeShares,analyzeShares} from './shares-analysis.mjs';
const defs=instruments.filter(d=>d.sector.endsWith('ETF'));
const storeFile=new URL('./data/etf-shares.json',import.meta.url);
let state={version:1,rows:[],dates:[],sources:{},prices:{}},job=null,loaded=false,timer;
let progress={running:false,done:0,total:0};
async function save(){await mkdir(new URL('./data/',import.meta.url),{recursive:true});const tmp=new URL('./data/etf-shares.tmp',import.meta.url);await writeFile(tmp,JSON.stringify(state));await rename(tmp,storeFile);}
async function load(){if(loaded)return;try{const s=JSON.parse(await readFile(storeFile,'utf8'));if(s.version===1){s.rows=mergeShares([],s.rows);state=s;}}catch{}loaded=true;}
async function request(url,referer){const res=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0',Referer:referer},signal:AbortSignal.timeout(20000)});if(!res.ok)throw Error('交易所返回 '+res.status);const b=Buffer.from(await res.arrayBuffer());if(b.length>20000000)throw Error('报表超过大小限制');return b;}
export function parseSse(payload,date){
 const raw=typeof payload==='string'?JSON.parse(payload):payload;
 if(!Array.isArray(raw.result))throw Error('上交所返回格式异常');
 if(Number(raw.pageHelp?.total)>raw.result.length)throw Error('上交所返回分页不完整');
 const known=new Set(defs.filter(d=>d.symbol.startsWith('sh')).map(d=>d.code));
 const rows=raw.result.filter(r=>known.has(String(r.SEC_CODE)));
 if(rows.some(r=>r.STAT_DATE!==date))throw Error('上交所返回日期与请求不符');
 return mergeShares([],rows.map(r=>({symbol:'sh'+r.SEC_CODE,date:r.STAT_DATE,shares:Number(String(r.TOT_VOL).replaceAll(',',''))*10000,source:'上交所',fetchedAt:new Date().toISOString()})));
}
export function parseSzse(buffer){return new Promise((resolve,reject)=>{
 const child=execFile('python3',[fileURLToPath(new URL('./scripts/read-shares-xlsx.py',import.meta.url)),...defs.filter(d=>d.symbol.startsWith('sz')).map(d=>d.code)],{timeout:30000,maxBuffer:2000000},(err,out)=>{
  if(err)return reject(Error('深交所报表解析失败，请检查 Python 3 环境或报表格式'));
  try{resolve(mergeShares([],JSON.parse(out).map(r=>({...r,source:'深交所',fetchedAt:new Date().toISOString()}))));}catch{reject(Error('深交所份额字段异常'));}
 });child.stdin.on('error',()=>{});child.stdin.end(buffer);
});}
export async function sse(date){const u=new URL('https://query.sse.com.cn/commonQuery.do');u.search=new URLSearchParams({'isPagination':'true','pageHelp.pageSize':'10000','pageHelp.pageNo':'1',sqlId:'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L',STAT_DATE:date});return parseSse((await request(u,'https://www.sse.com.cn/')).toString(),date);}
export async function szse(start,end){const u=new URL('https://www.szse.cn/api/report/ShowReport');u.search=new URLSearchParams({SHOWTYPE:'xlsx',CATALOGID:'scsj_fund_jjgm',TABKEY:'tab1',txtStart:start,txtEnd:end,jjlb:'ETF'});const rows=await parseSzse(await request(u,'https://www.szse.cn/market/fund/volume/etf/index.html'));if(rows.some(r=>r.date<start||r.date>end))throw Error('深交所返回日期超出请求范围');return rows;}
async function recordShares(rows){
 const prior=new Map(state.rows.map(r=>[r.symbol+r.date,r.shares]));
 const changed=rows.filter(r=>prior.get(r.symbol+r.date)!==r.shares);
 if(changed.length)await appendFile(new URL('./data/etf-share-observations.jsonl',import.meta.url),JSON.stringify(changed)+'\n');
 state.rows=mergeShares(state.rows,rows);
}
export async function refreshShares(){
 if(job)return job;
 job=(async()=>{
  await load();progress={running:true,done:0,total:0};state.lastAttempt=new Date().toISOString();
  const base=await getDaily('sh000300');
  if(base.stale||!base.bars?.length)throw Error('交易日基准日线不可用，保留历史份额');
  const dates=base.bars.slice(-61).map(b=>b.date);state.dates=dates;delete state.error;
  const end=dates.at(-1),recent=dates.slice(-5),missing=(prefix)=>dates.filter(date=>defs.filter(d=>d.symbol.startsWith(prefix)).some(d=>!state.rows.some(r=>r.date===date&&r.symbol===d.symbol)));
  const shDates=[...new Set([...missing('sh'),...recent])].sort().reverse();
  const szStart=[...new Set([...missing('sz'),...recent])].sort()[0];
  progress.total=shDates.length+1;
  await Promise.all([
   (async()=>{let failures=0;state.sources.sh={status:'获取中'};for(const date of shDates){
    try{const rows=await sse(date);await recordShares(rows);state.sources.sh={...state.sources.sh,checkedAt:new Date().toISOString(),status:rows.length?'已连接':'所查日期尚无数据'};failures=0;}
    catch(e){state.sources.sh={checkedAt:new Date().toISOString(),error:e.message};failures++;}
    progress.done++;if(failures>=3)break;
   }})(),
   (async()=>{try{const rows=await szse(szStart,end);await recordShares(rows);state.sources.sz={checkedAt:new Date().toISOString(),status:rows.length?'已连接':'所查区间尚无数据'};}catch(e){state.sources.sz={checkedAt:new Date().toISOString(),error:e.message};}progress.done++;})()
  ]);
  let cursor=0;await Promise.all(Array.from({length:3},async()=>{while(cursor<defs.length){const d=defs[cursor++];state.prices[d.symbol]=await getDaily(d.symbol);}}));
  state.completedAt=new Date().toISOString();
 })().catch(e=>{state.error=e.message;}).finally(async()=>{progress.running=false;try{await save();}catch(e){state.error='份额存储失败：'+e.message;}job=null;});
 return job;
}
export async function getShares(){
 await load();const result=analyzeShares(defs,state.rows,state.dates,new Map(Object.entries(state.prices)));
 return {...result,progress:{...progress},sources:state.sources,error:state.error,lastAttempt:state.lastAttempt,completedAt:state.completedAt};
}
export async function startSharesCollector(){
 await load();void refreshShares();
 timer=setInterval(()=>{
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hour12:false}).format(new Date()));
  if([7,8,9,16,17,18,19,20,21,22].includes(hour)&&Date.now()-Date.parse(state.lastAttempt||'1970-01-01')>=3600000)void refreshShares();
 },300000);timer.unref();
}
