import {macdDistribution} from './etf-insights.js';
import {exposures,median} from './etf-overview.js';
import {instrumentAdvice} from './instrument-advice.js';
import {marketAdvice} from './market-advice.js';
// Conditional 1–3 trading-session scenarios. Scores describe evidence, not probabilities.
const cnDate=t=>new Date(t+8*3600000).toISOString().slice(0,10);
const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
const valid=n=>Number.isFinite(n)&&n>0;
export function instrumentOutlook({quote:q,entry:e,daily:d,flow:f,macd:m,benchmark:b,shares:s,shareError=false,quoteStale=false,paused=false,now=Date.now()}){
 let last=e?.points?.at(-1),date=e?.date,time=last?.time;
 const today=cnDate(now),wallClock=new Date(now+8*3600000).toISOString().slice(11,16),qDate=q?.quoteTime?.slice(0,10),day=d?.date||d?.bars?.at(-1)?.date,dayPrice=d?.close||d?.bars?.at(-1)?.close;
 const closingQuote=qDate&&(qDate<today||(qDate===today&&wallClock>='15:05'))&&q.quoteTime.slice(11,16)>='15:00';
 const fallback=(!last||e?.stale||date!==qDate)&&closingQuote&&!d?.stale&&(d?.ready||d?.bars?.length>=60)&&day===qDate&&valid(dayPrice)&&valid(q.price)&&Math.abs(q.price/dayPrice-1)<=.002;
 if(fallback){date=day;time='15:00';last={time,price:dayPrice,amount:q.amount,volumeHands:q.volumeHands};}
 const unavailable=reason=>({ready:false,title:'后续走势待推演',summary:reason,date,time,evidence:[],conditions:[],missing:[]});
 if(paused)return unavailable('已暂停，恢复更新后重新推演。');
 if(quoteStale||(e?.stale&&!fallback)||!last||!q||q.quoteTime?.slice(0,10)!==date||!valid(last.price)||!valid(q.prev))return unavailable('报价与分时缺少有效同日基准。');
 const cutoff=Date.parse(date+'T'+time+':00+08:00'),clock=new Date(now+8*3600000).toISOString().slice(11,16);
 const closed=date<today||(date===today&&clock>='15:00'),reference=closed?Date.parse(date+'T15:00:00+08:00'):clock>='11:30'&&clock<'13:00'?Date.parse(date+'T11:30:00+08:00'):now;
 const quoteTime=Date.parse(q.quoteTime),quoteCutoff=closed?Math.min(quoteTime,reference):quoteTime;
 if(!Number.isFinite(cutoff)||cutoff>now+60000||quoteTime>now+60000||!Number.isFinite(quoteTime)||reference-cutoff>180000||reference-quoteCutoff>180000||(closed&&time!=='15:00'))return unavailable('行情未跟上交易截止时刻，暂停推演。');
 const p=last.price,change=(p/q.prev-1)*100,evidence=[],missing=fallback?['分时不可用，基于收盘报价与日线']:[];let score=0,votes=0;
 const bars=d?.bars||[],lastDaily=bars.at(-1),dailyDate=d?.date||lastDaily?.date;
 const dailyOK=!!(d?.ready||bars.length>=60)&&!d?.stale&&dailyDate&&dailyDate<=date&&Date.parse(date)-Date.parse(dailyDate)<=14*86400000;
 const average=n=>d?.averages?.find(a=>a.days===n)?.value||(bars.length>=n?bars.slice(-n).reduce((sum,b)=>sum+b.close,0)/n:null);
 const ma5=dailyOK?average(5):null,ma20=dailyOK?average(20):null,ma60=dailyOK?average(60):null;
 const dailyWeak=dailyOK&&p<ma20&&ma20<ma60,dailyStrong=dailyOK&&p>ma20&&ma20>ma60;
 if(dailyOK){votes++;score+=dailyStrong?2:dailyWeak?-2:0;evidence.push(`日线${dailyStrong?'偏强':dailyWeak?'偏弱':'分化'}（${dailyDate}）`);}else missing.push('近期日线不足');
 const vwap=last.volumeHands>0&&last.amount>0?last.amount/(last.volumeHands*100):null;
 if(valid(vwap)){votes++;score+=p>=vwap?1:-1;evidence.push(p>=vwap?'价格位于日内均价上方':'价格低于日内均价');}else missing.push('日内成交基准缺失');
 const volumeRows=(d?.volumeHistory||bars).filter(x=>x.date<date).slice(-5);
 const baseline=dailyOK&&volumeRows.length===5&&volumeRows.every(x=>valid(x.volume))?volumeRows.reduce((sum,x)=>sum+x.volume,0)/5:null;
 const volumeRatio=closed&&baseline&&valid(q.volumeHands)?q.volumeHands*100/baseline:null;
 if(volumeRatio!==null){votes++;if(volumeRatio>=1.5&&Math.abs(change)>=.5)score+=change>0?.5:-.5;evidence.push(`成交量为前5日均量 ${volumeRatio.toFixed(2)} 倍`);}else missing.push(closed?'5日成交量基线不足':'盘中量与完整日量不直接比较');
 const snap=f?.snapshot,flowOK=!f?.stale&&snap?.date===date&&Math.abs(Date.parse(snap.sourceTime)-cutoff)<=60000;
 const samples=(f?.samples||[]).filter(x=>x.date===date&&Date.parse(x.sourceTime)<=cutoff).slice(-31);
 const continuous=samples.length===31&&samples.every((x,i)=>!i||Date.parse(x.sourceTime)-Date.parse(samples[i-1].sourceTime)===60000);
 const flowImproving=flowOK&&continuous?samples.at(-1).main>samples[0].main:null;
 if(flowOK){votes++;score+=snap.main>0?1:snap.main<0?-1:0;if(flowImproving!==null)score+=flowImproving?.5:-.5;evidence.push(`主力净额${snap.main>=0?'为正':'为负'}${flowImproving===null?'':flowImproving?'，近30分钟改善':'，近30分钟未改善'}`);}else if(q.sector!=='指数'&&!q.sector?.endsWith('ETF'))missing.push('同期资金未确认');
 const ks=(m?.points||[]).filter(k=>k.confirmed&&k.time.slice(0,10)===date&&Date.parse(k.time)<=cutoff),k=ks.at(-1),previous=ks.at(-2);
 const adjacent=k&&previous&&(Date.parse(k.time)-Date.parse(previous.time)===15*60000||(k.time.slice(11,16)==='13:15'&&previous.time.slice(11,16)==='11:30'));
 const macdOK=!m?.stale&&adjacent&&cutoff-Date.parse(k.time)<=20*60000&&[k.histogram,previous.histogram].every(Number.isFinite);
 if(macdOK){votes++;const expanding=k.histogram>0&&k.histogram>previous.histogram,weakening=k.histogram<0&&k.histogram<previous.histogram;score+=expanding?1:weakening?-1:k.histogram>previous.histogram?.5:-.5;evidence.push(expanding?'15分钟正柱扩大':weakening?'15分钟负柱扩大':k.histogram>previous.histogram?'15分钟动能修复':'15分钟动能回落');}else missing.push('15分钟动能未确认');
 let relative=null;
 const btime=b?.quoteTime,bt=Date.parse(btime);
 if(b?.symbol!==q.symbol&&btime?.slice(0,10)===date&&Number.isFinite(bt)&&bt<=now+60000&&Math.abs((closed?Math.min(bt,reference):bt)-quoteCutoff)<=180000&&Number.isFinite(b.changePct)){
 relative=change-b.changePct;votes++;score+=relative>=.5?1:relative<=-.5?-1:0;evidence.push(`较参照${relative>=0?'强':'弱'} ${Math.abs(relative).toFixed(2)} 个百分点`);
 }
 const shareOK=!shareError&&s?.five?.ready&&s?.date<=date&&Date.parse(date)-Date.parse(s.date)<=14*86400000;
 if(shareOK){votes++;score+=s.five.pct>0?.5:s.five.pct<0?-.5:0;evidence.push(`份额截至${s.date}，5日${s.five.pct>=0?'增加':'减少'} ${Math.abs(s.five.pct).toFixed(2)}%`);}
 let bias='mixed';
 if(votes<3||!dailyOK)bias='limited';
 else if(dailyStrong&&score>=2.5)bias='strong';
 else if(score<=-2)bias='weak';
 else if(score>=2)bias='repair';
 const observedPrices=(e?.points||[]).map(x=>x.price).filter(valid);
 const support=valid(q.low)&&q.low<=p?q.low:observedPrices.filter(x=>x<=p).sort((a,b)=>a-b)[0]??null;
 const resistance=valid(q.high)&&q.high>=p?q.high:observedPrices.filter(x=>x>=p).sort((a,b)=>b-a)[0]??null;
 const pressures=[resistance,ma5,ma20].filter(x=>valid(x)&&x>p).sort((a,b)=>a-b);
 const pressure=pressures[0]||null,nextPressure=pressures.find(x=>x>pressure*1.002)||null;
 const advice=instrumentAdvice({bias,price:p,support,pressure,nextPressure,ma5,ma20,ma60,vwap,change,relative,volumeRatio,
  flowMain:flowOK?snap.main:null,macdTrend:macdOK?(k.histogram>previous.histogram?'improving':'weakening'):null,sector:q.sector,dailyOK});
 const format=n=>n.toFixed(q.sector?.endsWith('ETF')?3:2);
 const confirmation=q.sector==='指数'?'上涨广度与15分钟动能同步改善':q.sector?.endsWith('ETF')?'价格继续强于参照，15分钟动能改善':'资金净额与15分钟动能同步改善';
 return {ready:true,date,time,basis:fallback?'收盘报价＋已收盘日线':'报价＋分时',bias,...advice,score,votes,evidence,missing,support,pressure,nextPressure,vwap,volumeRatio,relative,horizon:'未来1—3个交易日',
 planNote:date<today||closed?'收盘计划：下一交易时段先核对新报价和触发条件，再决定执行。':'盘中计划：等待已完成的15分钟K线确认，触价后仍需核对其他条件。',conditions:[
 {label:'参与条件',text:pressure?`已完成15分钟K线收在 ${format(pressure)} 上方，后续回踩未跌回，且${confirmation}。`:`尚无可确认的上方压力，先等新价格结构形成，且${confirmation}。`},
 {label:'退出条件',text:support?`跌破 ${format(support)} 且下一根已完成15分钟K线仍未收回，原持有情景失效，优先减仓控制损失。`:'缺少有效支撑，暂不新增仓位；已有仓位需先补充可执行的风险边界。'}
 ]};
}
export function marketOutlook({overview:o,breadth,distribution:m,whole,groups=[],paused=false,quoteStale=false,quotes=new Map(),defs=[],macdData,now=Date.now()}){
 let fallback=false;
 if(!o?.ready||!whole?.ready){
 const today=cnDate(now),clock=new Date(now+8*3600000).toISOString().slice(11,16);
 const domestic=defs.filter(n=>n.sector.endsWith('ETF')&&n.market!=='HK'&&n.sector!=='港股科技 ETF');
 const dated=domestic.map(n=>({...n,q:quotes.get(n.symbol)})).filter(n=>valid(n.q?.price)&&valid(n.q?.prev)&&Number.isFinite(Date.parse(n.q.quoteTime))&&Date.parse(n.q.quoteTime)<=now+60000);
 const date=dated.map(n=>n.q.quoteTime.slice(0,10)).sort().at(-1);
 const closing=date&&(date<today||(date===today&&clock>='15:05'));
 const rows=dated.filter(n=>n.q.quoteTime.slice(0,10)===date&&n.q.quoteTime.slice(11,16)>='15:00');
 const index=quotes.get('sh000985');
 if(closing&&domestic.length&&rows.length>=Math.ceil(domestic.length*.9)&&valid(index?.price)&&valid(index?.prev)&&index.quoteTime?.slice(0,10)===date&&index.quoteTime.slice(11,16)>='15:00'&&Date.parse(index.quoteTime)<=now+60000){
 const units=exposures(rows.map(n=>({...n,change:(n.q.price/n.q.prev-1)*100,recent:null})));
 o={ready:true,date,time:'15:00',units,count:rows.length,up:units.filter(n=>n.change>.05).length,down:units.filter(n=>n.change<-.05).length};
 const aligned=breadth?.usable&&!breadth.stale&&breadth.date===date&&breadth.timeTo?.slice(0,5)>='15:00';
 whole={ready:true,date,time:'15:00',aligned,change:(index.price/index.prev-1)*100};
 if(macdData)m=macdDistribution(defs,macdData,o);
 groups=[...new Set(units.filter(n=>n.category==='行业轮动').map(n=>n.group||n.sector))].map(name=>({name,category:'行业轮动',ready:true,change:median(units.filter(n=>(n.group||n.sector)===name).map(n=>n.change))}));fallback=true;
 }
 }
 if(paused||quoteStale||!o?.ready||!whole?.ready||whole.date!==o.date||Math.abs(minutes(whole.time)-minutes(o.time))>2)return {ready:false,title:'后续市场方向待推演',summary:'等待有效同日行情与交易截止时刻对齐。'};
 const cutoff=Date.parse(o.date+'T'+o.time+':00+08:00');
 if(!o.units?.length||!Number.isFinite(cutoff)||cutoff>now+60000)return {ready:false,title:'市场建议待确认',summary:'行情日期、时间或方向覆盖无效。'};
 const aligned=whole.aligned&&!breadth?.stale&&Number.isFinite(breadth?.upRatio)&&breadth.upRatio>=0&&breadth.upRatio<=1;
 const macdLag=minutes(o.time)-minutes(m?.time||'');
 const momentum=m?.ready&&m.date===o.date&&m.units>0&&Number.isFinite(m.bullish)&&macdLag>=0&&macdLag<=20?m.bullish/m.units:null;
 const advice=marketAdvice({overview:o,breadthRatio:aligned?breadth.upRatio:null,momentum,momentumChange:momentum!==null?m.bullishChange:null,indexChange:whole.change,groups});
 return {ready:true,date:o.date,time:o.time,basis:fallback?'收盘报价＋广度':'分时＋广度',count:o.count||o.units.length,directionCount:o.units.length,horizon:'未来1—3个交易日',...advice,
 planNote:o.time==='15:00'?'收盘计划：下一交易时段先核对新行情；行业领涨只用于筛选，买入仍需对应标的确认。':'盘中计划：各标的满足参与条件后再执行，行业排名本身不构成买点。',
 missing:[fallback?'分时未取得，基于收盘报价与广度':'',!aligned?'全市场广度待对齐':'',momentum===null?'全体MACD覆盖不足':''].filter(Boolean)};
}
