import test from 'node:test';
import assert from 'node:assert/strict';
import {instruments,parseQuotes,parseIntraday} from '../market.mjs';
import {instrumentCatalog} from '../dist/instruments.js';
import {marketSummary,aggregateBreadth} from '../dist/market-analysis.js';
import {etfOverview,exposures} from '../dist/etf-overview.js';
import {groupStrength,macdDistribution} from '../dist/etf-insights.js';
import {watchlist} from '../flow.mjs';
import {archiveDefs} from '../forecast-collector.mjs';
const date='2026-10-13',entry={date,points:[{time:'10:00',price:101}]},quote={prev:100,quoteTime:date+'T10:00:00+08:00'};
const breadth={date,usable:true,timeTo:'10:00:00',upRatio:.7,up:3500,down:1400,amount:1e12};
test('subscription, sampling and forecast scope exclude individual stocks',()=>{
 assert.equal(instrumentCatalog.length,486);
 assert(instruments.every(n=>n.sector==='指数'||n.sector.endsWith('ETF')));
 assert(watchlist.length>0&&watchlist.every(n=>n.sector.endsWith('ETF')));
 assert(archiveDefs.every(n=>n.symbol==='market:A'||n.sector==='指数'||n.sector.endsWith('ETF')));
});
test('market verdict uses full index and stock breadth, and rejects stale/mixed dates',()=>{
 const summary=marketSummary({quote,entry,breadth});
 assert.equal(summary.title,'市场普遍走强');assert.match(summary.text,/10000 亿元/);
 assert.equal(marketSummary({quote,entry,breadth:{...breadth,upRatio:.3}}).title,'指数上涨，多数个股未跟随');
 for(const b of [{...breadth,stale:true},{...breadth,date:'2026-10-12'},{...breadth,timeTo:'10:10:00'},{...breadth,usable:false}])assert.equal(marketSummary({quote,entry,breadth:b}).aligned,false);
 assert.equal(marketSummary({quote,entry:{...entry,stale:true},breadth}).ready,false);
 assert.equal(marketSummary({quote,entry,breadth,quoteStale:true}).ready,false);
});
test('market turnover deduplicates stocks and never fills missing amounts with zero',()=>{
 const r={symbol:'a',date,time:'10:00',change:1,active:true,amount:100};
 assert.equal(aggregateBreadth([r,r,{...r,symbol:'b',amount:200}],2).amount,300);
 assert.equal(aggregateBreadth([r,{...r,symbol:'b',amount:null}],2).amount,null);
});
test('one ETF per theme, six indices; Beijing index quote and missing minute amount are supported',()=>{
 const etfs=instruments.filter(n=>n.sector.endsWith('ETF'));
 assert.equal(etfs.length,new Set(instrumentCatalog.filter(n=>n.theme).map(n=>n.theme)).size);
 assert.deepEqual(etfs.filter(n=>n.theme==='创新药').map(n=>n.code),['159835']);
 assert(etfs.some(n=>n.code==='515450')&&etfs.some(n=>n.code==='510300'));
 assert.equal(new Set(etfs.map(n=>n.theme)).size,etfs.length);
 assert(etfs.every(n=>n.indexCode));
 assert.equal(new Set(etfs.map(n=>n.indexCode)).size,etfs.length);
 assert.equal(new Set(etfs.map(n=>n.symbol)).size,etfs.length);
 assert.equal(instruments.filter(n=>n.sector==='指数').length,6);
 const f=Array(50).fill('');f[3]='101';f[4]='100';f[30]='20261013100000';f[32]='1';
 assert.equal(parseQuotes('v_bj899050="'+f.join('~')+'";')[0].symbol,'bj899050');
 const p=parseIntraday({code:0,data:{bj899050:{data:{date:'20261013',data:['1000 101 500']}}}},'bj899050');
 assert.equal(p.points[0].price,101);assert.equal(p.points[0].amount,null);
});
test('Hong Kong never votes in A-share overview or MACD coverage',()=>{
 const defs=[{symbol:'a',sector:'宽基 ETF'},{symbol:'hk',sector:'港股科技 ETF',market:'HK'}];
 const h=new Map([['a',entry],['hk',{...entry,points:[{time:'10:00',price:200}]}]]),q=new Map([['a',quote],['hk',quote]]);
 const o=etfOverview(defs,h,q);assert.equal(o.total,1);assert.ok(o.middle<2);
 assert.equal(macdDistribution(defs,new Map(),o).total,1);
});
test('industry ranks are independent of style ranks and include distinct sectors',()=>{
 const defs=instruments.filter(n=>n.sector.endsWith('ETF')&&n.market==='A');
 const frames=Array.from({length:16},(_,i)=>({time:'10:'+String(i).padStart(2,'0'),units:exposures(defs.map(n=>({...n,change:n.symbol==='sh512800'?i:n.symbol==='sh512010'?2:n.category==='行业轮动'?0:100,recent:0})))}));
 const groups=groupStrength({ready:true,...frames.at(-1),timeline:frames},defs),bank=groups.find(g=>g.name==='银行');
 assert.equal(bank.rank,1);assert.ok(bank.rankChange>0);assert.equal(groups.some(g=>g.name==='港股科技'),false);
 assert.ok(groups.some(g=>g.name==='沪深300医药'));
});
