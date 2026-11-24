import {updateCandidateTracking} from './candidate-tracking.mjs';
import {getShares} from './shares.mjs';
import {getDaily} from './market-context.mjs';
import {instruments} from './dist/instruments.js';
const mean=rows=>rows.reduce((sum,r)=>sum+r.close,0)/rows.length;
const ret=(rows,n)=>(rows.at(-1).close/rows.at(-1-n).close-1)*100;
// Evaluate a frozen closing-date cohort; never mix trading dates or forming bars.
export function dailyCandidates(defs,data){
 const benchmark=data.get('sh000300'), base=benchmark?.bars;
 const total=defs.length;
 if(benchmark?.stale||!base||base.length<65)return {ready:false,total,count:0,reason:'沪深300已收盘日线不足或来源异常，暂停筛选'};
 const date=base.at(-1).date, dates=base.slice(-65).map(b=>b.date);
 const valid=defs.flatMap(d=>{
  const source=data.get(d.symbol),bars=source?.bars;
  if(source?.stale||!bars||bars.at(-1)?.date!==date)return [];
  const map=new Map(bars.map(b=>[b.date,b]));
  const aligned=dates.map(day=>map.get(day));
  return aligned.every(b=>b&&[b.close,b.low,b.high].every(n=>Number.isFinite(n)&&n>0))?[{...d,bars:aligned}]:[];
 });
 if(valid.length<Math.ceil(total*.9))return {ready:false,date,total,count:valid.length,reason:'同日完整日线覆盖不足90%，暂停筛选'};
 const marketOK=base.at(-1).close>mean(base.slice(-20))&&mean(base.slice(-20))>mean(base.slice(-25,-5));
 const eligible=valid.flatMap(d=>{
  const b=d.bars,close=b.at(-1).close,ma20=mean(b.slice(-20)),ma60=mean(b.slice(-60));
  const rs5=ret(b,5)-ret(base,5),rs20=ret(b,20)-ret(base,20);
  if(!(close>ma20&&ma20>ma60&&ma20>mean(b.slice(-25,-5))&&rs5>0&&rs20>0))return [];
  const resistance=Math.max(...b.slice(-21,-1).map(r=>r.high));
  const invalidation=Math.min(...b.slice(-5).map(r=>r.low));
  const extended=(close/ma20-1)*100>8,breakout=close>resistance;
  return [{symbol:d.symbol,name:d.name,exposure:d.exposure||d.symbol,sector:d.sector,rs5,rs20,close,resistance,invalidation,
   status:!marketOK?'环境未确认':extended?'偏离均线，暂观察':breakout?'等待回踩确认':'等待突破确认',
   trigger:breakout?`后续回踩 ${resistance.toFixed(3)} 附近并收盘守住，随后突破回踩日高点`:`后续日线收盘突破 ${resistance.toFixed(3)}，再等下一交易日回踩守住`,
   score:(rs5+rs20)/2}];
 }).sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
 const seen=new Set(),unique=eligible.filter(r=>{if(seen.has(r.exposure))return false;seen.add(r.exposure);return true;});
 return {ready:true,date,total,count:valid.length,marketOK,qualified:unique.length,rows:unique.slice(0,3),priorityRows:unique,
  benchmarkClose:base.at(-1).close};
}
let pending;
export async function getDailyCandidates(){
 if(pending)return pending;
 pending=(async()=>{
  const defs=instruments.filter(d=>d.sector.endsWith('ETF')&&d.market!=='HK'),list=[...defs,{symbol:'sh000300'}],data=new Map();let cursor=0;
  await Promise.all(Array.from({length:3},async()=>{while(cursor<list.length){const d=list[cursor++];data.set(d.symbol,await getDaily(d.symbol));}}));
  const result=dailyCandidates(defs,data),shares=await getShares();
  for(const row of result.rows||[]){const s=shares.items.find(n=>n.symbol===row.symbol);row.shareEvidence=shareEvidence(s,result.date,shares);}
  let tracking;try{tracking=await updateCandidateTracking(result,data);}catch{tracking={error:'候选档案读取或保存失败，暂停更新原记录'};}
  return {...result,tracking,fetchedAt:new Date().toISOString(),source:'新浪已收盘日线 · 未复权'};
 })();
 try{return await pending;}finally{pending=null;}
}

export function shareEvidence(s,date,context={}){
 if(!s?.available)return '份额尚未取得，不参与确认';
 if(context.error||context.sources?.[s.symbol.slice(0,2)]?.error)return '份额来源异常，暂不用于候选确认';
 if(s.date!==date)return `份额截至 ${s.date}，与候选日期不同，暂不合并判断`;
 const pct=n=>(n>0?'+':'')+n.toFixed(2)+'%';
 return `份额 ${s.date}：${s.day.ready?'单日 '+pct(s.day.pct):s.day.reason}，${s.five.ready?'5日 '+pct(s.five.pct):'5日变化暂缺'}${s.relation?'；'+s.relation:''}（仅作补充证据）`;
}
