import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
const file=new URL('./data/candidate-tracking.json',import.meta.url);
export const TRACK_RULE={version:1,days:10,retestTolerance:.01,extension:.08};
const mean=b=>b.reduce((s,r)=>s+r.close,0)/b.length;
const labels={breakout:'等待突破',retest:'等待回踩',confirmation:'等待再次走强',confirmed:'条件已确认',invalid:'已失效',expired:'观察期结束'};
export function trackCandidate(seed,stock,benchmark){
 const state={...seed,stage:seed.initialBreakout?'retest':'breakout',events:[],asOf:seed.signalDate,age:0,terminal:false,blocked:null,gate:seed.initialStatus==='环境未确认'?'市场条件未通过':seed.initialStatus==='偏离均线，暂观察'?'偏离20日均线超过8%':null};
 const event=(date,stage,reason)=>{state.stage=stage;state.events.push({date,stage,label:labels[stage],reason});};
 event(seed.signalDate,state.stage,'生成观察条件，固定突破位与失效位');
 const finish=()=>({...state,status:state.blocked?'跟踪待更新':labels[state.stage]});
 if(stock?.stale||benchmark?.stale){state.blocked='日线来源异常';return finish();}
 const base=benchmark?.bars||[],bars=stock?.bars||[],start=base.findIndex(b=>b.date===seed.signalDate),map=new Map(bars.map(b=>[b.date,b]));
 if(start<0||!map.has(seed.signalDate)){state.blocked='信号日数据缺失';return finish();}
 let retest=null;
 for(let i=start+1;i<base.length;i++){
  const date=base[i].date,b=map.get(date);if(!b){state.blocked=`${date} 日线缺失`;break;}
  if(![b.close,b.high,b.low].every(Number.isFinite)||b.high<b.close||b.low>b.close){state.blocked=`${date} 日线无效`;break;}
  state.age++;state.asOf=date;
  // The daily bar cannot establish intraday ordering: invalidation wins.
  if(b.low<seed.invalidation){event(date,'invalid',`最低价跌破原失效位 ${seed.invalidation.toFixed(3)}`);state.terminal=true;break;}
  if((state.stage==='retest'||state.stage==='confirmation')&&b.close<seed.resistance){retest=null;delete state.retest;event(date,'breakout','收盘未守住突破位，重新等待突破');}
  if(state.stage!=='confirmed'){
   const market=base.slice(0,i+1),ownDates=market.slice(-25).map(r=>map.get(r.date));
   if(market.length<25||ownDates.length<25||ownDates.some(r=>!r)){state.blocked='均线判断所需日线缺失';break;}
   const marketOK=b&&base[i].close>mean(market.slice(-20))&&mean(market.slice(-20))>mean(market.slice(-25,-5));
   const extended=b.close/mean(ownDates.slice(-20))-1>TRACK_RULE.extension;
   state.gate=!marketOK?'市场条件未通过':extended?'偏离20日均线超过8%':null;
   if(!state.gate){
    if(state.stage==='breakout'&&b.close>seed.resistance){event(date,'retest','收盘突破原突破位，等待后续交易日回踩');}
    else if(state.stage==='retest'||state.stage==='confirmation'){
     if(b.close<seed.resistance){retest=null;event(date,'breakout','收盘未守住突破位，重新等待突破');}
     else if(state.stage==='confirmation'&&date>retest.date&&b.close>retest.high){state.confirmedAt=date;event(date,'confirmed',`收盘超过 ${retest.date} 回踩日高点 ${retest.high.toFixed(3)}`);}
     else if(state.stage==='retest'&&b.low>=seed.resistance*(1-TRACK_RULE.retestTolerance)&&b.low<=seed.resistance*(1+TRACK_RULE.retestTolerance)){
      retest={date,high:b.high};state.retest=retest;event(date,'confirmation','回踩原突破位±1%且收盘守住，等待下一交易日收盘超过回踩日高点');
     }
    }
   }
  }
  if(state.age>=TRACK_RULE.days){event(date,'expired','原条件观察满10个交易日，结束本轮跟踪');state.terminal=true;break;}
 }
 return finish();
}
export function reconcileTracking(saved,result,data,observedAt=new Date().toISOString()){
 const records=[...saved.records];const benchmark=data.get('sh000300');
 const evaluated=records.map(seed=>{
  const current=trackCandidate(seed,data.get(seed.symbol),benchmark),previous=saved.items?.find(r=>r.id===seed.id);
  return current.blocked&&previous&&previous.asOf>=current.asOf?{...previous,blocked:current.blocked,status:'跟踪待更新'}:current;
 });
 if(result.ready){for(const row of result.priorityRows||result.rows){
  const id=row.symbol+'|'+result.date;
  // One original plan per direction; never move its levels on daily re-screening.
  if(records.some(r=>r.id===id)||evaluated.some(r=>r.exposure===row.exposure&&(!r.terminal||r.asOf>=result.date)))continue;
  const seed={id,symbol:row.symbol,name:row.name,exposure:row.exposure,signalDate:result.date,observedAt,
   resistance:row.resistance,invalidation:row.invalidation,initialBreakout:row.close>row.resistance,initialStatus:row.status,ruleVersion:TRACK_RULE.version};
  records.push(seed);evaluated.push(trackCandidate(seed,data.get(row.symbol),benchmark));
 }}
 return {records,items:evaluated.sort((a,b)=>b.signalDate.localeCompare(a.signalDate)),rule:TRACK_RULE};
}
export function createTrackingStore(storage=file){
 let pending;
 return async(result,data)=>{
  if(pending)return pending;
  pending=(async()=>{
   let saved;
   try{saved=JSON.parse(await readFile(storage,'utf8'));if(saved.version!==1||!Array.isArray(saved.records))throw Error('候选档案格式异常');}
   catch(e){if(e.code!=='ENOENT')throw e;saved={version:1,startedAt:new Date().toISOString(),records:[]};}
   const updated=reconcileTracking(saved,result,data);
   const next={version:1,startedAt:saved.startedAt,records:updated.records,items:updated.items};
   const serialized=JSON.stringify(next);
   if(serialized!==JSON.stringify(saved)){await mkdir(new URL('./',storage),{recursive:true});const tmp=new URL(storage.href+'.tmp');await writeFile(tmp,serialized);await rename(tmp,storage);}
   return {items:updated.items,startedAt:saved.startedAt,rule:updated.rule};
  })();try{return await pending;}finally{pending=null;}
 };
}
export const updateCandidateTracking=createTrackingStore();
