// Replay the price-based selection with news availability held constant.
import {buildMorningPlan} from '../morning-plan.mjs';
import {loadDaily} from '../daily-store.mjs';
import {instruments} from '../dist/instruments.js';

const history = new Map(await Promise.all(instruments.map(async d => [d.symbol, (await loadDaily(d.symbol))?.bars || []])));
const benchmark = history.get('sh000300');
const results = [];
for (const session of benchmark.slice(60)) {
  const date = session.date;
  const now = Date.parse(date+'T08:00:00+08:00');
  const daily = new Map([...history].map(([symbol,bars]) => [symbol,{bars:bars.filter(b=>b.date<date).slice(-65)}]));
  const news = {items:[],sources:[{status:'connected',lastSuccessAt:new Date(now-60000).toISOString()}]};
  const plan = buildMorningPlan({daily,news,now,strongMarketOnly:false});
  // Reconstruct original conditional top three independently of subsequent focus-list changes.
  const picks = plan.items.filter(i=>i.sector.endsWith('ETF') && i.stance==='conditional')
    .sort((a,b)=>b.relative20-a.relative20 || a.symbol.localeCompare(b.symbol)).slice(0,3);
  const prices = picks.map(i=>{
    const bar = history.get(i.symbol).find(b=>b.date===date);
    if (!bar) throw Error('Missing evaluation bar '+date+' '+i.symbol);
    return {r:100*(bar.close/i.close-1), hit:bar.high>i.pressure, relative:i.relative20};
  });
  results.push({date,regime:plan.market.regime,prices,benchmark:100*(session.close/plan.market.close-1)});
}
const split = Math.floor(results.length*0.7);
for (const days of [results.slice(0,split),results.slice(split)]) {
  console.log(days[0].date,days.at(-1).date,days.length);
  for (const mode of ['原筛选','强市','分化市','相对强度为正']) {
    const samples=[];
    for (const d of days) {
      if (mode==='强市' && d.regime!=='strong' || mode==='分化市' && d.regime!=='mixed') continue;
      const p=d.prices.filter(x=>mode!=='相对强度为正'||x.relative>0);
      if (!p.length) continue;
      const avg=fn=>p.reduce((s,x)=>s+fn(x),0)/p.length;
      samples.push({r:avg(x=>x.r),excess:avg(x=>x.r)-d.benchmark,hit:avg(x=>Number(x.hit))});
    }
    const mean=fn=>samples.reduce((s,x)=>s+fn(x),0)/samples.length;
    console.log(mode,samples.length,...[mean(x=>x.r),mean(x=>x.excess),100*mean(x=>Number(x.r>0)),100*mean(x=>x.hit)].map(n=>n.toFixed(2)));
  }
}
