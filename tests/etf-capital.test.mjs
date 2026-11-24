import test from 'node:test';import assert from 'node:assert/strict';
import {analyzeShares} from '../shares-analysis.mjs';
import {etfCapital} from '../dist/etf-capital.js';
const defs=[{symbol:'sh510300',name:'沪深300',sector:'宽基 ETF',market:'A'}];
const dates=['2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16'];
const rows=dates.map((date,i)=>({symbol:'sh510300',date,shares:100+i*10}));
const prices=new Map([['sh510300',{bars:dates.map((date,i)=>({date,close:i+1}))}]]);
test('share amount proxy sums daily deltas at each daily close, never endpoint price',()=>{
 const s=analyzeShares(defs,rows,dates,prices).items[0];
 assert.equal(s.day.marketValue,60);assert.equal(s.five.marketValue,200);assert.notEqual(s.five.marketValue,s.five.delta*6);
 const missing=new Map([['sh510300',{bars:prices.get('sh510300').bars.filter(b=>b.date!==dates[2])}]]);
 assert.equal(analyzeShares(defs,rows,dates,missing).items[0].five.marketValue,null);
 assert.equal(analyzeShares(defs,rows,dates,new Map([['sh510300',{...prices.get('sh510300'),stale:true}]])).items[0].day.marketValue,null);
});
function fixture(){return {defs,quotes:new Map([['sh510300',{prev:1,quoteTime:'2026-10-16T10:00:00+08:00'}]]),history:new Map([['sh510300',{date:'2026-10-16',points:[{time:'10:00',price:1,amount:1000}]}]]),contexts:new Map(),shares:{...analyzeShares(defs,rows,dates,prices),sources:{sh:{status:'已连接'}}}};}
test('trade and published shares retain separate dates, HK is excluded from summary',()=>{
 const f=fixture();f.history.get('sh510300').date='2026-10-19';f.quotes.get('sh510300').quoteTime='2026-10-19T10:00:00+08:00';
 f.defs=[...defs,{symbol:'sz159740',sector:'港股科技 ETF',market:'HK'}];const d=etfCapital(f);
 assert.equal(d.date,'2026-10-19');assert.equal(d.shareDate,'2026-10-16');assert.equal(d.total,1);assert.equal(d.amount,1000);assert.equal(d.increases.length,1);
 assert.match(d.items[0].relation,/同向增强/);
});
test('failed sources, invalid share windows and lagging quotes cannot produce fund rankings',()=>{
 const f=fixture();f.shares.sources.sh.error='offline';let d=etfCapital(f);assert.equal(d.shareReady,false);assert.equal(d.increases.length,0);
 delete f.shares.sources.sh.error;f.shares.items[0].day.ready=false;assert.equal(etfCapital(f).shareReady,false);
 f.quotes.get('sh510300').quoteTime='2026-10-16T11:00:00+08:00';assert.equal(etfCapital(f).tradeReady,false);
});
test('missing turnover and stale comparison baselines never become zero or volume signals',()=>{
 const f=fixture();f.history.get('sh510300').points[0].amount=null;assert.equal(etfCapital(f).tradeCount,0);
 f.history.get('sh510300').points[0].amount=1000;f.contexts.set('sh510300',{history:{stale:true,days:dates.slice(0,3).map(date=>({date,points:[{time:'10:00',amount:100}]}))}});
 assert.equal(etfCapital(f).items[0].turnover,null);assert.equal(etfCapital({...f,quoteStale:true}).tradeReady,false);
});
