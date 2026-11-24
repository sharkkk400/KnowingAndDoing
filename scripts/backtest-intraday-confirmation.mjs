// Replay Sina monthly intraday price samples (09:30..11:30 and 13:00..15:00).
import {readFile,readdir} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {instruments as activeInstruments,instrumentCatalog} from '../dist/instruments.js';
const instruments=process.argv.includes('--universe-480')&&!process.argv.includes('--theme-pool')?instrumentCatalog:activeInstruments;
import {loadDaily} from '../daily-store.mjs';
import {buildMorningPlan} from '../morning-plan.mjs';
let openingEvidence={};
const fullUniverse=process.argv.includes('--universe-480');
const decade=process.argv.includes('--decade-480');
const monthScan=process.argv.includes('--candidate-months');
const currentReplay=process.argv.includes('--current-replay');
const jobs=new Set(), extraAdjusted={};
const joined=process.argv.includes('--history-through-present');
const earlier=joined||process.argv.includes('--history-2019');
const root=new URL(earlier?'../data/minute-research/history-2019/':'../data/minute-research/',import.meta.url);
const period=process.argv.find(x=>/^--year-(2019|202[0-6]|all)$/.test(x))?.slice(7);
const annual=Boolean(period);
const recoveryGate=process.argv.includes('--market-recovery');
const holdMinutes=process.argv.includes('--hold-two')?2:3;
const roots=joined?[root,new URL('../data/minute-research/',import.meta.url)]:[root];
async function archive(name){
 const blocks=await Promise.all(roots.map(dir=>readFile(new URL(name+'.json',dir)).then(JSON.parse)));
 if(!joined)return blocks[0];
 const [old,recent]=blocks;
 for(const [symbol,series] of Object.entries(recent)){
  if(name==='annual-daily'){
   old[symbol]=[...(old[symbol]||[]).filter(b=>b.date<'2024-01-01'),...series.filter(b=>b.date>='2024-01-01')];
  }else if(name==='annual-verification'){
   old[symbol]={daily:{...old[symbol]?.daily,...series.daily},quarters:{...old[symbol]?.quarters,...series.quarters}};
  }else old[symbol]={...old[symbol],...series};
 }
 return old;
}
const daily=annual?new Map(Object.entries(await archive('annual-daily'))):new Map(await Promise.all(instruments.map(async d=>[d.symbol,(await loadDaily(d.symbol))?.bars||[]])));
const minutes=new Map();
const opens=await archive(annual?'annual-opens':'session-opens');
for(const dir of roots)for(const file of (await readdir(dir)).filter(f=>f.endsWith('.gz'))){
 const symbol=file.split('-')[0];
 if(!minutes.has(symbol))minutes.set(symbol,new Map());
 const dates=JSON.parse(gunzipSync(await readFile(new URL(file,dir))));
 for(const [date,points] of Object.entries(dates))minutes.get(symbol).set(date,points);
}
const verification=await archive(annual?'annual-verification':'verification');
if(fullUniverse){
 const directory=new URL('../data/minute-research/universe-480/',import.meta.url);
 for(const file of await readdir(new URL('daily/',directory))){
  const symbol=file.split('.')[0],{bars,adjusted}=JSON.parse(gunzipSync(await readFile(new URL('daily/'+file,directory))));
  daily.set(symbol,bars);extraAdjusted[symbol]=adjusted;
  opens[symbol]=Object.fromEntries(bars.map(b=>[b.date,b.open]));
  verification[symbol]={quarters:{},daily:Object.fromEntries(bars.map(b=>[b.date,[b.open,b.close,b.high,b.low]]))};
 }
 if(!monthScan)for(const file of await readdir(new URL('minutes/',directory))){
  const symbol=file.split('-')[0];if(!minutes.has(symbol))minutes.set(symbol,new Map());
  for(const [d,p] of Object.entries(JSON.parse(gunzipSync(await readFile(new URL('minutes/'+file,directory))))))minutes.get(symbol).set(d,p);
 }
}
if(decade){
 const base=new URL('../data/minute-research/decade-480/',import.meta.url);
 for(const file of await readdir(new URL('daily/',base))){
  const s=file.split('.')[0],v=JSON.parse(gunzipSync(await readFile(new URL('daily/'+file,base))));
  daily.set(s,v.bars);extraAdjusted[s]=v.adjusted;opens[s]=Object.fromEntries(v.bars.map(b=>[b.date,b.open]));
  verification[s]??={quarters:{},daily:{}};
  for(const b of v.bars)verification[s].daily[b.date]=[b.open,b.close,b.high,b.low];
 }
 if(!monthScan)for(const file of await readdir(new URL('minutes/',base))){
  const s=file.split('-')[0];if(!minutes.has(s))minutes.set(s,new Map());
  for(const [d,p] of Object.entries(JSON.parse(gunzipSync(await readFile(new URL('minutes/'+file,base))))))minutes.get(s).set(d,p);
 }
}
// Optional older daily bars supply prior-day indicators before the archived decade starts.
const pre2020=process.argv.includes('--out-of-sample-2016-2019');
const continuous2016=process.argv.includes('--continuous-from-2016');
if((pre2020||continuous2016)&&process.env.REPLAY_EARLY_DAILY){
 const dir=process.env.REPLAY_EARLY_DAILY;
 for(const file of await readdir(dir)){
  if(!file.endsWith('.json'))continue;
  const symbol=file.slice(0,-5),extra=JSON.parse(await readFile(dir+'/'+file));
  const original=daily.get(symbol);
  if(!original||extra.bars.some(b=>b.date>=original[0].date))throw Error('Invalid early daily archive: '+symbol);
  daily.set(symbol,[...extra.bars,...original]);
  Object.assign(extraAdjusted[symbol],extra.adjusted);
  for(const b of extra.bars)opens[symbol][b.date]=b.open;
 }
}
const excludedSymbols=new Set((process.env.REPLAY_EXCLUDE||'').split(',').filter(Boolean));
const industryNames=/科技|芯片|半导体|通信|互联网|信息|软件|计算机|电子|人工智能|机器人|智能|云计算|数据|网络|数字|传媒|游戏|动漫|影视|文娱|出版|汽车|新能源|电池|光伏|储能|电力|电网|风电|核能|能源|煤炭|石油|油气|化工|有色|金属|材料|稀土|钢铁|矿业|黄金股|黄金产业|机械|设备|装备|制造|工业|航空|航天|国防|军工|卫星|船舶|银行|证券|券商|保险|金融|地产|房地产|建筑|基建|建材|水泥|交通|运输|物流|港口|航运|铁路|消费|食品|饮料|家电|白酒|酒指|医药|医疗|创新药|制药|生物|中药|疫苗|健康|农业|农牧|畜牧|养殖|种业|粮食|旅游|零售|环保|水务|公用事业|电信|电讯|5G|光通信/;
const industryETF=d=>d&&!/债券|期货/.test(d.sector)&&(d.sector==='行业 ETF'||industryNames.test(d.name+d.group));
const defs=instruments.filter(d=>!excludedSymbols.has(d.symbol)&&(!annual||daily.has(d.symbol)));
if(process.argv.includes('--expanded')){
 const directory=new URL('expanded/',root);
 for(const file of (await readdir(directory)).filter(f=>f.endsWith('.gz')).sort()){
  const {symbol,name,sector,code,bars,minutes:series,verify}=JSON.parse(gunzipSync(await readFile(new URL(file,directory))));
  defs.push({symbol,name,sector,code});daily.set(symbol,bars);
  minutes.set(symbol,new Map(Object.entries(series)));
  verification[symbol]={daily:verify,quarters:{}};
  opens[symbol]=Object.fromEntries(bars.map(b=>[b.date,b.open]));
 }
}
const dates=daily.get('sh000300').map(b=>b.date);
const indexed=new Map([...daily].map(([s,bars])=>[s,new Map(bars.map(b=>[b.date,b]))]));
const candles=new Map(), recoveredCandles=new Map();
const backfilledStarts=new Map(),backfilledSymbols=new Set();
if(decade&&process.argv.includes('--weak-top-ten-backfill')){
 const dir=new URL('../data/minute-research/weak-top-ten/',import.meta.url);
 const observed=JSON.parse(gunzipSync(await readFile(new URL('quarters/observed.json.gz',dir))));
 for(const [symbol,quotes] of Object.entries(observed)){
  Object.assign(quotes,verification[symbol].quarters);verification[symbol].quarters=quotes;
 }
 for(const file of await readdir(dir)){
  if(!file.endsWith('.json.gz'))continue;
  const symbol=file.split('-')[0];
  const sessions=JSON.parse(gunzipSync(await readFile(new URL(file,dir))));
  if(!minutes.has(symbol))minutes.set(symbol,new Map());
  backfilledSymbols.add(symbol);
  for(const [date,{p,first}] of Object.entries(sessions)){
   if(symbol==='sh000300'?(points(symbol,date)||boundedIndex(date)):(points(symbol,date)||verifiedMinuteDay(symbol,date)))continue;
   minutes.get(symbol).set(date,p);
   if(first>0)backfilledStarts.set(symbol+date,{raw:p,first});
  }
 }
}
function verifiedMinuteDay(symbol,date){
 const p=minutes.get(symbol)?.get(date), b=indexed.get(symbol)?.get(date), v=verification[symbol]?.daily[date];
 if(!p||p.length!==242||!b||!v)return null;
 const [o,c,h,l]=v;
 if(o!==opens[symbol]?.[date]||c!==b.close||h!==b.high||l!==b.low)return null;
 if(p.some((n,i)=>!(i===0&&n===0)&&(!Number.isFinite(n)||n<l-.000001||n>h+.000001)))return null;
 return p;
}
function boundedIndex(date){
 const s='sh000300',p=minutes.get(s)?.get(date),bar=indexed.get(s)?.get(date);
 if((earlier||decade)&&date<'2024-01-01'&&p?.length===242&&bar&&Math.abs(p[241]-bar.close)<=.00501){
  // Older daily index candles are rounded to two decimals. The first intraday
  // observation need not be the opening auction price and is not an entry input.
  if(p.every(v=>Number.isFinite(v)&&v>=bar.low-.00501&&v<=bar.high+.00501))return p;
 }
 if(p?.length!==242||!bar||p[0]!==bar.open||Math.abs(p[241]/bar.close-1)>.0001)return null;
 return p.every(v=>Number.isFinite(v)&&v>=bar.low&&v<=bar.high)?p:null;
}
// The scanner only asks whether the index met its floor. A daily bound
// proves that predicate for every minute without reconstructing index ticks.
function certifiedMarketFloor(date,floor){
 if(!decade)return null;
 const b=indexed.get('sh000300')?.get(date);
 if(b?.low>=floor)return Array(242).fill(b.low);
 if(b?.high<floor)return Array(242).fill(b.high);
 return null;
}
function quarterStamp(date,i){
 const t=i<=120?570+i:780+i-121;
 return date+' '+String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0')+':00';
}
const isEnd=i=>(i<=120?i>0&&i%15===0:i>121&&(i-121)%15===0);
function points(symbol,date,warmup=false){
 const p=minutes.get(symbol)?.get(date),b=indexed.get(symbol)?.get(date);
 if(!b||p?.length!==242||p.some((x,i)=>!(x>0)&&(warmup?isEnd(i):i!==0||!(opens[symbol]?.[date]>0)))||Math.abs(p[241]-b.close)>.00101)return null;
 return p;
}
for(const d of defs.filter(x=>!monthScan&&x.sector.endsWith('ETF'))){
 let fast,slow,dea=0,count=0;
 for(const date of dates){
  const p=points(d.symbol,date,true);
  if(!p){count=0;continue;}
  const positive=new Set();
  for(let i=1;i<p.length;i++)if(isEnd(i)){
   if(!count){fast=slow=p[i];dea=0;}
   else{fast+=(p[i]-fast)*2/13;slow+=(p[i]-slow)*2/27;}
   const dif=fast-slow;dea+=(dif-dea)*2/10;
   if(count>=100&&dif>dea)positive.add(i);
   count++;
  }
  if(count>=116)candles.set(d.symbol+date,positive);
 }
}
// For a broken warm-up, use published quarter closes when available, otherwise validated minute endpoints.
for(const {symbol} of defs.filter(d=>d.sector.endsWith('ETF'))){
 const hasQuarterArchive=Object.keys(verification[symbol]?.quarters||{}).length>0;
 let count=0,fast,slow,dea;
 for(const date of dates){
  const p=points(symbol,date,true)||verifiedMinuteDay(symbol,date);
  const positive=new Set(),ready=count>=100;
  if(!p&&!hasQuarterArchive){count=0;continue;}
  for(let i=1;i<=241;i++)if(isEnd(i)){
   const price=verification[symbol]?.quarters[quarterStamp(date,i)]??p?.[i];
   if(!(price>0)){count=0;continue;}
   if(!count){fast=slow=price;dea=0;}
   else{fast+=(price-fast)*2/13;slow+=(price-slow)*2/27;}
   const dif=fast-slow;dea+=(dif-dea)*2/10;
   if(count>=100&&dif>dea)positive.add(i);
   count++;
  }
  if(ready&&count>=116)recoveredCandles.set(symbol+date,positive);
 }
}
// Some sessions open late. Retain only actually quoted minutes when the raw
// file reports no earlier trades and the total matches the independent daily volume.
const lateOpen=new Map(backfilledStarts), repairedMacd=new Map();
if(fullUniverse&&!monthScan){
 const dir=new URL('../data/minute-research/universe-480/',import.meta.url);
 const openings=openingEvidence=JSON.parse(await readFile(new URL('observed-opening.json',dir)));
 if(decade){
  const historical=JSON.parse(await readFile(new URL('../data/minute-research/decade-480/openings.json',import.meta.url)));
  for(const [s,rows] of Object.entries(historical))openings[s]={...rows,...openings[s]};
 }
 const quarters=JSON.parse(await readFile(new URL('independent-quarters.json',dir)));
 for(const symbol of new Set([...Object.keys(openings),...Object.keys(quarters),...backfilledSymbols])){
  let count=0,fast,slow,dea;
  for(const date of dates){
   const key=symbol+date,b=indexed.get(symbol)?.get(date),raw=minutes.get(symbol)?.get(date);
   const o=openings[symbol]?.[date];
   if(o&&b&&raw?.length===242&&(o.independentNoTrade||Math.abs(o.volume-b.volume*100)<=100)&&o.price===raw[o.first]&&o.last===raw[241]&&Math.abs(o.last-b.close)<=.00101&&raw.slice(o.first).every(v=>v>=b.low-.000001&&v<=b.high+.000001))lateOpen.set(key,{raw,first:o.first});
   const delayed=lateOpen.get(key),p=points(symbol,date,true)||verifiedMinuteDay(symbol,date)||delayed?.raw;
   const quotes=quarters[symbol]||{},positive=new Set(),ready=count>=100;
   for(let i=1;i<=241;i++)if(isEnd(i)){
    const verified=verification[symbol]?.quarters[quarterStamp(date,i)];
    const source=quotes[quarterStamp(date,i)];
    // A missing minute elsewhere in the session does not invalidate a
    // separately observed quarter close. Validate its date, bounds and close.
    const endpoint=raw?.length===242&&b&&Math.abs(raw[241]-b.close)<=.00101&&
      raw[i]>=b.low-.000001&&raw[i]<=b.high+.000001?raw[i]:null;
    const price=verified??(p?.[i]>0?p[i]:source??endpoint);
    if(!(price>0)){if(delayed&&i<delayed.first)continue;count=0;continue;}
    if(!count){fast=slow=price;dea=0;}else{fast+=(price-fast)*2/13;slow+=(price-slow)*2/27;}
    const dif=fast-slow;dea+=(dif-dea)*2/10;
    if(count>=100&&dif>dea&&(!delayed||i-14>=delayed.first))positive.add(i);
    count++;
   }
   if(ready&&count>=100)repairedMacd.set(key,positive);
  }
 }
}
function scan(p,m,pos,r,open,sessionClose,first=1,skip=first){
 let a,b,k=-1,held=0;
 if(!(open>r.support)||open>r.pressure*1.01)return [null,null];
 for(let i=Math.max(1,first,skip);i<241;i++){
  if(p[i]<=r.support)break;
  if(i===121){k=-1;held=0;continue;}
  const eligible=m[i]>=r.marketFloor&&p[i]>=r.pressure&&p[i]<=r.pressure*1.01;
  if(isEnd(i)){
   held=0;k=i-14>=first&&pos.has(i)&&p[i]>r.pressure?i:-1;
   if(k===i&&eligible)a??=i;
  }else if(k>=0){
   held=p[i]>=r.pressure?held+1:0;
   if(held>=holdMinutes&&eligible)b??=i;
  }
 }
 return [a,b].map(i=>{
  if(i===undefined)return null;
  // Drop the duplicate 13:00 boundary when counting subsequent trading minutes.
  let j=i+30;if(i<=120&&j>120)j++;
  return {i,failed:sessionClose<=r.pressure,close:100*(sessionClose/p[i]-1),next:j<=241?100*(p[j]/p[i]-1):null};
 });
}
// Research-only alternatives to the production shortlist.
const resonancePool=new Set('510300 510050 510500 512100 588000 589680 159781 515080 159352 563300 515880 588200 159740 512400 510150 159842'.split(' '));
const referenceEtf={sh588200:'sh588000',sz159352:'sh510300'};
const holdingDays=[];
const cases=[];let total=0,covered=0,days=0;
const replayDates=process.argv.includes('--reset-2020')?dates.filter(d=>d>='2020-01-01'&&d<='2026-11-18'):continuous2016?dates.filter(d=>d>=(process.argv.includes('--combined-200k')?'2016-11-21':'2016-01-01')&&d<='2026-11-18'):pre2020?dates.filter(d=>d>='2016-01-01'&&d<='2019-12-31'):annual?dates.filter(d=>period==='all'?d>=(decade?'2016-11-18':earlier?'2019-01-01':'2024-01-01'):d.startsWith(period+'-')):dates.slice(60);
const resonanceMode=process.env.RESONANCE_FIVE_DAY;
const resonanceDates=resonanceMode?JSON.parse(await readFile(new URL(decade?'../data/minute-research/decade-480/five-day-probe.json':'../data/resonance-review/five-day-probe.json',import.meta.url)))[resonanceMode]:{};
const carryProbe=process.argv.includes('--carry-resonance-three')&&resonanceMode;
const coverageTest=process.env.REPLAY_MATURE_COVERAGE;
const minimumCoverage=coverageTest?Number(coverageTest)/100:.9;
if(coverageTest&&![.8,.85,.9].includes(minimumCoverage))throw Error('Unsupported coverage');
const barEnds=new Map();
let pendingProbe=null;
const weakRace=process.argv.includes('--weak-top-ten');
let raceBullish=false;
for(const [session,date] of replayDates.entries()){
 if(pendingProbe&&session>pendingProbe.expires)pendingProbe=null;
 const now=Date.parse(date+'T08:00:00+08:00');
 const input=new Map();
 for(const [s,bs] of daily){
  let end=barEnds.get(s)||0;
  while(end<bs.length&&bs[end].date<date)end++;
  barEnds.set(s,end);input.set(s,{bars:bs.slice(Math.max(0,end-65),end)});
 }
 const marketBars=input.get('sh000300').bars;
 const above20=marketBars.at(-1)?.close>marketBars.slice(-20).reduce((sum,b)=>sum+b.close,0)/20;
 const risingRecovery=process.argv.includes('--rising-recovery')&&marketBars.length>=60&&marketBars.at(-1).close>marketBars.at(-21).close&&marketBars.at(-1).close>marketBars.slice(-60).reduce((n,b)=>n+b.close,0)/60;
 const lastMarket=marketBars.at(-1);
 const marketBreakout=marketBars.length>=60&&lastMarket.close>Math.max(...marketBars.slice(-21,-1).map(b=>b.high))&&lastMarket.close>marketBars.slice(-60).reduce((sum,b)=>sum+b.close,0)/60;
 if(!above20)pendingProbe=null;
 const probe=(pendingProbe||resonanceDates[date]||process.argv.includes('--recovery-probe')||(process.argv.includes('--market-breakout-probe')&&marketBreakout))&&marketBars.length>=60&&above20;
 let eligibleDefs=(fullUniverse||earlier&&date<'2024-01-01')&&!process.argv.includes('--fixed-universe')?defs.filter(d=>input.get(d.symbol)?.bars.length>0):defs;
 if(coverageTest){
  const oldest=marketBars.at(-60)?.date;
  eligibleDefs=eligibleDefs.filter(d=>!d.sector.endsWith('ETF')||(oldest&&daily.get(d.symbol)[0].date<=oldest));
 }
 const screen=process.env.POOL_SCREEN,core=i=>!(i.symbol in extraAdjusted);
 const candidateFilter=process.argv.includes('--low-vol-cash-study')?i=>!i.name.includes('国债'):screen==='domestic'?i=>i.market==='A':null;
 const leaderFilter=screen==='prefer-core'?core:null;
 const diversify=screen?.startsWith('corr')?ranked=>{
  const chosen=[],threshold=Number(screen.slice(4))/100;
  function returns(i){
   const bars=i.evidence.slice(-21);return bars.slice(1).map((b,j)=>b.close/bars[j].close-1);
  }
  function similar(a,b){
   const x=returns(a),y=returns(b),n=x.length;
   if(n!==20||y.length!==n)return false;
   const mx=x.reduce((s,v)=>s+v,0)/n,my=y.reduce((s,v)=>s+v,0)/n;
   let xy=0,xx=0,yy=0;
   for(let j=0;j<n;j++){const dx=x[j]-mx,dy=y[j]-my;xy+=dx*dy;xx+=dx*dx;yy+=dy*dy;}
   return xx*yy>0&&xy/Math.sqrt(xx*yy)>=threshold;
  }
  for(const i of ranked){if(!chosen.some(j=>similar(i,j)))chosen.push(i);if(chosen.length===3)break;}
  return chosen;
 }:null;
 const plan=buildMorningPlan({minimumCoverage,candidateFilter,leaderFilter,diversify,now,defs:eligibleDefs,daily:input,strongMarketOnly:!((recoveryGate||risingRecovery||probe)&&above20),maxExtension:process.argv.includes('--extension-ten')?10:8,breakoutDays:process.argv.includes('--breakout-10')?10:process.argv.includes('--breakout-15')?15:20,news:{items:[],sources:[{status:'connected',lastSuccessAt:new Date(now-60000).toISOString()}]}});
 if(process.argv.includes('--first-industry-150k')){
  plan.industryLeader=industryETF(plan.items.find(i=>i.relativeStrengthRank===1));
  const earlier=marketBars.slice(0,-5);
  plan.risingStrong=plan.market.regime==='strong'&&earlier.length>=60&&[20,60].every(n=>plan.market['ma'+n]>earlier.slice(-n).reduce((sum,b)=>sum+b.close,0)/n);
 }
 if(plan.market.regime!=='mixed')pendingProbe=null;
 if(carryProbe&&probe&&plan.market.regime==='mixed'){
  if(!pendingProbe&&resonanceDates[date]){
   const first=plan.items.find(i=>i.relativeStrengthRank===1&&i.entryRule?.enabled);
   if(first)pendingProbe={symbol:first.symbol,pressure:first.pressure,support:first.support,expires:session+2};
  }
  if(pendingProbe){
   const ticket=pendingProbe,item=plan.items.find(i=>i.symbol===ticket.symbol);
   for(const i of plan.items)if(i.entryRule){i.entryRule.enabled=false;delete i.relativeStrengthRank;}
   if(item?.stance==='conditional'&&item.entryRule&&item.close>ticket.support){
    plan.focusSymbols=[item.symbol];item.relativeStrengthRank=1;item.focus=true;
    item.support=ticket.support;item.pressure=ticket.pressure;
    Object.assign(item.entryRule,{enabled:true,support:ticket.support,pressure:ticket.pressure});
   }
   if(process.env.AUDIT)console.error('ticket',date,ticket.symbol,ticket.pressure,item?.stance,item?.entryRule?.enabled);
  }
 }
 if(probe&&plan.market.regime==='mixed'){
  plan.recoveryProbe=true;
  if(process.argv.includes('--industry-recovery-leader')){
   // Keep the original ranking. Identify equity industries from the local fund and index names.

   for(const item of plan.items)if(item.entryRule?.enabled){
    const desc=defs.find(d=>d.symbol===item.symbol);
    if(!industryETF(desc))item.entryRule.enabled=false;
   }
  }
  plan.probeRace=process.argv.includes('--probe-first-of-three');
  if(!plan.probeRace)for(const item of plan.items)if(item.relativeStrengthRank!==1&&item.entryRule)item.entryRule.enabled=false;
 }
 if(process.argv.includes('--expanded')){
  const originalPlan=buildMorningPlan({now,daily:input,news:{items:[],sources:[{status:'connected',lastSuccessAt:new Date(now-60000).toISOString()}]}});
  if(!originalPlan.items.some(x=>x.entryRule?.enabled))continue;
 }
 if(process.argv.includes('--positive-relative')){
  for(const item of plan.items)if(item.entryRule?.enabled&&!(item.relative20>0))item.entryRule.enabled=false;
 }
 const alerts=new Map();
 if(!monthScan&&(process.argv.includes('--holding-review')||process.argv.includes('--three-slots')))holdingDays.push({date,plan,alerts});
 let picks=plan.items.filter(x=>x.entryRule?.enabled);
 if(process.argv.includes('--reference-trend')||process.argv.includes('--reference-pool')){
  const candidates=plan.items.filter(x=>x.sector.endsWith('ETF')&&x.stance==='conditional');
  picks=candidates.filter(x=>{
   if(process.argv.includes('--reference-pool')&&!resonancePool.has(x.code))return false;
   const parent=referenceEtf[x.symbol];
   return !process.argv.includes('--reference-trend')||!parent||plan.items.some(i=>i.symbol===parent&&i.trend==='偏强');
  }).sort((a,b)=>b.relative20-a.relative20||a.symbol.localeCompare(b.symbol)).slice(0,3);
 }
 if(process.env.RANK_LOG)console.log('ranks',date,picks.sort((a,b)=>a.relativeStrengthRank-b.relativeStrengthRank).map(i=>i.symbol).join(','));
 if(monthScan){
  for(const i of picks)if(extraAdjusted[i.symbol])for(const d of [date,...input.get(i.symbol).bars.slice(-45).map(b=>b.date)])jobs.add(i.symbol+','+d.slice(0,7));
  continue;
 }
 const raceSymbols=new Set();
 if(weakRace&&marketBars.length>=21){
  const c=marketBars.at(-1).close,ma=plan.market.ma20,prior=marketBars.at(-21).close;
  if(c>ma&&c>prior)raceBullish=true;
  if(c<ma&&c<prior)raceBullish=false;
  if(!raceBullish){
   plan.raceAlerts=new Map();plan.raceUnknown=[];
   const order=plan.directionCoverage.map(i=>i.symbol);
   for(const symbol of order)raceSymbols.add(symbol);
   picks=[...picks.filter(i=>!raceSymbols.has(i.symbol)),...order.map(s=>plan.items.find(i=>i.symbol===s)).filter(i=>i.entryRule)];
  }
 }
 if(currentReplay)for(const item of plan.items)delete item.evidence;
 if(picks.length)days++;
 for(const item of picks){
  total++;const symbol=item.symbol, original=points(symbol,date),m=points('sh000300',date)||(annual?boundedIndex(date):null)||certifiedMarketFloor(date,item.entryRule.marketFloor),prior=candles.get(symbol+date);
  const cohort=original&&m&&prior?'original':'recovered';
  let delayed=lateOpen.get(symbol+date);
  // The close-based first signal is observable when the daily low rules out
  // a support stop during the missing prefix and all subsequent ticks exist.
  const row=openingEvidence[symbol]?.[date],raw=minutes.get(symbol)?.get(date),bar=indexed.get(symbol)?.get(date);
  if(row?.observedPrefix&&row.first<15&&raw?.length===242&&bar.low>item.entryRule.support&&
   raw.slice(0,row.first).every(v=>v===0)&&raw.slice(row.first).every(v=>v>=bar.low&&v<=bar.high)&&
   raw[row.first]===row.price&&raw[241]===bar.close)delayed={raw,first:1,skip:row.first};
  const p=original||verifiedMinuteDay(symbol,date)||delayed?.raw,pos=prior||recoveredCandles.get(symbol+date)||repairedMacd.get(symbol+date);
  if(process.env.AUDIT)console.error(JSON.stringify({date,symbol,price:!!p,macd:!!pos,market:!!m,pressure:item.entryRule.pressure,support:item.entryRule.support,unconditionalNoEntry:!!(p&&m&&!pos&&!scan(p,m,new Set(Array.from({length:242},(_,i)=>i)),item.entryRule,opens[symbol]?.[date],p[241],delayed?.first??1,delayed?.skip)[1]),open:opens[symbol]?.[date],hi:indexed.get(symbol)?.get(date)?.high,original:cohort==='original',cause:!original?'分钟末价与日收盘不一致':!prior?'历史中断导致预热不足':'',replayable:!!(p&&pos&&m)}));
  const replayPos=pos||((process.argv.includes('--missing-macd-sensitivity')&&p&&m)?new Set(Array.from({length:242},(_,i)=>i)):null);
  if(raceSymbols.has(symbol)){
   const rule=item.entryRule,open=opens[symbol]?.[date];
   const excluded=(bar&&bar.high<=rule.pressure)||(open>0&&(open<=rule.support||open>rule.pressure*1.01))||indexed.get('sh000300')?.get(date)?.high<rule.marketFloor;
   const unresolved=!excluded&&(!p||!m||!pos)&&!(p&&m&&!scan(p,m,new Set(Array.from({length:242},(_,i)=>i)),rule,open,p[241],delayed?.first??1,delayed?.skip)[1]);
   const impossibleEvenWithoutMarket=process.argv.includes('--weak-top-ten-backfill')&&p&&!m&&!scan(p,Array(242).fill(Infinity),pos||new Set(Array.from({length:242},(_,i)=>i)),rule,open,p[241],delayed?.first??1,delayed?.skip)[1];
   if(unresolved&&!impossibleEvenWithoutMarket){
    plan.raceUnknown.push(symbol);
    if(process.env.RACE_GAPS)console.log('raceGap',JSON.stringify({date,symbol,price:!!p,market:!!m,macd:!!pos}));
   }
   if(['sh510630','sh515220','sz159985'].includes(symbol))console.log('raceTarget',date,symbol,unresolved?'unknown':excluded?'excluded':'check');
  }
  if(!p||!m||!replayPos)continue;
  covered++;const [a,b]=scan(p,m,replayPos,item.entryRule,opens[symbol]?.[date],process.argv.includes('--daily-close')?indexed.get(symbol).get(date).close:p[241],delayed?.first??1,delayed?.skip);
  if(b && process.argv.includes('--leader-failures')){
   b.gap=opens[symbol][date]/item.close-1;
   b.premium=p[b.i]/item.entryRule.pressure-1;
  }
  const signal=process.argv.includes('--immediate-breakout')?a:b;
  if(process.env.SIGNAL_LOG)console.error('target',date,symbol,signal?.i??'none');
  if(signal&&pendingProbe?.symbol===symbol)pendingProbe=null;
  if(signal&&raceSymbols.has(symbol)&&process.env.RACE_GAPS)console.log('verifiedRaceSignal',date,symbol,signal.i);
  if(signal&&raceSymbols.has(symbol))plan.raceAlerts.set(symbol,{confirmedPrice:p[signal.i],fill:p[signal.i===120?122:signal.i+1],minute:signal.i,support:item.support});
  if(signal&&(!raceSymbols.has(symbol)||item.entryRule.enabled))alerts.set(symbol,{confirmedPrice:p[signal.i],fill:p[signal.i===120?122:signal.i+1],minute:signal.i,support:item.support});
  cases.push({date,symbol,rank:plan.focusSymbols.indexOf(symbol)+1,cohort,a,b});
 }
}
if(monthScan){console.log(JSON.stringify([...jobs].map(k=>k.split(','))));process.exit(0);}
const mean=xs=>xs.length?(xs.reduce((s,x)=>s+x,0)/xs.length).toFixed(3):null;
function summary(items){return {n:items.length,falseN:items.filter(x=>x.failed).length,close:mean(items.map(x=>x.close)),nextN:items.filter(x=>x.next!=null).length,next:mean(items.flatMap(x=>x.next??[]))};}
console.log({range:[replayDates[0],replayDates.at(-1)],days,total,covered});
for(const [label,rows] of [['all',cases],['original',cases.filter(x=>x.cohort==='original')],['recovered',cases.filter(x=>x.cohort==='recovered')],['early',cases.filter(x=>x.date<'2026-05-08')],['late',cases.filter(x=>x.date>='2026-05-08')]]){
 console.log(label,JSON.stringify(Object.fromEntries(['a','b'].map(k=>[k,summary(rows.flatMap(x=>x[k]||[]))]))));
 const both=rows.filter(x=>x.a&&x.b);
 console.log('paired',both.length,'deltaClose',mean(both.map(x=>x.b.close-x.a.close)), 'onlyA',summary(rows.filter(x=>x.a&&!x.b).map(x=>x.a)),'onlyB',summary(rows.filter(x=>x.b&&!x.a).map(x=>x.b)));
}

