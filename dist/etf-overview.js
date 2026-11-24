import {analyzeVolume} from './price-volume.js';
export const median=xs=>{const a=[...xs].sort((a,b)=>a-b),n=a.length;return n?n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2:null;};
export const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
const required=n=>Math.ceil(n*.9);
export function exposures(rows){
 const groups=new Map();for(const r of rows){const key=r.exposure||r.symbol;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
 return [...groups].map(([key,members])=>({key,sector:members[0].sector,group:members[0].group,category:members[0].category,members,change:median(members.map(n=>n.change)),recent:members.every(n=>n.recent!==null)?median(members.map(n=>n.recent)):null}));
}
function classify(rows){
 const units=exposures(rows),middle=median(units.map(n=>n.change)),up=units.filter(n=>n.change>.05).length,down=units.filter(n=>n.change<-.05).length;
 const recentRows=units.filter(n=>n.recent!==null),recent=recentRows.length>=required(units.length)?median(recentRows.map(n=>n.recent)):null;
 const alerts=rows.map(n=>{
 const deviation=n.change-middle,reasons=[];let strength=0;
 if(Math.abs(deviation)>=1.5){reasons.push({type:'relative',value:deviation});strength=Math.max(strength,Math.abs(deviation)/1.5);}
 if(n.recent!==null&&Math.abs(n.recent)>=.5){reasons.push({type:'move',value:n.recent});strength=Math.max(strength,Math.abs(n.recent)/.5);}
 if(n.volumeRatio>=3&&n.amount>=1e7){reasons.push({type:'volume',value:n.volumeRatio});strength=Math.max(strength,n.volumeRatio/3);}
 return {...n,deviation,reasons,strength};
 }).filter(n=>n.reasons.length).sort((a,b)=>b.strength-a.strength);
 return {middle,up,down,flat:units.length-up-down,recent,alerts,units,trend:up/units.length>=.7?'多数走强':down/units.length>=.7?'多数走弱':'走势分化',rows};
}
export function etfOverview(instruments,history,quotes){
 const defs=instruments.filter(n=>n.sector.endsWith('ETF')&&n.market!=='HK'&&n.sector!=='港股科技 ETF');
 const date=defs.map(n=>history.get(n.symbol)?.date).filter(Boolean).sort().at(-1);
 const valid=defs.map(n=>({...n,data:history.get(n.symbol),quote:quotes.get(n.symbol)})).filter(n=>n.data&&n.data.date===date&&!n.data.stale&&n.quote?.prev>0&&n.quote.quoteTime?.slice(0,10)===date&&n.data.points?.length);
 const indexed=valid.map(n=>{const points=analyzeVolume(n.data.points);return {...n,points,byTime:new Map(points.map((p,i)=>[p.time,i]))};});
 const times=[...new Set(indexed.flatMap(n=>n.points.map(p=>p.time)))].sort(),timeline=[];
 for(const time of times){
 const rows=indexed.map(n=>{
 const i=n.byTime.get(time);if(i===undefined)return null;const last=n.points[i],tail=n.points.slice(Math.max(0,i-5),i+1);
 const continuous=tail.length===6&&tail.slice(1).every(p=>p.continuous)&&minute(last.time)-minute(tail[0].time)===5;
 return {symbol:n.symbol,name:n.name,sector:n.sector,group:n.group,category:n.category,exposure:n.exposure,price:last.price,change:(last.price/n.quote.prev-1)*100,recent:continuous?(last.price/tail[0].price-1)*100:null,from:continuous?tail[0].time:null,volumeRatio:last.volumeRatio,amount:last.turnover};
 }).filter(Boolean);
 if(rows.length>=required(defs.length))timeline.push({time,...classify(rows)});
 }
 const last=timeline.at(-1),latest=times.at(-1);
 if(!last||minute(latest)-minute(last.time)>2)return {ready:false,date,total:defs.length,count:valid.length,reason:'同日同分钟覆盖不足 90%，等待数据补齐'};
 return {ready:true,date,total:defs.length,count:last.rows.length,...last,timeline};
}
