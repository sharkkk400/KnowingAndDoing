import test from 'node:test';import assert from 'node:assert/strict';
import {instrumentOutlook,marketOutlook} from '../dist/outlook.js';
const date='2026-10-13',now=Date.parse(date+'T16:00:00+08:00');
function fixture(){
 const q={symbol:'sz002202',sector:'风电',quoteTime:date+'T15:20:00+08:00',prev:10,high:10.8,low:10.2,volumeHands:200};
 const flow={snapshot:{date,sourceTime:date+'T15:00:00+08:00',main:200000},samples:Array.from({length:31},(_,i)=>({date,sourceTime:date+'T14:'+String(30+i).padStart(2,'0')+':00+08:00',main:i*1000}))};flow.samples.at(-1).sourceTime=date+'T15:00:00+08:00';
 return {quote:q,entry:{date,points:[{time:'15:00',price:10.6,volumeHands:200,amount:208000}]},daily:{ready:true,date,close:10.6,averages:[{days:5,value:10.4},{days:20,value:10},{days:60,value:9.5}],volumeHistory:Array.from({length:6},(_,i)=>({date:'2026-10-'+String(7+i).padStart(2,'0'),volume:20000}))},flow,macd:{points:[{confirmed:true,time:date+'T14:45:00+08:00',histogram:.1},{confirmed:true,time:date+'T15:00:00+08:00',histogram:.2}]},benchmark:{symbol:'sh000300',quoteTime:date+'T15:10:00+08:00',changePct:0},now};
}
test('multiple supportive signals give a conditional outlook with levels, never a probability',()=>{
 const r=instrumentOutlook(fixture());assert.equal(r.ready,true);assert.equal(r.bias,'strong');assert.equal(r.support,10.2);assert.equal(r.pressure,10.8);assert.equal(r.volumeRatio,1);assert.equal(r.conditions.length,2);assert.match(r.conditions[1].text,/失效/);assert.equal(r.probability,undefined);
});
test('weak daily, price, relative strength and funds produce a different directional scenario',()=>{
 const f=fixture();f.entry.points[0].price=9.5;f.quote.low=9.2;f.quote.high=10;
 f.daily.averages=[{days:5,value:10.5},{days:20,value:11},{days:60,value:12}];f.flow.snapshot.main=-200000;
 f.macd.points[0].histogram=-.1;f.macd.points[1].histogram=-.2;
 const r=instrumentOutlook(f);assert.equal(r.bias,'weak');assert.equal(r.support,9.2);assert.equal(r.pressure,10);
});
test('optional missing data lowers evidence without manufacturing flow or share support',()=>{
 const f=fixture();f.flow.stale=true;f.macd.stale=true;
 const r=instrumentOutlook(f);assert.ok(r.missing.some(s=>s.includes('资金')));assert.ok(r.missing.some(s=>s.includes('动能')));assert.ok(!r.evidence.some(s=>s.includes('主力净额')));
 f.daily={ready:false};assert.equal(instrumentOutlook(f).bias,'limited');
});
test('market data failures and outdated daily bars cannot produce a current confident outlook',()=>{
 for(const extra of [{paused:true},{quoteStale:true},{entry:{...fixture().entry,stale:true}},{quote:{...fixture().quote,quoteTime:'2026-10-12T15:20:00+08:00'}}])assert.equal(instrumentOutlook({...fixture(),...extra}).ready,false);
 const f=fixture();f.daily.date='2016-10-13';assert.equal(instrumentOutlook(f).bias,'limited');assert.equal(instrumentOutlook(f).volumeRatio,null);
 f.daily.date='2026-10-14';assert.equal(instrumentOutlook(f).bias,'limited');
 f.quote.quoteTime=date+'T16:05:00+08:00';assert.equal(instrumentOutlook(f).ready,false);
});
test('old or failed published shares and nonadjacent MACD bars never add evidence',()=>{
 const f=fixture();f.shares={date:'2026-10-12',five:{ready:true,pct:3}};assert.ok(instrumentOutlook(f).evidence.some(s=>s.includes('截至2026-10-12')));
 f.shareError=true;assert.ok(!instrumentOutlook(f).evidence.some(s=>s.includes('份额')));
 f.shareError=false;f.shares.date='2026-10-14';assert.ok(!instrumentOutlook(f).evidence.some(s=>s.includes('份额')));
 f.macd.points[0].time=date+'T13:30:00+08:00';assert.ok(instrumentOutlook(f).missing.some(s=>s.includes('动能')));
});
test('intraday turnover is never divided by completed daily volume',()=>{
 const f=fixture();f.now=Date.parse(date+'T10:00:30+08:00');f.entry.points[0].time='10:00';f.quote.quoteTime=date+'T10:00:00+08:00';
 assert.equal(instrumentOutlook(f).volumeRatio,null);
 f.entry.points[0].time='09:50';assert.equal(instrumentOutlook(f).ready,false);
});
function marketFixture(){return {overview:{ready:true,date,time:'15:00',up:8,down:1,units:Array(10).fill({})},whole:{ready:true,date,time:'15:00',aligned:true},breadth:{upRatio:.7},distribution:{ready:true,date,time:'15:00',units:10,bullish:8},groups:[{category:'行业轮动',name:'军工',ready:true,change:2}]};}
test('market breadth, ETF spread and confirmed momentum jointly govern market scenarios',()=>{
 const f=marketFixture();assert.equal(marketOutlook(f).bias,'repair');
 f.overview.up=2;assert.equal(marketOutlook(f).bias,'mixed');
 f.breadth.upRatio=.3;f.overview.down=8;assert.equal(marketOutlook(f).bias,'weak');
 f.whole.aligned=false;assert.equal(marketOutlook(f).bias,'limited');
 f.whole.date='2026-10-12';assert.equal(marketOutlook(f).ready,false);
});

test('completed daily and closing quote provide an explicitly labelled fallback, never synthetic minutes',()=>{
 const f=fixture();f.quote.price=10.6;f.quote.amount=208000;f.entry={stale:true,error:'minute source failed'};
 const r=instrumentOutlook(f);assert.equal(r.ready,true);assert.equal(r.basis,'收盘报价＋已收盘日线');assert.ok(r.missing.some(s=>s.includes('分时不可用')));
 f.quote.price=11;assert.equal(instrumentOutlook(f).ready,false);
 f.quote.price=10.6;f.daily.date='2026-10-12';assert.equal(instrumentOutlook(f).ready,false);
});
test('market fallback uses only same-day closed quotes with coverage, keeps breadth failure distinct',()=>{
 const defs=Array.from({length:10},(_,i)=>({symbol:'e'+i,sector:'行业 ETF',market:'A',category:'行业轮动',group:'方向'+i}));
 const quotes=new Map(defs.map(n=>[n.symbol,{price:101,prev:100,quoteTime:date+'T15:20:00+08:00'}]));quotes.set('sh000985',{price:101,prev:100,quoteTime:date+'T15:20:00+08:00'});
 const f={overview:{ready:false},whole:{ready:false},quotes,defs,breadth:{usable:true,date,timeTo:'15:20:00',upRatio:.7},now};
 let r=marketOutlook(f);assert.equal(r.ready,true);assert.match(r.missing.join(''),/分时未取得/);
 f.breadth.stale=true;r=marketOutlook(f);assert.ok(r.missing.includes('全市场广度待对齐'));
 quotes.delete('e0');quotes.delete('e1');assert.equal(marketOutlook(f).ready,false);
});
