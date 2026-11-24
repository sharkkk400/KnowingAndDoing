import {readFile} from 'node:fs/promises';
import {instruments} from '../dist/instruments.js';
const read=async name=>JSON.parse(await readFile(new URL('../data/'+name,import.meta.url),'utf8'));
const sessions=(await read('daily/sh000300.json')).bars.map(b=>b.date);
const funds=instruments.filter(d=>d.sector.endsWith('ETF'));
const prices=new Map();
for(const {symbol} of funds) prices.set(symbol,new Map((await read('daily/'+symbol+'.json')).bars.map(b=>[b.date,b])));
const snapshots=(await read('forecast-archive.json')).records.filter(r=>r.inputs?.shares?.five?.ready);
const versions=new Map();
let journal=[];
try {
 const raw=await readFile(new URL('../data/etf-share-observations.jsonl',import.meta.url),'utf8');
 journal=raw.trim().split('\n').filter(Boolean).flatMap(line=>JSON.parse(line));
} catch(e){if(e.code!=='ENOENT')throw e;}

for(const row of [...journal,...(await read('etf-share-history.json')).rows,...(await read('etf-shares.json')).rows]){
 const key=row.symbol+row.date;
 if(!versions.has(key))versions.set(key,[]);
 versions.get(key).push(row);
}
for(const v of versions.values())v.sort((a,b)=>Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt));
const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
const split=Math.floor((sessions.length-60-5)*.7)+60;
for(const mode of ['strict','strict-one-session-lag','retrospective']){
 const samples=[];
 for(let i=60;i<sessions.length-5;i++){
  const date=sessions[i], cutoff=Date.parse(date+'T08:00:00+08:00');
  for(const {symbol} of funds){
   const series=prices.get(symbol), bars=sessions.slice(i-60,i).map(d=>series.get(d));
   const start=series.get(date), end=series.get(sessions[i+5]);
   if(bars.some(b=>!b)||!start||!end)continue;
   let flow;
   for(const lag of mode==='strict-one-session-lag'?[0,1]:[0]){
    const lastDate=sessions[i-1-lag];
    const shares=sessions.slice(i-4-lag,i-lag).map(d=>versions.get(symbol+d)?.find(v=>mode==='retrospective'||Date.parse(v.fetchedAt)<cutoff)?.shares);
    if(shares.every(s=>s>0)){
     if(shares.slice(1).every((s,k)=>Math.abs(s/shares[k]-1)<=.25))flow=shares.slice(1).every((s,k)=>s>shares[k]);
     break;
    }
    const snap=snapshots.filter(r=>r.symbol===symbol && r.inputs.shares.date===lastDate && Date.parse(r.observedAt)<cutoff).sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
    if(snap){flow=snap.inputs.shares.direction===1 && snap.inputs.shares.streak>=3;break;}
   }
   if(flow===undefined)continue;
   const low=Math.min(...bars.map(b=>b.low)),high=Math.max(...bars.map(b=>b.high)),last=bars.at(-1).close;
   if(!(high>low))continue;
   samples.push({date,symbol,index:i,part:i<split?'early':'late',low:(last-low)/(high-low)<=.25,
    flow,steady:last>=bars.at(-2).close,r:(end.close/start.close-1)*100});
  }
 }
 if(process.argv.includes('--hold-low')){
  const {report}=await import('./hold-low-report.mjs');
  report({samples,sessions,prices,split,mode});
  continue;
 }
 console.log(mode,'eligible symbol-days',samples.length,'days',new Set(samples.map(s=>s.date)).size);
 for(const part of ['early','late']){
  for(const [label,test] of Object.entries({control:s=>s.low&&!s.flow,signal:s=>s.low&&s.flow,steady:s=>s.low&&s.flow&&s.steady,falling:s=>s.low&&s.flow&&!s.steady})){
   const obs=samples.filter(s=>s.part===part&&test(s)), groups=Map.groupBy(obs,s=>s.date);
   const daily=[...groups.values()].map(g=>avg(g.map(s=>s.r)));
   console.log(part,label,obs.length,daily.length,daily.length?avg(daily).toFixed(2):'-',daily.length?(100*avg(daily.map(r=>Number(r>0)))).toFixed(1):'-');
  }
 }
}
console.log('split',sessions[split], 'last signal',sessions.at(-6));
