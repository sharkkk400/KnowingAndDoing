// Anchor at the setup day's low. A breach cancels this setup permanently.
const avg=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
export function report({samples,sessions,prices,split,mode}){
 for(const part of ['early','late']){
  for(const wait of [0,1,2,3,5]){
   const groups=new Map();
   for(const s of samples){
    if(!s.low||!s.flow||s.part!==part)continue;
    const i=s.index,j=i+wait,limit=part==='early'?split:sessions.length;
    if(j+10>=limit)continue;
    const series=prices.get(s.symbol), anchor=series.get(sessions[i-1]).low;
    const during=sessions.slice(i,j).map(d=>series.get(d));
    if(during.some(b=>!b||b.low<anchor))continue;
    const bar=k=>series.get(sessions[k]);
    if([i,i+5,i+10,j,j+5,j+10].some(k=>!bar(k)))continue;
    const ret=(k,h)=>(bar(k+h).close/bar(k).close-1)*100;
    const key=sessions[j];
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push([ret(j,5),ret(j,10),ret(j,5)-ret(i,5),ret(j,10)-ret(i,10)]);
   }
   const days=[...groups.values()].map(g=>g[0].map((_,k)=>avg(g.map(row=>row[k]))));
   console.log(mode,part,wait,days.length,...[0,1,2,3].map(k=>days.length?avg(days.map(row=>row[k])).toFixed(2):'-'));
  }
 }
}
