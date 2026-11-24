// Tencent public website endpoints. Field layout is unofficial and may change.
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {instruments} from './dist/instruments.js';
export {instruments};
const number=s=>s!==''&&s!=null&&Number.isFinite(Number(s))?Number(s):null;
export function parseQuotes(text){
  const rows=[];
  for(const match of text.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"]*)"/g)){
    const instrument=instruments.find(i=>i.symbol===match[1]);
    const f=match[2].split('~');
    if(!instrument||f.length<46||!(number(f[3])>0)||!(number(f[4])>0)||!/^\d{14}$/.test(f[30]))continue;
    const t=f[30];
    rows.push({...instrument,price:number(f[3]),prev:number(f[4]),open:number(f[5]),high:number(f[33]),low:number(f[34]),changePct:number(f[32]),amount:number(f[37])===null?null:number(f[37])*10000,volumeHands:number(f[6]),volumeRatio:number(f[49]),quoteTime:`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}+08:00`});
  }
  return rows;
}
export function parseIntraday(json,symbol){
  const raw=json?.data?.[symbol]?.data;
  if(json.code!==0||!raw||!/^\d{8}$/.test(raw.date))throw new Error('分时数据格式异常');
  const points=(raw.data||[]).map(line=>{
    const [time,price,volume,amount]=line.trim().split(/\s+/);
    return {time:`${time.slice(0,2)}:${time.slice(2)}`,price:number(price),volumeHands:number(volume),amount:number(amount)};
  }).filter(p=>/^\d{2}:\d{2}$/.test(p.time)&&p.time>='09:30'&&p.time<='15:00'&&!(p.time>'11:30'&&p.time<'13:00')&&p.price>0);
  if(!points.length)throw new Error('暂无有效分时数据');
  return {symbol,date:`${raw.date.slice(0,4)}-${raw.date.slice(4,6)}-${raw.date.slice(6)}`,points};
}
// Sina bars contain independent minute volume (shares) and amount (yuan).
// Prefix sums restore the cumulative fields expected by the shared chart consumers.
export function parseSinaIntraday(text,symbol){
  const match=text.match(/=\s*\(?(\[[\s\S]*\])\)?\s*;?\s*$/);
  if(!match)throw new Error('新浪分时格式异常');
  const raw=JSON.parse(match[1]);
  const rows=raw.filter(p=>/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(p.day||'')&&number(p.close)>0&&number(p.volume)!==null&&number(p.volume)>=0&&number(p.amount)!==null&&number(p.amount)>=0);
  if(!rows.length)throw new Error('新浪暂无有效分时');
  const date=rows.map(p=>p.day.slice(0,10)).sort().at(-1);
  const bars=[...new Map(rows.filter(p=>p.day.startsWith(date)).map(p=>[p.day.slice(11,16),p])).entries()].sort(([a],[b])=>a.localeCompare(b)).filter(([t])=>t>='09:30'&&t<='15:00'&&!(t>'11:30'&&t<'13:00'));
  if(!bars.length||bars[0][0]>'09:31')throw new Error('新浪当日分钟数据不完整');
  let volume=0,amount=0;
  const points=bars.map(([time,p])=>{volume+=Number(p.volume);amount+=Number(p.amount);return {time,price:Number(p.close),volumeHands:volume/100,amount};});
  return {symbol,date,points,source:'新浪1分钟K线（备用）',fallback:true,granularity:'minute-close'};
}
export function createCache(ttl=15000){
  const entries=new Map(),pending=new Map();
  return async function cached(key,loader){
    const old=entries.get(key);
    if(old&&Date.now()-old.time<ttl)return {...old.result,stale:false};
    if(pending.has(key))return pending.get(key);
    const job=(async()=>{try{const data=await loader();const result={...data,source:data.source||'腾讯公开行情',fetchedAt:new Date().toISOString()};entries.set(key,{time:Date.now(),result});return {...result,stale:false};}catch{if(old)return {...old.result,stale:true,error:'上游获取失败，保留上次数据'};throw new Error('行情源暂不可用，请稍后重试');}finally{pending.delete(key);}})();
    pending.set(key,job);return job;
  };
}
const cached=createCache();
async function upstream(url){const r=await fetch(url,{signal:AbortSignal.timeout(8000),headers:{'User-Agent':'Mozilla/5.0','Referer':'https://gu.qq.com/'}});if(!r.ok)throw new Error('上游请求失败');return r;}
export async function getQuotes(){return cached('quotes',async()=>{const response=await upstream('https://qt.gtimg.cn/q='+instruments.map(i=>i.symbol).join(','));const rows=parseQuotes(new TextDecoder('gb18030').decode(await response.arrayBuffer()));if(!rows.length)throw new Error('无有效行情');return {quotes:rows,missing:instruments.filter(i=>!rows.some(q=>q.symbol===i.symbol)).map(i=>i.symbol)};});}
const intradayDir=fileURLToPath(new URL('./data/intraday/',import.meta.url));
let primaryRetryAt=0;
export async function getIntraday(symbol){
  if(!instruments.some(i=>i.symbol===symbol))throw new Error('无效标的');
  try{return await cached(symbol,async()=>{
    let result;
    if(Date.now()>=primaryRetryAt){
      try{result=parseIntraday(await (await upstream('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code='+symbol)).json(),symbol);}
      catch{primaryRetryAt=Date.now()+300000;}
    }
    if(!result){
      result=parseSinaIntraday(await (await upstream('https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20k=/CN_MarketDataService.getKLineData?symbol='+symbol+'&scale=1&ma=no&datalen=480')).text(),symbol);
    }
    // Keep a last successful series across process restarts; persistence failure
    // must not discard a valid upstream response.
    try{await mkdir(intradayDir,{recursive:true});const path=intradayDir+symbol+'.json';await writeFile(path+'.tmp',JSON.stringify({...result,source:result.source||'腾讯公开行情',fetchedAt:new Date().toISOString()}));await rename(path+'.tmp',path);}catch{}
    return result;
  });}catch{
    try{const saved=JSON.parse(await readFile(intradayDir+symbol+'.json','utf8'));if(saved.symbol!==symbol||!Array.isArray(saved.points)||!saved.points.length)throw new Error();return {...saved,stale:true,error:'上游暂不可用，展示本地最后一次成功分时'};}catch{throw new Error('分时源暂不可用，尚无本地缓存');}
  }
}
