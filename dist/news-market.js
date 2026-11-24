const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
const chinaTime=ts=>new Date(ts+8*3600000).toISOString();
const rules=[
 [['风电','风机'],['sz002202'],'风电设备需求与订单，需核实公司实际影响'],
 [['甲醇','洛轴','蓝箭航天'],['sz002202'],'项目或投资因素，需核实权益及收益兑现'],
 [['银行','存款利率'],['sh512800','sh601169','sh600015'],'银行行业盈利与估值因素'],
 [['军工','国防','军贸'],['sh512660'],'军工行业需求与订单因素'],
 [['通信设备','光模块','CPO','算力','数据中心'],['sh515880'],'通信设备与算力建设，相关成分需核实'],
 [['芯片','半导体'],['sh588200'],'芯片行业需求与供给'],
 [['创新药','医药','药品'],['sh512010'],'医药因素；ETF仅覆盖沪深300医药范围'],
 [['煤炭','煤价'],['sh515220'],'煤炭价格与供需'],
 [['铜价','铝价','有色金属'],['sh512400'],'有色金属价格与供需'],
 [['电力运营','绿电交易','电价'],['sz159669'],'电力运营收益因素'],
 [['证券行业','券商'],['sz159842'],'证券行业活跃度与政策'],
 [['降准','降息','社融'],['sh000985','sh510300'],'市场流动性及增长，政策范围需核实']
];
export function associateNews(news,defs){
 const text=((news.title||'')+' '+(news.body||'')).replace(/电池银行|银行间|美国银行|英格兰银行|欧洲央行/g,'相关机构'),links=new Map();
 const add=(symbol,reason,kind)=>{const def=defs.find(n=>n.symbol===symbol);if(def&&(!links.has(symbol)||kind==='direct'))links.set(symbol,{...def,reason,kind});};
 for(const d of defs)if((news.watchCodes||[]).includes(d.code)||text.includes(d.name))add(d.symbol,'消息明确提及公司或指数，需核对原文','direct');
 for(const [terms,symbols,reason] of (/分析师.*(?:出任|任命)|(?:出任|任命).*分析师/.test(news.title||'')?[]:rules))if(terms.some(k=>text.includes(k)))for(const s of symbols)add(s,reason,'industry');
 return [...links.values()];
}
function interval(entry,from,to,date){
 if(entry?.stale||entry?.date!==date||!entry.points?.length)return null;
 const rows=entry.points.filter(p=>minute(p.time)>=from&&minute(p.time)<=to);
 if(rows.length!==to-from+1||minute(rows[0].time)!==from||minute(rows.at(-1).time)!==to||rows.some((p,i)=>!(p.price>0)||(i&&minute(p.time)-minute(rows[i-1].time)!==1)))return null;
 return {first:rows[0],last:rows.at(-1)};
}
const clock=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
export function evaluateResponse(news,link,context,now=Date.now()){
 const {history=new Map(),flows=new Map(),quoteStale=false,shares}=context;
 const publication=Date.parse(news.publishedAt),date=Number.isFinite(publication)?chinaTime(publication).slice(0,10):null;
 const pending=reason=>({symbol:link.symbol,name:link.name,status:'数据不足',reason,windows:[],date,kind:link.kind,association:link.reason});
 if(!date||publication>now)return pending('消息时间异常或尚未发布');
 if(news.datePrecision==='day')return pending('来源只有发布日期，不能计算消息后分钟响应');
 if(/收评|午评|早评|收盘|盘中|涨停|跌停|涨超|跌超|跌逾|涨逾|拉升|回落|涨幅|跌幅|成交额|主力资金|连板|复盘/.test(news.title||''))return pending('行情回顾仅作背景，不将既有走势归因于消息');
 const publishedMinute=minute(chinaTime(publication).slice(11,16));
 if(publishedMinute>=900)return pending('盘后消息，等待后续交易时段；本次不跨日推断');
 const entry=history.get(link.symbol);
 if(quoteStale||entry?.stale)return pending('行情来源异常，暂停响应判断');
 if(entry?.date!==date)return pending('消息日期与已取得分时不同');
 const points=(entry.points||[]).filter(p=>Date.parse(date+'T'+p.time+':00+08:00')<=now),latest=points.at(-1);
 if(!latest)return pending('等待消息日分时');
 const preopen=publishedMinute<570,lunch=publishedMinute>690&&publishedMinute<780;
 const anchor=preopen?570:lunch?780:publishedMinute;
 if(!points.find(p=>minute(p.time)===anchor))return pending('消息前基准分钟缺失');
 const windows=[15,30,60].map(n=>{
 const end=anchor+n;
 if(end>900||(anchor<=690&&end>690))return {minutes:n,ready:false,reason:'区间跨午休或收盘，暂停比较'};
 if(minute(latest.time)<end)return {minutes:n,ready:false,reason:'观察窗口尚未完成'};
 const span=interval({...entry,points},anchor,end,date);if(!span)return {minutes:n,ready:false,reason:'分钟数据有缺口'};
 const price=(span.last.price/span.first.price-1)*100;
 const market=link.market==='HK'?null:interval(history.get('sh000985'),anchor,end,date);
 const excess=market?price-(market.last.price/market.first.price-1)*100:null;
 const amount=Number.isFinite(span.last.amount)&&Number.isFinite(span.first.amount)&&span.last.amount>=span.first.amount?span.last.amount-span.first.amount:null;
 const prior=interval({...entry,points},anchor-n,anchor,date);
 const baseline=prior&&Number.isFinite(prior.last.amount)&&Number.isFinite(prior.first.amount)&&prior.last.amount>prior.first.amount?prior.last.amount-prior.first.amount:null;
 const volumeRatio=amount!==null&&baseline>0?amount/baseline:null;
 const flow=flows.get(link.symbol),samples=flow?.stale?[]:flow?.samples||[];
 const a=samples.find(s=>s.date===date&&s.sourceTime.slice(11,16)===clock(anchor)),b=samples.find(s=>s.date===date&&s.sourceTime.slice(11,16)===clock(end));
 const flowRows=samples.filter(s=>s.date===date&&minute(s.sourceTime.slice(11,16))>=anchor&&minute(s.sourceTime.slice(11,16))<=end);
 const flowOK=a&&b&&flowRows.length===n+1&&flowRows.every((s,i)=>!i||minute(s.sourceTime.slice(11,16))-minute(flowRows[i-1].sourceTime.slice(11,16))===1);
 return {minutes:n,ready:true,from:clock(anchor),to:clock(end),price,priorPrice:prior?(prior.last.price/prior.first.price-1)*100:null,excess,amount,volumeRatio,flowDelta:flowOK?b.main-a.main:null};
 });
 const usable=windows.filter(w=>w.ready),verified=usable.filter(w=>w.excess!==null&&w.volumeRatio!==null),last=verified.at(-1)||usable.at(-1);
 const aligned=w=>w.excess!==null&&Math.abs(w.excess)>=.2&&Math.abs(w.price)>=.2&&w.excess*w.price>0;
 let status='数据不足',reason=last?'成交或大盘基线不足，暂不确认响应':'观察窗口未完成或分钟数据不连续';
 if(last&&last.excess!==null&&last.volumeRatio!==null){
 const peak=usable.find(w=>aligned(w)&&w.volumeRatio>=1.5);
 if(peak&&last.minutes>peak.minutes&&(!aligned(last)||Math.sign(last.excess)!==Math.sign(peak.excess)||Math.abs(last.excess)<Math.abs(peak.excess)*.5)){status='响应衰减';reason='早期放量相对异动，后续相对幅度明显减弱';}
 else if(aligned(last)&&last.volumeRatio>=1.5){status='已有响应';reason=(last.price>0?'向上':'向下')+'相对异动伴随成交放大；同一时段可能存在其他事件';}
 else {status='暂无明显响应';reason='尚未同时满足相对强弱与成交放大条件';}
 }
 const share=(shares?.items||[]).find(n=>n.symbol===link.symbol);
 const shareOK=!shares?.failed&&!shares?.error&&!shares?.sources?.[link.symbol.slice(0,2)]?.error&&share?.day?.ready;
 return {...pending(reason),status,windows,time:last?.to,price:last?.price,excess:last?.excess,volumeRatio:last?.volumeRatio,preopen,lunch,share:shareOK?{date:share.date,pct:share.day.pct}:null};
}
export function analyzeNewsMarket(items,defs,context,now=Date.now()){
 return items.map(news=>({news,responses:associateNews(news,defs).map(link=>evaluateResponse(news,link,context,now))}));
}
export function newsMarketHighlights(analyses){
 const rows=analyses.flatMap(a=>a.responses.filter(r=>r.status==='已有响应'||r.status==='响应衰减').map(r=>({...r,news:a.news})));
 rows.sort((a,b)=>(b.status==='已有响应')-(a.status==='已有响应')||Date.parse(b.news.publishedAt)-Date.parse(a.news.publishedAt));
 const seen=new Set();return rows.filter(r=>{if(seen.has(r.symbol))return false;seen.add(r.symbol);return true;}).slice(0,3);
}

export function newsForSymbol(analyses,symbol){
 return analyses.flatMap(a=>{const response=a.responses.find(r=>r.symbol===symbol);return response?[{news:a.news,response}]:[];}).sort((a,b)=>Date.parse(b.news.publishedAt)-Date.parse(a.news.publishedAt));
}
