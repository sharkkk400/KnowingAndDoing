import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {buildMorningPlan} from '../morning-plan.mjs';
import {loadDaily} from '../daily-store.mjs';
import {instruments} from '../dist/instruments.js';

const history=new Map(await Promise.all(instruments.map(async d=>[d.symbol,(await loadDaily(d.symbol))?.bars||[]])));
const benchmark=history.get('sh000300');
const warmup=JSON.parse(await readFile(new URL('../data/hs300-ma250-warmup.json',import.meta.url)));
const longHistory=[...warmup.filter(b=>b.date<benchmark[0].date),...benchmark];
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
const rank=(a,b)=>b.relative20-a.relative20||a.symbol.localeCompare(b.symbol);
const rows=[];
for(const session of benchmark.slice(60)){
 const now=Date.parse(session.date+'T08:00:00+08:00');
 const daily=new Map([...history].map(([symbol,b])=>[symbol,{bars:b.filter(x=>x.date<session.date).slice(-65)}]));
 const plan=buildMorningPlan({daily,now,news:{items:[],sources:[{status:'connected',lastSuccessAt:new Date(now-60000).toISOString()}]}});
 const past=longHistory.filter(b=>b.date<session.date).slice(-250);
 if(past.length!==250)throw Error('年线预热不足');
 const prev=new Date(Date.parse(session.date)-86400000);
 while([0,6].includes(prev.getUTCDay()))prev.setUTCDate(prev.getUTCDate()-1);
 const common=plan.market.regime!=='limited' && prev.toISOString().slice(0,10)===plan.closeDate;
 const short=plan.market.regime==='strong',year=past.at(-1).close>mean(past.map(b=>b.close));
 const pool=plan.items.filter(x=>x.sector.endsWith('ETF')&&x.trend==='偏强'&&(x.close/x.ma20-1)*100<=8).sort(rank).slice(0,3);
 if(common&&short)assert.deepEqual(pool.map(x=>x.symbol),plan.items.filter(x=>x.entryRule?.enabled).sort(rank).map(x=>x.symbol));
 const obs=pool.map(x=>{
  const bar=history.get(x.symbol).find(b=>b.date===session.date);
  if(!bar)throw Error('候选行情缺失');
  return [Number(bar.high>x.pressure)*100,Number(bar.close>x.pressure)*100,Number(bar.low<=x.support)*100,(bar.close/x.close-1)*100];
 });
 rows.push({date:session.date,short,year,stats:common&&obs.length?obs[0].map((_,k)=>mean(obs.map(a=>a[k]))):null});
}
const cut=Math.floor(rows.length*.7);
for(const block of [rows,rows.slice(0,cut),rows.slice(cut)]){
 console.log(block[0].date,block.at(-1).date,block.length);
 for(const [label,test] of Object.entries({current:r=>r.short,annual:r=>r.year,both:r=>r.short&&r.year,onlyCurrent:r=>r.short&&!r.year,onlyAnnual:r=>!r.short&&r.year,neither:r=>!r.short&&!r.year})){
  const selected=block.filter(r=>r.stats&&test(r));
  console.log(label,selected.length,...(selected.length?selected[0].stats.map((_,k)=>mean(selected.map(r=>r.stats[k])).toFixed(2)):[]));
 }
}
