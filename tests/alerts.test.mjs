import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeFlows} from '../alerts.mjs';
const rows=(deltas)=>{let main=0;return [0,...deltas].map((d,i)=>({symbol:'sh600519',date:'2026-10-09',sourceTime:`2026-10-09T10:${String(i).padStart(2,'0')}:00+08:00`,main:main+=d}));};
test('uses previous absolute median and exact matching price/amount endpoints',()=>{
 const s=rows([1e6,1e6,1e6,1e6,1e6,12e6,-15e6]);
 const market={date:s[0].date,points:s.map((n,i)=>({time:n.sourceTime.slice(11,16),price:100+i,amount:1e8+i*2e7}))};
 const r=analyzeFlows(s,market);assert.equal(r.events.length,2);assert.equal(r.events[1].ratio,12);assert.equal(r.events[0].direction,'out');assert.equal(r.events[0].amount,2e7);assert(Math.abs(r.events[1].priceChange-(106/105-1)*100)<1e-9);
 assert.equal(analyzeFlows(s,{...market,date:'2026-10-08'}).events[0].amount,null);
});
test('insufficient baseline, zero baseline, duplicate timestamp and gaps',()=>{
 assert.equal(analyzeFlows(rows([20e6])).events.length,0);
 const s=rows([0,0,0,0,0,20e6]);assert.equal(analyzeFlows(s).events[0].ratio,null);
 assert.equal(analyzeFlows([...s,s.at(-1)]).events.length,1);
 const last={...s.at(-1),sourceTime:'2026-10-09T15:00:00+08:00'};
 const r=analyzeFlows([...s.slice(0,-1),last]);assert.equal(r.events.length,0);assert(r.latest.gap);
 const lunch=[{...s[0],sourceTime:'2026-10-09T11:30:00+08:00'},{...last,sourceTime:'2026-10-09T13:00:00+08:00'}];assert(analyzeFlows(lunch).latest.gap);
});
