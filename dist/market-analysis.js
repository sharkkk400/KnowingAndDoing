// Shared calculations: never compare different dates or partial days with full days.
export function dailyTrend(bars){
 if(bars.length<60)return null;
 const last=bars.at(-1),tail=bars.slice(-60),ma=n=>bars.slice(-n).reduce((s,b)=>s+b.close,0)/n;
 const low=Math.min(...tail.map(b=>b.low)),high=Math.max(...tail.map(b=>b.high)),ma20=ma(20),ma60=ma(60);
 return {date:last.date,close:last.close,ma20,ma60,position:high===low?50:100*(last.close-low)/(high-low),label:last.close>ma20&&ma20>ma60?'日线趋势偏强':last.close<ma20&&ma20<ma60?'日线趋势偏弱':'日线趋势分化'};
}
export function sameTimeTurnover(current,days){
 const last=current?.points?.at(-1);if(!last||!(last.amount>0))return null;
 const previous=[...new Map((days||[]).filter(d=>d.date<current.date).map(d=>[d.date,d])).values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-5);
 const samples=previous.map(d=>({date:d.date,amount:d.points.find(p=>p.time===last.time)?.amount})).filter(p=>p.amount>0);
 if(samples.length<3)return null;
 const average=samples.reduce((s,p)=>s+p.amount,0)/samples.length;
 return {date:current.date,time:last.time,amount:last.amount,ratio:last.amount/average,count:samples.length,dates:samples.map(p=>p.date),average};
}
export function alignComparison(market,stock,marketQuote,stockQuote){
 if(!market?.points?.length||!stock?.points?.length)return {error:'等待市场与个股分时数据'};
 if(market.date!==stock.date)return {error:'市场与个股日期不同，暂不比较'};
 if(!(marketQuote?.prev>0)||!(stockQuote?.prev>0)||marketQuote.quoteTime?.slice(0,10)!==market.date||stockQuote.quoteTime?.slice(0,10)!==stock.date)return {error:'缺少同日昨收基准，暂不比较'};
 const other=new Map(stock.points.map(p=>[p.time,p]));
 const points=market.points.filter(p=>other.has(p.time)).map(p=>({time:p.time,market:(p.price/marketQuote.prev-1)*100,stock:(other.get(p.time).price/stockQuote.prev-1)*100}));
 if(!points.length)return {error:'暂无同分钟行情'};
 const last=points.at(-1);return {points,date:market.date,last,difference:last.stock-last.market};
}
export function aggregateBreadth(rows,expected){
 const unique=[...new Map(rows.map(r=>[r.symbol,r])).values()];
 const dates=unique.map(r=>r.date).filter(Boolean).sort();const date=dates.at(-1);
 const dated=unique.filter(r=>r.date===date),active=dated.filter(r=>r.active&&Number.isFinite(r.change));
 const up=active.filter(r=>r.change>0).length,down=active.filter(r=>r.change<0).length,flat=active.length-up-down;
 const coverage=expected>0?dated.length/expected:0;
 const amountRows=active.filter(r=>Number.isFinite(r.amount)&&r.amount>=0);
 const amount=amountRows.length===active.length&&active.length?amountRows.reduce((s,r)=>s+r.amount,0):null;
 return {date,amount,up,down,flat,active:active.length,inactive:dated.length-active.length,received:dated.length,expected,coverage,usable:coverage>=.95&&active.length>0,upRatio:active.length?up/active.length:null,timeFrom:dated.map(r=>r.time).sort()[0],timeTo:dated.map(r=>r.time).sort().at(-1)};
}
export function breadthMatches(breadth,market){
 const last=market?.points?.at(-1);if(breadth?.stale||!breadth?.usable||!last||breadth.date!==market.date)return false;
 const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
 // Providers often stamp closing snapshots after 15:00. Compare their trading cutoff.
 return Math.abs(Math.min(900,minute(breadth.timeTo))-minute(last.time))<=6;
}

// The index describes aggregate price movement; stock breadth is an independent vote.
export function marketSummary({quote,entry,breadth,quoteStale=false}){
 const last=entry?.points?.at(-1),date=entry?.date,time=last?.time;
 if(quoteStale||entry?.stale||!last||!(quote?.prev>0)||quote.quoteTime?.slice(0,10)!==date)return {ready:false,title:'全市场数据待确认',text:'中证全指同日行情未齐，暂不判断市场整体。'};
 const change=(last.price/quote.prev-1)*100,aligned=breadthMatches(breadth,entry);
 const price=change>.05?'上涨':change<-.05?'下跌':'近乎持平';
 const title=!aligned?'指数'+price+' · 广度待确认':change>.05&&breadth.upRatio>=.6?'市场普遍走强':change<-.05&&breadth.upRatio<=.4?'市场普遍走弱':change>.05&&breadth.upRatio<=.4?'指数上涨，多数个股未跟随':change<-.05&&breadth.upRatio>=.6?'指数下跌，多数个股逆势上涨':'市场走势分化';
 const signed=(change>=0?'+':'')+change.toFixed(2)+'%';
 const text=`${title}：中证全指 ${signed}；`+(aligned?`上涨占比 ${(breadth.upRatio*100).toFixed(0)}%（${breadth.up} 涨 / ${breadth.down} 跌）`:'全市场涨跌广度待同步')+(aligned&&breadth.amount!==null&&Number.isFinite(breadth.amount)?`；已覆盖个股成交额 ${(breadth.amount/1e8).toFixed(0)} 亿元`:'')+'。';
 return {ready:true,date,time,change,aligned,title,text,weak:aligned&&change<-.05&&breadth.upRatio<=.4};
}
