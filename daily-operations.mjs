import {chinaDate} from './research-store.mjs';

export const dailyOperationLimit=2;
const sellPriority=new Map([['清仓',0],['减仓',1]]);

export function reserveOperations(plan,amounts){
 const sells=(plan.holdings||[]).filter(h=>sellPriority.has(h.action))
  .sort((a,b)=>sellPriority.get(a.action)-sellPriority.get(b.action)||a.symbol.localeCompare(b.symbol));
 return {scope:'perSymbol',limit:dailyOperationLimit,sells:sells.map(h=>h.symbol),buys:[...amounts.keys()]};
}

// Each scheduled sale and emitted entry reserves one operation. A matching
// quantity change consumes that reservation only once, including on a T trade.
export function remainingEntries(plan,confirmations,events,symbol){
 const sells=new Set(plan.operations?.sells??(plan.holdings||[]).filter(h=>sellPriority.has(h.action)).map(h=>h.symbol));
 const entries=events.filter(e=>e.date===plan.date&&e.kind==='entry'&&e.symbol===symbol);
 const pendingBuys=new Map(entries.map(e=>[e.symbol,Date.parse(e.observedAt)]));
 let used=Number(sells.has(symbol))+entries.length;
 const quantities=new Map();
 for(const r of confirmations){
  if(r.symbol!==symbol)continue;
  const previous=quantities.get(r.symbol)??0;
  quantities.set(r.symbol,r.quantity);
  const time=Date.parse(r.at);
  if(chinaDate(time)!==plan.date||previous===r.quantity||(plan.positionSnapshot&&time<=Date.parse(plan.cutoffAt)))continue;
  if(r.quantity<previous&&sells.delete(r.symbol))continue;
  if(r.quantity>previous&&pendingBuys.get(r.symbol)<=time){pendingBuys.delete(r.symbol);continue;}
  used++;
 }
 return Math.max(0,dailyOperationLimit-used);
}
