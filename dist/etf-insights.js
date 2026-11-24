import {median,minute,exposures} from './etf-overview.js';
const minCoverage=n=>Math.ceil(n*.9);
const domestic=n=>n.sector.endsWith('ETF')&&n.market!=='HK'&&n.sector!=='港股科技 ETF';
export function groupStrength(o,instruments){
 if(!o.ready)return [];
 const base=o.timeline.find(t=>minute(t.time)===minute(o.time)-15);
 const interval=o.timeline.filter(t=>base&&t.time>=base.time&&t.time<=o.time);
 const comparable=base&&interval.length===16&&interval.slice(1).every((t,i)=>minute(t.time)-minute(interval[i].time)===1);
 const defs=instruments.filter(domestic),key=n=>n.group||n.sector;
 const groupNames=[...new Set(defs.map(key))];
 const collect=t=>groupNames.map(sector=>{
 const members=defs.filter(n=>key(n)===sector),total=new Set(members.map(n=>n.exposure||n.symbol)).size;
 const units=t.units.filter(n=>key(n)===sector),ok=units.length>=minCoverage(total)&&total>0;
 return {sector,category:members[0]?.category||'大小盘与风格',name:sector.replace(' ETF',''),count:units.length,total,ready:ok,change:ok?median(units.map(n=>n.change)):null,recent:ok&&units.every(n=>n.recent!==null)?median(units.map(n=>n.recent)):null};
 });
 const current=collect(o),prior=comparable?collect(base):[];
 // Ranks compare the same complete set of groups, with equal changes sharing a rank.
 const complete=category=>current.filter(g=>g.category===category).every(g=>g.ready)&&prior.length&&prior.filter(g=>g.category===category).every(g=>g.ready);
 const rank=(list,g)=>1+list.filter(n=>n.category===g.category&&n.change>g.change+.05).length;
 return current.map(g=>{const p=prior.find(n=>n.sector===g.sector),all=complete(g.category);return {...g,rank:g.ready?rank(current.filter(n=>n.ready),g):null,rankChange:all?rank(prior,p)-rank(current,g):null,relative15:all?g.change-p.change:null,from:all?base.time:null};}).sort((a,b)=>(b.change??-Infinity)-(a.change??-Infinity));
}
export function anomalyEpisodes(o){
 if(!o.ready)return {events:[],current:new Map(),volumeHits:new Map()};
 const events=[],active=new Map(),volumeHits=new Map();let previous=null;
 for(const frame of o.timeline){
 const rowMap=new Map(frame.rows.map(n=>[n.symbol,n]));
 // Missing intervals and lunch terminate episodes, never imply persistence across a gap.
 if(previous&&minute(frame.time)-minute(previous)!==1){for(const event of active.values())event.status='数据间隔中断';active.clear();}
 const triggered=new Map();
 for(const row of frame.alerts)for(const reason of row.reasons){
 const direction=reason.type==='volume'?0:Math.sign(reason.value),key=row.symbol+':'+reason.type+':'+direction;
 triggered.set(key,{row,reason,direction});
 if(reason.type==='volume')volumeHits.set(row.symbol,(volumeHits.get(row.symbol)||0)+1);
 }
 for(const [key,event] of active){const row=rowMap.get(event.symbol);if(!triggered.has(key)){event.status=row?'条件已消退':'数据缺口';event.resolvedAt=row?frame.time:null;active.delete(key);}}
 for(const [key,{row,reason,direction}] of triggered){
 let event=active.get(key);
 if(!event){event={key,symbol:row.symbol,name:row.name,type:reason.type,direction,first:frame.time,last:frame.time,minutes:0,samples:0,peak:row.price,trough:row.price,adverse:0,status:'持续中',maxStrength:0};active.set(key,event);events.push(event);}
 event.last=frame.time;event.samples++;event.minutes=minute(event.last)-minute(event.first);event.peak=Math.max(event.peak,row.price);event.trough=Math.min(event.trough,row.price);
 event.adverse=direction<0?(row.price/event.trough-1)*100:(event.peak-row.price)/event.peak*100;
 event.maxStrength=Math.max(event.maxStrength,Math.abs(reason.value));
 }
 previous=frame.time;
 }
 const current=new Map();for(const event of active.values()){if(!current.has(event.symbol))current.set(event.symbol,[]);current.get(event.symbol).push(event);}
 return {events,current,volumeHits};
}
function state(members){
 const all=fn=>members.every(fn);
 return {above:all(p=>p.dif>=0&&p.dea>=0),repair:all(p=>p.dif<0&&p.dea<0&&p.dif>p.dea),bullish:all(p=>p.dif>p.dea),below:all(p=>p.dif<0&&p.dea<0),split:!all(p=>p.dif>p.dea)&&!all(p=>p.dif<=p.dea)};
}
export function macdDistribution(instruments,data,o){
 const defs=instruments.filter(domestic),total=defs.length,totalUnits=new Set(defs.map(n=>n.exposure||n.symbol)).size;
 if(!o.ready)return {ready:false,total,totalUnits,count:0,reason:'等待分时基准'};
 const rows=defs.map(n=>({...n,data:data.get(n.symbol)})).filter(n=>n.data&&!n.data.stale).map(n=>({...n,points:n.data.points.filter(p=>p.confirmed&&p.time.slice(0,10)===o.date&&p.time.slice(11,16)<=o.time)}));
 const counts=new Map();for(const n of rows)for(const time of new Set(n.points.map(p=>p.time)))counts.set(time,(counts.get(time)||0)+1);
 const cutoff=[...counts.keys()].filter(t=>counts.get(t)>=minCoverage(total)&&minute(o.time)-minute(t.slice(11,16))<=20).sort().at(-1);
 if(!cutoff)return {ready:false,total,totalUnits,count:rows.filter(n=>n.points.length).length,reason:'已完成的同一根15分钟线覆盖不足，或与分时相差超过20分钟'};
 const present=rows.map(n=>({...n,p:n.points.find(p=>p.time===cutoff)})).filter(n=>n.p);
 const units=exposures(present.map(n=>({...n,change:0,recent:null})));
 const states=units.map(u=>state(u.members.map(n=>n.p)));
 // Compare an exact prior bar for an unchanged ETF cohort. Lunch is a legitimate bar boundary.
 const previousTimes=present.map(n=>n.points.filter(p=>p.time<cutoff).at(-1)?.time);
 const candidate=previousTimes[0]&&previousTimes.every(t=>t===previousTimes[0])?previousTimes[0]:null;
 const previous=candidate&&(minute(cutoff.slice(11,16))-minute(candidate.slice(11,16))===15||(cutoff.slice(11,16)==='13:15'&&candidate.slice(11,16)==='11:30'))?candidate:null;
 const oldStates=previous?units.map(u=>state(u.members.map(n=>n.points.find(p=>p.time===previous)))):null;
 const count=key=>states.filter(s=>s[key]).length;
 return {ready:true,date:o.date,time:cutoff.slice(11,16),count:present.length,total,units:units.length,totalUnits,above:count('above'),below:count('below'),repair:count('repair'),bullish:count('bullish'),split:count('split'),previous:previous?.slice(11,16),bullishChange:oldStates?count('bullish')-oldStates.filter(s=>s.bullish).length:null};
}
