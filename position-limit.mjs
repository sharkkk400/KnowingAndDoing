export const positionLimit=3;

// Reserve new symbols in the frozen morning order, including when several trigger together.
export function allowedSymbols(plan, occupied){
 const allowed=new Set(),held=new Map((plan.holdings||[]).map(h=>[h.symbol,h]));
 let free=Math.max(0,positionLimit-occupied.size);
 for(const symbol of plan.focusSymbols||[]){
  const item=plan.items.find(i=>i.symbol===symbol);
  if(!item?.entryRule?.enabled)continue;
  const h=held.get(symbol);
  if(h){
   if(occupied.has(symbol)&&h.action==='条件加仓')allowed.add(symbol);
  }else if(occupied.has(symbol)||free>0){
   allowed.add(symbol);
   if(!occupied.has(symbol))free--;
  }
 }
 return allowed;
}
export function occupiedNow(plan,confirmations,events){
 const names=new Set((plan.holdings||[]).map(h=>h.symbol));
 const cutoff=Date.parse(plan.cutoffAt);
 const changes=[...confirmations.map(r=>({symbol:r.symbol,t:Date.parse(r.at),held:r.quantity>0})),
  ...events.filter(e=>e.kind==='entry').map(e=>({symbol:e.symbol,t:Date.parse(e.observedAt),held:true}))];
 for(const c of changes.filter(x=>x.t>cutoff).sort((a,b)=>a.t-b.t)){
  if(c.held)names.add(c.symbol);else names.delete(c.symbol);
 }
 return names;
}
