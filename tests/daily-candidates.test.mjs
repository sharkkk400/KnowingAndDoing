import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyCandidates} from '../daily-candidates.mjs';
const bars=(growth)=>Array.from({length:80},(_,i)=>{const close=10*(1+growth)**i;return {date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),close,high:close*1.001,low:close*.999};});
const defs=[{symbol:'a',name:'A',exposure:'same'},{symbol:'b',name:'B',exposure:'same'}];
const fixture=()=>new Map([['sh000300',{bars:bars(.001)}],['a',{bars:bars(.003)}],['b',{bars:bars(.002)}]]);
test('daily candidates align dates, deduplicate exposure and freeze price levels',()=>{
 const result=dailyCandidates(defs,fixture());assert.equal(result.ready,true);assert.equal(result.qualified,1);assert.equal(result.rows[0].symbol,'a');assert.equal(result.marketOK,true);assert.equal(result.rows[0].status,'等待回踩确认');
 assert.equal(result.rows[0].resistance,Math.max(...bars(.003).slice(-21,-1).map(r=>r.high)));assert.ok(result.rows[0].invalidation<result.rows[0].close);
});
test('stale source, missing sessions or mixed final dates suspend screening',()=>{
 for(const mutate of [d=>d.get('a').stale=true,d=>d.get('a').bars.splice(50,1),d=>d.get('a').bars.pop()]){const d=fixture();mutate(d);assert.equal(dailyCandidates(defs,d).ready,false);}
 const d=fixture();d.get('sh000300').stale=true;assert.equal(dailyCandidates(defs,d).ready,false);
});
test('weak environment is not an entry signal; no candidates is valid',()=>{
 const d=fixture();d.set('sh000300',{bars:bars(-.001)});const r=dailyCandidates(defs,d);assert.equal(r.marketOK,false);assert.equal(r.rows[0].status,'环境未确认');
 d.set('a',{bars:bars(-.002)});d.set('b',{bars:bars(-.003)});assert.equal(dailyCandidates(defs,d).rows.length,0);
});
test('unbroken resistance and stretched prices retain waiting status',()=>{
 const d=fixture();d.get('a').bars.at(-2).high*=1.05;assert.equal(dailyCandidates(defs,d).rows[0].status,'等待突破确认');
 d.set('a',{bars:bars(.02)});assert.equal(dailyCandidates(defs,d).rows[0].status,'偏离均线，暂观察');
});
