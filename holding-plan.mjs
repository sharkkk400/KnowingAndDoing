import {chinaDate} from './research-store.mjs';
// All times are observation times; later fills cannot enter an earlier archive.
export function holdingPlan(plan, confirmations, events, previousPlans, exitMode='half20',addRanks=1,supportRule='touch'){
 const cutoff=Date.parse(plan.cutoffAt);
 const lastManual=new Map(), tracked=new Map();
 for(const r of confirmations)if(Date.parse(r.at)<=cutoff)lastManual.set(r.symbol,r);
 const lastExit=new Map();
 for(const p of previousPlans)if(p.date<plan.date)for(const h of p.holdings||[]){
  if(h.mode==='信号跟踪'&&h.action==='清仓')lastExit.set(h.symbol,Math.max(lastExit.get(h.symbol)||0,Date.parse(p.generatedAt)));
 }
 for(const e of events){
  const t=Date.parse(e.observedAt),manual=lastManual.get(e.symbol);
  if(e.kind!=='entry'||!(t<=cutoff)||t<=Math.max(lastExit.get(e.symbol)||0,Date.parse(manual?.at)||0))continue;
  if(!tracked.has(e.symbol))tracked.set(e.symbol,{symbol:e.symbol,mode:'信号跟踪',since:e.date,support:e.support});
 }
 for(const r of lastManual.values())if(r.quantity>0)tracked.set(r.symbol,{symbol:r.symbol,mode:'已确认持仓',support:r.entrySupport,quantity:r.quantity,since:chinaDate(Date.parse(r.at))});
 return [...tracked.values()].flatMap(h=>{
  const i=plan.items.find(x=>x.symbol===h.symbol&&x.sector.endsWith('ETF'));if(!i)return [];
  let ma20Trim=exitMode==='half20'&&i.close<i.ma20;
  if(exitMode==='two-close-trim'&&i.close<i.ma20){
   const prior=i.evidence?.slice(-21,-1)||[];
   ma20Trim=prior.length===20&&prior.at(-1).close<prior.reduce((sum,b)=>sum+b.close,0)/20;
  }
  let action='持有',reason='日线趋势尚未触发退出，今天维持原仓。';
  if(plan.weekend||!i.close||plan.status!=='ready'||plan.late||plan.warnings.some(w=>w.includes('收盘日期与上一工作日不一致'))){
   action='待核实';reason='休市、补生成或依据不足，暂停调整，核实最新情况。';
  }else if(i.close<i.ma60||(h.support>0&&(supportRule==='strict'?i.close<h.support:supportRule==='touch'&&i.close<=h.support))){
   action='清仓';reason=i.close<i.ma60?'昨收已跌破60日均线。':'昨收已失守首次建仓风险位 '+h.support+'。';
  }else if(exitMode==='exit20'&&i.close<i.ma20){
   action='清仓';reason='昨收跌破20日均线，按盘前计划退出。';
  }else if(ma20Trim||plan.market.regime==='weak'||plan.market.macroRisk||plan.news.items.some(n=>n.risk&&i.newsIds.includes(n.id))){
   action='减仓';reason=ma20Trim?(exitMode==='two-close-trim'?'连续两天收盘低于20日均线，本段弱势首次减半。':'昨收跌破20日均线，本段弱势首次减半。'):'市场转弱或消息触发风险，本段弱势首次减半。';
  }else if(i.relativeStrengthRank>=1&&i.relativeStrengthRank<=addRanks&&i.entryRule?.enabled){
   action='条件加仓';reason='今日排第'+i.relativeStrengthRank+'；仅当今天重新触发完整入场提醒且尚有仓位预算时考虑加仓，否则维持。';
  }
  return [{...h,name:i.name,action,reason,close:i.close,ma20:i.ma20,ma60:i.ma60}];
 });
}
