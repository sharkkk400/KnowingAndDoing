import {loadDaily,saveDaily} from './daily-store.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {parseIntraday} from './market.mjs';
import {dailyTrend,aggregateBreadth} from './dist/market-analysis.js';
const cache=new Map(),pending=new Map();
async function cached(key,ttl,loader){
 const old=cache.get(key);if(old&&Date.now()-old.at<ttl)return old.data;
 if(pending.has(key))return pending.get(key);
 const job=(async()=>{try{const data={...await loader(),stale:false,fetchedAt:new Date().toISOString()};cache.set(key,{at:Date.now(),data});return data;}catch(e){const data={...old?.data,stale:true,error:e.message};cache.set(key,{at:Date.now(),data});return data;}finally{pending.delete(key);}})();pending.set(key,job);return job;
}
async function request(url,encoding){const r=await fetch(url,{signal:AbortSignal.timeout(10000),headers:{'User-Agent':'Mozilla/5.0',Referer:'https://finance.sina.com.cn/'}});if(!r.ok)throw Error('市场数据源暂不可用');return encoding?new TextDecoder(encoding).decode(await r.arrayBuffer()):r.text();}
export function parseDaily(text,now=Date.now()){
 const match=text.match(/var k=\((\[[\s\S]*\])\);?\s*$/);if(!match)throw Error('日线格式异常');
 const rows=JSON.parse(match[1]).map(r=>({date:r.day,close:Number(r.close),high:Number(r.high),low:Number(r.low),volume:r.volume!==''&&r.volume!=null&&Number.isFinite(Number(r.volume))&&Number(r.volume)>=0?Number(r.volume):null}));
 if(rows.some(r=>!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||![r.close,r.high,r.low].every(v=>v>0&&Number.isFinite(v))||r.high<r.close||r.low>r.close))throw Error('日线字段异常');
 return [...new Map(rows.filter(r=>Date.parse(r.date+'T15:05:00+08:00')<=now).map(r=>[r.date,r])).values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export async function getDaily(symbol){
 const key='daily:'+symbol;
 if(!cache.has(key)){const disk=await loadDaily(symbol);if(disk&&!cache.has(key))cache.set(key,{at:0,data:{...disk,trend:dailyTrend(disk.bars)}});}
 return cached(key,300000,async()=>{
  const bars=parseDaily(await request('https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20k=/CN_MarketDataService.getKLineData?symbol='+symbol+'&scale=240&ma=no&datalen=80'));
  if(!bars.length)throw Error('来源未返回已收盘日线');
  const saved=await saveDaily(symbol,{bars,source:'新浪日线（已收盘，未复权）',fetchedAt:new Date().toISOString()});
  return {...saved,trend:dailyTrend(saved.bars)};
 });
}
export async function getMarketContext(symbol){
 const [daily,days]=await Promise.all([
 getDaily(symbol),
 cached('days:'+symbol,60000,async()=>{const raw=JSON.parse(await request('https://web.ifzq.gtimg.cn/appstock/app/day/query?code='+symbol));const days=raw?.data?.[symbol]?.data;if(!Array.isArray(days))throw Error('历史分时格式异常');return {days:days.map(d=>parseIntraday({code:0,data:{[symbol]:{data:d}}},symbol)),source:'腾讯最近交易日分时'};})
 ]);return {symbol,daily,history:days};
}
async function pool(items,fn,concurrency=4){const out=[];let cursor=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(cursor<items.length){const i=cursor++;out[i]=await fn(items[i]);}}));return out;}
const universeFile=new URL('./data/market-universe.json',import.meta.url);
async function getUniverse(){
 try{const saved=JSON.parse(await readFile(universeFile,'utf8'));if(Date.now()-saved.at<86400000&&saved.symbols.length>4000)return saved.symbols;}catch{}
 const base='https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.';
 const count=Number(JSON.parse(await request(base+'getHQNodeStockCount?node=hs_a')));if(!(count>4000&&count<15000))throw Error('股票范围获取异常');
 const pages=await pool(Array.from({length:Math.ceil(count/100)},(_,i)=>i+1),async page=>JSON.parse(await request(base+'getHQNodeData?page='+page+'&num=100&sort=symbol&asc=1&node=hs_a&symbol=')));
 const symbols=[...new Set(pages.flat().map(r=>r.symbol).filter(s=>/^(sh|sz|bj)\d{6}$/.test(s)))];
 if(symbols.length<count*.99)throw Error('股票范围不完整，暂不统计广度');
 await mkdir(new URL('./data/',import.meta.url),{recursive:true});await writeFile(universeFile,JSON.stringify({at:Date.now(),symbols}));return symbols;
}
export function parseBreadthQuotes(text){
 const rows=[];for(const m of text.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"]*)"/g)){
 const f=m[2].split('~'),t=f[30];if(!/^\d{14}$/.test(t)||!(Number(f[4])>0)||f[32]===''||!Number.isFinite(Number(f[32])))continue;
 rows.push({symbol:m[1],date:t.slice(0,4)+'-'+t.slice(4,6)+'-'+t.slice(6,8),time:t.slice(8,10)+':'+t.slice(10,12)+':'+t.slice(12,14),change:Number(f[32]),amount:f[37]!==''&&Number.isFinite(Number(f[37]))?Number(f[37])*10000:null,active:Number(f[3])>0&&Number(f[6])>0});
 }return rows;
}
export async function getBreadth(){return cached('breadth',300000,async()=>{
 const symbols=await getUniverse(),chunks=[];for(let i=0;i<symbols.length;i+=250)chunks.push(symbols.slice(i,i+250));
 const startedAt=new Date().toISOString();
 const groups=await pool(chunks,async part=>{try{return parseBreadthQuotes(await request('https://qt.gtimg.cn/q='+part.join(','),'gb18030'));}catch{return [];}});
 const summary=aggregateBreadth(groups.flat(),symbols.length);if(!summary.date)throw Error('市场广度行情暂不可用');
 return {...summary,startedAt,source:'腾讯批量行情 · 新浪 A 股名单',scope:'沪深北 A 股（不含 ETF）'};
});}
