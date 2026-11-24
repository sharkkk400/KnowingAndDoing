import assert from 'node:assert/strict';
import {holdingPlan} from '../holding-plan.mjs';

const fee=.001; // all-in one-way commission and slippage assumption
function metrics(nav){
 let peak=nav[0],dd=0;
 for(const n of nav){peak=Math.max(peak,n);dd=Math.max(dd,1-n/peak);}
 return [nav.at(-1)/nav[0]-1,dd].map(n=>(100*n).toFixed(2));
}
export function review({holdingDays,opens,indexed,adjusted,defs}){
 for(const mode of ['hold-half','hold-full','current','no-add','no-trim','exit-only','one-trim','ma60-only','support-only']){
  const accounts=new Map(defs.filter(d=>d.sector.endsWith('ETF')).map(d=>[d.symbol,{cash:1,units:0,ever:false,trimmed:false}]));
  const nav=[accounts.size],counts={entry:0,add:0,trim:0,exit:0};
  let splitIndex;
  for(const {date,plan,alerts} of holdingDays){
   if(date==='2026-05-08')splitIndex=nav.length-1;
   let value=0;
   for(const [symbol,a] of accounts){
    const bar=indexed.get(symbol).get(date),close=adjusted[symbol][date],alert=alerts.get(symbol);
    if(!bar||!close){assert(!a.units,'missing held price '+symbol+date);value+=a.cash;continue;}
    const factor=close/bar.close;
    const buy=(amount,px)=>{a.units+=amount/(px*factor*(1+fee));a.cash-=amount;};
    const sell=(units,px)=>{assert(px>0);a.cash+=units*px*factor*(1-fee);a.units-=units;};
    if(!a.units){
     if(alert&&(!mode.startsWith('hold')||!a.ever)){
      buy(a.cash*(mode==='hold-full'?1:.5),alert.fill);a.ever=true;a.trimmed=false;
      a.event={kind:'entry',symbol,support:alert.support,date,observedAt:date+'T15:00:00+08:00'};counts.entry++;
     }
    }else if(!mode.startsWith('hold')){
     const [decision]=holdingPlan(plan,[],[a.event],[]);
     const item=plan.items.find(x=>x.symbol===symbol);
     if(decision.action==='清仓'&&((mode==='ma60-only'&&item.close>=item.ma60)||(mode==='support-only'&&item.close>a.event.support))){
      decision.action=item.close<item.ma20||plan.market.regime==='weak'?'减仓':'持有';
     }
     if(decision.action==='清仓'){sell(a.units,opens[symbol][date]);counts.exit++;}
     else if(decision.action==='减仓'){
      if(!a.trimmed&&!['no-trim','exit-only'].includes(mode)){sell(a.units/2,opens[symbol][date]);a.trimmed=true;counts.trim++;}
     }else if(decision.action!=='待核实'){
      if(mode!=='one-trim')a.trimmed=false;
      if(decision.action==='条件加仓'&&alert&&a.cash>1e-10&&!['no-add','exit-only'].includes(mode)){buy(a.cash,alert.fill);a.trimmed=false;counts.add++;}
     }
    }
    value+=a.cash+a.units*close;
   }
   assert(Number.isFinite(value));nav.push(value);
  }
  console.log('holdings',mode,JSON.stringify({full:metrics(nav),early:metrics(nav.slice(0,splitIndex+1)),late:metrics(nav.slice(splitIndex)),counts}));
 }
}
