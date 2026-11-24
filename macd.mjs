export function parseKlines(text){
 const match=text.match(/var k=\((\[[\s\S]*\])\);?\s*$/);if(!match)throw Error('15 分钟数据格式异常');
 const raw=JSON.parse(match[1]);if(!Array.isArray(raw))throw Error('无 K 线');
 const rows=raw.map(r=>({time:String(r.day).replace(' ','T')+'+08:00',open:Number(r.open),close:Number(r.close),high:Number(r.high),low:Number(r.low),volume:r.volume==null||r.volume===''?null:Number(r.volume)}));
 if(rows.some(r=>!/^\d{4}-\d{2}-\d{2}T(?:09:45|10:(?:00|15|30|45)|11:(?:00|15|30)|13:(?:15|30|45)|14:(?:00|15|30|45)|15:00):00\+08:00$/.test(r.time)||!Number.isFinite(Date.parse(r.time))||![r.open,r.close,r.high,r.low].every(x=>Number.isFinite(x)&&x>0)||r.high<Math.max(r.open,r.close)||r.low>Math.min(r.open,r.close)))throw Error('K 线字段异常');
 return [...new Map(rows.map(r=>[r.time,r])).values()].sort((a,b)=>a.time.localeCompare(b.time));
}
export function calculateMacd(bars,now=Date.now()){
 let fast=bars[0]?.close||0,slow=fast,dea=0;
 return bars.map((b,i)=>{if(i){fast+=(b.close-fast)*2/13;slow+=(b.close-slow)*2/27;}const dif=fast-slow;dea+=(dif-dea)*2/10;
 const prevVolumes=bars.slice(Math.max(0,i-20),i).map(x=>x.volume).filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b),n=prevVolumes.length;
 const base=n>=5?(n%2?prevVolumes[(n-1)/2]:(prevVolumes[n/2-1]+prevVolumes[n/2])/2):null;
 return {...b,dif,dea,histogram:2*(dif-dea),confirmed:Date.parse(b.time)+2000<=now,volumeRatio:base>0&&Number.isFinite(b.volume)?b.volume/base:null,changePct:(b.close/b.open-1)*100,warmed:i>=100};});
}
const cache=new Map(),jobs=new Map();
export async function getMacd(symbol){
 const old=cache.get(symbol);if(old&&Date.now()-old.at<60000)return {...old.data,stale:false};if(jobs.has(symbol))return jobs.get(symbol);
 const job=(async()=>{try{
 const r=await fetch('https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20k=/CN_MarketDataService.getKLineData?symbol='+symbol+'&scale=15&ma=no&datalen=240',{signal:AbortSignal.timeout(10000),headers:{'User-Agent':'Mozilla/5.0',Referer:'https://finance.sina.com.cn/'}});
 if(!r.ok)throw Error('15 分钟行情请求失败');const bars=parseKlines(await r.text());if(bars.length<110)throw Error('历史 K 线不足，无法充分预热 MACD');
 const points=calculateMacd(bars).filter(p=>p.warmed).slice(-80);const data={symbol,points,source:'新浪 15 分钟 K 线',fetchedAt:new Date().toISOString(),count:bars.length};cache.set(symbol,{data,at:Date.now()});return {...data,stale:false};
 }catch(e){if(old)return {...old.data,stale:true,error:'获取失败，保留旧 MACD 数据'};throw e;}finally{jobs.delete(symbol);}})();jobs.set(symbol,job);return job;
}
