import {sameTimeTurnover} from './market-analysis.js';
const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
export function etfCapital({defs,quotes,history,contexts,shares,quoteStale=false}){
 const items=defs.filter(d=>d.sector.endsWith('ETF')).map(d=>{
  const q=quotes.get(d.symbol),h=history.get(d.symbol),last=h?.points?.at(-1),context=contexts.get(d.symbol);
  const tradeOK=!quoteStale&&!h?.stale&&last&&q?.prev>0&&q.quoteTime?.slice(0,10)===h.date&&Math.abs(Math.min(900,minute(q.quoteTime.slice(11,16)))-minute(last.time))<=6;
  const s=shares?.items?.find(n=>n.symbol===d.symbol),sourceBad=shares?.failed||shares?.error||shares?.sources?.[d.symbol.slice(0,2)]?.error;
  const shareOK=!sourceBad&&s?.date===shares?.target&&s?.day?.ready;
  const turnover=tradeOK&&!context?.history?.stale?sameTimeTurnover(h,context?.history?.days):null;
  const relation=!shareOK?'份额待确认':s.priceChange===null?'同日价格待补齐':s.priceChange>0&&s.day.delta>0?'价涨份额增：同向增强':s.priceChange<0&&s.day.delta>0?'价跌份额增：逆势承接，尚未止跌':s.priceChange>0&&s.day.delta<0?'价涨份额减：上涨伴随份额退出':s.priceChange<0&&s.day.delta<0?'价跌份额减：同步走弱':'价格或份额持平';
  return {...d,tradeOK:!!tradeOK,date:tradeOK?h.date:null,time:tradeOK?last.time:null,amount:tradeOK&&Number.isFinite(last.amount)?last.amount:null,turnover,shareOK:!!shareOK,share:s,relation};
 });
 const domestic=items.filter(n=>n.market!=='HK'&&n.sector!=='港股科技 ETF'),date=domestic.filter(n=>n.tradeOK).map(n=>n.date).sort().at(-1);
 const dated=domestic.filter(n=>n.date===date&&n.amount!==null),cutoff=dated.map(n=>n.time).sort().at(-1);
 const traded=dated.filter(n=>minute(cutoff)-minute(n.time)<=2),active=[...traded].sort((a,b)=>b.amount-a.amount);
 const usable=domestic.filter(n=>n.shareOK),valued=usable.filter(n=>Number.isFinite(n.share.day.marketValue));
 return {items,date,time:cutoff,total:domestic.length,tradeCount:traded.length,tradeReady:traded.length>=Math.ceil(domestic.length*.9),amount:traded.reduce((sum,n)=>sum+n.amount,0),active:active.slice(0,3),shareDate:shares?.target,shareCount:usable.length,shareReady:usable.length>=Math.ceil(domestic.length*.9),up:usable.filter(n=>n.share.day.delta>0).length,down:usable.filter(n=>n.share.day.delta<0).length,increases:valued.filter(n=>n.share.day.marketValue>0).sort((a,b)=>b.share.day.marketValue-a.share.day.marketValue).slice(0,2),decreases:valued.filter(n=>n.share.day.marketValue<0).sort((a,b)=>a.share.day.marketValue-b.share.day.marketValue).slice(0,2)};
}