if(process.argv.includes('--rank-review')){
 const avg=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
 for(const [label,rows] of [['all',cases],['early',cases.filter(x=>x.date<'2026-05-08')],['late',cases.filter(x=>x.date>='2026-05-08')]]){
  for(const limit of [1,2,3]){
   const alerts=rows.filter(x=>x.rank>0&&x.rank<=limit&&x.b);
   const groups=Map.groupBy(alerts,x=>x.date);
   const returns=[...groups.values()].map(g=>avg(g.map(x=>x.b.close))).sort((a,b)=>a-b);
   const mid=Math.floor(returns.length/2);
   const median=returns.length%2?returns[mid]:avg(returns.slice(mid-1,mid+1));
   console.log('rank',label,limit,JSON.stringify({alerts:alerts.length,failed:alerts.filter(x=>x.b.failed).length,days:returns.length,mean:avg(returns),median,withoutBest3:avg(returns.slice(0,-3)),positiveDays:returns.filter(x=>x>0).length}));
  }
 }
}

if(process.argv.includes('--leader-failures')){
 const leaders=cases.filter(x=>x.rank===1&&x.b);
 // Fixed, round thresholds. Describe first alerts, without simulating later re-entry.
 for(const [label,flag] of Object.entries({
  gapUp:x=>x.b.gap>=.005, afternoon:x=>x.b.i>121, premium:x=>x.b.premium>=.005
 })){
  for(const [part,sample] of [['all',leaders],['early',leaders.filter(x=>x.date<'2026-05-08')],['late',leaders.filter(x=>x.date>='2026-05-08')]]){
   for(const marked of [true,false]){
    const obs=sample.filter(x=>flag(x)===marked).map(x=>x.b);
    console.log('leader',label,part,marked,JSON.stringify(summary(obs)));
   }
  }
 }
}

