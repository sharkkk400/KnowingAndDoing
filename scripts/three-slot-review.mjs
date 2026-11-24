import {annualStabilityCases,bondRegimeCases} from './annual-stability-cases.mjs';
import {reserveOperations,dailyOperationLimit} from '../daily-operations.mjs';
import {allocateBudget} from '../account-budget.mjs';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {holdingPlan} from '../holding-plan.mjs';
import {allowedSymbols,positionLimit} from '../position-limit.mjs';
const fee=process.argv.includes('--double-cost')?.002:process.argv.includes('--legacy-commission')?.001:.0003;
const minimumFee=process.argv.includes('--minimum-five')?5:0;
const commission=value=>Math.max(minimumFee,value*fee);
function stats(nav){
 let peak=nav[0],dd=0;
 for(const v of nav){peak=Math.max(peak,v);dd=Math.max(dd,1-v/peak);}
 return [nav.at(-1)/nav[0]-1,dd].map(n=>(100*n).toFixed(3));
}
function recentVolatilityHigher(closes,date){
 const history=Object.keys(closes).filter(d=>d<date).sort().slice(-21).map(d=>closes[d]);
 assert(history.length===21&&history.every(x=>x>0),'Missing volatility history');
 const returns=history.slice(1).map((x,i)=>x/history[i]-1);
 function variance(xs){
  const mean=xs.reduce((a,b)=>a+b,0)/xs.length;
  return xs.reduce((sum,x)=>sum+(x-mean)**2,0)/(xs.length-1);
 }
 return variance(returns.slice(-5))>variance(returns);
}
export async function compare(days,opens,indexed,adjusted,minuteDay){
 const rankScenarios=[[[2.27,2.27,2.27],4.55],[[3,2.27,1.54],4.55],[[3.4,2.27,1.14],4.55],[[1.54,2.27,3],4.55],[[4.54,4.54,4.54],9.1]];
 const sizeScenarios=[rankScenarios[0],...[5,10,15].flatMap(size=>[1.25,1.5,2].map(mult=>[[size,size,size],size*mult]))];
 const exits=process.argv.includes('--exit-rules');
 const redemption=process.argv.includes('--redemption-exit');
 let streak;
 if(redemption){
  const read=async name=>JSON.parse(await readFile(new URL('../data/'+name,import.meta.url)));
  const rows=[...(await read('etf-share-history.json')).rows,...(await read('etf-shares.json')).rows];
  try{const log=await readFile(new URL('../data/etf-share-observations.jsonl',import.meta.url),'utf8');
   for(const line of log.trim().split('\n').filter(Boolean))rows.push(...JSON.parse(line));
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const versions=Map.groupBy(rows,r=>r.symbol+r.date);
  for(const v of versions.values())v.sort((a,b)=>Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt));
  const snapshots=(await read('forecast-archive.json')).records;
  streak=(s,dates,deadline)=>{
   const levels=dates.map(d=>versions.get(s+d)?.find(v=>Date.parse(v.fetchedAt)<=deadline)?.shares);
   if(levels.every(x=>x>0)&&levels.slice(1).every((x,j)=>Math.abs(x/levels[j]-1)<=.25))return levels.slice(1).every((x,j)=>x<levels[j]);
   const snap=snapshots.filter(r=>r.symbol===s&&Date.parse(r.observedAt)<=deadline&&r.inputs?.shares?.five?.ready&&r.inputs.shares.date===dates.at(-1)).sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
   return snap?(snap.inputs.shares.direction===-1&&snap.inputs.shares.streak>=3):null;
  };
 }
 const roundLots=process.argv.includes('--round-lots');
 const reserveTest=process.argv.includes('--reserve-add');
 const rotationTest=process.argv.includes('--rotation');
 const fixed=rotationTest||reserveTest||redemption||exits||process.argv.includes('--fixed-cash');
 const reserveCash=process.argv.includes('--cash-buffer');
 const compareCaps=process.argv.includes('--equal-caps');
 const leaderStudy=process.argv.includes('--leader-entry-study');
 const leaderCapStudy=process.argv.includes('--leader-cap-study');
 const rankExitStudy=process.argv.includes('--rank-exit-study');
 const recoveryExitStudy=process.argv.includes('--three-close-exit-study');
 const trimStudy=process.argv.includes('--two-close-trim-study');
 const restoreStudy=process.argv.includes('--five-day-restore-study');
 const onceStudy=process.argv.includes('--once-trim-study');
 const finalReview=process.argv.includes('--final-review');
 const followerStudy=process.argv.includes('--follower-size-study');
 const capitalStudy=process.argv.includes('--capital-allocation-study');
 const compareSizing=capitalStudy||followerStudy||finalReview||onceStudy||restoreStudy||trimStudy||recoveryExitStudy||rankExitStudy||leaderCapStudy||leaderStudy||process.argv.includes('--rank-entry-study')||compareCaps||process.argv.includes('--compare-sizing');
 const limited=process.argv.includes('--daily-limit');
 if(limited)assert(compareSizing);
 const accountTest=compareSizing||reserveCash||process.argv.includes('--account-100k');
 const rankBudgetStudy=process.argv.includes('--rank-entry-study');
 const rankExits=['half20',trimStudy?'two-close-trim':recoveryExitStudy?'three-close-exit':'lower-exit20'].map(mode=>[[20000,10000,10000],30000,100000,false,mode]);
 const restoreScenarios=['half20',onceStudy?'once-trim':'restore-five'].map(mode=>[[20000,10000,10000],30000,100000,false,mode]);
 const finalScenarios=[];
 if(finalReview){
  const exits=['half20','two-close-trim','exit20','wait60','once-trim','three-close-exit','lower-exit20','restore-five'];
  for(const weights of [[20000,10000,10000],[10000,10000,10000],[20000,20000,20000]]){
   for(const target of [0,25000,30000,33333]){
    for(const mode of exits)finalScenarios.push([weights,target,100000,false,mode]);
   }
  }
 }
 const allocationCases=[];
 if(capitalStudy){
  for(const first of [20000,30000,40000,50000,60000,70000,80000,90000,100000]){
   for(const lower of [5000,10000,20000,30000]){
    if(lower>first)continue;
    for(const cap of new Set([first,Math.min(100000,first+10000),Math.min(100000,first+30000),100000]))
     allocationCases.push([[first,lower,lower],cap,100000]);
   }
  }
 }
 const audit=process.argv.includes('--operation-audit');
 const legacy=audit&&process.argv.includes('--legacy-account-limit');
 const restoreAmountStudy=process.argv.includes('--last-trim-amount-study');
 const stagedStudy=process.argv.includes('--staged-leader-study');
 const waitStudy=process.argv.includes('--wait-three-add-study');
 const timingGrid=process.argv.includes('--leader-timing-grid');
 const supportStudy=process.argv.includes('--entry-support-study');
 const robustnessStudy=process.argv.includes('--leader-risk-sizing-study');
 const refineSizing=process.argv.includes('--refine-opening-sizes');
 const riskSizingCases=robustnessStudy?(refineSizing?[5000,10000,12500,15000,17500]:[15000,20000,25000,30000]).flatMap(first=>(refineSizing?[1000,2500,4000]:[2500,5000,7500]).flatMap(lower=>(refineSizing?[5]:[3,5,8]).map(days=>[[first,lower,lower],90000,100000,false,'hold-after-trim',null,false,3,'strict',days]))):[];
 const currentReplay=process.argv.includes('--current-replay');
 const replayModes=process.argv.includes('--volatility-leader-study')?['hold-after-trim','volatility-leader']:stagedStudy?['hold-after-trim','staged-leader']:['hold-after-trim'];
 const combined=process.argv.includes('--combined-200k');
 const current200k=process.argv.includes('--current-200k');
 const firstIndustryStudy=process.argv.includes('--first-industry-150k');
 const scenarios=process.argv.includes('--reset-2020')&&current200k?[[[33300,33300,33300],75000,150000,false,'hold-after-trim',null,false,3,'strict']]:firstIndustryStudy?[33300,50000,60000,75000,90000].map(n=>[[n,33300,33300],75000,150000,false,'hold-after-trim',null,false,3,'strict']):current200k?[[[33300,33300,33300],100000,200000,false,'hold-after-trim',null,false,3,'strict']]:currentReplay?replayModes.map(mode=>[[10000,1000,1000],90000,100000,false,mode,null,false,3,'strict']):robustnessStudy?riskSizingCases:supportStudy?['none','strict','touch'].map(rule=>[[20000,5000,5000],90000,100000,false,'hold-after-trim',null,false,3,rule]):timingGrid?[1,2,3,4,5,10].flatMap(wait=>[50000,70000,80000,90000].map(target=>[[20000,5000,5000],target,100000,false,'wait-three-add',null,false,wait])):waitStudy?['hold-after-trim','wait-three-add'].map(mode=>[[20000,5000,5000],90000,100000,false,mode]):stagedStudy?['hold-after-trim','staged-leader'].map(mode=>[[20000,5000,5000],90000,100000,false,mode]):restoreAmountStudy?['half20','last-trim-amount','hold-after-restore','hold-after-trim'].map(mode=>[[20000,5000,5000],90000,100000,false,mode]):audit?[100000,90000,80000,70000,60000].map(n=>[[20000,5000,5000],n,100000]):capitalStudy?allocationCases:followerStudy?[10000,5000].map(lower=>[[20000,lower,lower],30000,100000]):finalReview?finalScenarios:(restoreStudy||onceStudy)?restoreScenarios:(rankExitStudy||recoveryExitStudy||trimStudy)?rankExits:leaderCapStudy?[25000,30000,33333].map(target=>[[20000,10000,10000],target,100000]):leaderStudy?[20000,10000].map(first=>[[first,10000,10000],33333,100000]):rankBudgetStudy?[20000,15000,10000].map(lower=>[[20000,lower,lower],33333,100000]):compareCaps?(process.argv.includes('--cap-study')?[0,25000,33333,40000,50000]:[33333,40000,50000]).map(cap=>[[20000,20000,20000],cap,100000]):compareSizing?[[[30000,20000,10000],70000,100000],[[20000,20000,20000],33333,100000]]:reserveCash?[25000,33333,50000].map(c=>[[20000,20000,20000],c,100000]):accountTest?[[[15000,15000,15000],20000,100000],[[20000,20000,20000],25000,100000],[[20000,15000,10000],25000,100000],[[25000,25000,25000],30000,100000],[[30000,30000,30000],0,100000]]:rotationTest?[90000,180000].flatMap(c=>[false,true].map(rotate=>[null,null,c,false,'half20',null,rotate])):reserveTest?[90000,180000].flatMap(c=>[false,'reserve','refill'].map(add=>[null,null,c,add])):redemption?[90000,180000].flatMap(c=>['baseline','known','backfill'].map(flow=>[null,null,c,false,'half20',flow])):exits?[90000,180000].flatMap(capital=>['half20','exit20','wait60'].map(mode=>[null,null,capital,false,mode])):fixed?[90000,180000].flatMap(capital=>[false,true].map(allowAdd=>[null,null,capital,allowAdd])):process.argv.includes('--sizes')?sizeScenarios:rankScenarios;
 const stabilityStudy=process.argv.includes('--annual-stability');
 const lowVolStudy=process.argv.includes('--low-vol-cash-study');
 const defensive=lowVolStudy?'sh515450':process.argv.includes('--bank-defense-study')?'sh512800':'sh511010';
 const defensiveCloses=new Map(),lowVolTrend=new Map();
 const attributionStudy=process.argv.includes('--turn-attribution');
 const coverageFile=process.env.TURN_DIRECTION_REPLAY;
 const monthlyLeaders=coverageFile?JSON.parse(await readFile(coverageFile,'utf8')):{};
 const risingMarket60=new Map();
 const trialCapStudy=process.argv.includes('--trial-no-add');
 const reboundStudy=process.argv.includes('--rebound-index-study');
 const reboundCashStudy=process.argv.includes('--cash-recovery-10k');
 const earlyBounceStudy=process.argv.includes('--prolonged-weak-bounce');
 const earlyBounceSignals=new Map(),confirmedBounceSignals=new Map();
 const industryProbe=process.argv.includes('--industry-recovery-leader');
 const attributionCases=(current200k?['cash']:earlyBounceStudy?(process.argv.includes('--bounce-fast-exit')?['cash','early-bounce','bounce-trim','bounce-flat']:process.argv.includes('--half-gain-confirm')?['cash','early-bounce','confirmed-bounce']:['cash','early-bounce']):industryProbe?['cash']:reboundCashStudy?['cash','rebound-index']:lowVolStudy?['cash','low-vol','low-vol-ma20']:process.argv.includes('--rebound-handoff-study')?['profitable-add','rebound-impulse','impulse-handoff']:reboundStudy?(process.argv.includes('--rebound-impulse')?['profitable-add','rebound-index','rebound-impulse']:['profitable-add','rebound-index']):trialCapStudy?['profitable-add','race-strict-priority','race-known-priority','race-strict-capped-priority','race-known-capped-priority']:process.argv.includes('--trial-priority')?['profitable-add','race-strict','race-known','race-strict-priority','race-known-priority']:process.argv.includes('--weak-top-ten')?['profitable-add','race-strict','race-known']:coverageFile?['original','coverage','coverage-add']:['original','bond-trend','entry-trend','profitable-add']).map(id=>({id,period:20,strongBudget:0,budget:earlyBounceStudy||reboundCashStudy||id==='cash'?0:60000,cap:90000}));
 const pentadAdds=process.argv.includes('--pentad-adds');
 const pentadStudy=process.argv.includes('--regime-pentad');
 if(pentadAdds)for(const addGate of ['成交拥挤','长期动量','MACD柱体'])attributionCases.push({...attributionCases[0],addGate});
 const flowFile=process.env.PENTAD_FLOW_FLAGS;
 const flowFlags=flowFile?JSON.parse(await readFile(flowFile,'utf8')):{};
 if(flowFile)for(const flowGate of ['份额首仓','份额加仓'])attributionCases.push({...attributionCases[0],flowGate});
 const pentadCache=new Map();
 if(pentadStudy)for(const gate of ['high-vol','crowded','both'])attributionCases.push({...attributionCases[0],gate});
 function pentadFlags(symbol,date){
  const key=symbol+date;
  if(pentadCache.has(key))return pentadCache.get(key);
  const history=[...indexed.get(symbol).values()].filter(b=>b.date<=date).sort((a,b)=>a.date.localeCompare(b.date)).slice(-250);
  const closes=history.map(b=>adjusted[symbol]?.[b.date]);
  const mean=x=>x.reduce((a,b)=>a+b,0)/x.length;
  const sd=x=>Math.sqrt(mean(x.map(v=>(v-mean(x))**2)));
  const last=closes.slice(-21),r=last.slice(1).map((v,i)=>v/last[i]-1);
  const amt=history.slice(-60).map(b=>b.close*b.volume);
  let ema12=closes[0],ema26=closes[0],signal=0,diff=0;
  for(const close of closes.slice(1)){
   ema12+=(close-ema12)*2/13;ema26+=(close-ema26)*2/27;diff=ema12-ema26;
   signal+=(diff-signal)*2/10;
  }
  const flags={weakMacd:closes.length>=60&&diff<=signal,
   weakLong:history.length===250&&closes.at(-1)<=closes[0],
   hot:closes.length===250&&closes.at(-1)>=.97*Math.max(...closes)&&sd(r)*Math.sqrt(252)>=.45,
   crowded:amt.length===60&&mean(amt.slice(-5))-mean(amt)>sd(amt)};
  pentadCache.set(key,flags);return flags;
 }
 const annualTargetStudy=process.argv.includes('--annual-target-study');
 if(annualTargetStudy){
  for(const variant of ['leader-only','early-open','size-50','size-60','leader-50']){
   attributionCases.push({...attributionCases[0],variant});
  }
 }
 const transitionStudy=process.argv.includes('--transition-index');
 const marketFastMean=new Map();
 if(transitionStudy){
  for(const limit of [33300,60000])attributionCases.push({...attributionCases[0],transitionLimit:limit});
  const bars=[...indexed.get('sh000300').values()].sort((a,b)=>a.date.localeCompare(b.date));
  for(let i=4;i<bars.length;i++)marketFastMean.set(bars[i].date,bars.slice(i-4,i+1).reduce((n,b)=>n+b.close,0)/5);
 }
 const crowdedDefenseStudy=process.argv.includes('--crowded-defense-study');
 if(crowdedDefenseStudy)attributionCases[0].gate='crowded';
 const coalStudy=process.argv.includes('--coal-weak-start');
 if(process.argv.includes('--coal-balance'))for(const defenseBudget of [33300,60000])attributionCases.push({...attributionCases[0],filter:'coal-'+defenseBudget,defenseBudget});
 if(coalStudy&&!process.argv.includes('--coal-risk-momentum'))attributionCases.push({...attributionCases[0],filter:'coal-relative'});
 if(process.argv.includes('--review-defensive-filter')){
  const original=attributionCases[0];
  for(const filter of ['cash-only','above20','above60','above60-rising'])attributionCases.push({...original,filter});
 }

 const turningStudy=process.argv.includes('--early-turn-study');
 const turningSignals=new Map(),impulseDates=new Set();
 const turningCases=[{id:'base'},{id:'fixed60',budget:60000,cap:90000},{id:'confirmed',strongBudget:0,budget:60000,cap:90000}];
 if(turningStudy){
  const bars=[...indexed.get('sh000300').values()].sort((a,b)=>a.date.localeCompare(b.date));
  if(earlyBounceStudy||combined){
   let weakSessions=0;
   for(let i=59;i+1<bars.length;i++){
    const bar=bars[i],mean60=bars.slice(i-59,i+1).reduce((sum,b)=>sum+b.close,0)/60;
    const volume20=bars.slice(i-20,i).reduce((sum,b)=>sum+b.volume,0)/20;
    if(weakSessions>=20&&bar.close>=1.02*bars[i-1].close&&volume20>0&&bar.volume>=1.2*volume20){
     earlyBounceSignals.set(bars[i+1].date,bar.low);
     if(i+2<bars.length&&bars[i+1].close>=(bar.close+bars[i-1].close)/2)confirmedBounceSignals.set(bars[i+2].date,bar.low);
    }
    weakSessions=bar.close<mean60?weakSessions+1:0;
   }
  }
  if(reboundStudy)for(let i=21;i<bars.length;i++){
   const last=bars[i-1],avg=bars.slice(i-21,i-1).reduce((sum,b)=>sum+b.volume,0)/20;
   if(avg>0&&last.volume>=1.2*avg&&last.close>=1.02*bars[i-2].close)impulseDates.add(bars[i].date);
  }
  if(attributionStudy){
   for(let i=65;i<bars.length;i++){
    const sum=part=>part.reduce((v,b)=>v+b.close,0);
    risingMarket60.set(bars[i].date,sum(bars.slice(i-5,i))>sum(bars.slice(i-65,i-60)));
   }
  }
  for(const period of (process.argv.includes('--nearby-turn-periods')?[15,20,25]:[5,10,20])){
   for(const budget of [30000,60000])turningCases.push({id:'turn-'+period+'-'+budget,period,strongBudget:0,budget,cap:90000});
   let bullish=false;
   for(let i=period+1;i<bars.length;i++){
    const prior=bars.slice(i-period,i);
    const mean=prior.reduce((sum,b)=>sum+b.close,0)/period;
    const close=prior.at(-1).close, displaced=bars[i-period-1].close;
    if(close>mean&&close>displaced)bullish=true;
    if(close<mean&&close<displaced)bullish=false;
    turningSignals.set(period+'-'+bars[i].date,bullish);
   }
  }
 }
 const scoreDefense=process.argv.includes('--weak-core8');
 const scoredDays=new Map();
 if(scoreDefense){
  const csv=await readFile(new URL('../outputs/弱市逐信号日防守选择.csv',import.meta.url),'utf8');
  for(const line of csv.trim().split(/\r?\n/).slice(1)){
   const [start,end,,symbol,count]=line.split(',');
   if(count!=='3')continue;
   for(const date of indexed.get('sh000300').keys())if(date>=start&&(!end||date<end))scoredDays.set(date,'sh'+symbol);
  }
  attributionCases.push({...attributionCases[0],filter:'weak-core8'});
 }
 const riskMomentum=process.argv.includes('--coal-risk-momentum');
 const confirmRelative20=process.argv.includes('--coal-confirm-relative20');
 const horizons=confirmRelative20?[20,120]:riskMomentum?[60,120,250]:process.argv.includes('--coal-horizons')?[20,60,120,250]:[20];
 const lockedByPeriod=new Map();
 if(coalStudy){
  const dates=[...indexed.get('sh000300').keys()].sort();
  for(const horizon of horizons){
   const decisions=new Map();
   lockedByPeriod.set(horizon,decisions);
   if(horizon!==20)attributionCases.push({...attributionCases[0],filter:'coal-relative-'+horizon,horizon});
   let wasWeak=false,choice='sh515450';
   for(let i=21;i<dates.length;i++){
    const weak=turningSignals.get('20-'+dates[i])===false;
    if(weak&&!wasWeak){
     const growth=s=>adjusted[s]?.[dates[i-1]]/adjusted[s]?.[dates[i-1-horizon]];
     const coal=growth('sh515220'),red=growth('sh515450');
     choice=Number.isFinite(coal)&&Number.isFinite(red)&&coal>red?'sh515220':'sh515450';
     if(confirmRelative20&&horizon===120){
      const relativeAt=t=>adjusted.sh515220?.[t]/adjusted.sh515450?.[t];
      const shortRatio=relativeAt(dates[i-1])/relativeAt(dates[i-21]);
      if(!(shortRatio>=1))choice='sh515450';
      console.log('weakChoice',dates[i],coal/red,shortRatio,choice);
     }
     if(riskMomentum){
      const active=[];
      for(let j=i-horizon;j<i;j++){
       const change=s=>Math.log(adjusted[s]?.[dates[j]]/adjusted[s]?.[dates[j-1]]);
       active.push(change('sh515220')-change('sh515450'));
      }
      const mean=active.reduce((a,b)=>a+b,0)/horizon;
      const sd=Math.sqrt(active.reduce((a,b)=>a+(b-mean)**2,0)/(horizon-1));
      choice=mean*Math.sqrt(horizon)>sd&&sd>0?'sh515220':'sh515450';
     }
    }
    if(weak)decisions.set(dates[i],choice);
    wasWeak=weak;
   }
  }
 }
 if(stabilityStudy){
  const prices=adjusted[defensive],calendar=[...indexed.get('sh000300').keys()].sort();
  if(lowVolStudy)for(let i=20;i<calendar.length;i++){
   const prior=calendar.slice(i-20,i).map(d=>prices[d]);
   if(prior.every(p=>p>0))lowVolTrend.set(calendar[i],Math.sign(20*prior[19]-prior.reduce((a,b)=>a+b,0)));
  }
  for(let i=60;i<calendar.length;i++){
   const prior=calendar.slice(i-60,i).map(d=>prices[d]);
   defensiveCloses.set(calendar[i],prior.every(p=>p>0)&&prior[59]>prior.reduce((a,b)=>a+b,0)/60);
  }
 }
 for(const [weights,cap,capital=1,allowAdd,exitMode='half20',flow,rotate,waitSessions=3,supportRule='touch',riskDays=5] of scenarios)for(const testCase of (stabilityStudy?(attributionStudy?attributionCases:turningStudy?turningCases:process.argv.includes('--bond-regime-study')?bondRegimeCases():annualStabilityCases()):[{}]))for(const bridgeLimit of (process.argv.includes('--idle-index-study')?[0,10000,25000,50000]:[0])){
  if(transitionStudy)console.log("transitionCase",testCase.transitionLimit||0);
  if(flowFile)console.log('targetCase',testCase.flowGate||'baseline');
  if(pentadAdds)console.log('targetCase',testCase.addGate||'baseline');
  if(pentadStudy)console.log('targetCase',testCase.gate||'baseline');
  if(annualTargetStudy)console.log('targetCase',testCase.variant||'baseline');
  if(scoreDefense||coalStudy||process.argv.includes('--review-defensive-filter'))console.log('defenseCase',testCase.filter||'baseline');
  if(firstIndustryStudy)console.log('firstSize',weights[0]);
  const example=[],maSales=[];
  const inExample=(symbol,date)=>(leaderStudy||leaderCapStudy||recoveryExitStudy||trimStudy||restoreStudy||onceStudy)&&symbol==='sh515880'&&date>='2025-06-06'&&date<='2025-11-17';
  let maxOperations=0,fullDays=0,trades=0;
  let swaps=0,lateSwaps=0,missing=0;
  let advanced=0,qualifying=0,known=0;
  let extraAdds=0,lateExtra=0,minCash=capital,peakRisk=0;
  let cash=capital,split=0,exposureSum=0,maxHeld=0,adds=0;
  const ledger=[],yearEnd={};
  let buyFees=0,sellFees=0;
  const book=new Map(),nav=[capital],entries=[0,0,0],lateEntries=[0,0,0];
  const trialCannotAdd=testCase.id?.includes('-capped-');
  const useCoverage=testCase.id?.startsWith('coverage');
  let side=null, monthLeader=null;
  let previousBudget=null;
  let bridgeUnits=0,bridgeTrades=0,previousBreakout=false;
  let bridgeSymbol=combined?'sh515450':testCase.budget?defensive:'sh510300';
  if(testCase.defenseBudget)bridgeSymbol='sh515220';
  let yearHigh=capital,previousYear=null;
  let sessionIndex=-1,restores=0;
  for(const {date,plan,alerts} of days){
   sessionIndex++;
   if(testCase.filter==='weak-core8'&&!bridgeUnits)bridgeSymbol=scoredDays.get(date)??'sh515450';
   const lockedDefense=lockedByPeriod.get(testCase.horizon??20);
   if(testCase.filter?.startsWith('coal-relative')&&!bridgeUnits&&lockedDefense?.has(date))bridgeSymbol=lockedDefense.get(date);
   if(date==='2026-05-08')split=nav.length-1;
   let operations=0;
   const counts=new Map();
   const dailyFills=[];
   function recordOperation(symbol){
    const count=(counts.get(symbol)||0)+1;
    if(limited)assert(count<=dailyOperationLimit);
    counts.set(symbol,count);
    operations++;
   }
   const start=nav.at(-1);
   const px=(s,raw)=>raw*adjusted[s][date]/indexed.get(s).get(date).close;
   if(previousYear!==date.slice(0,4)){yearHigh=start;previousYear=date.slice(0,4);}
   yearHigh=Math.max(yearHigh,start);
   const handoff=testCase.id==='impulse-handoff';
   const rebound=handoff||testCase.id==='rebound-index'||testCase.id==='rebound-impulse';
   const mkt=plan.market;
   const inRecovery=rebound&&turningSignals.get('20-'+date)&&mkt.close>mkt.ma20&&mkt.ma20<=mkt.ma60;
   if(testCase.id==='rebound-impulse'&&inRecovery&&impulseDates.has(date)&&process.argv.includes('--out-of-sample-2016-2019'))console.log('impulseSignal',date,side?'held':'flat');
   if(handoff&&side&&mkt.ma20>mkt.ma60)side.crossed=true;
   const occupiedMorning=new Set(book.keys());
   const morningSleeves=[];
   if(combined){
    const prior=plan.closeDate;
    if(bridgeUnits){occupiedMorning.add(bridgeSymbol);morningSleeves.push({symbol:bridgeSymbol,marketValue:bridgeUnits*adjusted[bridgeSymbol][prior]});}
    if(side){occupiedMorning.add(side.symbol);morningSleeves.push({symbol:side.symbol,marketValue:side.units*side.mark});}
    const priorExposure=morningSleeves.reduce((a,h)=>a+h.marketValue,0)+[...book.values()].reduce((a,h)=>a+h.units*h.lastClose,0);
    let free=Math.min(cash,capital-priorExposure);
    const on=turningSignals.get('20-'+date);
    const strongIdleStudy=process.argv.includes('--strong-idle-index');
    const strong=on&&mkt.regime==='strong';
    if(strongIdleStudy)console.log('strongState',JSON.stringify([date,!!strong,start,priorExposure,book.size]));
    const fastMean=marketFastMean.get(prior);
    const eligibleIndustry=strong&&plan.focusSymbols.some(s=>s!=='sh510300'&&plan.items.find(i=>i.symbol===s)?.entryRule?.enabled);
    const transitioning=testCase.transitionLimit&&on&&mkt.close>mkt.ma20&&mkt.ma20<=mkt.ma60&&mkt.close>=fastMean;
    if(side&&opens[side.symbol]?.[date]>0){
     const open=opens[side.symbol][date],mark=px(side.symbol,open);
     const stalled=side.mark*(1-fee)<=side.entryMark*(1+fee);
     const half=Math.floor(side.units*mark/open/200+1e-7)*100*open;
     const full=side.units*mark;
     const exit=side.transition?(!on||mkt.close<fastMean||mkt.close<mkt.ma20||eligibleIndustry):side.strongIdle?(!strong||book.size>0):sessionIndex-side.entered>=5||mkt.close<side.stop||stalled&&(side.trimmed||full-half<30000||(1-half/full)*side.units*side.mark<30000);
     if(exit||!side.transition&&!side.strongIdle&&stalled&&half>=30000&&half/full*side.units*side.mark>=30000){
      const gross=exit?full:half;
      cash+=gross-commission(gross);recordOperation(side.symbol);
      console.log('sleeve',JSON.stringify([date,side.symbol,exit?'清仓':'减半',gross]));
      if(exit&&side.transition){
       occupiedMorning.delete(side.symbol);
       const ix=morningSleeves.findIndex(h=>h.symbol===side.symbol);
       if(ix>=0)morningSleeves.splice(ix,1);
      }
      if(exit)side=null;else {side.units-=gross/mark;side.trimmed=true;}
     }
    }
    let useDefense=!on;
    if(testCase.filter==='cash-only')useDefense=false;
    if(testCase.filter==='above20')useDefense&&=lowVolTrend.get(date)>0;
    if(testCase.filter?.startsWith('above60'))useDefense&&=defensiveCloses.get(date)===true;
    if(testCase.filter==='above60-rising')useDefense&&=risingMarket60.get(date)===true;
    if(bridgeUnits&&!useDefense&&opens[bridgeSymbol]?.[date]>0){
     const gross=bridgeUnits*px(bridgeSymbol,opens[bridgeSymbol][date]);
     cash+=gross-commission(gross);recordOperation(bridgeSymbol);bridgeUnits=0;
     console.log('sleeve',JSON.stringify([date,bridgeSymbol,'清仓',gross]));
    }
    const offers=[];
    if(earlyBounceSignals.has(date))offers.push(['sh510300',33300]);
    if(transitioning&&!book.size&&!earlyBounceSignals.has(date))offers.push(['sh510300',testCase.transitionLimit,false,true]);
    if(useDefense)offers.push([bridgeSymbol,testCase.defenseBudget??60000]);
    if(strongIdleStudy&&strong&&!book.size&&!earlyBounceSignals.has(date))offers.push(['sh510300',60000,true]);
    for(const [symbol,limit,strongIdle,transition] of offers){
     const item=plan.items.find(i=>i.symbol===symbol),open=opens[symbol]?.[date];
     if(plan.status!=='ready'||plan.warnings?.some(w=>w.includes('收盘日期与上一工作日不一致'))||!(item?.close>0&&open>0)||occupiedMorning.has(symbol)||occupiedMorning.size>=3)continue;
     const budget=Math.min(limit,Math.floor(free/(1+fee)));
     if(Math.floor(budget/(100*item.close))*100*item.close<30000)continue;
     occupiedMorning.add(symbol);morningSleeves.push({symbol,marketValue:budget*(1+fee)});
     free-=budget*(1+fee);
     const gross=Math.floor(budget/(100*open))*100*open;
     if(gross<30000)continue;
     cash-=gross+commission(gross);recordOperation(symbol);
     const mark=px(symbol,open),units=gross/mark;
     if(symbol===bridgeSymbol)bridgeUnits=units;
     else side={symbol,units,mark,strongIdle,transition,entryMark:mark,entered:sessionIndex,stop:earlyBounceSignals.get(date)};
     console.log('sleeve',JSON.stringify([date,symbol,'买入',gross]));
    }
   }
   const confirmed=testCase.id==='confirmed-bounce';
   const fastExit=testCase.id==='bounce-trim'||testCase.id==='bounce-flat';
   const earlyBounce=confirmed||fastExit||testCase.id==='early-bounce';
   const bounceSignals=confirmed?confirmedBounceSignals:earlyBounceSignals;
   const stalled=fastExit&&side&&side.mark*(1-fee)<=side.entryMark*(1+fee);
   const earlyExit=earlyBounce&&side&&(sessionIndex-side.entered>=5||mkt.close<side.stop||
    (stalled&&(testCase.id==='bounce-flat'||side.trimmed)));
   if(stalled&&!earlyExit&&opens[side.symbol]?.[date]>0){
    const open=opens[side.symbol][date],mark=px(side.symbol,open);
    const lots=Math.floor(side.units*mark/open/200+1e-7);
    if(lots>0){
     const gross=lots*100*open,net=gross-commission(gross);
     side.units-=gross/mark;side.trimmed=true;cash+=net;recordOperation(side.symbol);
     if(days.length>400)console.log('reboundFill',JSON.stringify([testCase.id,date,'half',net]));
    }
   }
   if((earlyExit||rebound&&side&&(handoff&&side.crossed?mkt.close<=mkt.ma20:!inRecovery))&&opens[side.symbol]?.[date]>0){
    const gross=side.units*px(side.symbol,opens[side.symbol][date]);
    if(days.length>400)console.log('reboundFill',JSON.stringify([testCase.id,date,'sell',gross-commission(gross)]));
    cash+=gross-commission(gross);recordOperation(side.symbol);side=null;
   }
   if(useCoverage){
    if(Object.hasOwn(monthlyLeaders,date))monthLeader=monthlyLeaders[date];
    const desired=turningSignals.get('20-'+date)?null:monthLeader;
    if(side&&side.symbol!==desired&&opens[side.symbol]?.[date]>0){
     const gross=side.units*px(side.symbol,opens[side.symbol][date]);
     cash+=gross-commission(gross);recordOperation(side.symbol);side=null;
    }
    if(desired&&!side&&!book.has(desired)&&book.size+Number(bridgeUnits>0)<positionLimit&&opens[desired]?.[date]>0){
     const open=opens[desired][date],gross=Math.floor(Math.min(10000,cash/(1+fee))/(100*open))*100*open;
     if(gross>0){
      cash-=gross+commission(gross);side={symbol:desired,units:gross/px(desired,open),mark:px(desired,open)};
      recordOperation(desired);
      if(days.length>400)console.log('coverageFill',JSON.stringify([testCase.id,date,desired,gross]));
     }
    }
   }
   if(bridgeLimit||testCase.budget){
    const strong=plan.market.regime==='strong';
    const open=opens[bridgeSymbol]?.[date];
    const priorWeekday=new Date(date+'T00:00:00Z');
    do{priorWeekday.setUTCDate(priorWeekday.getUTCDate()-1);}while([0,6].includes(priorWeekday.getUTCDay()));
    const idle=!previousBreakout&&!book.size;
    const bondEligible=(!testCase.regime?.includes('idle')||idle)&&(!testCase.regime?.includes('above60')||defensiveCloses.get(date));
    const enter=testCase.budget?bondEligible&&book.size<positionLimit&&!book.has(bridgeSymbol):strong&&idle&&plan.closeDate===priorWeekday.toISOString().slice(0,10);
    if(testCase.strongBudget!==undefined){
     const m=plan.market;
     const riskOn=testCase.period?turningSignals.get(testCase.period+'-'+date):m.close>m.ma20&&m.ma20>m.ma60&&m.ma60>0;
     const trend=lowVolTrend.get(date);
     const skipLowVol=testCase.id==='low-vol-ma20'&&!(trend>0||(trend===0&&bridgeUnits>0));
     const target=(riskOn||skipLowVol||(testCase.id==='bond-trend'&&!defensiveCloses.get(date)))?testCase.strongBudget:testCase.budget;
     if(open>0&&target!==previousBudget&&!book.has(bridgeSymbol)){
      const mark=px(bridgeSymbol,open), value=bridgeUnits*mark;
      const change=target-value;
      const gross=change<0?(target===0?value:Math.floor(-change/(100*open))*100*open):Math.floor(Math.min(change,cash/(1+fee))/(100*open))*100*open;
      if(gross>0&&(change<0||bridgeUnits>0||book.size+Number(!!side)<positionLimit)){
       const signed=change<0?-gross:gross;
       if(attributionStudy&&days.length>400)console.log('leg',JSON.stringify([testCase.id,date,bridgeSymbol,'债',-signed-commission(gross),signed/mark,commission(gross)]));
       cash-=signed+commission(gross);bridgeUnits=target===0?0:bridgeUnits+signed/mark;
       if(change<0)sellFees+=commission(gross);else buyFees+=commission(gross);
       bridgeTrades++;recordOperation(bridgeSymbol);
      }
      previousBudget=target;
     }
    }else if(open>0&&bridgeUnits&&(testCase.budget?!bondEligible:(!strong||previousBreakout||book.size))){
     const proceeds=bridgeUnits*px(bridgeSymbol,open);
     cash+=proceeds-commission(proceeds);sellFees+=commission(proceeds);
     bridgeUnits=0;bridgeTrades++;recordOperation(bridgeSymbol);
    }else if(open>0&&!bridgeUnits&&enter){
     const gross=Math.floor(Math.min(testCase.budget||bridgeLimit,cash/(1+fee))/(100*open))*100*open;
     if(gross>0){
      cash-=gross+commission(gross);buyFees+=commission(gross);
      bridgeUnits=gross/px(bridgeSymbol,open);bridgeTrades++;recordOperation(bridgeSymbol);
     }
    }
    previousBreakout=alerts.size>0;
   }
   if(((earlyBounce&&!earlyExit&&bounceSignals.has(date))||inRecovery&&(testCase.id==='rebound-index'||impulseDates.has(date)))&&!side&&!bridgeUnits&&!book.has('sh510300')&&book.size<positionLimit){
    const symbol='sh510300',open=opens[symbol]?.[date];
    const exposure=[...book.values()].reduce((total,p)=>total+p.units*p.lastClose,0);
    const available=Math.min(cash,Math.max(0,100000-exposure));
    const gross=open>0?Math.floor(Math.min((earlyBounce||reboundCashStudy)?10000:30000,available/(1+fee))/(open*100))*open*100:0;
    if(gross>0){
     cash-=gross+commission(gross);side={symbol,units:gross/px(symbol,open),mark:px(symbol,open),entered:sessionIndex,entryMark:px(symbol,open),stop:bounceSignals.get(date)};
     recordOperation(symbol);
     if(days.length>400)console.log('reboundFill',JSON.stringify([testCase.id,date,'buy',gross+commission(gross)]));
    }
   }
   if((reboundCashStudy&&testCase.id==='cash'&&/^2022-(06|11)/.test(date))||(reboundStudy&&testCase.id==='profitable-add'&&date.startsWith('2024'))){
    const enabled=plan.items.filter(i=>i.entryRule?.enabled).map(i=>i.symbol);
    console.log('gateAudit',JSON.stringify({date,regime:mkt.regime,coverage:mkt.coverage,total:mkt.total,ma20:mkt.ma20,ma60:mkt.ma60,close:mkt.close,enabled,alerts:[...alerts.keys()]}));
   }
   const holdings=holdingPlan(plan,[],[...book.values()].map(p=>p.event),[],['once-trim','three-close-exit','lower-exit20','restore-five','last-trim-amount','hold-after-restore','hold-after-trim','staged-leader','volatility-leader','wait-three-add'].includes(exitMode)?'half20':exitMode,process.argv.includes('--runner-add')?2:1,supportRule);
   if(exitMode==='once-trim'){
    for(const h of holdings){
     if(!book.get(h.symbol).trimmedByMA20||h.action!=='减仓'||!(h.close<h.ma20))continue;
     const item=plan.items.find(i=>i.symbol===h.symbol);
     const separateRisk=plan.market.regime==='weak'||plan.market.macroRisk||plan.news.items.some(n=>n.risk&&item.newsIds.includes(n.id));
     if(!separateRisk)h.action='持有';
    }
   }
   if(exitMode==='lower-exit20'){
    for(const h of holdings){
     if(h.action==='减仓'&&h.close<h.ma20&&book.get(h.symbol).entryRank>1)h.action='清仓';
    }
   }
   if(exitMode==='three-close-exit'){
    for(const h of holdings){
     const pos=book.get(h.symbol);
     if(pos.belowCloses==null)continue;
     if(!(h.ma20>0&&h.close>0)||h.close>=h.ma20){pos.belowCloses=null;continue;}
     pos.belowCloses++;
     if(pos.belowCloses>=3&&h.action!=='待核实'&&h.action!=='清仓'){
      h.action='清仓';h.failedRecovery=true;
     }
    }
   }
   const heldAtOpen=new Set(book.keys()),rotatedOut=new Set();
   const allowed=allowedSymbols({...plan,holdings},combined?occupiedMorning:new Set(book.keys()));
   if(combined)for(const h of morningSleeves)allowed.delete(h.symbol);
   let amounts,ordinary;
   if(accountTest){
    const valued=holdings.map(h=>({...h,marketValue:book.get(h.symbol).units*book.get(h.symbol).lastClose}));
    if(reserveCash)ordinary=allocateBudget({...plan,focusSymbols:plan.focusSymbols.filter(s=>allowed.has(s))},valued,weights,25000,cash,25000,fee,minimumFee);
    if(combined)valued.push(...morningSleeves);
    const leader=valued.find(h=>book.has(h.symbol)&&h.symbol===plan.focusSymbols[0]);
    const lastTrim=leader&&book.get(leader.symbol).lastTrimAmount;
    let target=cap;
    if(testCase.cap){
     const weak=plan.market.ma20<plan.market.ma60*1.02;
     const restrict=(!testCase.weakSpread||weak)&&(!testCase.drawdown||start<yearHigh*.98);
     if(restrict)target=Math.min(target,testCase.cap);
    }
    if(current200k){
     plan.sizing={totalBudget:capital,minimumTradeAmount:30000};
     target=Math.floor(capital/Math.max(2,new Set([...(combined?occupiedMorning:book.keys()),...allowed]).size)/100)*100;
    }
    if(['last-trim-amount','hold-after-restore'].includes(exitMode)&&leader){
     if(lastTrim>0)target=Math.min(cap,leader.marketValue+lastTrim);
     else if(exitMode==='hold-after-restore'&&book.get(leader.symbol).restored)target=leader.marketValue;
    }
    if(leader&&['hold-after-trim','staged-leader','volatility-leader','wait-three-add'].includes(exitMode)){
     const position=book.get(leader.symbol);
     if(position.wasTrimmed)target=leader.marketValue;
     else if(exitMode==='wait-three-add'&&sessionIndex-position.openSession<waitSessions)target=leader.marketValue;
     else if(exitMode==='staged-leader'&&!position.added)target=50000;
     else if(exitMode==='volatility-leader'&&!position.added&&recentVolatilityHigher(adjusted[leader.symbol],date))target=50000;
    }
    const concentrate=process.argv.includes('--adaptive-first')&&weights[0]>33300&&plan.risingStrong&&plan.industryLeader;
    let firstSizes=process.argv.includes('--adaptive-first')?(concentrate?[weights[0],0,0]:[33300,33300,33300]):firstIndustryStudy?[plan.industryLeader&&mkt.regime==='strong'?weights[0]:33300,33300,33300]:weights;
    if(mkt.regime==='strong'&&['size-50','size-60','leader-50'].includes(testCase.variant)){
     firstSizes=[testCase.variant==='size-60'?60000:50000,33300,33300];
    }
    if(['leader-only','leader-50'].includes(testCase.variant)){
     for(const symbol of plan.focusSymbols.slice(1))if(!book.has(symbol))allowed.delete(symbol);
    }
    amounts=allocateBudget({...plan,focusSymbols:plan.focusSymbols.filter(s=>allowed.has(s)&&!(trialCannotAdd&&book.get(s)?.trial))},valued,plan.recoveryProbe?[10000,0,0]:firstSizes,plan.recoveryProbe?0:target,cash+(handoff&&side?.crossed?side.units*side.mark*(1-fee):0),reserveCash&&cap===25000?25000:0,fee,minimumFee);
    if(reserveCash)for(const s of amounts.keys())if(!book.has(s))amounts.set(s,ordinary.get(s)||0);
   }
   const restoreOrders=new Map();
   if(exitMode==='restore-five'){
    let exposure=0;
    for(const pos of book.values())exposure+=pos.units*pos.lastClose;
    let available=Math.max(0,Math.min(cash,capital-exposure))/(1+fee);
    for(const h of holdings){
     const pos=book.get(h.symbol),ticket=pos.restoreTicket;
     if(!ticket||sessionIndex-ticket.session>5||!(h.close>h.ma20))continue;
     pos.restoreTicket=null;
     const item=plan.items.find(i=>i.symbol===h.symbol);
     if(!['持有','条件加仓'].includes(h.action)||item.stance!=='conditional')continue;
     const value=pos.units*pos.lastClose;
     const budget=Math.max(0,Math.min(available,cap-value,ticket.units*pos.lastClose));
     if(budget<100*h.close)continue;
     restoreOrders.set(h.symbol,{budget,units:ticket.units});
     available-=budget;
    }
    if(restoreOrders.size){
     const combined=new Map([...restoreOrders].map(([s,o])=>[s,o.budget]));
     for(const [s,amount] of amounts)if(!combined.has(s)&&available>=100){
      const budget=Math.min(amount,Math.floor(available/100)*100);
      combined.set(s,budget);available-=budget;
     }
     amounts=combined;
    }
   }
   if(plan.probeRace){
    amounts.clear();
    if(book.size<positionLimit){
     const first=[...alerts].filter(([s])=>!book.has(s)).sort((a,b)=>a[1].minute-b[1].minute||plan.focusSymbols.indexOf(a[0])-plan.focusSymbols.indexOf(b[0]))[0];
     if(first){
      const symbol=first[0];allowed.add(symbol);
      const valued=holdings.map(h=>({...h,marketValue:book.get(h.symbol).units*book.get(h.symbol).lastClose}));
      amounts=allocateBudget({...plan,focusSymbols:[symbol]},valued,[10000,10000,10000],0,cash,0,fee,minimumFee);
     }
    }
   }
   if(limited){
    const actionable=holdings.filter(h=>h.action!=='减仓'||!book.get(h.symbol).trimmed);
    const reserved=reserveOperations({holdings:actionable},amounts);
    if(legacy){
     const sells=actionable.filter(h=>['清仓','减仓'].includes(h.action)).sort((a,b)=>Number(a.action==='减仓')-Number(b.action==='减仓')||a.symbol.localeCompare(b.symbol));
     for(const h of sells.slice(2))h.action='暂缓操作';
     reserved.buys=reserved.buys.slice(0,Math.max(0,2-sells.length));
    }
    for(const symbol of amounts.keys())if(!reserved.buys.includes(symbol))amounts.delete(symbol);
   }
   for(const h of holdings){
    const p=book.get(h.symbol);
    let exit=h.action==='清仓';let trim=h.action==='减仓';
    if(flow && flow!=='baseline'&&!exit&&h.action!=='待核实'){
     const item=plan.items.find(i=>i.symbol===h.symbol),bars=item.evidence.slice(-60),last=bars.at(-1);
     const low=Math.min(...bars.map(b=>b.low)),high=Math.max(...bars.map(b=>b.high));
     if(last.close<item.ma5 && last.close<bars.at(-2).close && high>low && (last.close-low)/(high-low)>=.7 && !trim){
      qualifying++;
      const out=streak(h.symbol,bars.slice(-4).map(b=>b.date),flow==='known'?Date.parse(plan.cutoffAt):Infinity);
      if(out!==null)known++;
      if(out){trim=true;if(!p.trimmed){advanced++;p.early=true;}}
     }
     if(p.early&&last.close<item.ma5)trim=true;
     else p.early=false;
    }
    if((exit||(trim&&!p.trimmed))&&opens[h.symbol]?.[date]>0&&adjusted[h.symbol]?.[date]>0){
     const factor=px(h.symbol,1);
     let units=exit?p.units:roundLots?Math.floor(p.units*factor/200)*100/factor:p.units/2;
     if(combined&&!exit&&(p.units-units)*Math.min(p.lastClose,px(h.symbol,opens[h.symbol][date]))<30000){
      units=p.units;exit=true;trim=false;h.action='清仓';
     }
     if(current200k&&!(combined&&exit)&&(units*p.lastClose<30000||units*px(h.symbol,opens[h.symbol][date])<30000))continue;
     if(!(units>0)){p.trimmed=true;continue;}
     recordOperation(h.symbol);
     if(trimStudy&&trim&&h.reason.includes('20日均线'))maSales.push({date,s:h.symbol});
     const gross=units*px(h.symbol,opens[h.symbol][date]);
     const proceeds=gross-commission(gross);
     if(attributionStudy&&days.length>400)console.log('leg',JSON.stringify([testCase.id,date,h.symbol,'卖',proceeds,-units,commission(gross)]));
     sellFees+=commission(gross);
     if(inExample(h.symbol,date))example.push({date,net:proceeds});
     if(process.argv.includes('--daily-journal'))dailyFills.push([h.symbol,h.action,opens[h.symbol][date],Math.round(units*factor),proceeds,h.reason]);
     if(audit)ledger.push([date,h.symbol,h.action,proceeds,-units]);
     if(restoreAmountStudy&&!exit)p.lastTrimAmount=proceeds;
     cash+=proceeds;
     if(exitMode==='three-close-exit'&&trim&&h.close<h.ma20)p.belowCloses=0;
     if(exitMode==='restore-five'&&trim&&h.close<h.ma20) p.restoreTicket={units,session:sessionIndex};
     if(exitMode==='once-trim'&&trim&&h.close<h.ma20)p.trimmedByMA20=true;
     if(h.failedRecovery)advanced++;
     p.units-=units;p.wasTrimmed=true;if(exit)book.delete(h.symbol);
    }
    if(h.action!=='待核实'&&opens[h.symbol]?.[date]>0)p.trimmed=trim;
   }
   for(const [s,order] of restoreOrders){
    if(!amounts.has(s))continue;
    amounts.delete(s);
    const pos=book.get(s),open=opens[s][date],fill=px(s,open);
    const maxSpend=Math.min(order.budget,cash/(1+fee),cash-minimumFee,cap-pos.units*fill,order.units*fill);
    const shares=Math.floor(maxSpend/(100*open))*100;
    if(!(shares>0))continue;
    const spend=shares*open+commission(shares*open);buyFees+=commission(shares*open);
    cash-=spend;pos.units+=shares*open/fill;recordOperation(s);restores++;
    if(inExample(s,date))example.push({date,net:-spend});
   }
   const testingProbe=industryProbe&&plan.recoveryProbe;
   if(testingProbe&&turningSignals.get('20-'+date))console.log('industryDay',JSON.stringify([date,plan.items.filter(i=>i.entryRule?.enabled).map(i=>i.symbol),[...alerts.keys()]]));
   const raceDay=testCase.id?.startsWith('race-')&&plan.raceAlerts&&!turningSignals.get('20-'+date);
   const possible=raceDay?[...plan.raceAlerts].filter(([s])=>!book.has(s)&&!heldAtOpen.has(s)&&s!==bridgeSymbol):[];
   possible.sort((a,b)=>a[1].minute-b[1].minute);
   if(raceDay&&days.length>400)console.log('raceDay',testCase.id,date,plan.directionCoverage.length,plan.raceUnknown.length,possible.length);
   const trial=raceDay&&possible.length&&(testCase.id.startsWith('race-known')||!plan.raceUnknown.length)?possible[0]:null;
   let entryAlerts=alerts;
   if(testCase.variant==='early-open'&&mkt.regime==='strong'){
    entryAlerts=new Map(alerts);
    const symbol=plan.focusSymbols[0],item=plan.items.find(i=>i.symbol===symbol);
    const fill=opens[symbol]?.[date];
    if(!heldAtOpen.has(symbol)&&item?.entryRule?.enabled&&allowed.has(symbol)&&fill>0){
     entryAlerts.set(symbol,{fill,confirmedPrice:fill,minute:0,support:item.support});
    }
   }
   if(annualTargetStudy&&!testCase.variant&&days.length>400)console.log('regimeDay',date,mkt.regime);
   for(const [s,a] of (trial?[trial]:[...entryAlerts]).sort((a,b)=>a[1].minute-b[1].minute||plan.focusSymbols.indexOf(a[0])-plan.focusSymbols.indexOf(b[0]))){
    if(!trial&&testCase.period&&!turningSignals.get(testCase.period+'-'+date))continue;
    if(testingProbe&&(book.has(s)||[...book.values()].some(v=>v.recoveryEntry)))continue;
    if(trial&&book.size+Number(bridgeUnits>0)>=positionLimit)continue;
    const canHandoff=handoff&&side?.crossed&&s!==side.symbol;
    if(side&&(s===side.symbol||(!canHandoff&&!book.has(s)&&book.size+1+Number(bridgeUnits>0)>=positionLimit)))continue;
    const priority=testCase.id?.endsWith('-priority')&&!process.argv.includes('--disable-trial-replacement');
    if(priority&&!trial&&!book.has(s)&&(book.size+Number(bridgeUnits>0)>=positionLimit||!allowed.has(s))){
     if(rotatedOut.has(s)||!plan.focusSymbols.includes(s)||!plan.items.find(i=>i.symbol===s)?.entryRule?.enabled)continue;
     const candidates=[...book].filter(([symbol,pos])=>pos.trial&&pos.openSession<sessionIndex&&(counts.get(symbol)||0)<dailyOperationLimit).sort((a,b)=>a[1].openSession-b[1].openSession||a[0].localeCompare(b[0]));
     if(!candidates.length)continue;
     const [out,pos]=candidates[0],idx=a.minute===120?122:a.minute+1;
     const sellPrice=minuteDay(out,date)?.[idx];
     if(!(sellPrice>0)){if(days.length>400)console.log('noSwapQuote',testCase.id,date,out,s);continue;}
     const proceeds=pos.units*px(out,sellPrice),net=proceeds-commission(proceeds);
     const retained=[...book].filter(([symbol])=>symbol!==out).map(([symbol,p])=>({symbol,marketValue:p.units*p.lastClose}));
     const budget=allocateBudget({...plan,focusSymbols:[s]},retained,weights,cap,cash+net,0,fee,minimumFee).get(s)||0;
     if(budget+1e-8<100*a.fill)continue;
     sellFees+=commission(proceeds);recordOperation(out);cash+=net;book.delete(out);rotatedOut.add(out);
     allowed.add(s);amounts.set(s,budget);
     if(days.length>400)console.log('prioritySwap',JSON.stringify([testCase.id,date,out,s,net,budget]));
    }
    if(bridgeUnits&&(s===bridgeSymbol||(!book.has(s)&&book.size+1>=positionLimit)))continue;
    if(rotatedOut.has(s))continue;
    if(!trial&&!allowed.has(s)){
     if(!rotate||heldAtOpen.size!==positionLimit||book.size!==positionLimit||heldAtOpen.has(s)||book.has(s))continue;
     const strength=symbol=>plan.items.find(x=>x.symbol===symbol)?.relative20;
     if(![s,...book.keys()].every(k=>Number.isFinite(strength(k))))continue;
     const weakest=[...book.keys()].sort((a,b)=>strength(a)-strength(b)||a.localeCompare(b))[0];
     if(!heldAtOpen.has(weakest)||strength(s)<=strength(weakest))continue;
     const series=minuteDay(weakest,date);
     if(!series){missing++;continue;}
     const fillIndex=a.minute===120?122:a.minute+1;
     const sale=book.get(weakest).units*px(weakest,series[fillIndex]);
     const proceeds=sale-commission(sale);
     if(cash+proceeds<30000*(1+fee))continue;
     sellFees+=commission(sale);recordOperation(weakest);cash+=proceeds;book.delete(weakest);rotatedOut.add(weakest);swaps++;
     if(date>='2026-05-08')lateSwaps++;
    }
    const rank=trial?0:plan.focusSymbols.indexOf(s),fill=px(s,a.fill);
    assert(rank>=0&&rank<3&&fill>0);
    let p=book.get(s);
    if(testCase.flowGate&&mkt.regime==='strong'&&Boolean(p)===(testCase.flowGate==='份额加仓')&&flowFlags[plan.closeDate]?.includes(s.slice(2)))continue;
    if(testCase.addGate&&p&&mkt.regime==='strong'){
     const flags=pentadFlags(s,plan.closeDate);
     const skip=testCase.addGate==='成交拥挤'?flags.crowded:testCase.addGate==='长期动量'?flags.weakLong:flags.weakMacd;
     if(skip)continue;
    }
    if(testCase.gate&&!p&&mkt.regime==='strong'){
     const {hot,crowded}=pentadFlags(s,plan.closeDate);
     if((testCase.gate!=='crowded'&&hot)||(testCase.gate!=='high-vol'&&crowded))continue;
    }
    if(p?.trial&&trialCannotAdd)continue;
    if(!p&&testCase.id==='entry-trend'&&!risingMarket60.get(date))continue;
    if(p&&['cash','early-bounce','confirmed-bounce','bounce-trim','bounce-flat','low-vol','low-vol-ma20','profitable-add','rebound-index','rebound-impulse','impulse-handoff','coverage-add','race-strict','race-known','race-strict-priority','race-known-priority','race-strict-capped-priority','race-known-capped-priority'].includes(testCase.id)&&px(s,a.confirmedPrice)<=p.firstFill*(1+fee)/(1-fee))continue;
    if(fixed&&p&&(!allowAdd||p.added))continue;
    if(p&&(allowAdd==='reserve'||allowAdd==='refill')){
     if(cash<(1+positionLimit-book.size)*30000*(1+fee))continue;
     if(allowAdd==='refill'&&!p.wasTrimmed)continue;
    }
    if(canHandoff&&amounts.get(s)>0){
     const idx=a.minute===120?122:a.minute+1,price=minuteDay(side.symbol,date)?.[idx];
     if(!(price>0)){console.log('handoffMissing',date,s,idx);continue;}
     const sale=side.units*px(side.symbol,price),net=sale-commission(sale);
     if(Math.min(amounts.get(s),(cash+net)/(1+fee))+1e-8<100*a.fill)continue;
     console.log('reboundFill',JSON.stringify([testCase.id,date,'sell',net,s,idx]));
     cash+=net;recordOperation(side.symbol);side=null;
    }
    let spend=trial?Math.min(cash,10000*(1+fee)):accountTest?Math.min(cash,(amounts.get(s)||0)*(1+fee)):fixed?(cash>=30000*(1+fee)?30000*(1+fee):0):Math.min(cash,Math.max(0,p?start*cap/100-p.units*fill:start*weights[rank]/100));
    let gross=Math.min(spend/(1+fee),cash-minimumFee);
    if(roundLots)gross=Math.floor(gross/(a.fill*100)+1e-10)*100*a.fill;
    if(gross<=0||(current200k&&gross<30000))continue;
    spend=gross+commission(gross);buyFees+=commission(gross);
    if(spend<=1e-10)continue;
    if(reserveCash&&p&&(amounts.get(s)||0)>(ordinary.get(s)||0)){extraAdds++;if(date>='2026-05-08')lateExtra++;}
    if(process.argv.includes('--daily-journal'))dailyFills.push([s,p?'加仓':'建仓',a.fill,Math.round(gross/a.fill),-spend,'排名第'+(rank+1)+'，突破确认']);
    if(trial&&days.length>400)console.log('trial',JSON.stringify([testCase.id,date,s,spend,a.minute]));
    if(attributionStudy&&days.length>400)console.log('leg',JSON.stringify([testCase.id,date,s,p?'加':'首',-spend,gross/fill,commission(gross)]));
    if(audit)ledger.push([date,s,p?'加仓':'建仓',-spend,gross/fill,rank+1]);
    if(!p){
     p={units:0,recoveryEntry:testingProbe,trial:!!trial,firstFill:fill,openSession:sessionIndex,entryRank:rank+1,trimmed:false,event:{symbol:s,kind:'entry',support:riskDays===5?a.support:Math.min(...plan.items.find(i=>i.symbol===s).evidence.slice(-riskDays).map(b=>b.low)),date,observedAt:date+'T15:00:00+08:00'}};
     book.set(s,p);entries[rank]++;if(date>='2026-05-08')lateEntries[rank]++;
    }
    else {p.trial=false;adds++;if(p.lastTrimAmount>0)p.restored=true;p.lastTrimAmount=null;p.added=true;p.restoreTicket=null;}
    recordOperation(s);
    if(inExample(s,date))example.push({date,net:-spend});
    cash-=spend;minCash=Math.min(minCash,cash);p.units+=gross/fill;
   }

   trades+=operations;
   maxOperations=Math.max(maxOperations,operations);
   if(operations===dailyOperationLimit)fullDays++;
   if(lowVolStudy)assert(book.size+Number(bridgeUnits>0)+Number(!!side)<=positionLimit);
   maxHeld=Math.max(maxHeld,book.size);assert(book.size<=positionLimit&&cash>=0);
   for(const [s,p] of book)if(adjusted[s][date]>0)p.lastClose=adjusted[s][date];
   assert(book.size+Number(bridgeUnits>0)+Number(!!side)<=positionLimit);
   if(side&&adjusted[side.symbol]?.[date]>0)side.mark=adjusted[side.symbol][date];
   const risk=(side?side.units*side.mark:0)+(bridgeUnits?bridgeUnits*adjusted[bridgeSymbol][date]:0)+[...book.values()].reduce((sum,p)=>sum+p.units*p.lastClose,0);
   if(process.argv.includes('--daily-journal')&&supportRule==='strict')console.log('journal',JSON.stringify({date,probe:!!plan.recoveryProbe,cash,risk,nav:cash+risk,fills:dailyFills,held:[...book].map(([s,p])=>[s,p.units*p.lastClose]),daily:cash+risk-nav.at(-1)}));
   if(attributionStudy&&days.length>400&&days[sessionIndex+1]?.date.slice(0,4)!==date.slice(0,4))console.log('marks',JSON.stringify([testCase.id,date,Object.fromEntries([[defensive,adjusted[defensive][date]],...[...book].map(([symbol,p])=>[symbol,p.lastClose])])]));
   if(trialCapStudy&&['2020-05-29','2020-06-30','2020-07-31'].includes(date)){
    const marks=Object.fromEntries([...book].map(([s,p])=>[s,p.units*p.lastClose]));
    if(bridgeUnits)marks[bridgeSymbol]=bridgeUnits*adjusted[bridgeSymbol][date];
    console.log('monthMarks',JSON.stringify([testCase.id,date,marks]));
   }
   peakRisk=Math.max(peakRisk,risk);nav.push(cash+risk);if(audit||robustnessStudy)yearEnd[date.slice(0,4)]=cash+risk;assert(Number.isFinite(nav.at(-1)));exposureSum+=risk/nav.at(-1);
  }
  if((leaderStudy||leaderCapStudy||recoveryExitStudy||trimStudy||restoreStudy||onceStudy)&&example.length)console.log('communication',JSON.stringify({first:weights[0],cap,example,profit:Math.round(example.reduce((sum,e)=>sum+e.net,0))}));
  if(trimStudy){
   let eligible=0,rebounded=0;
   for(const sale of maSales){
    const bars=[...indexed.get(sale.s).values()].sort((a,b)=>a.date.localeCompare(b.date));
    const j=bars.findIndex(b=>b.date===sale.date);
    if(j<19||!bars[j+4]||bars[j+4].date>days.at(-1).date)continue;
    eligible++;
    const fill=opens[sale.s][sale.date]*adjusted[sale.s][sale.date]/bars[j].close;
    const bounced=bars.slice(j,j+5).some((b,k)=>b.close>bars.slice(j+k-19,j+k+1).reduce((n,z)=>n+z.close,0)/20&&adjusted[sale.s][b.date]>fill);
    if(bounced)rebounded++;
   }
   console.log('recoveries',JSON.stringify({exitMode,eligible,rebounded,total:maSales.length}));
  }
  if(process.argv.includes('--idle-index-study')||process.argv.includes('--research-nav'))console.log('bridge',JSON.stringify({limit:bridgeLimit,bridgeTrades,nav,dates:days.map(d=>d.date)}));
  if(stabilityStudy)console.log('stability',JSON.stringify({id:testCase.id,start:days[0].date,end:days.at(-1).date,profit:nav.at(-1)-capital,dd:+stats(nav)[1],trades,bridgeTrades,yearEnd,nav:days.length>400?nav:undefined}));
  if(currentReplay)console.log('current',JSON.stringify({start:days[0].date,end:days.at(-1).date,profit:nav.at(-1)-capital,dd:+stats(nav)[1],trades,buyFees,sellFees}));
  if(robustnessStudy)console.log('riskSizing',JSON.stringify({weights,riskDays,yearEnd,buyFees,sellFees,dd:+stats(nav)[1],trades}));
  if(audit)console.log('audit',JSON.stringify({cap,exitMode,waitSessions,supportRule,yearEnd,ledger,ending:[...book].map(([s,p])=>[s,p.units*p.lastClose]),dd:stats(nav)[1]}));
  if(capitalStudy){
   const boundary=days.findIndex(d=>d.date>='2024-01-01');
   const left=nav.slice(0,boundary+1),right=nav.slice(boundary);
   console.log('capital',JSON.stringify({first:weights[0],lower:weights[1],cap,train:left.at(-1)-capital,
    later:right.at(-1)-right[0],ddTrain:+stats(left)[1],ddLater:+stats(right)[1],profit:nav.at(-1)-capital,
    drawdown:+stats(nav)[1],trades,adds,entries,averageExposure:exposureSum/days.length}));
   continue;
  }
  if(finalReview){
   console.log('final',JSON.stringify({weights,cap,exitMode,trades,adds,entries,profit:Math.round(nav.at(-1)-capital),dd:Number(stats(nav)[1]),maxHeld,maxOperations}));
   continue;
  }
  if(compareSizing){
   let peak=capital,drop=0;
   for(const value of nav){peak=Math.max(peak,value);drop=Math.max(drop,peak-value);}
   console.log('sizing',JSON.stringify({start:days[0].date,end:days.at(-1).date,days:days.length,cap,exitMode,restores,advanced,trades,maxOperations,fullDays,profit:Math.round(nav.at(-1)-capital),draw:Math.round(drop),lateProfit:Math.round(nav.at(-1)-nav[split])}));
  }
  if(fixed){
   let peak=capital,maxDrop=0;
   for(const v of nav){peak=Math.max(peak,v);maxDrop=Math.max(maxDrop,peak-v);}
   console.log('cash-test',{capital,allowAdd,exitMode,rotate,swaps,lateSwaps,missing,flow,advanced,qualifying,known,profit:Math.round(nav.at(-1)-capital),maxDrop:Math.round(maxDrop),lateProfit:Math.round(nav.at(-1)-nav[split]),drawdownPct:stats(nav)[1],entries:entries.reduce((s,n)=>s+n,0),adds});
  }
  if(reserveCash){
   let high=capital,draw=0;for(const v of nav){high=Math.max(high,v);draw=Math.max(draw,high-v);}
   console.log('buffer',JSON.stringify({cap,profit:Math.round(nav.at(-1)-capital),draw:Math.round(draw),lateProfit:Math.round(nav.at(-1)-nav[split]),extraAdds,lateExtra,minCash:Math.round(minCash),peakRisk:Math.round(peakRisk)}));
  }
  console.log('slots',JSON.stringify({weights,cap,full:stats(nav),early:stats(nav.slice(0,split+1)),late:stats(nav.slice(split)),entries,lateEntries,adds,maxHeld,avgExposure:100*exposureSum/days.length}));
 }
}
