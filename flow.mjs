import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {instruments,getIntraday} from './market.mjs';
import {analyzeFlows} from './alerts.mjs';
const flowMarkets=new Map();
export const watchlist=instruments.filter(i=>i.sector.endsWith('ETF')&&['sh510300','sh512100'].includes(i.symbol));
export const FLOW_SOURCE='东方财富资金流向';
export const FLOW_METHOD='主力净额为来源口径的大单与超大单净额之和；不代表机构身份。单位：元。';
export function parseFlow(json,symbol,collectedAt=new Date().toISOString()){
  return parseFlowSeries(json,symbol,collectedAt).at(-1);
}
export function parseFlowSeries(json,symbol,collectedAt=new Date().toISOString()){
  const d=json?.data;
  if(json?.rc!==0||d?.code!==symbol.slice(2)||!Array.isArray(d.klines))throw Error('来源未提供有效资金数据');
  const rows=d.klines.map(line=>{
  if(typeof line!=='string')throw Error('资金字段不完整');
  const f=line.split(',');
  if(!/^\d{4}-\d{2}-\d{2} (?:09:(?:3\d|[45]\d)|10:\d{2}|11:(?:[012]\d|30)|13:\d{2}|14:\d{2}|15:00)$/.test(f[0]))throw Error('资金时间不在有效交易时段');
  if(!f||f.length<6||f.slice(1,6).some(x=>x.trim()===''||!Number.isFinite(Number(x))))throw Error('资金字段不完整');
  const [main,small,medium,large,superLarge]=f.slice(1,6).map(Number);
  if(Math.abs(main-large-superLarge)>Math.max(10,Math.abs(main)*.001))throw Error('资金字段校验失败');
  const sourceTime=f[0].replace(' ','T')+':00+08:00';
  if(!Number.isFinite(Date.parse(sourceTime))||Date.parse(sourceTime)>Date.parse(collectedAt)||new Date(Date.parse(sourceTime)+8*3600000).toISOString().slice(0,16)!==f[0].replace(' ','T'))throw Error('来源时间异常');
  return {symbol,date:f[0].slice(0,10),sourceTime,collectedAt,main,small,medium,large,superLarge,source:FLOW_SOURCE,origin:'upstream-minute-series'};
  });
  if(!rows.length)throw Error('来源未提供有效资金数据');
  return [...new Map(rows.map(r=>[r.sourceTime,r])).values()].sort((a,b)=>a.sourceTime.localeCompare(b.sourceTime));
}
export class FlowStore{
  constructor(directory){this.directory=directory;this.data={};this.queue=Promise.resolve();}
  async load(){try{const raw=JSON.parse(await readFile(new URL('snapshots.json',this.directory),'utf8'));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid flow store');this.data=raw;}catch(e){if(e.code!=='ENOENT')throw e;}}
  async add(snapshot){
    return this.addMany([snapshot]);
  }
  async addMany(snapshots){
    if(!snapshots.length)return;
    this.queue=this.queue.then(async()=>{
      const next={...this.data},groups=new Map();
      for(const snapshot of snapshots){
      const key=snapshot.symbol+'|'+snapshot.date;
      if(!groups.has(key))groups.set(key,new Map((next[key]||[]).map(p=>[p.sourceTime,p])));
      const rows=groups.get(key),previous=rows.get(snapshot.sourceTime);
      // One point per upstream timestamp: no flat synthetic points on repeated polling.
      rows.set(snapshot.sourceTime,{...previous,...snapshot,collectedAt:previous?.collectedAt||snapshot.collectedAt});
      }
      for(const [key,rows] of groups)next[key]=[...rows.values()].sort((a,b)=>a.sourceTime.localeCompare(b.sourceTime));
      await mkdir(this.directory,{recursive:true});
      await writeFile(new URL('snapshots.json.tmp',this.directory),JSON.stringify(next));
      await rename(new URL('snapshots.json.tmp',this.directory),new URL('snapshots.json',this.directory));
      this.data=next;
    });
    try{await this.queue;}catch(e){this.queue=Promise.resolve();throw e;}
  }
  latest(symbol){const keys=Object.keys(this.data).filter(k=>k.startsWith(symbol+'|')).sort();const samples=this.data[keys.at(-1)]||[];return {snapshot:samples.at(-1)||null,samples};}
}
export const store=new FlowStore(new URL('./data/',import.meta.url));
const status=new Map();let pending=null,lastAttempt=0;
async function fetchFlow(symbol){
  const secid=(symbol.startsWith('sh')?'1.':'0.')+symbol.slice(2);
  const url='https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid='+secid+'&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63';
  const response=await fetch(url,{signal:AbortSignal.timeout(8000),headers:{'User-Agent':'Mozilla/5.0','Referer':'https://quote.eastmoney.com/'}});
  if(!response.ok)throw Error('来源请求失败');
  return parseFlowSeries(await response.json(),symbol);
}
export async function pollFlows(){
  if(pending)return pending;
  if(Date.now()-lastAttempt<55000)return;
  lastAttempt=Date.now();
  pending=(async()=>{
    // Two requests at a time; every watched instrument is sampled even when unselected.
    for(let i=0;i<watchlist.length;i+=2)await Promise.all(watchlist.slice(i,i+2).map(async item=>{
      try{const samples=await fetchFlow(item.symbol);
      // Quote failures do not suppress successful money-flow samples.
      try{const market=await getIntraday(item.symbol);flowMarkets.set(item.symbol,market);const points=new Map(market.points.map(p=>[p.time,p]));for(const snap of samples){const p=market.date===snap.date?points.get(snap.sourceTime.slice(11,16)):null;if(p)snap.market={...p,sourceTime:snap.sourceTime,source:market.source||'腾讯分时行情',stale:!!market.stale};}}catch{}
      await store.addMany(samples);status.set(item.symbol,{stale:false,lastAttemptAt:new Date().toISOString(),error:null});}
      catch{status.set(item.symbol,{stale:true,lastAttemptAt:new Date().toISOString(),error:'资金源暂不可用或不支持该标的，稍后自动重试'});}
    }));
  })();
  try{await pending;}finally{pending=null;}
}
export function getFlow(symbol){
  const result=store.latest(symbol);const state=status.get(symbol)||{stale:true,error:'等待资金采集',lastAttemptAt:null};
  return {...result,...state,alerts:analyzeFlows(result.samples,flowMarkets.get(symbol)),source:FLOW_SOURCE,method:FLOW_METHOD,pollIntervalSeconds:60,status:result.snapshot?'available':state.lastAttemptAt?'unavailable':'loading',historical:result.snapshot?Date.now()-Date.parse(result.snapshot.sourceTime)>180000:true};
}
export async function startFlowSampler(){await store.load();void pollFlows();const timer=setInterval(()=>void pollFlows(),60000);timer.unref();return timer;}
