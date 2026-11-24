import test from 'node:test';import assert from 'node:assert/strict';
import {exposures} from '../dist/etf-overview.js';
import {groupStrength,anomalyEpisodes,macdDistribution} from '../dist/etf-insights.js';
test('same tracking index has one vote, combining percentage returns not prices',()=>{
 const units=exposures([{symbol:'a',exposure:'dual',sector:'科技 ETF',change:2,recent:1},{symbol:'b',exposure:'dual',sector:'科技 ETF',change:4,recent:3},{symbol:'c',sector:'红利 ETF',change:0,recent:null}]);
 assert.equal(units.length,2);assert.equal(units[0].change,3);assert.equal(units[0].recent,2);
});
test('rotation compares complete groups and breaks across missing minutes',()=>{
 const sectors=['宽基 ETF','科技 ETF','红利 ETF','行业 ETF','港股科技 ETF'],defs=sectors.map((sector,i)=>({symbol:String(i),sector}));
 const timeline=Array.from({length:16},(_,i)=>({time:'10:'+String(i).padStart(2,'0'),units:sectors.map((sector,j)=>({sector,change:j===0?4-i/5:j===1?i/3:0,recent:0}))}));
 const o={ready:true,...timeline.at(-1),timeline};let g=groupStrength(o,defs).find(g=>g.name==='科技');assert.equal(g.rankChange,1);assert.equal(g.from,'10:00');
 g=groupStrength({...o,timeline:timeline.filter(t=>t.time!=='10:05')},defs)[0];assert.equal(g.rankChange,null);
});
const frame=(time,price,reasons)=>({time,rows:[{symbol:'a',price}],alerts:reasons.length?[{symbol:'a',name:'ETF A',price,reasons}]:[]});
test('episodes use source minutes, count volume once, and measure retreat from episode high',()=>{
 const reasons=[{type:'relative',value:2},{type:'volume',value:4}];
 const o={ready:true,timeline:[frame('10:00',100,[reasons[0]]),frame('10:01',110,reasons),frame('10:02',105,reasons)]};
 const a=anomalyEpisodes(o);assert.equal(a.current.get('a')[0].minutes,2);assert.ok(Math.abs(a.current.get('a')[0].adverse-100*5/110)<1e-8);assert.equal(a.volumeHits.get('a'),2);assert.deepEqual(anomalyEpisodes(o),a);
});
test('gaps, condition expiry and direction changes reset episodes',()=>{
 const up=[{type:'relative',value:2}],down=[{type:'relative',value:-2}];
 const r=anomalyEpisodes({ready:true,timeline:[frame('11:29',100,up),frame('11:30',101,up),frame('13:00',101,up),frame('13:01',99,down),frame('13:02',99,[])]});
 assert.equal(r.events.length,3);assert.equal(r.events[0].status,'数据间隔中断');assert.equal(r.events[1].minutes,0);assert.equal(r.events[2].status,'条件已消退');assert.equal(r.current.size,0);
});
const defs=[{symbol:'a',sector:'科技 ETF',exposure:'dual'},{symbol:'b',sector:'科技 ETF',exposure:'dual'},{symbol:'c',sector:'红利 ETF'}];
const bar=(time,dif,dea,confirmed=true)=>({time:'2026-10-09T'+time+':00+08:00',dif,dea,confirmed});
function macds(){return new Map([['a',{points:[bar('10:00',-2,-1),bar('10:15',-1,-2),bar('10:30',9,8,false)]}],['b',{points:[bar('10:00',-2,-1),bar('10:15',-1,-2)]}],['c',{points:[bar('10:00',2,1),bar('10:15',2,1)]}]]);}
test('MACD uses common confirmed bar, deduplicates directions and compares fixed cohort',()=>{
 const m=macdDistribution(defs,macds(),{ready:true,date:'2026-10-09',time:'10:30'});
 assert.equal(m.time,'10:15');assert.equal(m.units,2);assert.equal(m.above,1);assert.equal(m.repair,1);assert.equal(m.bullish,2);assert.equal(m.bullishChange,1);
});
test('MACD rejects missing/stale dates and treats duplicate product disagreement explicitly',()=>{
 const data=macds();data.get('a').stale=true;assert.equal(macdDistribution(defs,data,{ready:true,date:'2026-10-09',time:'10:15'}).ready,false);
 data.get('a').stale=false;data.get('b').points[1].dif=-3;
 const m=macdDistribution(defs,data,{ready:true,date:'2026-10-09',time:'10:15'});assert.equal(m.split,1);assert.equal(m.repair,0);assert.equal(m.bullish,1);
 assert.equal(macdDistribution(defs,data,{ready:true,date:'2026-10-10',time:'10:15'}).ready,false);
});
test('nonadjacent MACD bars never claim a change from the previous complete bar',()=>{
 const data=macds();for(const v of data.values())v.points[0].time='2026-10-09T09:45:00+08:00';
 assert.equal(macdDistribution(defs,data,{ready:true,date:'2026-10-09',time:'10:15'}).bullishChange,null);
});
