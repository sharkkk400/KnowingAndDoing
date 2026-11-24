import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyTrend,sameTimeTurnover,aggregateBreadth,alignComparison,breadthMatches} from '../dist/market-analysis.js';
import {parseDaily,parseBreadthQuotes} from '../market-context.mjs';
test('same-time turnover excludes today, future and unmatched minutes; requires three days',()=>{
 const current={date:'2026-10-09',points:[{time:'10:00',amount:400}]};
 const day=(date,time,amount)=>({date,points:[{time,amount}]});
 const days=[day('2026-10-08','10:00',100),day('2026-10-07','10:00',200),day('2026-10-06','10:00',300),day('2026-10-05','15:00',10000),day('2026-10-09','10:00',9999),day('2026-10-10','10:00',9999)];
 assert.equal(sameTimeTurnover(current,days).ratio,2);assert.equal(sameTimeTurnover(current,days).count,3);assert.equal(sameTimeTurnover(current,days.slice(0,2)),null);
});
test('daily trend only uses completed days and handles flat ranges',()=>{
 const text='var k=('+JSON.stringify([{day:'2026-10-08',close:'10',high:'10',low:'10'},{day:'2026-10-09',close:'12',high:'12',low:'12'}])+');';
 assert.equal(parseDaily(text,Date.parse('2026-10-09T14:00:00+08:00')).length,1);
 assert.equal(parseDaily(text,Date.parse('2026-10-09T15:06:00+08:00')).length,2);
 assert.equal(dailyTrend(Array.from({length:60},()=>({date:'2026-10-08',close:10,high:10,low:10}))).position,50);
 assert.equal(dailyTrend([]),null);
});
test('breadth deduplicates stocks, excludes old dates and no-trade stocks, gates coverage',()=>{
 const row=(symbol,change,active=true,date='2026-10-09')=>({symbol,change,active,date,time:'15:00:00'});
 const rows=[row('a',1),row('a',1),row('b',-1),row('c',0),row('d',0,false),row('e',2,true,'2026-10-08')];
 const b=aggregateBreadth(rows,5);assert.equal(b.up,1);assert.equal(b.down,1);assert.equal(b.flat,1);assert.equal(b.inactive,1);assert.equal(b.coverage,.8);assert.equal(b.usable,false);
 assert.equal(aggregateBreadth(rows.slice(0,5),4).usable,true);
});
test('comparison rejects mixed dates and missing quote baselines, aligns exact minutes',()=>{
 const market={date:'2026-10-09',points:[{time:'10:00',price:102},{time:'10:01',price:103}]};
 const stock={date:market.date,points:[{time:'10:00',price:101}]},q={prev:100,quoteTime:'2026-10-09T10:01:00+08:00'};
 assert.equal(alignComparison(market,stock,q,q).points.length,1);
 assert.ok(alignComparison(market,{...stock,date:'2026-10-08'},q,q).error);
 assert.ok(alignComparison(market,stock,{...q,quoteTime:'2026-10-08'},q).error);
});
test('breadth parser requires source dates and numeric changes',()=>{
 const f=Array(50).fill('');f[3]='10';f[4]='9';f[6]='10';f[30]='20261009150000';f[32]='11.11';
 const result=parseBreadthQuotes('v_sh600000="'+f.join('~')+'";');assert.equal(result[0].date,'2026-10-09');assert.equal(result[0].active,true);
 f[32]='';assert.equal(parseBreadthQuotes('v_sh600000="'+f.join('~')+'";').length,0);
});

test('breadth must be near chart cutoff, closing provider timestamps are normalized',()=>{
 const market={date:'2026-10-09',points:[{time:'10:00'}]};
 const b={date:market.date,usable:true,timeTo:'10:04:00'};
 assert.equal(breadthMatches(b,market),true);assert.equal(breadthMatches({...b,timeTo:'11:00:00'},market),false);
 assert.equal(breadthMatches({...b,timeTo:'16:15:00'},{...market,points:[{time:'15:00'}]}),true);
 assert.equal(breadthMatches({...b,date:'2026-10-08'},market),false);
});
