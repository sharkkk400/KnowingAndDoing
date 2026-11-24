import {analyzeVolume} from './dist/price-volume.js';
export const ALERT_RULE={minDelta:10000000,minRatio:3,minBaseline:5,window:20};
const session=t=>{const h=t.slice(11,16);return h>='09:30'&&h<='11:30'?'am':h>='13:00'&&h<='15:00'?'pm':null;};
const median=a=>{const v=[...a].sort((x,y)=>x-y),i=Math.floor(v.length/2);return v.length%2?v[i]:(v[i-1]+v[i])/2;};
export function analyzeFlows(samples,market=null){
 const rows=[...new Map(samples.map(s=>[s.sourceTime,s])).values()].sort((a,b)=>Date.parse(a.sourceTime)-Date.parse(b.sourceTime));
 let baseline=[],events=[],gaps=0,latest=null;
 const volumeAnalysis=new Map(analyzeVolume(market?.points||[]).map(p=>[p.time,p]));
 const context=s=>{const p=market?.date===s.date?market.points?.find(p=>p.time===s.sourceTime.slice(11,16)):null;return p?{...p,sourceTime:s.sourceTime,source:'腾讯分时行情',stale:!!market.stale}:s.market;};
 for(let i=1;i<rows.length;i++){
  const a=rows[i-1],b=rows[i],seconds=(Date.parse(b.sourceTime)-Date.parse(a.sourceTime))/1000;
  if(a.date!==b.date||!session(a.sourceTime)||session(a.sourceTime)!==session(b.sourceTime)||seconds!==60){baseline=[];gaps++;latest={from:a.sourceTime,to:b.sourceTime,seconds,delta:b.main-a.main,gap:true};continue;}
  const delta=b.main-a.main;if(!Number.isFinite(delta)){baseline=[];continue;}
  const base=baseline.length>=ALERT_RULE.minBaseline?median(baseline):null;
  const ratio=base>0?Math.abs(delta)/base:null;
  const x=context(a),y=context(b);
  const aligned=x?.sourceTime===a.sourceTime&&y?.sourceTime===b.sourceTime;
  const priceChange=aligned&&x.price>0&&y.price>0?(y.price/x.price-1)*100:null;
  const amount=aligned&&Number.isFinite(x.amount)&&Number.isFinite(y.amount)&&y.amount>=x.amount?y.amount-x.amount:null;
  const v=market?.date===b.date?volumeAnalysis.get(b.sourceTime.slice(11,16)):null;
  const volumeContext=v?.from===a.sourceTime.slice(11,16)?{volumeRatio:v.volumeRatio,label:v.label,baselineCount:v.baselineCount}:null;
  const data={volumeContext,id:b.symbol+'|'+a.sourceTime+'|'+b.sourceTime,from:a.sourceTime,to:b.sourceTime,seconds,delta,ratio,baseline:base,baselineCount:baseline.length,priceChange,amount,marketStale:!!(x?.stale||y?.stale),gap:false};
  latest=data;
  if(base!==null&&Math.abs(delta)>=ALERT_RULE.minDelta&&(base===0||ratio>=ALERT_RULE.minRatio))events.push({...data,direction:delta>0?'in':'out'});
  baseline.push(Math.abs(delta));baseline=baseline.slice(-ALERT_RULE.window);
 }
 return {events:events.reverse().slice(0,30),latest,gaps,rule:ALERT_RULE};
}
