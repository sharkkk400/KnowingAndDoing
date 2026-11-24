export function volumePoints(points){
 const minutes=t=>{const [h,m]=t.split(':').map(Number);return h*60+m;};
 return points.map((p,i)=>{
  const prev=points[i-1],continuous=!!prev&&minutes(p.time)-minutes(prev.time)===1&&!(prev.time==='11:30');
  const delta=k=>continuous&&Number.isFinite(p[k])&&Number.isFinite(prev[k])&&p[k]>=prev[k]?p[k]-prev[k]:null;
  return {...p,continuous,volume:delta('volumeHands'),turnover:delta('amount'),direction:continuous?Math.sign(p.price-prev.price):0};
 });
}

export const VOLUME_RULE={window:20,minBaseline:5,high:2,low:0.5,flatPct:0.05};
export function analyzeVolume(points){
 let baseline=[];
 return volumePoints(points).map((p,i)=>{
  if(!p.continuous||p.volume===null)baseline=[];
  const sorted=[...baseline].sort((a,b)=>a-b),n=sorted.length;
  const base=n>=VOLUME_RULE.minBaseline?(n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2):null;
  const ratio=base>0&&p.volume!==null?p.volume/base:null;
  const priceChange=p.continuous&&points[i-1]?.price>0?(p.price/points[i-1].price-1)*100:null;
  const trend=priceChange===null?'':Math.abs(priceChange)<=VOLUME_RULE.flatPct?'价格变化较小':priceChange>0?'上涨':'下跌';
  const label=p.volume===null?'分钟数据不连续':base===null?'连续样本不足':base===0?'近期成交量基线为零':ratio>=VOLUME_RULE.high?'放量'+trend:ratio<=VOLUME_RULE.low?'缩量'+trend:'成交量平稳 · '+trend;
  const result={...p,from:p.continuous?points[i-1].time:null,priceChange,volumeRatio:ratio,volumeBaseline:base,baselineCount:n,label,marked:ratio!==null&&ratio>=VOLUME_RULE.high};
  if(p.volume!==null){baseline.push(p.volume);baseline=baseline.slice(-VOLUME_RULE.window);}
  return result;
 });
}
