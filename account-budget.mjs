// Values are yuan. Reserve capacity in morning rank order, before any sell fills.
export function allocateBudget(plan,holdings,initial,target,cash=plan.sizing?.totalBudget??100000,reserve=0,rate=.0003,minimum=0){
 let exposure=0;
 for(const h of holdings){
  const value=h.marketValue??(h.quantity>0&&h.close>0?h.quantity*h.close:null);
  if(value===null)return new Map();
  exposure+=value;
 }
 let remaining=Math.max(0,Math.min(cash-reserve,(plan.sizing?.totalBudget??100000)-reserve-exposure));
 const amounts=new Map();
 for(const symbol of plan.focusSymbols){
  const i=plan.items.find(x=>x.symbol===symbol),h=holdings.find(x=>x.symbol===symbol);
  if(!i?.entryRule?.enabled||(h&&h.action!=='条件加仓'))continue;
  const value=h?(h.marketValue??h.quantity*h.close):0;
  const desired=h?Math.min(target-value,h.lastTrimAmount??Infinity):initial[i.relativeStrengthRank-1];
  const amount=Math.floor(Math.min(remaining/(1+rate),remaining-minimum,Math.max(0,desired))/100)*100;
  if(amount>0&&amount>=(plan.sizing?.minimumTradeAmount??0)){amounts.set(symbol,amount);remaining-=amount+Math.max(amount*rate,minimum);}
 }
 return amounts;
}
