export function validShare(r){return /^(sh|sz)\d{6}$/.test(r?.symbol)&&/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&Number.isFinite(r.shares)&&r.shares>0;}
export function mergeShares(old,rows){
 const clean=r=>({...r,shares:Math.abs(r.shares-Math.round(r.shares))<.0001?Math.round(r.shares):r.shares});
 const map=new Map(old.filter(validShare).map(r=>[r.symbol+'|'+r.date,clean(r)]));
 for(const r of rows){if(!validShare(r))throw Error('份额字段异常');map.set(r.symbol+'|'+r.date,clean(r));}
 return [...map.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.symbol.localeCompare(b.symbol));
}
export function analyzeShares(defs,rows,dates,prices=new Map()){
 const expected=[...new Set(dates)].sort(),target=expected.at(-1);
 const items=defs.map(def=>{
  const history=rows.filter(r=>r.symbol===def.symbol&&validShare(r)&&expected.includes(r.date)).sort((a,b)=>a.date.localeCompare(b.date));
  const last=history.at(-1);if(!last)return {...def,available:false,count:0};
  const byDate=new Map(history.map(r=>[r.date,r])),end=expected.indexOf(last.date);
  // Large moves are retained as raw observations but not interpreted as flows.
  const suspicious=(a,b)=>Math.abs(b.shares/a.shares-1)>.25;
  const window=n=>{
   if(end<n)return {ready:false,reason:'历史不足'};
   const needed=expected.slice(end-n,end+1).map(d=>byDate.get(d));
   if(needed.some(r=>!r))return {ready:false,reason:'交易日数据缺失'};
   if(needed.slice(1).some((r,i)=>suspicious(needed[i],r)))return {ready:false,reason:'份额大幅变动待核实'};
   const first=needed[0],delta=last.shares-first.shares;
   return {ready:true,from:first.date,to:last.date,delta,pct:delta/first.shares*100};
  };
  const priceData=prices.get(def.symbol),priceBars=priceData?.stale?[]:priceData?.bars||[];
  const valuedWindow=n=>{
   const w=window(n);if(!w.ready)return w;
   const daily=expected.slice(end-n+1,end+1).map((date,i)=>{
    const previous=byDate.get(expected[end-n+i]),today=byDate.get(date),bar=priceBars.find(b=>b.date===date);
    return bar?.close>0?{date,value:(today.shares-previous.shares)*bar.close}:null;
   });
   return {...w,marketValue:daily.every(Boolean)?daily.reduce((sum,r)=>sum+r.value,0):null};
  };
  const day=valuedWindow(1),five=valuedWindow(5),twenty=valuedWindow(20);let streak=0,direction=0;
  for(let i=end;i>0;i--){const b=byDate.get(expected[i]),a=byDate.get(expected[i-1]);if(!a||!b||suspicious(a,b))break;const sign=Math.sign(b.shares-a.shares);if(!sign||(direction&&sign!==direction))break;direction=sign;streak++;}
  const p=prices.get(def.symbol),bars=p?.stale?[]:p?.bars||[],current=bars.find(b=>b.date===last.date),prior=bars.find(b=>b.date===expected[end-1]);
  const priceChange=current&&prior?(current.close/prior.close-1)*100:null;
  const relation=day.ready&&priceChange!==null?`${priceChange>0?'价格上涨':priceChange<0?'价格下跌':'价格持平'}、份额${day.delta>0?'增加':day.delta<0?'减少':'持平'}`:null;
  return {...def,available:true,date:last.date,shares:last.shares,count:history.length,lag:expected.length-1-end,day,five,twenty,streak,direction,priceChange,relation,history};
 });
 const usable=items.filter(r=>r.date===target&&r.day?.ready),groups=new Map();
 for(const d of defs){const key=d.exposure||d.symbol;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(d);}
 const directions=[...groups.values()].flatMap(members=>{
  const group=members.map(d=>usable.find(r=>r.symbol===d.symbol));if(group.some(r=>!r))return [];
  // Different products may use different unit sizes. Require direction agreement.
  const signs=group.map(r=>Math.sign(r.day.delta));return [signs.every(s=>s===signs[0])?signs[0]:null];
 });
 return {target,total:defs.length,count:usable.length,complete:items.filter(r=>r.count>=61).length,
  ready:!!target&&usable.length>=Math.ceil(defs.length*.9),units:directions.length,totalUnits:groups.size,
  up:directions.filter(x=>x>0).length,down:directions.filter(x=>x<0).length,flat:directions.filter(x=>x===0).length,split:directions.filter(x=>x===null).length,items};
}
