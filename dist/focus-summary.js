const signed=n=>(n>0?'+':'')+n.toFixed(2);
export function focusSummary({overview:o,market=null,paused=false,quoteStale=false,daily=null,now=Date.now()}){
 if(!o?.ready||quoteStale)return {tone:'waiting',status:paused?'已暂停':'数据待确认',title:'需要关注：行情数据是否完整',body:quoteStale?'报价来源异常，暂不生成关注标的。':(market?.text||'')+(o?.reason||'等待同日行情补齐后生成结论。'),targets:[]};
 const timestamp=Date.parse(`${o.date}T${o.time}:00+08:00`),age=now-timestamp;
 const live=Number.isFinite(age)&&age>=0&&age<=180000;
 const status=paused?'已暂停':live?'近期行情 · 30秒刷新':'历史截面 · 非实时';
 const alerts=[...o.alerts].sort((a,b)=>b.strength-a.strength).slice(0,2);
 const targets=alerts.map(n=>({symbol:n.symbol,name:n.name}));
 const reasons=alerts.map(n=>{
  const r=n.reasons.find(r=>r.type==='move')||n.reasons.find(r=>r.type==='relative')||n.reasons[0];
  const detail=r.type==='move'?`近5分钟${signed(r.value)}%`:r.type==='relative'?`${r.value>0?'强于':'弱于'}ETF整体${Math.abs(r.value).toFixed(2)}个百分点`:`分钟成交量放大至${r.value.toFixed(1)}倍`;
  return `${n.name}${detail}`;
 });
 let body=`${market?.text||''}监测 A 股 ETF ${o.trend}；${reasons.length?reasons.join('；'):'暂无达到阈值的个别异动，观察整体方向是否明确'}。`;
 if(daily?.ready&&daily.date<=o.date){body+=daily.marketOK?(daily.qualified?`日线有${daily.qualified}个观察方向，等待条件确认。`:'日线暂无符合全部条件的候选。'):'日线市场条件未通过，暂观察。';}
 return {tone:!live||paused?'historical':(market?market.weak:o.trend==='多数走弱')?'caution':'active',status,date:o.date,time:o.time,
  title:targets.length?`需要关注：${targets.map(n=>n.name).join('、')}`:'需要关注：等待清晰的盘面方向',body,targets,dailyDate:daily?.ready&&daily.date<=o.date?daily.date:null};
}
