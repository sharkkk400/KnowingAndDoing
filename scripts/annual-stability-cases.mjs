// Research-only grid. The defensive leg uses the traded CGB ETF, never imputed cash interest.
export function annualStabilityCases(){
 const cases=[{id:'base'}];
 for(const cap of [30000,50000,70000]){
  cases.push({id:'cap-'+cap,cap});
  cases.push({id:'weakspread-'+cap,cap,weakSpread:true});
  cases.push({id:'drawdown-'+cap,cap,drawdown:true});
 }
 for(const regime of ['always','above60','idle','idle-above60']){
  for(const budget of [20000,40000,60000,80000]){
   for(const cap of [50000,90000]){
    cases.push({id:[regime,budget,cap].join('-'),regime,budget,cap});
   }
  }
 }
 return cases;
}

export function bondRegimeCases(){
 const cases=[{id:'fixed60',budget:60000,cap:90000}];
 for(const strongBudget of [0,20000,40000]){
  for(const budget of [40000,60000,80000]){
   if(budget<=strongBudget)continue;
   cases.push({id:'dynamic-'+strongBudget+'-'+budget,budget,strongBudget,cap:90000});
  }
 }
 return cases;
}
