import {getDaily} from './market-context.mjs';
const cache=new Map(),pending=new Map();
export function parseDailyFlow(json,symbol,now=Date.now()){
 if(json?.rc!==0||json.data?.code!==symbol.slice(2)||!Array.isArray(json.data.klines))throw Error('日资金数据无效');
 const rows=json.data.klines.map(line=>{
  const f=typeof line==='string'?line.split(','):[];
  if(!/^\d{4}-\d{2}-\d{2}$/.test(f[0])||new Date(f[0]+'T00:00:00Z').toISOString().slice(0,10)!==f[0]||f.length<6||f.slice(1,6).some(v=>!v.trim()||!Number.isFinite(Number(v))))throw Error('日资金字段异常');
  const [main,small,medium,large,superLarge]=f.slice(1,6).map(Number);
  if(Math.abs(main-large-superLarge)>Math.max(10,Math.abs(main)*.001))throw Error('日资金净额校验失败');
  return {date:f[0],main,small,medium,large,superLarge};
 }).filter(r=>Date.parse(r.date+'T15:05:00+08:00')<=now);
 if(!rows.length)throw Error('暂无已收盘资金数据');
 return [...new Map(rows.map(r=>[r.date,r])).values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export function alignDailyFlow(rows,daily){
 if(daily.stale||!daily.bars?.length)throw Error('交易日基准暂不可用');
 const dates=daily.bars.slice(-20).map(r=>r.date),byDate=new Map(rows.map(r=>[r.date,r]));
 return {rows:dates.map(date=>byDate.get(date)||{date,missing:true}),count:dates.filter(d=>byDate.has(d)).length,total:dates.length};
}
export async function getDailyFlow(symbol){
 const old=cache.get(symbol);
 if(old&&Date.now()-old.at<300000)return old.data;
 if(pending.has(symbol))return pending.get(symbol);
 const job=(async()=>{try{
  const secid=(symbol.startsWith('sh')?'1.':'0.')+symbol.slice(2);
  const url='https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=40&klt=101&secid='+secid+'&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63';
  const [response,daily]=await Promise.all([fetch(url,{signal:AbortSignal.timeout(10000),headers:{'User-Agent':'Mozilla/5.0','Referer':'https://quote.eastmoney.com/'}}),getDaily(symbol)]);
  if(!response.ok)throw Error('日资金来源请求失败');
  const result={...alignDailyFlow(parseDailyFlow(await response.json(),symbol),daily),symbol,stale:false,source:'东方财富日资金',fetchedAt:new Date().toISOString()};
  cache.set(symbol,{at:Date.now(),data:result});return result;
 }catch{const result={...(old?.data||{symbol,rows:[],count:0,total:20}),stale:true,error:'日资金来源暂不可用，已保留取得的数据'};cache.set(symbol,{at:Date.now(),data:result});return result;}finally{pending.delete(symbol);}})();
 pending.set(symbol,job);return job;
}
