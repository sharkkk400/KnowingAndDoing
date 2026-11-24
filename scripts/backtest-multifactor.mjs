// Point-in-time inputs, paired rankings and fixed forward horizons.
import {readFile} from 'node:fs/promises';
import {instruments} from '../dist/instruments.js';
import {loadDaily} from '../daily-store.mjs';
import {buildMorningPlan} from '../morning-plan.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../data/'+name,import.meta.url),'utf8'));
const funds=instruments.filter(d=>d.sector.endsWith('ETF'));
const history=new Map(await Promise.all(instruments.map(async d=>[d.symbol,(await loadDaily(d.symbol))?.bars||[]])));
const sessions=history.get('sh000300').map(b=>b.date);
const bySymbol=new Map([...history].map(([s,b])=>[s,new Map(b.map(x=>[x.date,x]))]));
const versions=new Map();
let journal=[];
try{const lines=await readFile(new URL('../data/etf-share-observations.jsonl',import.meta.url),'utf8');journal=lines.trim().split('\n').filter(Boolean).flatMap((line=>JSON.parse(line)));}catch(e){if(e.code!=='ENOENT')throw e;}
for(const row of [...journal,...(await read('etf-share-history.json')).rows,...(await read('etf-shares.json')).rows]){
 const key=row.symbol+row.date;
 if(!versions.has(key))versions.set(key,[]);
 versions.get(key).push(row);
}
for(const v of versions.values())v.sort((a,b)=>Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt));
const snapshots=(await read('forecast-archive.json')).records;
function crowd(symbol,i,cutoff){
 const dates=sessions.slice(i-6,i);
 const values=dates.map(d=>versions.get(symbol+d)?.find(r=>Date.parse(r.fetchedAt)<cutoff)?.shares);
 if(values.every(n=>n>0)&&values.slice(1).every((n,k)=>Math.abs(n/values[k]-1)<=.25))return values[5]/values[0]-1;
 const s=snapshots.find(r=>r.symbol===symbol && Date.parse(r.observedAt)<cutoff && r.inputs?.shares?.five?.ready && r.inputs.shares.five.from===dates[0] && r.inputs.shares.five.to===dates[5]);
 return s?s.inputs.shares.five.pct/100:null;
}
const mean=a=>a.reduce((sum,x)=>sum+x,0)/a.length;
function factors(b){
 const c=b.map(x=>x.close),p=c.at(-1),v=b.slice(-25).map(x=>x.volume);
 if(v.some(n=>!Number.isFinite(n)||n<0)||!mean(v.slice(0,20)))return null;
 const returns=c.slice(-20).map((n,k)=>Math.log(n/c[c.length-21+k])),mu=mean(returns);
 let fast=c[0], slow=c[0], signal=0, diff=0, age=0;
 for(const n of c){fast+=(n-fast)*2/13;slow+=(n-slow)*2/27;diff=fast-slow;signal+=(diff-signal)*2/10;age=diff>0?age+1:0;}
 return [1-p/Math.max(...c.slice(-60)),1-p/mean(c.slice(-20)),p/c.at(-251)-1,
 Math.sqrt(252*mean(returns.map(x=>(x-mu)**2))),0,mean(v.slice(-5))/mean(v.slice(0,20)),2*(diff-signal)/p,age];
}
const weights=[.2,.2,.1,-.15,-.15,-.1,.1,.1];
const results=new Map();
const split=251+Math.floor((sessions.length-10-251)*.7);
for(let i=251;i+10<sessions.length;i++){
 if(i<split&&i+10>=split)continue;
 const date=sessions[i],now=Date.parse(date+'T08:00:00+08:00');
 const daily=new Map([...history].map(([s,b])=>[s,{bars:b.filter(x=>x.date<date).slice(-65)}]));
 const plan=buildMorningPlan({daily,now,news:{items:[],sources:[{status:'connected',lastSuccessAt:new Date(now-60000).toISOString()}]}});
 const universe=[];
 for(const {symbol} of funds){
  const series=bySymbol.get(symbol),bars=sessions.slice(i-251,i).map(d=>series.get(d));
  if(bars.some(b=>!b))continue;
  const f=factors(bars);
  universe.push({symbol,f,rs:bars.at(-1).close/bars.at(-21).close,eligible:plan.items.find(x=>x.symbol===symbol)?.stance==='conditional'});
 }
 for(const mode of ['strict','lag1','archive','seven']){
  const ranked=[];
  for(const x of universe){
   if(!x.f)continue;
   let flow=crowd(x.symbol,i,mode==='archive'?Infinity:now);
   if(flow==null&&mode==='lag1')flow=crowd(x.symbol,i-1,now);
   if(flow==null&&mode!=='seven')continue;
   const f=[...x.f];f[4]=flow??0;ranked.push({...x,f});
  }
  if(ranked.length!==universe.length || ranked.length<3)continue;
  for(const x of ranked)x.score=weights.reduce((s,w,k)=>{
   const vals=ranked.map(y=>y.f[k]);const percentile=(vals.filter(v=>v<x.f[k]).length+(vals.filter(v=>v===x.f[k]).length-1)/2)/(vals.length-1);
   return s+w*percentile;
  },0);
  for(const scope of ['all','plan']){
   const pool=ranked.filter(x=>scope==='all'||x.eligible);
   if(pool.length<3)continue;
   const top=k=>[...pool].sort((a,b)=>b[k]-a[k]||a.symbol.localeCompare(b.symbol)).slice(0,3);
   const picks=[top('score'),top('rs')];
   const returns=picks.flatMap(p=>[5,10].map(h=>mean(p.map(x=>{
    const bars=bySymbol.get(x.symbol);return (bars.get(sessions[i+h])?.close/bars.get(date)?.close-1)*100;
   }))));
   if(!returns.every(Number.isFinite))continue;
   const key=[mode,scope,i<split?'early':'late'].join('/');
   if(!results.has(key))results.set(key,[]);results.get(key).push(returns);
  }
 }
}
console.log('split',sessions[split]);
for(const [k,r] of [...results].sort())console.log(k,r.length,...r[0].map((_,j)=>mean(r.map(x=>x[j])).toFixed(2)));