if(process.argv.includes('--holding-review')){
 const {review}=await import('./holding-review.mjs');
 const adjusted=await archive(annual?'annual-adjusted':'adjusted-closes');
 review({holdingDays,opens,indexed,adjusted,defs});
}

if(process.argv.includes('--three-slots')){
 const {compare}=await import('./three-slot-review.mjs');
 const adjusted={...await archive(annual?'annual-adjusted':'adjusted-closes'),...extraAdjusted};
 const windows=(continuous2016||pre2020)?[holdingDays]:process.argv.includes('--continuous-from-2020')?[holdingDays.filter(d=>d.date>='2020-01-01')]:currentReplay&&period==='all'?[holdingDays,...[...new Set(holdingDays.map(d=>d.date.slice(0,4)))].map(y=>holdingDays.filter(d=>d.date.startsWith(y)))]:[holdingDays];
 for(const window of windows)await compare(window,opens,indexed,adjusted,(s,d)=>points(s,d)||verifiedMinuteDay(s,d)||(process.argv.includes('--weak-top-ten-backfill')?backfilledStarts.get(s+d)?.raw:null));
}

if(process.argv.includes('--share-context')){
 const read=async key=>JSON.parse(await readFile(new URL('../data/'+key,import.meta.url)));
 const rows=[...(await read('etf-share-history.json')).rows,...(await read('etf-shares.json')).rows];
 try{
  const log=await readFile(new URL('../data/etf-share-observations.jsonl',import.meta.url),'utf8');
  for(const line of log.trim().split('\n').filter(Boolean))rows.push(...JSON.parse(line));
 }catch(err){if(err.code!=='ENOENT')throw err;}
 const versions=Map.groupBy(rows,r=>r.symbol+r.date);
 for(const values of versions.values())values.sort((a,b)=>Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt));
 const snapshots=(await read('forecast-archive.json')).records;
 for(const realTime of [true,false]){
  const groups=new Map();
  for(const x of cases.filter(x=>x.b)){
   const i=dates.indexOf(x.date),days=dates.slice(i-6,i),deadline=Date.parse(x.date+'T08:00:00+08:00');
   const levels=days.map(d=>versions.get(x.symbol+d)?.find(r=>!realTime||Date.parse(r.fetchedAt)<=deadline)?.shares);
   let change=null;
   if(levels.every(n=>n>0)&&levels.slice(1).every((n,j)=>Math.abs(n/levels[j]-1)<=.25))change=levels.at(-1)/levels[0]-1;
   else if(realTime){
    const s=snapshots.filter(r=>r.symbol===x.symbol&&Date.parse(r.observedAt)<=deadline&&r.inputs?.shares?.five?.ready&&r.inputs.shares.five.from===days[0]&&r.inputs.shares.five.to===days.at(-1)).sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
    if(s)change=s.inputs.shares.five.pct/100;
   }
   const bars=daily.get(x.symbol).filter(b=>b.date<x.date).slice(-60);
   const lo=Math.min(...bars.map(b=>b.low)),hi=Math.max(...bars.map(b=>b.high));
   const high=(bars.at(-1).close-lo)/(hi-lo)>=.7;
   const category=change===null?'unknown':change<0?'out':change>0?'in':'flat';
   for(const group of [category,...(high?['high-'+category]:[])]){
    for(const part of ['all',x.date<'2026-05-08'?'early':'late']){
     const key=part+'/'+group;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(x.b);
    }
   }
  }
  for(const [k,g] of [...groups].sort())console.log('flow',realTime,k,g.length,g.filter(x=>x.failed).length,mean(g.map(x=>x.close)));
 }
}
