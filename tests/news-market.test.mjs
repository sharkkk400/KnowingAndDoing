import test from 'node:test';import assert from 'node:assert/strict';
import {associateNews,evaluateResponse,newsMarketHighlights} from '../dist/news-market.js';
const def={symbol:'sz002202',code:'002202',name:'金风科技',market:'A',sector:'风电'};
const news={id:'n',title:'金风科技新订单公告',body:'金风科技公布风机订单',publishedAt:'2026-10-13T10:00:32+08:00'};
const now=Date.parse('2026-10-13T11:05:00+08:00');
const clock=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
function fixture(){
 const points=Array.from({length:121},(_,i)=>{const m=540+i,t=Math.max(0,m-600);return {time:clock(m),price:100+t*.04,amount:1000*i+Math.max(0,m-600)*1000};});
 return {history:new Map([[def.symbol,{date:'2026-10-13',points}],['sh000985',{date:'2026-10-13',points:points.map(p=>({...p,price:100}))}]]),flows:new Map()};
}
test('direct links outrank industry guesses; no blanket new-energy mapping',()=>{
 const links=associateNews(news,[def]);assert.equal(links.length,1);assert.equal(links[0].kind,'direct');
 assert.equal(associateNews({title:'新能源政策',body:''},[def]).length,0);
 const med={symbol:'sh512010',code:'512010',name:'沪深300医药 ETF'};assert.equal(associateNews({title:'创新药审批进展'},[med])[0].symbol,'sh512010');
});
test('responses measure post-publication changes, relative return and equal-length volume',()=>{
 const r=evaluateResponse(news,def,fixture(),now);assert.equal(r.status,'已有响应');assert.equal(r.windows[0].from,'10:00');assert.equal(r.windows[0].to,'10:15');assert.ok(Math.abs(r.windows[0].price-.6)<1e-8);assert.equal(r.windows[0].volumeRatio,2);
 assert.equal(r.windows[2].minutes,60);assert.equal(r.windows[0].flowDelta,null);
});
test('price moves without trading expansion do not become confirmed responses',()=>{
 const f=fixture();f.history.get(def.symbol).points=f.history.get(def.symbol).points.map((p,i)=>({...p,amount:i*1000}));
 assert.equal(evaluateResponse(news,def,f,now).status,'暂无明显响应');
});
test('response decay compares later windows against early response, including negative moves',()=>{
 const f=fixture();f.history.get(def.symbol).points=f.history.get(def.symbol).points.map(p=>({...p,price:minute(p.time)<=615?p.price:100.1}));
 assert.equal(evaluateResponse(news,def,f,now).status,'响应衰减');
 const down=fixture();down.history.get(def.symbol).points=down.history.get(def.symbol).points.map(p=>({...p,price:200-p.price}));
 const r=evaluateResponse(news,def,down,now);assert.equal(r.status,'已有响应');assert.ok(r.price<0);assert.match(r.reason,/向下/);
});
const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3,5));
test('missing/stale/mixed-date data, publication precision and market recaps gate conclusions',()=>{
 for(const n of [{...news,datePrecision:'day'},{...news,title:'金风科技盘中拉升'},{...news,publishedAt:'2026-10-13T15:05:00+08:00'},{...news,publishedAt:'2026-10-14T10:00:00+08:00'}])assert.equal(evaluateResponse(n,def,fixture(),now).status,'数据不足');
 const f=fixture();f.history.get(def.symbol).stale=true;assert.equal(evaluateResponse(news,def,f,now).status,'数据不足');
 delete f.history.get(def.symbol).stale;f.history.get('sh000985').stale=true;assert.equal(evaluateResponse(news,def,f,now).status,'数据不足');
 f.history.get('sh000985').stale=false;f.history.get(def.symbol).points=f.history.get(def.symbol).points.filter(p=>p.time!=='10:05');assert.equal(evaluateResponse(news,def,f,now).status,'数据不足');
 assert.equal(evaluateResponse({...news,publishedAt:'2026-10-12T10:00:00+08:00'},def,fixture(),now).status,'数据不足');
});
test('uncompleted windows and lunch are never forecast; only continuous source flows combine',()=>{
 const f=fixture();const r=evaluateResponse(news,def,f,Date.parse('2026-10-13T10:20:00+08:00'));assert.equal(r.windows[0].ready,true);assert.equal(r.windows[1].ready,false);
 const samples=Array.from({length:61},(_,i)=>({date:'2026-10-13',sourceTime:'2026-10-13T'+clock(600+i)+':00+08:00',main:i*1000}));f.flows.set(def.symbol,{samples});assert.equal(evaluateResponse(news,def,f,now).windows[0].flowDelta,15000);
 f.flows.get(def.symbol).samples=samples.filter(s=>!s.sourceTime.includes('10:05'));assert.equal(evaluateResponse(news,def,f,now).windows[0].flowDelta,null);
 f.flows.get(def.symbol).stale=true;assert.equal(evaluateResponse(news,def,f,now).windows[0].flowDelta,null);
 const lunch={...news,publishedAt:'2026-10-13T11:25:00+08:00'};const points=Array.from({length:31},(_,i)=>({time:clock(660+i),price:100,amount:i*1000}));const ctx={history:new Map([[def.symbol,{date:'2026-10-13',points}]]),flows:new Map()};assert.match(evaluateResponse(lunch,def,ctx,Date.parse('2026-10-13T13:30:00+08:00')).windows[0].reason,/午休/);
});
test('highlights keep one entry per instrument and never surface pending data',()=>{
 const r=evaluateResponse(news,def,fixture(),now);const h=newsMarketHighlights([{news,responses:[r]},{news:{...news,id:'b'},responses:[r]},{news,responses:[{...r,symbol:'missing',status:'数据不足'}]}]);assert.equal(h.length,1);
});

test('battery banks are not financial banks; latest fully comparable window may be shorter',()=>{
 const bank={symbol:'sh512800',code:'512800',name:'银行 ETF'};assert.equal(associateNews({title:'推动电池银行换电'},[bank]).length,0);
 const f=fixture();f.history.get(def.symbol).points=f.history.get(def.symbol).points.filter(p=>p.time>='09:40');
 const r=evaluateResponse(news,def,f,now);assert.equal(r.status,'已有响应');assert.equal(r.time,'10:15');assert.equal(r.windows[2].volumeRatio,null);
});

test('symbol-level news lists only the selected stock or ETF, sorted by publication',async()=>{
 const {newsForSymbol}=await import('../dist/news-market.js');
 const a={news:{id:'early',publishedAt:'2026-10-13T09:45:00+08:00'},responses:[{symbol:'sz002202'},{symbol:'sh512660'}]};
 const b={news:{id:'late',publishedAt:'2026-10-13T10:15:00+08:00'},responses:[{symbol:'sz002202'}]};
 const c={news:{id:'other',publishedAt:'2026-10-13T10:30:00+08:00'},responses:[{symbol:'sh512800'}]};
 assert.deepEqual(newsForSymbol([a,b,c],'sz002202').map(n=>n.news.id),['late','early']);
 assert.equal(newsForSymbol([a,b,c],'sh512660').length,1);
 assert.equal(newsForSymbol([a,b,c],'sh000985').length,0);
 assert.equal(newsForSymbol([a,b,c],'sh512660')[0].response.symbol,'sh512660');
});
