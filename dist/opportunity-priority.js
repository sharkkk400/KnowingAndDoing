const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positive=value=>finite(value)&&value>0;
const compare=(a,b)=>a<b?-1:a>b?1:0;
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const stages={
 confirmed:{priority:4,label:'条件已确认',reason:'已完成收盘突破、后续回踩守住和再次收盘走强'},
 confirmation:{priority:3,label:'回踩守住，等待再次走强',reason:'等待后续交易日收盘超过回踩日高点'},
 retest:{priority:2,label:'收盘突破，等待回踩',reason:'等待后续交易日回踩原突破位并收盘守住'},
 breakout:{priority:1,label:'等待收盘突破',reason:'尚未完成收盘突破及后续回踩确认'}
};

// Half-point score buckets keep tiny source revisions from reshuffling near ties.
export const PRIORITY_SCORE_STEP=.5;
const bucket=score=>Math.round(score/PRIORITY_SCORE_STEP)*PRIORITY_SCORE_STEP;
const order=(a,b)=>b.priority-a.priority||b.scoreBucket-a.scoreBucket||compare(a.exposure,b.exposure)||compare(a.symbol,b.symbol);
const direction=row=>row.exposure||row.symbol;
const currentRow=(row,date)=>row&&typeof row.symbol==='string'&&row.symbol&&
 !row.stale&&!row.forming&&(!row.date||row.date===date)&&
 [row.close,row.resistance,row.invalidation].every(positive)&&row.invalidation<row.close&&
 positive(row.rs5)&&positive(row.rs20);
const currentGate=(daily,row)=>{
 if(daily.marketOK!==true||row.status==='环境未确认')return '市场条件未通过';
 if(row.status==='偏离均线，暂观察')return '偏离20日均线超过8%';
 return row.gate||null;
};
const terminal=plan=>plan.terminal||['invalid','expired'].includes(plan.stage);
const newest=items=>[...items].sort((a,b)=>compare(b.signalDate||'',a.signalDate||'')||compare(b.observedAt||'',a.observedAt||'')||compare(b.id||'',a.id||''))[0];
const latestPlan=(items,row,date)=>{
 const plan=newest(items.filter(plan=>plan&&plan.symbol===row.symbol&&direction(plan)===row.exposure));
 // A plan ending today must remain visibly paused for the current cohort.
 return plan&&(!terminal(plan)||plan.asOf>=date||plan.id===row.symbol+'|'+date)?plan:null;
};

/**
 * Rank only the qualified directions from one completed daily-candidate cohort.
 * A frozen plan is usable only for its own symbol. A direction switching to a
 * different representative waits for a fresh plan rather than borrowing levels.
 */
export function opportunityPriority(daily) {
 const date=validDate(daily?.date)?daily.date:null;
 if(daily?.ready!==true||!date||daily.stale||daily.forming)return {
  ready:false,date,items:[],reason:daily?.reason||'同日已收盘候选数据未就绪，暂停机会排序'
 };
 const source=Array.isArray(daily.priorityRows)?daily.priorityRows:daily.rows;
 if(!Array.isArray(source))return {ready:false,date,items:[],reason:'候选明细缺失，暂停机会排序'};
 const plans=Array.isArray(daily.tracking?.items)?daily.tracking.items:[];
 if(daily.tracking?.error&&!plans.length)return {ready:false,date,items:[],reason:'跟踪记录暂不可用，暂停机会排序'};
 const candidates=source.filter(row=>currentRow(row,date)).map(row=>({
  ...row,exposure:direction(row),score:(row.rs5+row.rs20)/2
 })).sort((a,b)=>bucket(b.score)-bucket(a.score)||compare(a.exposure,b.exposure)||compare(a.symbol,b.symbol));
 const seen=new Set(),rows=candidates.filter(row=>{if(seen.has(row.exposure))return false;seen.add(row.exposure);return true;});
 const items=rows.map(row=>{
  const plan=latestPlan(plans,row,date);
  const changedRepresentative=!plan&&plans.some(other=>other&&direction(other)===row.exposure&&other.symbol!==row.symbol&&!terminal(other));
  const levelsOK=plan&&[plan.resistance,plan.invalidation].every(positive)&&plan.invalidation<plan.resistance;
  const identityOK=plan&&typeof plan.id==='string'&&plan.id&&typeof plan.symbol==='string'&&plan.symbol;
  let gate=currentGate(daily,row),trackingReady=false,sourceStage=row.close>row.resistance?'retest':'breakout';
  if(daily.tracking?.error)gate=gate||'跟踪记录暂不可用';
  else if(changedRepresentative)gate=gate||'同方向标的已变化，等待重新建立计划';
  else if(plan) {
   const dated=validDate(plan.signalDate)&&plan.signalDate<=date&&plan.asOf===date;
   if(terminal(plan))gate=gate||'原计划本日已结束，等待新一轮计划';
   else if(plan.blocked||!dated||!levelsOK||!identityOK||!stages[plan.stage])gate=gate||'跟踪待更新，暂不沿用原确认状态';
   else {
    trackingReady=true;
    sourceStage=plan.stage;
   }
  }
  const usePlan=!!(levelsOK&&identityOK);
  const stage=gate?'waiting':sourceStage;
  const state=gate?{priority:0,label:'等待条件恢复',reason:gate}:stages[stage];
  const item={
   symbol:usePlan?plan.symbol:row.symbol,
   name:usePlan?(plan.name||plan.symbol):(row.name||row.symbol),
   exposure:row.exposure,
   planId:identityOK?plan.id:null,signalDate:identityOK?plan.signalDate:date,
   stage,label:state.label,priority:state.priority,waiting:stage!=='confirmed',
   reason:state.reason,gate:gate||null,trackingReady,
   resistance:usePlan?plan.resistance:row.resistance,
   invalidation:usePlan?plan.invalidation:row.invalidation,
   rs5:row.rs5,rs20:row.rs20,score:row.score,scoreBucket:bucket(row.score),
   close:row.close,date
  };
  // Compare plan state rather than raw floating-point score in change notices.
  item.comparisonKey=JSON.stringify([item.exposure,item.symbol,item.planId,item.stage,item.gate,item.resistance,item.invalidation]);
  return item;
 }).sort(order);
 return {ready:true,date,items,reason:items.length?null:'当日暂无合格方向'};
}
